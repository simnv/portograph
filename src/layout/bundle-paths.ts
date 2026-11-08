import { equal } from '../model/json-equality.js';
import type { Bundle, LayoutModel, LayoutPath, Owner, PathSegment, Point, Rect } from '../model/index.js';
import { clearBundleMembers, routeBundleChannel } from './bundle-channel.js';
import { mergeMembers } from './bundle-merge.js';
import { bundleFans, crossBundleFans } from './bundle-junctions.js';
import { groupBoxes, groupConsumers, junctionChain, junctionFan, mergedRun, sharedStem } from '../score/model.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { EPS, intersection, overlapSegment, samePoint, segmentDistance } from '../geometry/planar.js';
import { MEMBER_GAP, MIN_STEM, clearOfGroupEdges, clone, coordinate, edgeMargin, facing, inversionPairs, members, normal, outward, pitch, type DepthPair, type Member } from './bundle-geometry.js';
import { bundleTurnSpan } from './bundle-need.js';
import { COALESCE_PRODUCT_EPS, PLACEMENT_EPS } from './tolerance.js';
import { PlacementRefusal } from './placement-refusal.js';

export class BundleFeasibilityError extends PlacementRefusal {
  /** The rule that failed (`BUNDLE_CHANNEL_BLOCKED`, ...); `code` is the refusal's family. */
  readonly reason: string;
  readonly bundle: string;
  constructor(reason: string, bundle: string, detail: string) {
    super('bundle', `${reason}: ${bundle}: ${detail}`, { stage: 'bundles', owners: [{ kind: 'bundle', id: bundle }] });
    this.reason = reason; this.bundle = bundle;
  }
}
export function polyline(points: Point[], owner: Owner): PathSegment[] {
  const result: PathSegment[] = [];
  for (const to of points.slice(1)) {
    const from = result.at(-1)?.to ?? points[0]!;
    if (samePoint(from, to)) continue;
    const prior = result.at(-1);
    if (prior && (prior.from.x === prior.to.x && from.x === to.x || prior.from.y === prior.to.y && from.y === to.y)
      && (from.x - prior.from.x) * (to.x - from.x) + (from.y - prior.from.y) * (to.y - from.y) >= 0) prior.to = { ...to };
    else result.push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
  }
  return result;
}
export function reverse(segments: PathSegment[]): PathSegment[] { return [...segments].reverse().map(s => ({ ...clone(s), from: { ...s.to }, to: { ...s.from } })); }
function path(segments: PathSegment[], owner: Owner, width?: Pick<LayoutPath, 'strokeWidth'>): LayoutPath {
  return { owner: { ...owner }, layer: 'routed', fixed: true, ...(width ?? {}), segments };
}
export function pathBounds(segments: PathSegment[], padding = 0): Rect {
  const points = segments.flatMap(s => [s.from, s.to]);
  const x = Math.min(...points.map(p => p.x)) - padding, y = Math.min(...points.map(p => p.y)) - padding;
  return { x, y, width: Math.max(...points.map(p => p.x)) + padding - x, height: Math.max(...points.map(p => p.y)) + padding - y };
}
/**
 * Join a straight run that two producers emitted as two segments back into one. The fan and the
 * channel meet head-on and collinear, and their join is neither a bend nor a terminal — but every
 * crossing test here treats a segment endpoint as one, so a member crossing that run at the join
 * would be discarded by `bundleCrossings` and rejected as bend contact by the pair validator
 * (ticket 44). Strict drawn crossings must not depend on how a straight run was split.
 *
 * Only a genuine continuation merges: the same owner, the same lane, bar and straight annotations,
 * and the same direction. A turn, a U-turn, an ownership boundary or a lane edge all survive.
 */
function coalesce(segments: PathSegment[]): PathSegment[] {
  const compatible = (a: PathSegment, b: PathSegment): boolean => {
    if (!samePoint(a.to, b.from)) return false;
    const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
    if (Math.abs(ax * by - ay * bx) > COALESCE_PRODUCT_EPS || ax * bx + ay * by <= COALESCE_PRODUCT_EPS) return false;
    // Only the bundle's own geometry. Everything else a member's path carries is immutable and is
    // matched verbatim somewhere: a junction's stems are counted one per junction from the root by
    // the tree validator (and ticket 41's continuation is collinear with its stem on purpose), and
    // a lane run, a bar traversal or any other reserved segment must appear in the complete path
    // exactly as it was reserved.
    if (a.owner.kind !== 'bundle' || b.owner.kind !== 'bundle') return false;
    return a.owner.id === b.owner.id && a.lane === undefined && b.lane === undefined
      && a.straight === b.straight && a.barCross === undefined && b.barCross === undefined;
  };
  const result: PathSegment[] = [];
  for (const segment of segments) {
    const last = result.at(-1);
    if (last && compatible(last, segment)) last.to = { ...segment.to };
    else result.push({ ...segment, from: { ...segment.from }, to: { ...segment.to } });
  }
  return result;
}

