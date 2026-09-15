import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { bottom, EPS, right } from '../score/geometry.js';
import { groupConsumers } from '../score/model.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { GROUP_LABEL_GEOMETRY, nodeObstacleReach, routedStroke, stemReach } from './bands.js';
import { MEMBER_GAP } from './bundle-geometry.js';
import { findPort, STRAIGHT_PATH_CLEARANCE } from './row-paths.js';

/**
 * ADR-0015 rule 1, per gap: the room every run that crosses a **tier gap** needs, allocated before
 * the first ownership batch runs rather than discovered by whichever batch reaches the gap first.
 *
 * A tier gap is the open band between two adjacent tier bands. The reservations that face it bound
 * it: the bottom of each lane that ends at its upper side, and the top of each lane that begins at
 * its lower side. Every planned routed gap of a transit link that straddles it is allocated here.
 * A run whose two ends share one x takes that **column**; a run whose ends differ takes a **row**
 * at its own pitch. Stage 8 receives the result as reserved geometry it routes through, and as an
 * obstacle to every other link. Nothing inside the gap is left for a batch to take.
 *
 * The allocation reads frozen placement and writes no model geometry, exactly as rule 1's leg
 * reservation does (`legReservation`) and for the same reason: `fixedSegments` belongs to the lanes
 * rule, which runs long before the geometry this reads exists.
 */

/** A gap a run may be allocated in: the open band between two tier bands, clipped to the lanes. */
interface TierGap { low: number; high: number }

/** One planned routed gap of one link that straddles a tier gap. */
interface Participant {
  link: LayoutLink;
  /** Index of the planned gap: 0 before the first reserved run, `n` after the last. */
  index: number;
  /** The end that stands on a gap boundary, and the end beyond it. */
  near: Point;
  far: Point;
  /** `true` when `near` comes first in the link's traversal order. */
  nearFirst: boolean;
  /** The boundary `near` stands on. */
  nearEdge: 'low' | 'high';
  /** `true` when `far` also stands on the opposite boundary, so the whole run is determined. */
  farOnEdge: boolean;
  /**
   * Where the port's own approach has to arrive, when the far end is a port beyond the gap: that
   * port's outward checkpoint. The run stops at the gap's boundary; the approach between the two is
   * the piece stage 8 still routes, and the gap allocates only where it is clear.
   */
  reach?: Point;
}

/** One allocated run: the reserved geometry, and the links that may cross it. */
export interface GapRun {
  link: string;
  /** The planned gap it belongs to, in the link's own traversal order. */
  index: number;
  segments: PathSegment[];
  /**
   * Links whose own route must cross this tier gap. A run **along** a gap is a wall along it and
   * never across it, so the links that have to get through are given the crossing rather than a
   * dead end (ADR-0015 rule 3). The crossing is of the row alone: the vertical parts of the run
   * still obstruct them, and a route can pass those by.
   */
  crossers: string[];
}

/** One rectangle stage 8 must respect, with the links a rule has already let through it. */
interface Blocker { bounds: Rect; owners: ReadonlySet<string>; node?: string }

const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;
const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.attachments !== undefined
  && link.layer === 'routed' && link.path === undefined;
const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
const OUTWARD: Record<Side, number> = { top: -1, bottom: 1, left: 0, right: 0 };
const OUTWARD_X: Record<Side, number> = { top: 0, bottom: 0, left: -1, right: 1 };

/**
 * The tier gaps of this diagram, low to high. A lane overhangs its band, so the room a run really
 * has is the band gap clipped to the lane bounds that face it.
 */
