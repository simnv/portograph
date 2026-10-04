import type { Point, Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { chordEnds, chordPoints, overlayBlockers, straightBetween, type OverlayEnd, type OverlayShape, type ShapeQuery } from './overlay-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { drawn, drawnCrossings, overlayCrossingPoints, portKey, type Drawn } from './read/crossings.js';

/**
 * The window rule of the overlay barycentre (ranked-groups ticket 143, decisions-log Q112).
 *
 * The mean of a free group's partners is the place that keeps the sum of its overlay chord lengths short, and it says nothing about
 * the bodies the chords pass. Two free groups that stand one under the other near the canton axis put the upper one on the chords of
 * the lower one, and each of those chords takes the orthogonal branch. The group can instead stand where its chords are straight.
 *
 * A chord enters a shape for one interval of group shifts `dx` (`chordWindows`). The candidates are the mean and the two ends of each
 * interval, pushed out by `PLACEMENT_EPS`; `windowTarget` judges every candidate with the overlay rule's own straight test and takes
 * the one that keeps the most chords straight, the nearest the mean on a tie. It reads only *settled* geometry: the shapes of a free
 * group that the pass has not placed yet are left out, so a second run finds the same x. There is no clock: the bound is a count.
 *
 * **Crossings first** (ticket 147, decisions-log Q112, user decision 2026-09-30). The objective is lexicographic: the fewest overlay
 * crossings, then the most straight chords, then the nearest to the mean, then the smaller x. The crossings are counted between the
 * paths of the group's own counted overlay links at the candidate x (the straight chord, or the planned orthogonal path where a shape
 * stands on it) and every overlay link whose two groups are settled. Routed links are not counted: their paths do not exist yet at
 * placement. The candidates add the x values where a link starts or stops crossing another (the `events` of `windowTarget`).
 */

/** The candidates judged for one group, the mean not counted. A count, not a time (ticket 141). */
export const CHORD_WINDOW_TRIALS = 32;
/** The event points judged for one group (ticket 147): they only break ties inside a maximum-straight interval, so fewer are enough. */
export const EVENT_TRIALS = 8;
/** A parameter this close to the fixed end stands for the end itself; the interval of a shift there is unbounded. */
const NEAR_END = 1e-9;
/** A shift larger than this is no candidate: the interval it ends is unbounded on that side. */
const UNBOUNDED = 1e7;

export interface Window { low: number; high: number }
export type Mover = 'from' | 'to' | 'shape';

/**
 * The interval of horizontal shifts `dx` at which the straight chord `from`-`to` enters `shape` (open, as `crosses` reads it), or
 * nothing. `mover` names what `dx` moves: the `from` end, the `to` end (the chord then swings about the other end), or the shape
 * (the chord is fixed). The set is one interval: for a fixed parameter along the chord the shifts that enter the shape are one
 * interval, and its two ends are monotone in the parameter, so the union over the parameter range is connected and its ends stand at
 * the two ends of that range. An end that is unbounded is very large; `windowTarget` drops it.
 */
export function chordWindows(from: Point, to: Point, mover: Mover, shape: Rect): Window[] {
  const left = shape.x + EPS, right = shape.x + shape.width - EPS, top = shape.y + EPS, bottom = shape.y + shape.height - EPS;
  if (right <= left || bottom <= top) return [];
  // The fixed end and the moving end, so the parameter `s` runs from the fixed end (0) to the moving end (1).
  const [fixed, moving] = mover === 'to' ? [from, to] : [to, from];
  const start = mover === 'shape' ? from : fixed, dy = mover === 'shape' ? to.y - from.y : moving.y - fixed.y;
  let low = 0, high = 1;
  if (Math.abs(dy) <= EPS) {
    if (start.y <= top || start.y >= bottom) return [];
  } else {
    const a = (top - start.y) / dy, b = (bottom - start.y) / dy;
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
  }
  if (high <= low) return [];
  if (mover === 'shape') {
    const xa = from.x + (to.x - from.x) * low, xb = from.x + (to.x - from.x) * high;
    return [{ low: Math.min(xa, xb) - right, high: Math.max(xa, xb) - left }];
  }
  // x(s) = fixed.x + s * (moving.x - fixed.x) + s * dx, so dx lies in ((left - c(s)) / s, (right - c(s)) / s) and both ends are monotone in s.
  const at = (s: number): Window => {
    const c = fixed.x + s * (moving.x - fixed.x);
    return { low: (left - c) / s, high: (right - c) / s };
  };
  const one = at(Math.max(low, NEAR_END)), two = at(Math.max(high, NEAR_END));
  return [{ low: Math.min(one.low, two.low), high: Math.max(one.high, two.high) }];
}

/**
 * What a candidate x is judged by: the counted chords that are straight (more is better), whether one of them is bent that is straight
 * at the mean (`bendsMean`), and the overlay crossings (fewer is better; `Infinity` where the candidate was not counted).
 */
export interface Score { crossings: number; straight: number; bendsMean: boolean }

/**
 * The candidate with the most straight chords; among equal counts, the fewest crossings, but only among candidates that bend no chord
 * that is straight at the mean (ticket 147, user order 2026-09-30); then the nearest to the mean, then the smaller x. `score(x, atLeast)`
 * judges the group's centre at `x`; it may leave the crossings uncounted (`Infinity`) where fewer than `atLeast` chords are straight,
 * because such a candidate cannot win. The mean is scored first. Candidates are taken nearest the mean first, at most
 * `CHORD_WINDOW_TRIALS` of them besides the mean, and the event points have their own bound `EVENT_TRIALS`. `gained` is the rise in
 * straight chords and `saved` the fall in crossings (either may be negative).
 */
export function pickTarget(mean: number, candidates: readonly number[], score: (x: number, atLeast: number) => Score, events: readonly number[] = []): { target: number; gained: number; saved: number } {
  // Each kind has its own count bound, so the many event points do not crowd out the ends of the straight windows.
  const nearest = (list: readonly number[], count: number): number[] => [...new Set(list)].filter(x => Math.abs(x - mean) > PLACEMENT_EPS)
    .sort((a, b) => Math.abs(a - mean) - Math.abs(b - mean) || a - b).slice(0, count);
  const sorted = [...new Set([...nearest(candidates, CHORD_WINDOW_TRIALS), ...nearest(events, EVENT_TRIALS)])]
    .sort((a, b) => Math.abs(a - mean) - Math.abs(b - mean) || a - b);
  const base = score(mean, 0);
  let target = mean, best = base;
  for (const x of sorted) {
    const value = score(x, best.straight);
    if (value.straight > best.straight || (value.straight === best.straight && !value.bendsMean && value.crossings < best.crossings)) { best = value; target = x; }
  }
  return { target, gained: best.straight - base.straight, saved: base.crossings - best.crossings };
}

export { portKey, drawn, drawnCrossings, overlayCrossingPoints as overlayCrossings, type Drawn };

interface Counted { link: LayoutLink; head: OverlayEnd; tail: OverlayEnd; moves: 'head' | 'tail' | undefined }

const shiftEnd = (end: OverlayEnd, dx: number): OverlayEnd => ({
  anchor: { x: end.anchor.x + dx, y: end.anchor.y }, box: { ...end.box, x: end.box.x + dx },
  pill: end.pill && { ...end.pill, x: end.pill.x + dx }, face: { x: end.face.x + dx, y: end.face.y },
  clear: { x: end.clear.x + dx, y: end.clear.y }, out: end.out,
});

export interface WindowInput {
  /** The mean of the partners, the group's centre x when the rule finds nothing better. */
  mean: number;
  /** The centre x the sweep allows: between the walls of the tier, or inside the canton wall. */
  range: Window;
  /** Groups whose place is settled: not free, or free and placed by this pass. */
  settled: ReadonlySet<string>;
  /** Every overlay link of the model. */
  overlays: readonly LayoutLink[];
}

/**
 * The centre x for a free group: the candidate with the fewest overlay crossings, then the most straight counted chords. The counted
 * chords are the overlay links of the group's nodes to settled partners on other tiers, and the overlay links between two settled
 * nodes whose segment passes the rows of the group. A mesh bus member is no chord. Chords to a free group the pass has not placed are
 * not counted, and the shapes of that group are not read (they stand where ELK left them, and a second run would read another place).
 * The crossings are read between the group's own counted links and every overlay link whose two groups are settled.
 */
export function windowTarget(model: LayoutModel, group: LayoutGroup, input: WindowInput): { target: number; gained: number; saved: number } {
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const box = group.bounds!, centre = box.x + box.width / 2;
  const { settled } = input;
  const mine = new Set(group.nodes);
  const skip = new Set(group.nodes);
  for (const other of Object.values(model.groups)) if (!settled.has(other.id) && other.id !== group.id) for (const node of other.nodes) skip.add(node);
  const bare = overlayBlockers(model, skip);
  const counted: Counted[] = [];
  /** The links between two settled nodes, none in the group. Their paths are read for crossings; `rows` marks those that pass the group's rows. */
  const fixed: { link: LayoutLink; head: OverlayEnd; tail: OverlayEnd; rows: boolean; points: Point[]; drawn: Drawn }[] = [];
  // The group's centre stays inside the x-span of its settled partners, as the into-span step (ticket 22) puts it: a chord that is
  // straight only from far outside the span is not worth the width.
  const span: Window = { low: Infinity, high: -Infinity };
  for (const link of input.overlays) {
    if (link.meshBus !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    const inFrom = mine.has(from.node), inTo = mine.has(to.node);
    if (inFrom && inTo) continue;
    const ends = chordEnds(model, link);
    if (!ends) continue;
    if (inFrom || inTo) {
      const otherGroup = groupOf(inFrom ? to.node : from.node);
      if (!settled.has(otherGroup) || model.groups[otherGroup]!.tier === group.tier) continue;
      counted.push({ link, ...ends, moves: inFrom ? 'head' : 'tail' });
      const partner = model.nodes[inFrom ? to.node : from.node]!.bounds!, at = partner.x + partner.width / 2;
      span.low = Math.min(span.low, at); span.high = Math.max(span.high, at);
    } else {
      if (!settled.has(groupOf(from.node)) || !settled.has(groupOf(to.node))) continue;
      const low = Math.min(ends.head.face.y, ends.tail.face.y), high = Math.max(ends.head.face.y, ends.tail.face.y);
      const rows = high > box.y + PLACEMENT_EPS && low < box.y + box.height - PLACEMENT_EPS;
      const points = chordPoints(ends.head, ends.tail, bare);
      fixed.push({ link, ...ends, rows, points, drawn: drawn(points, [portKey(from), portKey(to)]) });
      if (rows) counted.push({ link, ...ends, moves: undefined });
    }
  }
  if (!counted.length) return { target: input.mean, gained: 0, saved: 0 };
  const own = counted.filter(item => item.moves !== undefined);
  // The shapes of the group: they move with it.
  const shapesOfGroup: OverlayShape[] = [];
  for (const id of group.nodes) {
    const node = model.nodes[id]!;
    if (node.bounds) shapesOfGroup.push({ ...node.bounds });
    for (const port of node.ports) if (port.pill && port.ref.anonymous !== true) shapesOfGroup.push({ ...port.pill.bounds, pill: true });
  }
  const keys = (link: LayoutLink): [string, string] => [portKey(link.attachments!.from), portKey(link.attachments!.to)];
  /** The blockers with the group's own shapes shifted by `dx`. */
  const blockersAt = (dx: number): ShapeQuery => {
    const shapes = shapesOfGroup.map(shape => ({ ...shape, x: shape.x + dx }));
    return { some: (bounds, predicate, work, padding) => bare.some(bounds, predicate, work, padding) || shapes.some(shape => predicate(shape)) };
  };
  const endsAt = ({ head, tail, moves }: Counted, dx: number): [OverlayEnd, OverlayEnd] =>
    [moves === 'head' ? shiftEnd(head, dx) : head, moves === 'tail' ? shiftEnd(tail, dx) : tail];
  let meanFlags: boolean[] | undefined;
  const scoreAt = (x: number, atLeast: number): Score => {
    const dx = x - centre, blockers = blockersAt(dx);
    const flags = counted.map(item => { const [head, tail] = endsAt(item, dx); return straightBetween(head, tail, blockers) !== undefined; });
    const straight = flags.filter(Boolean).length;
    meanFlags ??= flags;
    const bendsMean = flags.some((flag, index) => !flag && meanFlags![index]);
    // The crossings are counted only where the candidate can win: it needs at least as many straight chords as the best so far, and a candidate that ties the best and bends a mean-straight chord cannot take it.
    if (straight < atLeast || (straight === atLeast && bendsMean)) return { crossings: Infinity, straight, bendsMean };
    const paths: Drawn[] = [];
    counted.forEach((item, index) => {
      if (item.moves === undefined) return;
      const [head, tail] = endsAt(item, dx);
      paths.push(drawn(flags[index]! ? [head.face, tail.face] : chordPoints(head, tail, blockers), keys(item.link)));
    });
    let crossings = overlayCrossingPoints(paths);
    // A link between two settled nodes that passes the group's rows may bend round a shifted shape of the group: it is read at `x`, the rest as they stand.
    for (const item of fixed) {
      const other = item.rows ? drawn(chordPoints(item.head, item.tail, blockers), item.drawn.ports) : item.drawn;
      for (const path of paths) crossings += drawnCrossings(path, other);
    }
    return { crossings, straight, bendsMean };
  };
  const shifts: number[] = [];
  const add = (found: readonly Window[], into: number[] = shifts): void => {
    for (const { low, high } of found) {
      if (Number.isFinite(low) && Math.abs(low) < UNBOUNDED) into.push(low - PLACEMENT_EPS);
      if (Number.isFinite(high) && Math.abs(high) < UNBOUNDED) into.push(high + PLACEMENT_EPS);
    }
  };
  const eventShifts: number[] = [];
  for (const { head, tail, moves } of counted) {
    if (moves === undefined) { for (const shape of shapesOfGroup) add(chordWindows(head.face, tail.face, 'shape', shape)); continue; }
    const fixedEnd = moves === 'head' ? tail : head, movingEnd = moves === 'head' ? head : tail;
    const low = Math.min(head.face.y, tail.face.y), high = Math.max(head.face.y, tail.face.y);
    const seen: OverlayShape[] = [];
    bare.some({ x: -UNBOUNDED, y: low, width: 2 * UNBOUNDED, height: high - low }, shape => { seen.push(shape); return false; });
    const pill = fixedEnd.pill;
    for (const shape of seen) {
      if (pill && pill.x === shape.x && pill.y === shape.y && pill.width === shape.width && pill.height === shape.height) continue;
      add(chordWindows(head.face, tail.face, moves === 'head' ? 'from' : 'to', shape));
    }
    // The segment must leave each end outward (`straightBetween`): where a lateral port's outward direction is horizontal the limit is a shift.
    // Moving end: (other - end - dx) . out >= 0. Fixed end: (moving end + dx - end) . out >= 0.
    for (const [end, other, moving] of [[movingEnd, fixedEnd, true], [fixedEnd, movingEnd, false]] as const) {
      if (end.out.x === 0) continue;
      const along = (other.face.x - end.face.x) * end.out.x + (other.face.y - end.face.y) * end.out.y;
      shifts.push(moving ? along / end.out.x - Math.sign(end.out.x) * PLACEMENT_EPS : -along / end.out.x + Math.sign(end.out.x) * PLACEMENT_EPS);
    }
  }
  // The events (ticket 147): the shifts at which an own link starts or stops crossing another link. The straight line from the fixed end
  // `f` to the moving end `m` passes a point `p` that moves with the group (rate 1) or stands (rate 0) at one shift; a fixed segment is
  // met by the moving end of a link at another.
  const through = (f: Point, m: Point, p: Point, rate: number): Window[] => {
    const dy = m.y - f.y;
    if (Math.abs(dy) <= EPS) return [];
    const t = (p.y - f.y) / dy;
    if (t < 0 || t > 1 || Math.abs(t - rate) < 1e-9) return [];
    const dx = (p.x - f.x - (m.x - f.x) * t) / (t - rate);
    return [{ low: dx, high: dx }];
  };
  const pointsOfFixed = fixed.flatMap(item => item.points);
  for (const item of own) {
    const f = (item.moves === 'head' ? item.tail : item.head).face, m = (item.moves === 'head' ? item.head : item.tail).face;
    for (const p of pointsOfFixed) add(through(f, m, p, 0), eventShifts);
    for (const other of own) {
      if (other === item) continue;
      add(through(f, m, (other.moves === 'head' ? other.head : other.tail).face, 1), eventShifts);
      add(through(f, m, (other.moves === 'head' ? other.tail : other.head).face, 0), eventShifts);
    }
    for (const { points } of fixed) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!;
        if (Math.abs(b.y - a.y) <= EPS || m.y < Math.min(a.y, b.y) || m.y > Math.max(a.y, b.y)) continue;
        const dx = a.x + (b.x - a.x) * (m.y - a.y) / (b.y - a.y) - m.x;
        add([{ low: dx, high: dx }], eventShifts);
      }
    }
  }
  const inside = (list: readonly number[]): number[] => list.map(dx => centre + dx).filter(x => x >= Math.max(input.range.low, span.low) - PLACEMENT_EPS && x <= Math.min(input.range.high, span.high) + PLACEMENT_EPS);
  return pickTarget(input.mean, inside(shifts), scoreAt, inside(eventShifts));
}