/** Strict internal member intersections, deduplicated per pair and geometric point. */
export function bundleCrossings(list: Member[]): number {
  const hits = new Set<string>();
  for (let i = 0; i < list.length; i++) for (const other of list.slice(i + 1)) {
    const item = list[i]!;
    for (const a of item.link.path!.segments) for (const b of other.link.path!.segments) {
      const p = intersection(a, b);
      if (p && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, p))) hits.add(JSON.stringify([item.link.id, other.link.id, p]));
    }
  }
  return hits.size;
}
function checkReservations(model: LayoutModel, bundle: Bundle, list: Member[]): void {
  const tiers = [...new Set(model.lanes.filter(l => l.owner.kind === 'link' && bundle.members.includes(l.owner.id)).map(l => l.tier))].sort((a, b) => a - b);
  if (!tiers.length) return;
  const aTier = model.groups[model.document.nodes[bundle.nodes[0]]!.group]!.tier!, bTier = model.groups[model.document.nodes[bundle.nodes[1]]!.group]!.tier!;
  if (aTier > bTier) tiers.reverse();
  for (let i = 0; i < list.length; i++) for (const other of list.slice(i + 1)) {
    const item = list[i]!, sections: number[] = [coordinate(item.a) - coordinate(other.a)];
    for (const tier of tiers) {
      const a = model.lanes.find(l => l.tier === tier && l.owner.kind === 'link' && l.owner.id === item.link.id);
      const b = model.lanes.find(l => l.tier === tier && l.owner.kind === 'link' && l.owner.id === other.link.id);
      if (a && b) sections.push(a.x - b.x);
    }
    sections.push(coordinate(item.b) - coordinate(other.b));
    const signs = sections.map(Math.sign).filter(n => n !== 0), swaps = signs.slice(1).filter((n, i) => n !== signs[i]).length;
    const allowed = sections[0]! * sections.at(-1)! < 0 ? 1 : 0;
    if (swaps > allowed) throw new BundleFeasibilityError('BUNDLE_RESERVATION_ORDER_CONFLICT', bundle.id,
      `Fixed lanes reverse ${item.link.id}/${other.link.id} across endpoint/lane sections ${JSON.stringify(sections)}; lane x and owners are immutable.`);
  }
}
function reservedPath(model: LayoutModel, bundle: Bundle, item: Member, routed: Member): PathSegment[] | undefined {
  const drops = model.barDrops.filter(d => d.link === item.link.id);
  const ownLanes = model.lanes.filter(l => l.owner.kind === 'link' && l.owner.id === item.link.id);
  if (!drops.length && !ownLanes.length) return undefined;
  // A free bar approach is superseded by its shared tree. Rebuild the independent channel
  // between leaves; a point inside the old converged trunk is not a reservation boundary.
  const hasFan = !samePoint(item.a.anchor!, routed.a.anchor!) || !samePoint(item.b.anchor!, routed.b.anchor!);
  if (hasFan && !ownLanes.length && !drops.some(drop => drop.barCross.length) && facing([item])) return undefined;
  let segments: PathSegment[];
  if (drops.length) {
    segments = polyline(item.reversed ? [...drops[0]!.hint!].reverse() : drops[0]!.hint!, bundle.owner);
    const trim = (runs: PathSegment[], port: Member['a'], actual: Member['a']): PathSegment[] => {
      if (samePoint(port.anchor!, actual.anchor!)) return runs;
      const n = normal(port.side!), start = outward(port), depth = (p: Point): number => n.x * p.x + n.y * p.y;
      const near = n.x === 0 ? ownLanes.map(lane => ({ lane, point: { x: lane.x, y: n.y > 0 ? lane.bounds.y : lane.bounds.y + lane.bounds.height } }))
        .filter(item => depth(item.point) > depth(port.anchor!)).sort((a, b) => depth(a.point) - depth(b.point))[0] : undefined;
      const index = near ? runs.findIndex(s => s.from.x === near.lane.x && s.to.x === near.lane.x
        && Math.min(s.from.y, s.to.y) <= near.lane.bounds.y && Math.max(s.from.y, s.to.y) >= near.lane.bounds.y + near.lane.bounds.height)
        : runs.findIndex(s => depth(s.from) <= depth(start) && depth(s.to) >= depth(start)
          && (n.x === 0 ? s.from.x === s.to.x : s.from.y === s.to.y));
      if (index < 0 || near && depth(near.point) < depth(start)) throw new BundleFeasibilityError('BUNDLE_FAN_APPROACH', bundle.id, 'Reserved hint has no outward continuation beyond its shared fan.');
      const run = runs[index]!, join = near?.point ?? (n.x === 0 ? { x: run.from.x, y: start.y } : { x: start.x, y: run.from.y });
      const turn = n.x === 0 ? { x: join.x, y: start.y } : { x: start.x, y: join.y };
      return [...polyline([port.anchor!, start, turn, join], bundle.owner), ...(samePoint(join, run.to) ? [] : [{ ...run, from: join }]), ...runs.slice(index + 1)];
    };
    segments = trim(segments, routed.a, item.a);
    segments = reverse(trim(reverse(segments), routed.b, item.b));
  } else {
    const source = routed.a, target = routed.b;
    const downward = source.anchor!.y < target.anchor!.y;
    ownLanes.sort((a, b) => downward ? a.tier - b.tier : b.tier - a.tier);
    const points = [source.anchor!, outward(source)];
    for (const lane of ownLanes) {
      const from = { x: lane.x, y: downward ? lane.bounds.y - 17.5 : lane.bounds.y + lane.bounds.height + 17.5 };
      const to = { x: lane.x, y: downward ? lane.bounds.y + lane.bounds.height + 17.5 : lane.bounds.y - 17.5 };
      points.push({ x: from.x, y: points.at(-1)!.y }, from, to);
    }
    const end = outward(target);
    points.push({ x: points.at(-1)!.x, y: end.y }, end, target.anchor!);
    segments = polyline(points, bundle.owner);
  }
  // Keep each immutable extent as its own record, even when several transits share one x.
  segments = segments.flatMap(segment => {
    const low = Math.min(segment.from.y, segment.to.y), high = Math.max(segment.from.y, segment.to.y);
    const contained = ownLanes.filter(lane => segment.from.x === lane.x && segment.to.x === lane.x
      && low <= lane.bounds.y + lane.bounds.height && high >= lane.bounds.y).sort((a, b) => a.bounds.y - b.bounds.y);
    if (!contained.length) return [segment];
    const cuts = [...new Set([low, high, ...contained.flatMap(lane => [lane.bounds.y, lane.bounds.y + lane.bounds.height]).filter(y => y > low && y < high),
      ...contained.slice(1).map((lane, i) => (contained[i]!.bounds.y + contained[i]!.bounds.height + lane.bounds.y) / 2).filter(y => y > low && y < high)])].sort((a, b) => a - b);
    const pieces = cuts.slice(1).map((to, i) => {
      const from = cuts[i]!, midpoint = (from + to) / 2;
      const lane = [...contained].sort((a, b) => Math.max(a.bounds.y - midpoint, midpoint - a.bounds.y - a.bounds.height, 0)
        - Math.max(b.bounds.y - midpoint, midpoint - b.bounds.y - b.bounds.height, 0))[0]!;
      return { from: { x: lane.x, y: from }, to: { x: lane.x, y: to }, owner: { ...item.link.owner }, lane: lane.id };
    });
    return segment.from.y < segment.to.y ? pieces : reverse(pieces);
  });
  for (const lane of ownLanes) if (!segments.some(segment => segment.lane === lane.id
    && Math.min(segment.from.y, segment.to.y) === lane.bounds.y && Math.max(segment.from.y, segment.to.y) === lane.bounds.y + lane.bounds.height)) {
    throw new BundleFeasibilityError('BUNDLE_LANE_NOT_CONSUMED', bundle.id, lane.id);
  }
  for (const segment of segments) {
    const crossed = [...new Set(drops.flatMap(d => d.barCross))].filter(id => {
      const box = model.nodes[id]!.bounds!;
      return segment.from.x === segment.to.x && segment.from.x >= box.x && segment.from.x <= box.x + box.width
        && Math.min(segment.from.y, segment.to.y) < box.y + box.height && Math.max(segment.from.y, segment.to.y) > box.y;
    });
    if (crossed.length) segment.barCross = crossed;
  }
  return segments;
}
/** Adjacent swaps have one strict crossing each, with no coincident run or fan exemption. */
function crossedPaths(bundle: Bundle, list: Member[], q: number): Map<string, PathSegment[]> {
  const n = normal(list[0]!.a.side!), horizontal = n.x !== 0;
  const local = (p: Point): Point => ({ x: horizontal ? p.y : p.x, y: horizontal ? n.x * p.x : n.y * p.y });
  const world = (p: Point): Point => horizontal ? { x: n.x * p.y, y: p.x } : { x: p.x, y: n.y * p.y };
  const source = [...list].sort((a, b) => coordinate(a.a) - coordinate(b.a)), target = [...list].sort((a, b) => coordinate(a.b) - coordinate(b.b));
  const x0 = Math.min(...source.map(m => coordinate(m.a)), ...target.map(m => coordinate(m.b))), d = 2 * q;
  const start = Math.max(...source.map(m => local(m.a.anchor!).y)) + 15 + q * (list.length + 1);
  const end = Math.min(...target.map(m => local(m.b.anchor!).y)) - 15 - q * (list.length + 1);
  const count = inversionPairs(list).length;
  if (end - start < count * 4 * q - PLACEMENT_EPS) throw new BundleFeasibilityError('BUNDLE_CROSSOVER_CAPACITY', bundle.id, `Need ${count * 4 * q} px crossover length, have ${end - start}.`);
  const tracks = [...source], points = new Map(source.map((m, i) => [m.link.id, [local(m.a.anchor!), { x: coordinate(m.a), y: start - (i + 1) * q }, { x: x0 + i * d, y: start - (i + 1) * q }, { x: x0 + i * d, y: start }]]));
  let y = start;
  for (let targetIndex = 0; targetIndex < target.length; targetIndex++) {
    let at = tracks.indexOf(target[targetIndex]!);
    while (at > targetIndex) {
      const slot = at - 1, x = x0 + slot * d;
      for (const [i, member] of tracks.entries()) {
        const p = points.get(member.link.id)!;
        if (i === slot) p.push({ x, y: y + q }, { x: x + d + q, y: y + q }, { x: x + d + q, y: y + 3 * q }, { x: x + d, y: y + 3 * q }, { x: x + d, y: y + 4 * q });
        else if (i === at) p.push({ x: x + d, y: y + 2 * q }, { x, y: y + 2 * q }, { x, y: y + 4 * q });
        else p.push({ x: x0 + i * d, y: y + 4 * q });
      }
      [tracks[slot], tracks[at]] = [tracks[at]!, tracks[slot]!]; at--; y += 4 * q;
    }
  }
  for (const [i, member] of tracks.entries()) {
    const target = local(member.b.anchor!), p = points.get(member.link.id)!;
    const fanY = end + (tracks.length - i) * q;
    p.push({ x: x0 + i * d, y: fanY }, { x: target.x, y: fanY }, target);
  }
  return new Map(list.map(m => [m.link.id, polyline(points.get(m.link.id)!.map(world), bundle.owner)]));
}

