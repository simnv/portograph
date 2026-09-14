import type { Bundle, LayoutModel, LayoutPath, Owner, PathSegment, Point, Rect } from '../model/index.js';
import { clearBundleMembers, routeBundleChannel } from './bundle-channel.js';
import { mergeMembers } from './bundle-merge.js';
import { bundleFans, crossBundleFans } from './bundle-junctions.js';
import { junctionChain, junctionFan, mergedRun, sharedStem } from '../score/model.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { EPS, intersection, overlapSegment, samePoint, segmentDistance } from '../score/geometry.js';
import { MEMBER_GAP, MIN_STEM, clone, coordinate, facing, inversionPairs, members, normal, outward, pitch, type Member } from './bundle-geometry.js';

export class BundleFeasibilityError extends Error {
  readonly code: string;
  readonly bundle: string;
  constructor(code: string, bundle: string, detail: string) { super(`${code}: ${bundle}: ${detail}`); this.code = code; this.bundle = bundle; }
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
    if (Math.abs(ax * by - ay * bx) > 1e-9 || ax * bx + ay * by <= 1e-9) return false;
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
  if (end - start < count * 4 * q - 1e-6) throw new BundleFeasibilityError('BUNDLE_CROSSOVER_CAPACITY', bundle.id, `Need ${count * 4 * q} px crossover length, have ${end - start}.`);
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
    if (!(error instanceof BundleFeasibilityError) || error.code !== 'BUNDLE_CROSSOVER_CAPACITY') throw error;
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

/** Non-inverted members turn in distinct rows, including when their endpoint pitches differ. */
function parallelPaths(bundle: Bundle, list: Member[], q: number): Map<string, PathSegment[]> {
  const n = normal(list[0]!.a.side!), horizontal = n.x !== 0;
  const depth = (p: Point): number => n.x * p.x + n.y * p.y;
  const start = Math.max(...list.map(item => depth(item.a.anchor!))) + 15;
  const end = Math.min(...list.map(item => depth(item.b.anchor!))) - 15;
  const result = new Map<string, PathSegment[]>();
  for (const direction of [-1, 1]) {
    const turning = list.filter(item => Math.sign(coordinate(item.b) - coordinate(item.a)) === direction)
      .sort((a, b) => -direction * (coordinate(a.a) - coordinate(b.a)));
    const span = (turning.length - 1) * q;
    if (turning.length && end - start < span - 1e-6) {
      throw new BundleFeasibilityError('BUNDLE_CHANNEL_CAPACITY', bundle.id, `Need ${span} px for distinct member turns, have ${end - start}.`);
    }
    for (const [index, item] of turning.entries()) {
      const a = item.a.anchor!, b = item.b.anchor!, row = (start + end - span) / 2 + index * q;
      result.set(item.link.id, polyline(horizontal
        ? [a, { x: n.x * row, y: a.y }, { x: n.x * row, y: b.y }, b]
        : [a, { x: a.x, y: n.y * row }, { x: b.x, y: n.y * row }, b], bundle.owner));
    }
  }
  return result;
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
    const parallel = !inversions && facing(list) ? parallelPaths(bundle, channel, q) : undefined;
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