function tierGaps(model: LayoutModel): TierGap[] {
  const bands = model.tierBands.filter(band => band.bounds).map(band => band.bounds!).sort((a, b) => a.y - b.y);
  const result: TierGap[] = [];
  for (const [index, band] of bands.entries()) {
    const next = bands[index + 1];
    if (!next || bottom(band) >= next.y - EPS) continue;
    let low = bottom(band), high = next.y;
    for (const lane of model.lanes) {
      if (lane.layer === 'overlay') continue;
      if (bottom(lane.bounds) > low + EPS && bottom(lane.bounds) < high - EPS) low = bottom(lane.bounds);
    }
    for (const lane of model.lanes) {
      if (lane.layer === 'overlay') continue;
      if (lane.bounds.y > low + EPS && lane.bounds.y < high - EPS) high = lane.bounds.y;
    }
    if (high > low + EPS) result.push({ low, high });
  }
  return result;
}

/**
 * Every stop one link's route passes through, in the order stage 8 plans them: the two ends and the
 * ends of the runs the lanes rule fixed. An end that consumes a declared shared run starts at that
 * run's terminal, not at its port anchor.
 */
function stopsOf(model: LayoutModel, link: LayoutLink): { point: Point; kind: 'port' | 'shared' | 'lane' }[] {
  const ends = (['from', 'to'] as const).map(end => {
    const runs = link.sharedRuns?.[end];
    if (runs?.length) return { point: runs.at(-1)!.to, kind: 'shared' as const };
    const anchor = findPort(model, link.attachments![end])?.anchor;
    return anchor ? { point: anchor, kind: 'port' as const } : undefined;
  });
  if (!ends[0] || !ends[1]) return [];
  // Every reserved run keeps its place, so the index of each planned gap is the one `planRoute`
  // plans from. Only a lane terminal opens into a tier gap: a port anchor can sit on a boundary as
  // well — a band's extent is the union of its nodes — and a run from there is that link's own stem.
  const kindOf = (segment: PathSegment): 'shared' | 'lane' => segment.lane === undefined ? 'shared' : 'lane';
  return [ends[0], ...(link.fixedSegments ?? []).flatMap(segment =>
    [{ point: segment.from, kind: kindOf(segment) }, { point: segment.to, kind: kindOf(segment) }]), ends[1]];
}

/** The gap boundary a point stands on, or undefined when it stands on neither. */
function edgeOf(gap: TierGap, point: Point): 'low' | 'high' | undefined {
  if (same(point.y, gap.low)) return 'low';
  if (same(point.y, gap.high)) return 'high';
  return undefined;
}

/**
 * The outward checkpoint of a participant's far port, when the far end is a port beyond the gap.
 * The run reaches the gap's boundary and the port's own approach reaches this point. It exists only
 * where the port faces the gap: a port on a node's other side, or an end that consumes a shared
 * run, leaves a route placement cannot see, and the gap leaves that run out.
 */
function reachOf(model: LayoutModel, link: LayoutLink, end: 'from' | 'to', far: Point, edge: number):
{ point: Point } | undefined {
  const port = findPort(model, link.attachments![end]);
  if (!port?.anchor || port.side === undefined) return undefined;
  const travel = Math.sign(far.y - edge);
  if (travel === 0 || OUTWARD[port.side] !== -travel) return undefined;
  const stem = stemReach(model, model.nodes[link.attachments![end].node]!);
  return { point: { x: far.x, y: far.y - travel * stem } };
}

/**
 * One run's head-on approach to the corridor it leaves: a corridor admits only its owner's collinear
 * run, so the run stands off the boundary on the lane's own x for at least the router stem. Every
 * run with a lane terminal on a boundary holds one, whether the gap seats it or not.
 */
interface Approach { link: string; x: number; edge: 'low' | 'high' }

/** One link's crossing of a tier gap it has no allocation in, with the x its two ends stand at. */
interface Crossing { link: string; low: number; high: number }

/** What one tier gap holds: the runs it can place, the approaches it owes, and its crossings. */
interface GapUsers { items: Participant[]; approaches: Approach[]; crossers: Crossing[] }

/**
 * The planned gaps of every routed link that must cross a tier gap, grouped by the gap.
 *
 * A run the allocation cannot place — one with no lane terminal on either boundary, one that
 * crosses two gaps at once, one whose far end placement cannot follow — is not a reason to give up
 * the gap. Its link becomes a **crosser**: it keeps the route it has today, and the allocated runs
 * do not obstruct it.
 */