/** The stem, diagonal and stem of one member between the two stem rows of a straight channel. */
function straightMember(item: Member, start: number, end: number, n: Point, horizontal: boolean): Point[] {
  const world = (track: number, d: number): Point => horizontal ? { x: n.x * d, y: track } : { x: track, y: n.y * d };
  return [item.a.anchor!, world(coordinate(item.a), start), world(coordinate(item.b), end), item.b.anchor!];
}

/**
 * Whether the proposed straight members hold the member gap, judged exactly as G6 judges the drawn
 * paths: every pair of segments of two different members, stems included, except a pair that
 * strictly crosses and except two axis-aligned runs on different axes. Distances are measured
 * between finite segments — the closest points of two non-crossing runs lie at an endpoint of one of
 * them — minus the pair's own strokes. Members tied at a port are left out: their shared stem
 * belongs to the fan stage 7e builds, which G6 exempts. Nothing is moved to make room; a bundle that
 * fails this keeps the orthogonal staircase.
 */
function straightFeasible(list: Member[], start: number, end: number, n: Point, horizontal: boolean): boolean {
  const owner = { kind: 'bundle' as const, id: 'clearance' };
  const paths = list.map(item => ({ item, segments: polyline(straightMember(item, start, end, n, horizontal), owner) }));
  const diagonal = (s: PathSegment): boolean => s.from.x !== s.to.x && s.from.y !== s.to.y;
  for (const [i, one] of paths.entries()) for (const other of paths.slice(i + 1)) {
    if (samePoint(one.item.a.anchor!, other.item.a.anchor!) || samePoint(one.item.b.anchor!, other.item.b.anchor!)) continue;
    const strokes = (linkStrokeWidth(one.item.link) + linkStrokeWidth(other.item.link)) / 2;
    for (const a of one.segments) for (const b of other.segments) {
      const slanted = diagonal(a) || diagonal(b);
      if (!slanted && !(a.from.y === a.to.y && b.from.y === b.to.y || a.from.x === a.to.x && b.from.x === b.to.x)) continue;
      if (slanted) {
        // Only a strict crossing — the interior of both runs — excuses the pair, as in G6.
        const point = intersection(a, b);
        if (point !== undefined && ![a.from, a.to, b.from, b.to].some(corner => samePoint(corner, point))) continue;
      }
      // The same tolerance G6 applies, so a pair this accepts cannot fail the gate it was chosen for.
      if (segmentDistance(a, b) - strokes < MEMBER_GAP - EPS) return false;
    }
  }
  return true;
}

