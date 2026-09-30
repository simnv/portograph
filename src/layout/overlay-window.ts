import type { Point, Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { EPS } from '../score/geometry.js';
import { chordEnds, overlayBlockers, straightBetween, type OverlayEnd, type OverlayShape, type ShapeQuery } from './overlay-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';

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
 */

/** The candidates judged for one group, the mean not counted. A count, not a time (ticket 141). */
export const CHORD_WINDOW_TRIALS = 32;
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
 * The candidate that keeps the most chords straight. `count(x)` is the number of straight chords with the group's centre at `x`.
 * Candidates are taken nearest the mean first (then the smaller x), at most `CHORD_WINDOW_TRIALS` of them besides the mean; a tie
 * goes to the nearest, so the mean stays where no other x is better.
 */
export function pickTarget(mean: number, candidates: readonly number[], count: (x: number) => number): { target: number; gained: number } {
  const sorted = [...new Set(candidates)].filter(x => Math.abs(x - mean) > PLACEMENT_EPS)
    .sort((a, b) => Math.abs(a - mean) - Math.abs(b - mean) || a - b).slice(0, CHORD_WINDOW_TRIALS);
  const base = count(mean);
  let target = mean, best = base;
  for (const x of sorted) {
    const value = count(x);
    if (value > best) { best = value; target = x; }
  }
  return { target, gained: best - base };
}

interface Counted { head: OverlayEnd; tail: OverlayEnd; moves: 'head' | 'tail' | undefined }

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
 * The centre x for a free group: the candidate that keeps the most of its counted chords straight. The counted chords are the overlay
 * links of the group's nodes to settled partners on other tiers, and the overlay links between two settled nodes whose segment
 * passes the rows of the group. A mesh bus member is no chord. Chords to a free group the pass has not placed are not counted, and
 * the shapes of that group are not read (they stand where ELK left them, and a second run would read another place).
 */
export function windowTarget(model: LayoutModel, group: LayoutGroup, input: WindowInput): { target: number; gained: number } {
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const box = group.bounds!, centre = box.x + box.width / 2;
  const { settled } = input;
  const mine = new Set(group.nodes);
  const skip = new Set(group.nodes);
  for (const other of Object.values(model.groups)) if (!settled.has(other.id) && other.id !== group.id) for (const node of other.nodes) skip.add(node);
  const bare = overlayBlockers(model, skip);
  const counted: Counted[] = [];
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
      counted.push({ ...ends, moves: inFrom ? 'head' : 'tail' });
      const partner = model.nodes[inFrom ? to.node : from.node]!.bounds!, at = partner.x + partner.width / 2;
      span.low = Math.min(span.low, at); span.high = Math.max(span.high, at);
    } else {
      if (!settled.has(groupOf(from.node)) || !settled.has(groupOf(to.node))) continue;
      const low = Math.min(ends.head.face.y, ends.tail.face.y), high = Math.max(ends.head.face.y, ends.tail.face.y);
      if (high > box.y + PLACEMENT_EPS && low < box.y + box.height - PLACEMENT_EPS) counted.push({ ...ends, moves: undefined });
    }
  }
  if (!counted.length) return { target: input.mean, gained: 0 };
  // The shapes of the group: they move with it.
  const own: OverlayShape[] = [];
  for (const id of group.nodes) {
    const node = model.nodes[id]!;
    if (node.bounds) own.push({ ...node.bounds });
    for (const port of node.ports) if (port.pill && port.ref.anonymous !== true) own.push({ ...port.pill.bounds, pill: true });
  }
  const straightAt = (x: number): number => {
    const dx = x - centre;
    const shapes = own.map(shape => ({ ...shape, x: shape.x + dx }));
    const blockers: ShapeQuery = { some: (bounds, predicate, work, padding) => bare.some(bounds, predicate, work, padding) || shapes.some(shape => predicate(shape)) };
    return counted.filter(({ head, tail, moves }) =>
      straightBetween(moves === 'head' ? shiftEnd(head, dx) : head, moves === 'tail' ? shiftEnd(tail, dx) : tail, blockers) !== undefined).length;
  };
  const shifts: number[] = [];
  const add = (found: readonly Window[]): void => {
    for (const { low, high } of found) {
      if (Number.isFinite(low) && Math.abs(low) < UNBOUNDED) shifts.push(low - PLACEMENT_EPS);
      if (Number.isFinite(high) && Math.abs(high) < UNBOUNDED) shifts.push(high + PLACEMENT_EPS);
    }
  };
  for (const { head, tail, moves } of counted) {
    if (moves === undefined) { for (const shape of own) add(chordWindows(head.face, tail.face, 'shape', shape)); continue; }
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
  const candidates = shifts.map(dx => centre + dx).filter(x => x >= Math.max(input.range.low, span.low) - PLACEMENT_EPS && x <= Math.min(input.range.high, span.high) + PLACEMENT_EPS);
  return pickTarget(input.mean, candidates, straightAt);
}