function gapUsers(model: LayoutModel, gaps: TierGap[]): Map<number, GapUsers> {
  const result = new Map<number, GapUsers>(gaps.map((gap, key) => [key, { items: [], approaches: [], crossers: [] }]));
  for (const link of model.links) {
    if (!drawn(link)) continue;
    const stops = stopsOf(model, link);
    for (let index = 0; index * 2 + 1 < stops.length; index++) {
      const a = stops[index * 2]!, b = stops[index * 2 + 1]!;
      const low = Math.min(a.point.y, b.point.y), high = Math.max(a.point.y, b.point.y);
      const found = gaps.flatMap((gap, key) => gap.low > low - EPS && gap.high < high + EPS ? [key] : []);
      const across = { link: link.id, low: Math.min(a.point.x, b.point.x), high: Math.max(a.point.x, b.point.x) };
      // A run that only reaches into a gap still has to leave it, and a row across its way is a
      // wall for it exactly as it is for a run that crosses the gap end to end.
      for (const [key, gap] of gaps.entries()) {
        if (found.includes(key) || !(high > gap.low + EPS && low < gap.high - EPS)) continue;
        result.get(key)!.crossers.push(across);
      }
      if (!found.length) continue;
      if (found.length > 1) { for (const key of found) result.get(key)!.crossers.push(across); continue; }
      const key = found[0]!, gap = gaps[key]!, users = result.get(key)!;
      const edgeA = a.kind === 'lane' ? edgeOf(gap, a.point) : undefined;
      const edgeB = b.kind === 'lane' ? edgeOf(gap, b.point) : undefined;
      if (edgeA === undefined && edgeB === undefined) { users.crossers.push(across); continue; }
      const nearFirst = edgeA !== undefined;
      const near = nearFirst ? a : b, far = nearFirst ? b : a;
      const item: Participant = { link, index, near: near.point, far: far.point, nearFirst,
        nearEdge: (nearFirst ? edgeA : edgeB)!, farOnEdge: edgeA !== undefined && edgeB !== undefined };
      // The approach is owed whether this run is seated or not: a run the gap declines still leaves
      // its corridor head-on, and a run seated over that stem would share length with it.
      users.approaches.push({ link: link.id, x: item.near.x, edge: item.nearEdge });
      if (item.farOnEdge) users.approaches.push({ link: link.id, x: item.far.x, edge: item.nearEdge === 'low' ? 'high' : 'low' });
      if (!item.farOnEdge) {
        const reach = far.kind === 'port'
          ? reachOf(model, link, nearFirst ? 'to' : 'from', far.point, item.nearEdge === 'low' ? gap.high : gap.low)
          : undefined;
        if (!reach) { users.crossers.push(across); continue; }
        item.reach = reach.point;
      }
      users.items.push(item);
    }
  }
  return result;
}

/** Whether this participant needs a row of its own: its two ends do not share one x. */
const needsRow = (item: Participant): boolean => !same(item.near.x, item.far.x);

/** Where a participant stands on each gap boundary, one entry per vertical segment. */
function ends(item: Participant): { x: number; edge: 'low' | 'high' }[] {
  const far: 'low' | 'high' = item.nearEdge === 'low' ? 'high' : 'low';
  return [{ x: item.near.x, edge: item.nearEdge }, { x: item.far.x, edge: far }];
}

/**
 * The order of the rows in one gap, nearest the low boundary first, or undefined when no order is
 * clean.
 *
 * Two runs that stand on one x — a lane under a lane of the same x in the band above, or a port
 * over a lane's mouth — would share length there unless the one leaving the low boundary turns
 * first. That is the only forced constraint. A row that crosses another run's vertical segment is a
 * crossing, and
 * a crossing between two allocated runs is reserved rather than discovered.
 */