/**
 * Whether a heavily inverted bundle draws straight members (ADR-0017): more inversions than half its
 * members, or — below that threshold — a staircase more than `STRAIGHT_LENGTH_FACTOR` times the
 * straight members' drawn length; and in either case only when the geometry that already exists
 * holds the member gap between every pair of member segments G6 would measure. Nothing is moved to
 * make straight members fit; an infeasible bundle keeps the orthogonal staircase. Only a facing bundle
 * without lanes qualifies, like the staircase. (An authored override is out of scope: `route:
 * straight` is a per-link key and stage 1 excludes such links from bundles.)
 */
export function straightMembers(model: LayoutModel, bundle: Bundle, list: Member[], q: number): boolean {
  const inversions = inversionPairs(list).length;
  if (!inversions || !facing(list) || model.lanes.some(l => l.owner.kind === 'link' && bundle.members.includes(l.owner.id))) return false;
  const n = normal(list[0]!.a.side!), depth = (p: Point): number => n.x * p.x + n.y * p.y;
  const start = Math.max(...list.map(m => depth(m.a.anchor!))) + MIN_STEM;
  const end = Math.min(...list.map(m => depth(m.b.anchor!))) - MIN_STEM;
  // Both stems must exist between the two rows; the clearance test judges the rest.
  if (end - start <= 0) return false;
  if (!straightFeasible(list, start, end, n, n.x !== 0)) return false;
  if (inversions > Math.floor(list.length / 2)) return true;
  // Below the inversion threshold the choice is made on drawn length: both shapes are built (both
  // are pure) and the staircase is rejected when its members are half as long again as the straight
  // ones — the maintainer's "so many crossings … better to use straight lines". A staircase that
  // cannot be built at all leaves straight members as the only shape.
  const total = (paths: Map<string, PathSegment[]>): number =>
    [...paths.values()].reduce((sum, segments) => sum + segments.reduce((run, s) => run + Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y), 0), 0);
  let staircase: number;
  try { staircase = total(crossedPaths(bundle, list, q)); } catch (error) {
    // Only "the staircase does not fit" leaves straight members as the remaining shape; any other
    // failure is a defect and must surface.
    if (!(error instanceof BundleFeasibilityError) || error.reason !== 'BUNDLE_CROSSOVER_CAPACITY') throw error;
    return true;
  }
  return staircase > STRAIGHT_LENGTH_FACTOR * total(straightPaths(bundle, list));
}