function rowOrder(rows: Participant[]): Participant[] | undefined {
  const key = (item: Participant): string => `${item.link.id}#${item.index}`;
  const after = new Map(rows.map(item => [key(item), new Set<string>()]));
  for (const one of rows) {
    for (const other of rows) {
      if (other === one) continue;
      for (const mine of ends(one)) {
        for (const theirs of ends(other)) {
          if (!same(mine.x, theirs.x)) continue;
          // Two runs standing on one x from one boundary share length whichever rows they take.
          if (mine.edge === theirs.edge) return undefined;
          if (mine.edge === 'high') after.get(key(one))!.add(key(other));
        }
      }
    }
  }
  const travel = (item: Participant): number => Math.abs(item.far.x - item.near.x);
  const depth = (item: Participant): number => item.nearEdge === 'low' ? 0 : item.farOnEdge ? 1 : 2;
  const waiting = new Map(rows.map(item => [key(item), after.get(key(item))!.size]));
  const feeds = new Map(rows.map(item => [key(item), [] as Participant[]]));
  for (const item of rows) for (const id of after.get(key(item))!) feeds.get(id)!.push(item);
  const ready = rows.filter(item => waiting.get(key(item)) === 0);
  const order: Participant[] = [];
  while (ready.length) {
    ready.sort((a, b) => depth(a) - depth(b) || travel(b) - travel(a) || (key(a) < key(b) ? -1 : 1));
    const next = ready.shift()!;
    order.push(next);
    for (const item of feeds.get(key(next))!) {
      waiting.set(key(item), waiting.get(key(item))! - 1);
      if (waiting.get(key(item)) === 0) ready.push(item);
    }
  }
  // Runs that must each turn beyond the other: no order is clean, so the gap keeps its routed gaps.
  return order.length === rows.length ? order : undefined;
}

/** The reserved segments of one participant, in the link's own traversal order. */
function runSegments(item: Participant, gap: TierGap, row: number | undefined): PathSegment[] {
  const owner = { kind: 'link' as const, id: item.link.id };
  const at = (x: number, y: number): Point => ({ x, y });
  // A run reaches the far lane terminal, or the gap's far boundary on the far port's x. Everything
  // inside the gap is then reserved: the piece an earlier batch could otherwise take, and the piece
  // the gates measure against the run's own link.
  const far = item.farOnEdge ? item.far.y : item.nearEdge === 'low' ? gap.high : gap.low;
  const points: Point[] = row === undefined
    ? [item.near, at(item.near.x, far)]
    : [item.near, at(item.near.x, row), at(item.far.x, row), at(item.far.x, far)];
  const ordered = item.nearFirst ? points : [...points].reverse();
  const segments: PathSegment[] = [];
  for (let index = 0; index + 1 < ordered.length; index++) {
    const from = ordered[index]!, to = ordered[index + 1]!;
    if (same(from.x, to.x) && same(from.y, to.y)) continue;
    segments.push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
  }
  return segments;
}

/**
 * Whether an allocated run comes closer to one of its own link's reserved runs than the gates allow.
 * A pair that meets at a corner is one turn of one path and is left out; a pair that runs the same
 * way and never meets is the pair G6 measures, whichever link owns it.
 */
function meetsOwnRun(model: LayoutModel, item: Participant, segments: PathSegment[]): boolean {
  const margin = linkStrokeWidth(item.link) / 2 + routedStroke(model) / 2 + STRAIGHT_PATH_CLEARANCE.path;
  const alongY = (run: { from: Point; to: Point }): boolean => same(run.from.x, run.to.x);
  const meet = (a: { from: Point; to: Point }, b: { from: Point; to: Point }): boolean =>
    [a.from, a.to].some(one => [b.from, b.to].some(other => same(one.x, other.x) && same(one.y, other.y)));
  return reservedRuns(item.link).some(run => {
    const box = grow({ x: Math.min(run.from.x, run.to.x), y: Math.min(run.from.y, run.to.y),
      width: Math.abs(run.to.x - run.from.x), height: Math.abs(run.to.y - run.from.y) }, margin);
    return segments.some(segment => {
      // Two segments that meet at a corner are one turn of one path; two that run the same way and
      // never meet are the pair G6 measures.
      if (alongY(segment) !== alongY(run) || meet(segment, run)) return false;
      const low = { x: Math.min(segment.from.x, segment.to.x), y: Math.min(segment.from.y, segment.to.y) };
      const high = { x: Math.max(segment.from.x, segment.to.x), y: Math.max(segment.from.y, segment.to.y) };
      return high.x > box.x + EPS && low.x < right(box) - EPS && high.y > box.y + EPS && low.y < bottom(box) - EPS;
    });
  });
}

/**
 * Whether a run lies along a group's edge inside the link-free margin that edge keeps (ADR-0013).
 * A link that attaches inside a group crosses its boundary at its own port, so the group is not an
 * obstacle for it; G6 still refuses a segment that *runs along* the edge from on or outside the
 * box. The edge a run crosses is therefore free, and the edge it follows is not.
 */
function alongGroupEdge(model: LayoutModel, run: { from: Point; to: Point }): boolean {
  const margin = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
  const flat = same(run.from.y, run.to.y);
  const low = { x: Math.min(run.from.x, run.to.x), y: Math.min(run.from.y, run.to.y) };
  const high = { x: Math.max(run.from.x, run.to.x), y: Math.max(run.from.y, run.to.y) };
  return Object.values(model.groups).some(group => {
    if (!group.bounds || !group.nodes.length) return false;
    const box = group.bounds;
    if (flat) {
      if (!(high.x > box.x - margin + EPS && low.x < right(box) + margin - EPS)) return false;
      return [box.y, bottom(box)].some(edge => Math.abs(low.y - edge) < margin - EPS);
    }
    if (!(high.y > box.y - margin + EPS && low.y < bottom(box) + margin - EPS)) return false;
    return [box.x, right(box)].some(edge => Math.abs(low.x - edge) < margin - EPS);
  });
}

/** Whether a run meets a corridor its own link owns. Only a collinear vertical run may. */
function meetsOwnLane(model: LayoutModel, link: LayoutLink, run: { from: Point; to: Point }): boolean {
  const low = { x: Math.min(run.from.x, run.to.x), y: Math.min(run.from.y, run.to.y) };
  const high = { x: Math.max(run.from.x, run.to.x), y: Math.max(run.from.y, run.to.y) };
  return model.lanes.some(lane => ownsLane(model, link, lane) && high.x >= lane.bounds.x && low.x <= right(lane.bounds)
    && high.y >= lane.bounds.y && low.y <= bottom(lane.bounds));
}

function ownsLane(model: LayoutModel, link: LayoutLink, lane: LayoutModel['lanes'][number]): boolean {
  const owner = lane.owner;
  if (owner.kind === 'link') return owner.id === link.id;
  return owner.kind === 'bundle' && model.bundles.some(bundle => bundle.id === owner.id && bundle.members.includes(link.id));
}

/** Every run of `link` a rule has already fixed, and that stage 8 must therefore route around. */
function reservedRuns(link: LayoutLink): PathSegment[] {
  return [...(link.path?.fixed === true ? link.path.segments : []), ...(link.fixedSegments ?? []),
    ...(link.sharedRuns?.from ?? []), ...(link.sharedRuns?.to ?? [])];
}

/**
 * Every rectangle an allocated run must stay out of, each expanded by exactly what
 * `routeObstacles` expands it by. Built once for the whole allocation and then filtered per gap.
 */