/** How much longer the staircase must be than straight members before straight members win. */
const STRAIGHT_LENGTH_FACTOR = 1.5;

/**
 * Straight members: each is stem → one diagonal → stem, on the member's own tracks. The decision
 * above has already checked that these paths hold the member gap.
 */
function straightPaths(bundle: Bundle, list: Member[]): Map<string, PathSegment[]> {
  const n = normal(list[0]!.a.side!), horizontal = n.x !== 0;
  const depth = (p: Point): number => n.x * p.x + n.y * p.y;
  const start = Math.max(...list.map(m => depth(m.a.anchor!))) + MIN_STEM;
  const end = Math.min(...list.map(m => depth(m.b.anchor!))) - MIN_STEM;
  if (end - start <= 0) throw new BundleFeasibilityError('BUNDLE_CROSSOVER_CAPACITY', bundle.id, `Straight members need a positive channel, have ${end - start}.`);
  const result = new Map<string, PathSegment[]>();
  for (const item of list) {
    const segments = polyline(straightMember(item, start, end, n, horizontal), bundle.owner);
    // A member whose two tracks coincide is one plain axis-aligned run; only a true diagonal is flagged.
    for (const segment of segments) {
      if (segment.from.x !== segment.to.x && segment.from.y !== segment.to.y) segment.straight = true;
    }
    result.set(item.link.id, segments);
  }
  return result;
}

/**
 * Whether a segment runs along an edge of a group box (a frame or a plain group) closer than the margin, read as gate G6 `segment-group-edge` reads it: parallel to
 * the edge, overlapping it along its length, on or outside the box (strictly inside a box a link turns in its padding).
 */
function alongFrame(segment: PathSegment, box: Rect, margin: number): boolean {
  const { from, to } = segment;
  const check = (edge: number, low: number, high: number, at: number, a: number, b: number, inner: [number, number]): boolean =>
    !(at > inner[0] + EPS && at < inner[1] - EPS) && Math.abs(at - edge) < margin - EPS && Math.min(a, b) < high - EPS && Math.max(a, b) > low + EPS;
  if (from.y === to.y) return [box.y, box.y + box.height].some(edge => check(edge, box.x, box.x + box.width, from.y, from.x, to.x, [box.y, box.y + box.height]));
  if (from.x === to.x) return [box.x, box.x + box.width].some(edge => check(edge, box.y, box.y + box.height, from.x, from.y, to.y, [box.x, box.x + box.width]));
  return false;
}

/**
 * The depths at which the turn row of `item` would bring its path into a foreign box (architecture-2 ticket 76), as open intervals.
 * A foreign box is one gate G2 holds the member out of (`groupBoxes` that do not consume it) and a node body that is no end of the
 * bundle; each keeps its gate margin. A box over the member's run forbids its own depth band; a box over the leg from the near end
 * also forbids every deeper row, because the leg would reach it; a box over the leg to the far end forbids every shallower row.
 */