function blockers(model: LayoutModel): Blocker[] {
  const routed = routedStroke(model), half = routed / 2, result: Blocker[] = [];
  const none: ReadonlySet<string> = new Set(), pillGap = (routed + DEFAULT_STROKE_WIDTHS.pill) / 2;
  for (const node of Object.values(model.nodes)) {
    if (!node.bounds || node.layer === 'overlay') continue;
    // `nodeBox` gives the router the *enclosing* rectangle of the expanded body and every expanded
    // pill, not their union, so it owns the corners between them as well.
    const boxes = [grow(node.bounds, nodeObstacleReach(model, node, routed)),
      ...node.ports.filter(port => port.pill && port.pill.layer !== 'overlay').map(port => grow(port.pill!.bounds, pillGap))];
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    result.push({ bounds: { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y },
      owners: none, node: node.id });
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length) continue;
    result.push({ bounds: grow(group.bounds, GROUP_EDGE_LINK_CLEARANCE + half), owners: new Set(groupConsumers(model, id)) });
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds || label.layer === 'overlay' || label.role !== 'group') continue;
    result.push({ bounds: grow(label.bounds, GROUP_LABEL_LINK_CLEARANCE + half), owners: none });
  }
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay') continue;
    const owner = lane.owner;
    const owners = owner.kind === 'link' ? [owner.id]
      : owner.kind === 'bundle' ? model.bundles.find(bundle => bundle.id === owner.id)?.members ?? [] : [];
    result.push({ bounds: grow(lane.bounds, half), owners: new Set(owners) });
  }
  for (const bundle of model.bundles) {
    if (bundle.layer === 'overlay') continue;
    const owners = new Set(bundle.members);
    for (const part of bundle.envelopeParts ?? (bundle.envelope ? [bundle.envelope] : [])) {
      result.push({ bounds: grow(part, half), owners });
    }
  }
  for (const obstacle of model.obstacles) {
    if (obstacle.layer === 'overlay') continue;
    result.push({ bounds: grow(obstacle.bounds, half), owners: new Set(obstacle.owner.kind === 'link' ? [obstacle.owner.id] : []) });
  }
  for (const link of model.links) {
    if (link.layer === 'overlay') continue;
    const owners = new Set([link.id]);
    const margin = linkStrokeWidth(link) / 2 + half + STRAIGHT_PATH_CLEARANCE.path;
    for (const run of reservedRuns(link)) {
      result.push({ owners, bounds: grow({ x: Math.min(run.from.x, run.to.x), y: Math.min(run.from.y, run.to.y),
        width: Math.abs(run.to.x - run.from.x), height: Math.abs(run.to.y - run.from.y) }, margin) });
    }
    // Every routed attachment holds an outward stem, whether a rule has claimed its path or not.
    // An allocated run may not stand in one: the link that owns it then has no route to its port.
    if (!drawn(link)) continue;
    for (const end of ['from', 'to'] as const) {
      const runs = link.sharedRuns?.[end];
      if (runs?.length) {
        // An end that consumes a shared run leaves that run's terminal instead of a port, and the
        // route beyond it needs the same room. A run standing on the terminal takes it.
        const terminal = runs.at(-1)!.to;
        result.push({ owners, bounds: grow({ x: terminal.x, y: terminal.y, width: 0, height: 0 }, margin) });
        continue;
      }
      const port = findPort(model, link.attachments![end]);
      if (!port?.anchor || port.side === undefined) continue;
      const stem = stemReach(model, model.nodes[link.attachments![end].node]!);
      const tip = { x: port.anchor.x + OUTWARD_X[port.side] * stem, y: port.anchor.y + OUTWARD[port.side] * stem };
      result.push({ owners, bounds: grow({ x: Math.min(port.anchor.x, tip.x), y: Math.min(port.anchor.y, tip.y),
        width: Math.abs(tip.x - port.anchor.x), height: Math.abs(tip.y - port.anchor.y) }, margin) });
    }
  }
  return result;
}