function foreignDepths(model: LayoutModel, bundle: Bundle, item: Member, n: Point, margin: number, stroke: number): DepthPair[] {
  const horizontal = n.x !== 0, depth = (p: Point): number => n.x * p.x + n.y * p.y;
  const tangent = (p: Point): number => (horizontal ? p.y : p.x);
  const a = tangent(item.a.anchor!), b = tangent(item.b.anchor!), faceA = depth(item.a.anchor!), faceB = depth(item.b.anchor!);
  const boxes = groupBoxes(model).filter(({ id }) => !groupConsumers(model, id).includes(item.link.id)).map(({ bounds }) => ({ box: bounds, reach: margin }));
  for (const node of Object.values(model.nodes)) {
    // An overlay-layer node is no obstacle to a routed segment (gate G2 skips it too).
    if (bundle.nodes.includes(node.id) || node.layer === 'overlay') continue;
    boxes.push({ box: node.bounds!, reach: 10 + (stroke + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2 });
  }
  const result: DepthPair[] = [];
  for (const { box, reach } of boxes) {
    const t0 = horizontal ? box.y : box.x, t1 = t0 + (horizontal ? box.height : box.width);
    const depths = [depth({ x: box.x, y: box.y }), depth({ x: box.x + box.width, y: box.y + box.height })];
    const d0 = Math.min(...depths) - reach, d1 = Math.max(...depths) + reach;
    const over = (low: number, high: number): boolean => t0 - reach < high - EPS && t1 + reach > low + EPS;
    if (!over(Math.min(a, b), Math.max(a, b))) continue;
    result.push([d0, d1]);
    if (over(a, a) && d1 > faceA + EPS) result.push([d0, Infinity]);
    if (over(b, b) && d0 < faceB - EPS) result.push([-Infinity, d1]);
  }
  return result;
}

/** A row strictly inside one of `blocked` moves `direction`-ward to its edge; bounded, so a chain of intervals cannot loop. */
function clearOfBlocked(value: number, blocked: DepthPair[], direction: 1 | -1): number {
  let result = value;
  for (let guard = 0; guard <= blocked.length; guard++) {
    const hit = blocked.find(([low, high]) => result > low + EPS && result < high - EPS);
    if (!hit) return result;
    result = direction < 0 ? hit[0] : hit[1];
  }
  return result;
}

/** Non-inverted members turn in distinct rows, including when their endpoint pitches differ. */
function parallelPaths(model: LayoutModel, bundle: Bundle, list: Member[], q: number): Map<string, PathSegment[]> {
  const n = normal(list[0]!.a.side!), horizontal = n.x !== 0;
  const depth = (p: Point): number => n.x * p.x + n.y * p.y;
  const start = Math.max(...list.map(item => depth(item.a.anchor!))) + 15;
  const end = Math.min(...list.map(item => depth(item.b.anchor!))) - 15;
  // A frame (a canton frame too) is a group edge (ADR-0013), and so is a plain group's box; a cell is not. The rows are centred in the
  // channel unless that leaves a segment of the bundle along such an edge; then the rows move one edge margin off the edge toward the near
  // end, or else toward the far end, whichever keeps every row and stem clear of every box. Rows that fit no way stay centred and are named.
  // The rows also keep clear of every foreign box (`foreignDepths`): a strategy whose rows stand in one is not taken (ticket 76).
  const stroke = Math.max(...list.map(item => linkStrokeWidth(item.link))), margin = edgeMargin(stroke);
  // The boxes gate G6 holds a segment off the edges of (`groupBoxes`): every frame and every plain group, the bundle's own included.
  const boxes = groupBoxes(model).map(({ bounds }) => ({ box: bounds }));
  const groups = [-1, 1].map(direction => {
    const turning = list.filter(item => Math.sign(coordinate(item.b) - coordinate(item.a)) === direction)
      .sort((a, b) => -direction * (coordinate(a.a) - coordinate(b.a)));
    const span = bundleTurnSpan(turning.length, q);
    if (turning.length && end - start < span - PLACEMENT_EPS) {
      throw new BundleFeasibilityError('BUNDLE_CHANNEL_CAPACITY', bundle.id, `Need ${span} px for distinct member turns, have ${end - start}.`);
    }
    // Only a box that overlaps the row along its length can hold the row; one elsewhere on the canvas cannot.
    const lows = turning.map(item => Math.min(item.a.anchor![horizontal ? 'y' : 'x'], item.b.anchor![horizontal ? 'y' : 'x']));
    const highs = turning.map(item => Math.max(item.a.anchor![horizontal ? 'y' : 'x'], item.b.anchor![horizontal ? 'y' : 'x']));
    const [lo, hi] = [Math.min(...lows), Math.max(...highs)];
    const pairs: DepthPair[] = boxes.filter(({ box }) => horizontal
      ? box.y < hi && box.y + box.height > lo : box.x < hi && box.x + box.width > lo).map(({ box }) => {
      const values = [depth({ x: box.x, y: box.y }), depth({ x: box.x + box.width, y: box.y + box.height })];
      return [Math.min(...values), Math.max(...values)] as DepthPair;
    });
    const blocked = turning.map(item => foreignDepths(model, bundle, item, n, margin, stroke));
    return { turning, first: (start + end - span) / 2, pairs, blocked };
  });
  // A row moves off a group edge and out of a foreign box, in turn, until neither moves it; bounded like each of the two.
  const clearOf = (value: number, pairs: DepthPair[], blocked: DepthPair[], direction: 1 | -1): number => {
    let result = value;
    for (let guard = 0; guard < 8; guard++) {
      const next = clearOfBlocked(clearOfGroupEdges(result, pairs, direction, margin), blocked, direction);
      if (next === result) return result;
      result = next;
    }
    return result;
  };
  const build = (strategy: 'centre' | 'near' | 'far'): { paths: Map<string, PathSegment[]>; fits: boolean } => {
    const paths = new Map<string, PathSegment[]>();
    let fits = true;
    for (const { turning, first, pairs, blocked } of groups) {
      const rows: number[] = [];
      if (strategy === 'near') {
        for (let i = turning.length - 1; i >= 0; i--) rows[i] = clearOf(Math.min(first + i * q, (rows[i + 1] ?? Infinity) - q), pairs, blocked[i]!, -1);
      } else for (let i = 0; i < turning.length; i++) {
        rows[i] = strategy === 'far' ? clearOf(Math.max(first + i * q, (rows[i - 1] ?? -Infinity) + q), pairs, blocked[i]!, 1) : first + i * q;
      }
      if (rows.length && (rows[0]! < start - PLACEMENT_EPS || rows[rows.length - 1]! > end + PLACEMENT_EPS)) fits = false;
      if (rows.some((row, i) => blocked[i]!.some(([low, high]) => row > low + EPS && row < high - EPS))) fits = false;
      for (const [index, item] of turning.entries()) {
        const a = item.a.anchor!, b = item.b.anchor!, row = rows[index]!;
        paths.set(item.link.id, polyline(horizontal
          ? [a, { x: n.x * row, y: a.y }, { x: n.x * row, y: b.y }, b]
          : [a, { x: a.x, y: n.y * row }, { x: b.x, y: n.y * row }, b], bundle.owner));
      }
    }
    return { paths, fits };
  };
  const clear = (paths: Map<string, PathSegment[]>): boolean => ![...paths.values()].flat()
    .some(segment => boxes.some(({ box }) => alongFrame(segment, box, margin)));
  const centred = build('centre');
  if (centred.fits && clear(centred.paths)) return centred.paths;
  for (const strategy of ['near', 'far'] as const) {
    const moved = build(strategy);
    if (moved.fits && clear(moved.paths)) return moved.paths;
  }
  if (!model.diagnostics.some(d => d.code === 'BUNDLE_ROWS_ALONG_FRAME_EDGE' && equal(d.owners, [bundle.owner]))) {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'BUNDLE_ROWS_ALONG_FRAME_EDGE', owners: [bundle.owner],
      message: `The channel of ${bundle.id} has no rows that keep every member clear of every group edge and every foreign box; the rows stay centred, and gates G2 and G6 report what is left.` });
  }
  return centred.paths;
}

/** Replace complete bundle paths and swept reservations from the final coherent geometry. */
export function rebuildBundlePaths(model: LayoutModel): void {
  for (const link of model.links) if (link.bundle) delete link.path;
  model.junctions = [];
  crossBundleFans(model);
  for (const bundle of model.bundles) {
    const list = members(model, bundle), q = pitch(model, bundle), inversions = inversionPairs(list).length;
    checkReservations(model, bundle, list);
    bundle.memberGap = 16; bundle.memberPitch = q; bundle.inversions = inversions;
    delete bundle.mergeRuns;
    const fans = bundleFans(model, bundle, list, q), channel = fans?.members ?? list;
    const straight = straightMembers(model, bundle, channel, q);
    const crossing = inversions && facing(list) && !model.lanes.some(l => l.owner.kind === 'link' && bundle.members.includes(l.owner.id))
      ? straight ? straightPaths(bundle, channel) : crossedPaths(bundle, channel, q) : undefined;
    const parallel = !inversions && facing(list) ? parallelPaths(model, bundle, channel, q) : undefined;
    for (const item of list) {
      const routed = channel.find(m => m.link.id === item.link.id)!;
      const reserved = reservedPath(model, bundle, item, routed);
      let segments = reserved ?? crossing?.get(item.link.id) ?? parallel?.get(item.link.id);
      if (!segments && !reserved) {
        const a = routed.a.anchor!, b = routed.b.anchor!;
        if (facing(list) && (a.x === b.x || a.y === b.y)) segments = polyline([a, b], bundle.owner);
        else {
          const start = outward(channel.find(m => m.link.id === item.link.id)!.a), end = outward(channel.find(m => m.link.id === item.link.id)!.b);
          const horizontal = normal(item.a.side!).x !== 0;
          const middle = horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2;
          segments = polyline(horizontal ? [a, start, { x: middle, y: start.y }, { x: middle, y: end.y }, end, b]
            : [a, start, { x: start.x, y: middle }, { x: end.x, y: middle }, end, b], bundle.owner);
        }
      }
      if (fans && segments) segments = coalesce([...fans.a.get(item.link.id)!, ...segments, ...reverse(fans.b.get(item.link.id)!)]);
      item.link.path = path(item.reversed ? reverse(segments!) : segments!, item.link.owner, pathStrokeWidth(item.link));
    }
    let routedCentreline: PathSegment[] | undefined;
    if (!inversions && !fans && !model.barDrops.some(d => bundle.members.includes(d.link))
      && !model.lanes.some(l => l.owner.kind === 'link' && bundle.members.includes(l.owner.id))
      && !clearBundleMembers(model, bundle, list.map(m => m.link.path!.segments), Math.max(...list.map(item => linkStrokeWidth(item.link))))) {
      const routed = routeBundleChannel(model, bundle, list);
      if (!routed) throw new BundleFeasibilityError('BUNDLE_CHANNEL_ORIENTATION', bundle.id, 'Endpoint tracks cannot be transported through one clear channel.');
      routedCentreline = routed.centreline;
      for (const item of list) item.link.path!.segments = item.reversed ? reverse(routed.paths.get(item.link.id)!) : routed.paths.get(item.link.id)!;
    }
    const merged = mergeMembers(model, bundle, list, q);
    if (merged) bundle.mergeRuns = merged;
    const all = list.flatMap(m => m.link.path!.segments);
    const widest = Math.max(...list.map(item => linkStrokeWidth(item.link)));
    bundle.envelope = pathBounds(all, widest / 2);
    bundle.rows = { ...bundle.envelope };
    const meanTrack = list.reduce((sum, item) => sum + coordinate(item.a), 0) / list.length;
    const channelHalfWidth = Math.max(...list.map(item => Math.abs(coordinate(item.a) - meanTrack))) + widest / 2;
    bundle.envelopeParts = routedCentreline ? routedCentreline.map(s => pathBounds([s], channelHalfWidth)) : [bundle.envelope];
    // A straight channel has an exact midline between its outer tracks. Curved channels retain the middle member traversal.
    const centre = (end: 'a' | 'b', dimension: 'x' | 'y'): number => (Math.min(...list.map(m => m[end].anchor![dimension])) + Math.max(...list.map(m => m[end].anchor![dimension]))) / 2;
    const middle = list[Math.floor(list.length / 2)]!;
    bundle.centreline = all.length === list.length ? path(polyline([
      { x: centre('a', 'x'), y: centre('a', 'y') },
      { x: centre('b', 'x'), y: centre('b', 'y') },
    ], bundle.owner), bundle.owner) : path(middle.reversed ? reverse(middle.link.path!.segments) : clone(middle.link.path!.segments), bundle.owner);
    if (routedCentreline) bundle.centreline = path(routedCentreline, bundle.owner);
    if (!bundle.mergeRuns?.length && bundleCrossings(list) !== inversions) throw new BundleFeasibilityError('BUNDLE_CROSSING_MISMATCH', bundle.id,
      `Endpoint inversions ${inversions}; strict drawn crossings ${bundleCrossings(list)}.`);

  }
  for (const junction of model.junctions) if (!junctionChain(model, junction)) throw new BundleFeasibilityError('BUNDLE_JUNCTION_TRAVERSAL', junction.id, 'Shared-run membership does not match exact root-to-leaf traversal.');
  for (const bundle of model.bundles) {
    const list = members(model, bundle);
    const expectedPairs = new Set(inversionPairs(list).map(pair => JSON.stringify([...pair].sort())));
    const actualPairs = new Map<string, Set<string>>();
    for (let i = 0; i < list.length; i++) for (const other of list.slice(i + 1)) for (const [ai, a] of list[i]!.link.path!.segments.entries()) for (const [bi, b] of other.link.path!.segments.entries()) {
      const point = intersection(a, b), left = { segment: a, index: ai, link: list[i]!.link, stroke: 1.5 }, right = { segment: b, index: bi, link: other.link, stroke: 1.5 };
      if (point) {
        const endpoint = [list[i]!.a, list[i]!.b].some(p => [other.a, other.b].some(q => p === q && samePoint(p.anchor!, point)));
        const extent = { from: point, to: point, owner: bundle.owner };
        const mergeVertex = bundle.mergeRuns?.some(run => run.path.segments.some(s => [s.from, s.to].some(p => samePoint(p, point)) && mergedRun(model, left, right, s)));
        if (!endpoint && !mergeVertex && !junctionFan(model, left, right) && !mergedRun(model, left, right, extent)) {
          if ([a.from, a.to, b.from, b.to].some(p => samePoint(p, point))) throw new BundleFeasibilityError('BUNDLE_BEND_CONTACT', bundle.id, `${list[i]!.link.id}/${other.link.id} touch at a bend instead of a strict crossover.`);
          const key = JSON.stringify([list[i]!.link.id, other.link.id].sort()), points = actualPairs.get(key) ?? new Set<string>();
          points.add(JSON.stringify(point)); actualPairs.set(key, points);
        }
      }

      const overlap = overlapSegment(a, b);
      if (overlap && !mergedRun(model, { segment: a, index: ai, link: list[i]!.link, stroke: 1.5 }, { segment: b, index: bi, link: other.link, stroke: 1.5 }, overlap) && !sharedStem(model, { segment: a, index: ai, link: list[i]!.link, stroke: 1.5 }, { segment: b, index: bi, link: other.link, stroke: 1.5 }, overlap)) throw new BundleFeasibilityError('BUNDLE_UNDECLARED_OVERLAP', bundle.id, 'Parallel members need distinct runs or explicit shared geometry.');
    }
    if (!bundle.mergeRuns?.length && (actualPairs.size !== expectedPairs.size || [...actualPairs].some(([key, points]) => !expectedPairs.has(key) || points.size !== 1))) {
      throw new BundleFeasibilityError('BUNDLE_CROSSING_PAIRS', bundle.id, 'Actual crossed member pairs do not equal the strict endpoint inversions.');
    }
  }
}