/** The first rectangle in this run's way, or undefined when nothing stands in it. */
function firstBlock(list: readonly Blocker[], link: LayoutLink, line: { from: Point; to: Point },
  attached: ReadonlySet<string>): Blocker | undefined {
  const low = { x: Math.min(line.from.x, line.to.x), y: Math.min(line.from.y, line.to.y) };
  const high = { x: Math.max(line.from.x, line.to.x), y: Math.max(line.from.y, line.to.y) };
  let found: Blocker | undefined;
  for (const item of list) {
    if (item.owners.has(link.id) || (item.node !== undefined && attached.has(item.node))) continue;
    if (!(high.x > item.bounds.x + EPS && low.x < right(item.bounds) - EPS
      && high.y > item.bounds.y + EPS && low.y < bottom(item.bounds) - EPS)) continue;
    if (!found || bottom(item.bounds) < bottom(found.bounds)) found = item;
  }
  return found;
}

/**
 * The allocation of one tier gap, or undefined when the gap declines it and keeps the routed gaps
 * it has today. A gap declines when no run needs a row — there is then nothing to allocate and no
 * diagram changes — when no clean order exists, when a row cannot be seated clear of frozen
 * placement geometry, or when the rows do not fit at their pitch inside the room the gap has.
 *
 * The rows pack from the low boundary: each takes the first row that is clear at or beyond one
 * pitch past the one before it, half a pitch inside each boundary. A lane's own reserved run
 * reaches into the gap beside its corridor, so the first clear row is often not the first one the
 * pitch allows.
 */
function allocateGap(model: LayoutModel, list: readonly Blocker[], gap: TierGap,
  users: GapUsers): Map<Participant, PathSegment[]> {
  const { items, approaches } = users;
  const empty = new Map<Participant, PathSegment[]>();
  const rows = items.filter(needsRow);
  if (!rows.length) return empty;
  const order = rowOrder(rows);
  if (!order) return empty;
  const attachedOf = (item: Participant): Set<string> =>
    new Set([item.link.attachments!.from.node, item.link.attachments!.to.node]);
  // The line beyond a boundary is the port's own approach. It does not move with the row, so it is
  // answered once, and a gap that cannot leave one of them clear allocates nothing: the run it
  // would have to leave out is the one another batch then takes.
  for (const item of items) {
    if (!item.reach) continue;
    const edge = { x: item.far.x, y: item.nearEdge === 'low' ? gap.high : gap.low };
    if (firstBlock(list, item.link, { from: edge, to: item.reach }, attachedOf(item))) return empty;
  }
  const pitch = MEMBER_GAP + routedStroke(model), limit = gap.high - pitch / 2;
  // Two centrelines that run side by side keep the gate's clearance plus the widest routed stroke,
  // the same figure the router nudges a same-batch pair apart by.
  const clearance = GROUP_LABEL_GEOMETRY.nodeClearance + routedStroke(model);
  /**
   * The approaches the gap owes to the runs it leaves out, as rectangles. A run the gap does not
   * seat still leaves its own corridor head-on for one router stem, on the lane's own x, and an
   * allocated run that comes within the gate's clearance of that stem takes it.
   */
  const owed = (absent: ReadonlySet<string>): Blocker[] => approaches.flatMap(item => {
    if (!absent.has(item.link)) return [];
    const stem = GROUP_LABEL_GEOMETRY.routerStem;
    const from = item.edge === 'low' ? gap.low : gap.high, to = item.edge === 'low' ? gap.low + stem : gap.high - stem;
    return [{ owners: new Set([item.link]), bounds: grow({ x: item.x, y: Math.min(from, to), width: 0,
      height: Math.abs(to - from) }, clearance) }];
  });
  const clear = (item: Participant, row: number | undefined, full: readonly Blocker[]): boolean => {
    const segments = runSegments(item, gap, row);
    if (!segments.length) return false;
    // A corridor admits its owner's collinear run alone, so a row that met one of the link's own
    // lanes would enter it sideways. Nothing places a lane inside a gap; this keeps it so.
    if (segments.some(segment => same(segment.from.y, segment.to.y) && meetsOwnLane(model, item.link, segment))) return false;
    // The link's own reserved runs are its exemption only where the allocated run meets them. A run
    // this one merely passes is geometry the gates measure against it like any other.
    return !segments.some(line => firstBlock(full, item.link, line, attachedOf(item)))
      && !segments.some(line => alongGroupEdge(model, line))
      && !meetsOwnRun(model, item, segments);
  };
  const seat = (absent: ReadonlySet<string>): Map<Participant, number> => {
    const full = [...list, ...owed(absent)];
    const at = new Map<Participant, number>();
    let next = gap.low + pitch / 2;
    for (const item of order) {
      const attached = attachedOf(item);
      let row = next, seated = false;
      while (row <= limit + EPS) {
        const blocked = runSegments(item, gap, row).map(line => firstBlock(full, item.link, line, attached))
          .filter((found): found is Blocker => found !== undefined);
        if (!blocked.length) { seated = true; break; }
        const past = Math.max(...blocked.map(found => bottom(found.bounds)));
        if (past <= row + EPS) break;
        row = past;
      }
      // A run the gap cannot seat keeps the route it has today and crosses the rows it did seat.
      if (!seated || row > limit + EPS || !clear(item, row, full)) continue;
      at.set(item, row);
      next = row + pitch;
    }
    return at;
  };
  // A run this pass leaves out owes its approach to the ones it seats, so the pass runs again with
  // that approach in hand. Each round leaves at least one more run out, so it terminates.
  let absent = new Set(approaches.map(owed => owed.link).filter(id => !items.some(item => item.link.id === id)));
  let at = seat(absent);
  for (let round = 0; round < rows.length; round++) {
    const missing = new Set([...absent, ...rows.filter(item => !at.has(item)).map(item => item.link.id)]);
    if (missing.size === absent.size) break;
    absent = missing;
    at = seat(absent);
  }
  if (!at.size) return empty;
  const result = new Map<Participant, PathSegment[]>();
  const settled = [...list, ...owed(absent)];
  for (const item of items) {
    if (needsRow(item) && !at.has(item)) continue;
    if (!clear(item, at.get(item), settled)) continue;
    result.set(item, runSegments(item, gap, at.get(item)));
  }
  return result;
}

/**
 * ADR-0015 rule 1 per tier gap: every run that crosses a tier gap beside a lane, allocated once
 * from frozen placement and keyed by the link and the planned gap it belongs to. Stage 8 stitches
 * each run back unchanged and routes only what is left beyond it.
 */
export function allocateGapRuns(model: LayoutModel): GapRun[] {
  const gaps = tierGaps(model);
  if (!gaps.length) return [];
  const users = gapUsers(model, gaps);
  if (![...users.values()].some(item => item.items.length)) return [];
  const list = blockers(model), result: GapRun[] = [];
  for (const [key, entry] of [...users].sort((a, b) => a[0] - b[0])) {
    const { items, crossers } = entry;
    if (!items.length) continue;
    const gap = gaps[key]!;
    // The lines this gap measures reach past its own boundaries wherever a run ends at a port.
    const reach = items.flatMap(item => item.reach ? [item.reach.y] : []);
    const low = Math.min(gap.low, ...reach), high = Math.max(gap.high, ...reach);
    const near = list.filter(item => item.bounds.y < high - EPS && bottom(item.bounds) > low + EPS);
    const allocated = allocateGap(model, near, gap, entry);
    if (!allocated.size) continue;
    // A run this gap could not seat keeps the route it has today, so it crosses the seated ones.
    for (const item of items) {
      if (allocated.has(item)) continue;
      crossers.push({ link: item.link.id, low: Math.min(item.near.x, item.far.x), high: Math.max(item.near.x, item.far.x) });
    }
    for (const [item, segments] of allocated) {
      result.push({ link: item.link.id, index: item.index, segments,
        crossers: [...new Set(crossers.filter(cross => cross.link !== item.link.id).map(cross => cross.link))].sort() });
    }
  }
  return result;
}
