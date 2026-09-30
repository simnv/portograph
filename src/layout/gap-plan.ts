import type { Point, Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { bottom, EPS, right } from '../score/geometry.js';
import { measureText } from '../text/index.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { cantonTiers, GROUP_LABEL_GEOMETRY, nodeObstacleReach, nudgingDistance, routedStroke } from './bands.js';
import { drawn, edgeOf, nestedTips, stopsOf, tierGaps, type NestedTip, type TierGap } from './gap-runs.js';
import { LINK_LABEL_GEOMETRY } from './link-labels.js';
import { findPort } from './row-paths.js';
import { bandGap } from './skeleton-graph.js';
import { stemCache, stemPlan, type StemCache } from './sides-two.js';

/**
 * The tier-gap row plan (`docs/design/tier-gap-rows.md`, ranked-groups ticket 48): the rows, legs and
 * drops of every **part** of one tier gap, and the height the gap needs, computed from frozen
 * placement. Nothing calls it yet; it reads the model and writes nothing.
 *
 * `planGap` is the pure core. It takes the parts of one gap as plain numbers (an **end** is a tip or a
 * mouth) and the frame they stand in, and returns the order, the rows, the crossings and `H`.
 * `tierGapPlan` reads a placed model into that shape, with the model reads `gap-runs.ts` already has.
 *
 * Vocabulary is the spec's: **part**, **drop**, **stepped part**, **Z part** with its **middle drop**,
 * **row**, **need**, **lb**, **H**. A Z part is planned as two halves, `<id>a` and `<id>b`, each with
 * one row; every other stepped part has one.
 */

/** One end of a part: a port's stem tip, or a lane's mouth (one router stem inside the gap boundary). */
export interface PlanEnd {
  x: number;
  y: number;
  kind: 'tip' | 'mouth';
  /** The port or the lane the end belongs to. Two ends of one source share their leg; two others may not stand within `keep`. */
  source: string;
}

/** A part as the plan takes it: `upper` is the end nearer the low boundary. */
export interface PlanInput {
  id: string;
  link: string;
  /** Model order of the link, then of the planned gap; breaks every tie. */
  order: number;
  /** The planned gap of the link (the index `stopsOf` pairs), and whether the link visits the upper end first: stage 8 reads them back. */
  index?: number;
  upperFirst?: boolean;
  upper: PlanEnd;
  lower: PlanEnd;
  /** Room a described part keeps below its row before the next row: `label height + 2 × 4 + stroke`. */
  labelRoom?: number;
}

/** An obstacle, as a y band over an x range (O5). It is anchored to one band, never to a bounding box. */
export interface PlanObstacle {
  x0: number;
  x1: number;
  /**
   * `above`: anchored to the band above; `bound` is the y a row must reach (a lower bound).
   * `below`: anchored to the band below; `bound` is the distance from `bandTop` the row must keep (a need).
   */
  anchor: 'above' | 'below';
  bound: number;
  /** A link the obstacle does not stop: its own lane. */
  owner?: string;
}

export type ResidualReason = 'spans-two-gaps' | 'lateral-port' | 'u-turn' | 'faces-away' | 'off-boundary' | 'crosses-lane'
  | 'row-cycle' | 'leg-blocked' | 'crosses-shared-run';

/** A part the plan declines, with the reason (`TIER_GAP_PART_RESIDUAL`; `row-cycle` is `TIER_GAP_ROW_CYCLE`). */
export interface ResidualPart {
  id: string;
  link: string;
  order: number;
  reason: ResidualReason;
  /** The ends, where the part has two tips facing the gap; they feed the residual term of `H` and the tips others avoid. */
  upper?: PlanEnd;
  lower?: PlanEnd;
  /** The x-range the residual link spans in the gap: a planned vertical within `keep` of it is granted to the link (2.2, S5). */
  span?: { x0: number; x1: number };
}

/** What the plan stands in. */
export interface PlanFrame {
  /** The low boundary of the gap, and the top of the band below (the depth of a lower end is measured from it). */
  low: number;
  bandTop: number;
  /** The least height: the band gap, less what a lane overhang takes of it. */
  floor: number;
  /** Run clearance `k`, row pitch `P`, group-edge margin `e`. */
  keep: number;
  pitch: number;
  edge: number;
  /** Upper tips and lower tips of ports that belong to no part of this gap (a residual link, a bundle port). */
  tips: readonly { x: number; y: number }[];
  lowerTips: readonly { x: number; y: number }[];
  obstacles: readonly PlanObstacle[];
  /**
   * Fixed obstacles a leg may not pass through (a group label, a foreign lane box, a bundle envelope, a placed obstacle), with the
   * same anchoring as `obstacles` but whatever the sign of the bound. A group edge is not among them: a leg crosses it at its port.
   */
  blocks?: readonly PlanObstacle[];
  residual: readonly ResidualPart[];
  /**
   * The x of every riser vertical that crosses the gap (mesh-bus.md, section 11.5): a mesh bus riser is no part and asks for no height, a planned
   * row crosses it (one accepted crossing), and a Z part's middle drop keeps `keep` from it.
   */
  verticals?: readonly number[];
}

export type PartShape = 'drop' | 'stepped' | 'z';

export interface PlannedPart {
  id: string;
  link: string;
  order: number;
  shape: PartShape;
  index?: number;
  upperFirst?: boolean;
  upper: PlanEnd;
  lower: PlanEnd;
  /** `bandTop − lower.y`. */
  depth: number;
  /** One y per row: none for a drop, one for a stepped part, two for a Z part. */
  rows: number[];
  /** The x of a Z part's middle drop. */
  middle?: number;
  /** The y of a drop's jog, where its ends differ, and the end whose x its long vertical stands on. */
  jog?: number;
  stand?: 'upper' | 'lower';
}

export interface PlanEdge {
  above: string;
  below: string;
  /** O1 same way, O2 shared vertical, `Z` the first half above the second, `ZX` a part the whole Z interleaves. */
  kind: 'O1' | 'O2' | 'Z' | 'ZX';
}

export interface PlanCrossing {
  /** The unit whose run crosses, and the part whose vertical is crossed. */
  run: string;
  vertical: string;
  kind: 'upper-leg' | 'lower-leg' | 'middle-drop' | 'drop';
  at: Point;
}

export interface GapPlan {
  low: number;
  bandTop: number;
  parts: PlannedPart[];
  residual: ResidualPart[];
  /** Parts planned with a leg within `keep` of another node's leg: the gate reports them (spec 2.2 prefers that to a removed link). */
  crowded: { id: string; link: string; with: string }[];
  edges: PlanEdge[];
  /** The units that take a row, in the topological order they were packed. */
  order: string[];
  crossings: PlanCrossing[];
  /** `H`: the gap's height from `low`, never under the floor. */
  height: number;
  /** The largest term of `H` without the floor: what the parts alone ask for. */
  demand: number;
  /** `max(0, H − (bandTop − low))`. */
  growth: number;
  /** The unit, drop or term that set `H`. */
  setBy: string;
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;

/** One planned whole part, with the numbers the rules read. */
interface Part extends PlanInput {
  drop: boolean;
  jogged: boolean;
  /** Which end's x the vertical of a jogged drop stands on: the upper by default, the lower where that is the one that keeps `keep` from every foreign leg. */
  stand: 'upper' | 'lower';
  depth: number;
  after: number;
}

/** A whole stepped part, or one half of a Z part. */
interface Unit {
  id: string;
  part: Part;
  half: 0 | 1 | 2;
  xu: number;
  xl: number;
  lo: number;
  hi: number;
}

interface Solved {
  parts: Part[];
  units: Unit[];
  edges: PlanEdge[];
  split: Map<string, number>;
}

const interleave = (a: { xu: number; xl: number }, b: { xu: number; xl: number }): boolean => {
  const upper = a.xu - b.xu, lower = a.xl - b.xl;
  return (upper > EPS && lower < -EPS) || (upper < -EPS && lower > EPS);
};
const overlaps = (a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean =>
  Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo) + EPS;
const inside = (x: number, unit: { lo: number; hi: number }): boolean => x > unit.lo + EPS && x < unit.hi - EPS;

function unitsOf(parts: readonly Part[], split: ReadonlyMap<string, number>): Unit[] {
  const result: Unit[] = [];
  for (const part of parts) {
    if (part.drop) continue;
    const make = (id: string, half: 0 | 1 | 2, xu: number, xl: number): Unit =>
      ({ id, part, half, xu, xl, lo: Math.min(xu, xl), hi: Math.max(xu, xl) });
    const middle = split.get(part.id);
    if (middle === undefined) result.push(make(part.id, 0, part.upper.x, part.lower.x));
    else result.push(make(`${part.id}a`, 1, part.upper.x, middle), make(`${part.id}b`, 2, middle, part.lower.x));
  }
  return result;
}

/** O2 between whole stepped parts. Each entry names its two parts; the halves of a Z part take the upper edge on the first, the lower on the second (2.2). */
interface BaseEdge { above: Part; below: Part; kind: 'O2' }

function baseEdges(parts: readonly Part[], keep: number): BaseEdge[] {
  const stepped = parts.filter(part => !part.drop);
  const result: BaseEdge[] = [];
  // O2. The upper end of `above` stands within `keep` of the lower end of `below`: the leg from the low boundary turns first.
  for (const p of stepped) for (const q of stepped) if (q !== p && Math.abs(p.upper.x - q.lower.x) < keep - EPS) result.push({ above: p, below: q, kind: 'O2' });
  return result;
}

/**
 * The unit-level edges. O1 is read from each unit's own span by the arithmetic of 2.1, so a half of a Z part is ordered against a
 * part only where their spans overlap, run the same way and do not interleave (two spans that do not overlap cannot cross, in any
 * order); a part the whole Z interleaves is left to the ZX edge. O2 is carried by end: the upper edge on the first half, the lower one
 * on the second.
 */
function expand(base: readonly BaseEdge[], split: ReadonlyMap<string, number>, units: readonly Unit[]): PlanEdge[] {
  const named = (part: Part, which: 'upper' | 'lower'): string => split.has(part.id) ? `${part.id}${which === 'upper' ? 'a' : 'b'}` : part.id;
  const result: PlanEdge[] = [], seen = new Set<string>();
  const add = (above: string, below: string, kind: PlanEdge['kind']): void => {
    const key = `${above}>${below}`;
    if (above === below || seen.has(key)) return;
    seen.add(key);
    result.push({ above, below, kind });
  };
  const whole = (part: Part): { xu: number; xl: number } => ({ xu: part.upper.x, xl: part.lower.x });
  for (const [index, a] of units.entries()) {
    for (const b of units.slice(index + 1)) {
      if (a.part === b.part) continue;
      if ((split.has(a.part.id) || split.has(b.part.id)) && interleave(whole(a.part), whole(b.part))) continue;
      const way = Math.sign(a.xl - a.xu);
      if (way !== Math.sign(b.xl - b.xu) || interleave(a, b) || !overlaps(a, b)) continue;
      // O1. Of two rightward units the one further right at the upper end is above (ties: the lower end); leftward mirrors it.
      const upper = (a.xu - b.xu) * way, lower = (a.xl - b.xl) * way;
      const first = upper > EPS ? true : upper < -EPS ? false : lower > EPS ? true : lower < -EPS ? false : a.part.order * 4 + a.half < b.part.order * 4 + b.half;
      if (first) add(a.id, b.id, 'O1'); else add(b.id, a.id, 'O1');
    }
  }
  for (const edge of base) add(named(edge.above, 'upper'), named(edge.below, 'lower'), 'O2');
  for (const id of split.keys()) add(`${id}a`, `${id}b`, 'Z');
  return result;
}

/** A cycle of the edges, as unit ids, or undefined when the graph is acyclic. */
function findCycle(ids: readonly string[], edges: readonly PlanEdge[]): string[] | undefined {
  const next = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const edge of edges) next.get(edge.above)?.push(edge.below);
  const state = new Map<string, 1 | 2>(), stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const other of next.get(id) ?? []) {
      if (state.get(other) === 1) return stack.slice(stack.indexOf(other));
      if (!state.has(other)) {
        const found = visit(other);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/** Whether `to` follows from `from` along the edges. */
function reaches(edges: readonly PlanEdge[], from: string, to: string): boolean {
  const seen = new Set<string>([from]), todo = [from];
  while (todo.length) {
    const id = todo.pop()!;
    for (const edge of edges) {
      if (edge.above !== id || seen.has(edge.below)) continue;
      if (edge.below === to) return true;
      seen.add(edge.below);
      todo.push(edge.below);
    }
  }
  return false;
}

/**
 * The x a Z part's middle drop may take (2.2 O6): the centre of every interval between the part's ends that stands `keep` clear of
 * every other leg and drop, widest first (the first of equally wide ones first). `solve` takes the first that breaks the cycle.
 */
function middleDrops(part: Part, parts: readonly Part[], split: ReadonlyMap<string, number>, keep: number, verticals: readonly number[] = []): number[] {
  const centres = [part.upper.x, part.lower.x, ...verticals];
  for (const other of parts) {
    if (other === part) continue;
    centres.push(other.upper.x, other.lower.x);
    const middle = split.get(other.id);
    if (middle !== undefined) centres.push(middle);
  }
  const lo = Math.min(part.upper.x, part.lower.x), hi = Math.max(part.upper.x, part.lower.x);
  const forbidden = centres.map(x => [x - keep, x + keep] as const).sort((a, b) => a[0] - b[0]);
  const found: { from: number; to: number }[] = [];
  let cursor = lo;
  const take = (from: number, to: number): void => { if (to >= from - EPS) found.push({ from, to }); };
  for (const [from, to] of forbidden) {
    if (to <= cursor) continue;
    if (from > hi) break;
    take(cursor, Math.min(from, hi));
    cursor = Math.max(cursor, to);
  }
  if (cursor <= hi) take(cursor, hi);
  return found.map((item, index) => ({ item, index })).sort((a, b) => (b.item.to - b.item.from) - (a.item.to - a.item.from) || a.index - b.index)
    .map(({ item }) => (item.from + item.to) / 2);
}

/** Whether the edges close a cycle through `id`. */
function inCycle(edges: readonly PlanEdge[], id: string): boolean {
  const seen = new Set<string>(), todo = [id];
  while (todo.length) {
    const at = todo.pop()!;
    for (const edge of edges) {
      if (edge.above !== at) continue;
      if (edge.below === id) return true;
      if (!seen.has(edge.below)) { seen.add(edge.below); todo.push(edge.below); }
    }
  }
  return false;
}

/** Splits cycles into Z parts (O6) and orders the parts a whole Z interleaves; returns the part to make residual otherwise. */
function solve(parts: readonly Part[], frame: PlanFrame): Solved | { reject: Part } {
  const keep = frame.keep, base = baseEdges(parts, keep), split = new Map<string, number>();
  for (;;) {
    const units = unitsOf(parts, split), edges = expand(base, split, units);
    const cycle = findCycle(units.map(unit => unit.id), edges);
    if (!cycle) break;
    const onCycle = units.filter(unit => cycle.includes(unit.id)).map(unit => unit.part);
    const latest = (list: readonly Part[]): Part => list.reduce((a, b) => (b.order > a.order ? b : a));
    const unsplit = onCycle.filter(part => !split.has(part.id));
    // Where the cycle is among halves only, its latest part is residual (`TIER_GAP_ROW_CYCLE`).
    if (!unsplit.length) return { reject: latest(onCycle) };
    const pick = latest(unsplit);
    // The widest clear interval that leaves the halves on no cycle; residual only where none does.
    const middle = middleDrops(pick, parts, split, keep, frame.verticals).find(candidate => {
      const trial = new Map(split).set(pick.id, candidate), after = expand(base, trial, unitsOf(parts, trial));
      return !inCycle(after, `${pick.id}a`) && !inCycle(after, `${pick.id}b`);
    });
    if (middle === undefined) return { reject: pick };
    split.set(pick.id, middle);
  }
  // A part the whole Z interleaves is not left free: between the halves it can cross the Z three times. It goes above
  // the first half where that keeps the graph acyclic, else below the second half, else it is residual.
  const units = unitsOf(parts, split);
  let edges = expand(base, split, units);
  for (const id of split.keys()) {
    const whole = parts.find(part => part.id === id)!;
    const zed = { xu: whole.upper.x, xl: whole.lower.x };
    for (const other of parts) {
      if (other.drop || other === whole || split.has(other.id)) continue;
      if (!interleave(zed, { xu: other.upper.x, xl: other.lower.x })) continue;
      const first = `${id}a`, second = `${id}b`;
      if (reaches(edges, first, other.id) && reaches(edges, other.id, second)) continue;
      if (!reaches(edges, first, other.id)) edges = [...edges, { above: other.id, below: first, kind: 'ZX' }];
      else if (!reaches(edges, other.id, second)) edges = [...edges, { above: second, below: other.id, kind: 'ZX' }];
      else return { reject: other };
    }
  }
  return { parts: [...parts], units, edges, split };
}

/**
 * The plan of one tier gap.
 *
 * The rows come from a topological order of O1 ∪ O2 ∪ Z (2.3): among the ready units the largest static need
 * first, then the smaller lb, then model order, each on the highest row it may take, packed from `low`. `H` is
 * computed afterwards from the crossings the packed order really has (Section 3).
 */
export function planGap(inputs: readonly PlanInput[], frame: PlanFrame): GapPlan {
  const { keep, pitch, edge: margin, low, bandTop } = frame;
  const residual: ResidualPart[] = [...frame.residual];
  const asPart = (input: PlanInput): Part => {
    const drop = Math.abs(input.lower.x - input.upper.x) < keep - EPS;
    const jogged = drop && !same(input.lower.x, input.upper.x);
    return { ...input, drop, jogged, stand: jogged && upperStandBlocked(input) ? 'lower' : 'upper', depth: frame.bandTop - input.lower.y,
      after: Math.max(pitch, input.labelRoom ?? 0) };
  };
  // The long vertical of a jogged drop that stands on its upper x runs down to one clearance above the lower tip, so an obstacle anchored to the
  // band below (a group title, a lane box) that stands over that x stops it: the drop then stands on its lower x (whose leg `blocked` reads).
  const upperStandBlocked = (input: PlanInput): boolean => (frame.blocks ?? []).some(block => block.owner !== input.link && block.anchor === 'below'
    && input.upper.x > block.x0 + EPS && input.upper.x < block.x1 - EPS && frame.bandTop - (input.lower.y - keep) < block.bound - EPS);
  // A leg through a fixed obstacle (2.2, residual by constraint): an upper leg reaches down from its tip past the bottom of an
  // obstacle anchored to the band above, a lower leg up from its tip past the top of one anchored to the band below.
  const blocked = (input: PlanInput): boolean => (frame.blocks ?? []).some(block => {
    if (block.owner === input.link) return false;
    if (block.anchor === 'above') return input.upper.x > block.x0 + EPS && input.upper.x < block.x1 - EPS && input.upper.y < block.bound - EPS;
    return input.lower.x > block.x0 + EPS && input.lower.x < block.x1 - EPS && bandTop - input.lower.y < block.bound - EPS;
  });
  const unblocked = inputs.filter(input => {
    if (!blocked(input)) return true;
    residual.push({ id: input.id, link: input.link, order: input.order, reason: 'leg-blocked', upper: input.upper, lower: input.lower });
    return false;
  });
  // Two upper legs, or two lower legs, of two sources within `keep` (2.2; the spec prefers a published finding to a removed link): the part is
  // planned all the same and the clash is named in `crowded`, for the gate to report. A drop first tries the other end's x for its vertical.
  let live: Part[] = [];
  const crowded: { id: string; link: string; with: string }[] = [];
  // A jogged drop has a long vertical on its `stand` end and a short stub on the other, so each end's x is a leg of both kinds.
  const legsOf = (item: Part, end: 'upper' | 'lower'): PlanEnd[] => item.drop && item.jogged
    ? [item[end], item.stand === 'upper' ? item.upper : item.lower] : item.drop ? [item.upper, item.lower] : [item[end]];
  const near = (a: PlanEnd, b: PlanEnd): boolean => a.source !== b.source && Math.abs(a.x - b.x) < keep - EPS;
  const anyNear = (a: readonly PlanEnd[], b: readonly PlanEnd[]): boolean => a.some(one => b.some(other => near(one, other)));
  for (const input of [...unblocked].sort((a, b) => a.order - b.order)) {
    let part = asPart(input);
    const clashing = (item: Part): Part | undefined => live.find(other => anyNear(legsOf(other, 'upper'), legsOf(item, 'upper'))
      || anyNear(legsOf(other, 'lower'), legsOf(item, 'lower')));
    let clash = clashing(part);
    if (clash && part.jogged) {
      const other: Part = { ...part, stand: 'lower' };
      if (!clashing(other)) { part = other; clash = undefined; }
    }
    if (clash) crowded.push({ id: part.id, link: part.link, with: clash.link });
    live.push(part);
  }
  // A jogged drop that another part's leg crowds may still stand on its other end's x, whichever of the two came first.
  for (const [index, drop] of live.entries()) {
    if (!drop.jogged || !crowded.some(item => item.id === drop.id || item.with === drop.link)) continue;
    if (drop.stand === 'lower' && upperStandBlocked(drop)) continue;
    const flipped: Part = { ...drop, stand: drop.stand === 'upper' ? 'lower' : 'upper' };
    const others = live.filter(other => other !== drop);
    if (others.some(other => anyNear(legsOf(other, 'upper'), legsOf(flipped, 'upper')) || anyNear(legsOf(other, 'lower'), legsOf(flipped, 'lower')))) continue;
    live[index] = flipped;
    for (let at = crowded.length - 1; at >= 0; at--) if (crowded[at]!.id === drop.id || crowded[at]!.with === drop.link) crowded.splice(at, 1);
  }
  let solved = solve(live, frame);
  while ('reject' in solved) {
    const part = solved.reject;
    residual.push({ id: part.id, link: part.link, order: part.order, reason: 'row-cycle', upper: part.upper, lower: part.lower });
    live = live.filter(other => other !== part);
    solved = solve(live, frame);
  }
  const { units, edges, split } = solved;

  // Every tip a run must keep off: the upper ends of all parts (and of the residual ones that have tips), and the ports outside the plan.
  const upperTips = [...live.map(part => part.upper), ...residual.flatMap(item => item.upper ? [item.upper] : []), ...frame.tips];
  const lowerTips = [...frame.lowerTips, ...residual.flatMap(item => item.lower ? [item.lower] : [])];
  const drops = live.filter(part => part.drop);
  const applies = (obstacle: PlanObstacle, unit: Unit): boolean =>
    obstacle.owner !== unit.part.link && obstacle.x1 > unit.lo + EPS && obstacle.x0 < unit.hi - EPS;

  /** The y of the jog of a drop that stands on its lower x: one clearance below its upper tip, and O5 like a row (`e` off the group edge at `low`, the bands anchored above). */
  const jogOf = (drop: Part): number => {
    const x0 = Math.min(drop.upper.x, drop.lower.x), x1 = Math.max(drop.upper.x, drop.lower.x);
    let y = Math.max(drop.upper.y + keep, low + margin);
    for (const obstacle of frame.obstacles) {
      if (obstacle.anchor === 'above' && obstacle.owner !== drop.link && obstacle.x1 > x0 + EPS && obstacle.x0 < x1 - EPS) y = Math.max(y, obstacle.bound);
    }
    return y;
  };
  /** How far above `bandTop` the jog of a drop that stands on its upper x lies: one clearance above its lower tip, and no nearer than an O5 band anchored below over the jog's x (`e` off the group edge). */
  const jogDepth = (drop: Part): number => {
    const x0 = Math.min(drop.upper.x, drop.lower.x), x1 = Math.max(drop.upper.x, drop.lower.x);
    let depth = drop.depth + keep;
    for (const obstacle of frame.obstacles) {
      if (obstacle.anchor === 'below' && obstacle.owner !== drop.link && obstacle.x1 > x0 + EPS && obstacle.x0 < x1 - EPS) depth = Math.max(depth, obstacle.bound);
    }
    return depth;
  };
  const ownLb = (unit: Unit): number => {
    if (unit.half === 2) return -Infinity;
    const end = unit.part.upper;
    return end.kind === 'mouth' ? end.y : end.y < low - EPS ? low + margin : end.y;
  };
  const lbOf = (unit: Unit): number => {
    let lb = ownLb(unit);
    for (const tip of upperTips) if (inside(tip.x, unit)) lb = Math.max(lb, tip.y + keep);
    for (const obstacle of frame.obstacles) if (obstacle.anchor === 'above' && applies(obstacle, unit)) lb = Math.max(lb, obstacle.bound);
    // A drop that stands on its lower x has its jog one clearance below its upper tip: a run that crosses the drop keeps a clearance from
    // the jog, and the lower leg of a part beside the stub (its lower x within `keep` of the upper x) starts below it.
    for (const drop of drops) {
      if (drop.stand !== 'lower' || !drop.jogged || drop.link === unit.part.link) continue;
      const jog = jogOf(drop);
      if (inside(drop.upper.x, unit) || inside(drop.lower.x, unit) || unit.half !== 1 && Math.abs(unit.xl - drop.upper.x) < keep - EPS) lb = Math.max(lb, jog + keep);
    }
    return lb;
  };
  /** The terms of the need that do not read the order. */
  const fixedNeed = (unit: Unit): number => {
    let need = unit.half === 1 ? -Infinity : unit.part.depth;
    for (const obstacle of frame.obstacles) if (obstacle.anchor === 'below' && applies(obstacle, unit)) need = Math.max(need, obstacle.bound);
    for (const drop of drops) {
      if (inside(drop.upper.x, unit) || inside(drop.lower.x, unit)) need = Math.max(need, drop.jogged && drop.stand === 'upper' ? keep + jogDepth(drop) : keep + drop.depth);
      // O2 between a drop's vertical and a stepped part's leg (S4): the upper leg of a part within `keep` of the stub below the jog turns above the jog.
      if (drop.jogged && drop.stand === 'upper' && drop.link !== unit.part.link && unit.half !== 2 && Math.abs(unit.xu - drop.lower.x) < keep - EPS) {
        need = Math.max(need, keep + jogDepth(drop));
      }
    }
    for (const tip of lowerTips) if (inside(tip.x, unit)) need = Math.max(need, keep + bandTop - tip.y);
    return need;
  };
  /** need*: the fixed terms and `k + depth(j)` of every partner that interleaves the unit with its lower x inside the span. */
  const staticNeed = (unit: Unit): number => {
    let need = fixedNeed(unit);
    for (const other of units) {
      if (other.part === unit.part || other.half === 1) continue;
      if (interleave(unit, other) && inside(other.xl, unit)) need = Math.max(need, keep + other.part.depth);
    }
    return need;
  };

  // Topological order (2.3).
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const waiting = new Map(units.map(unit => [unit.id, edges.filter(item => item.below === unit.id).length]));
  const ready = units.filter(unit => waiting.get(unit.id) === 0);
  const rows = new Map<string, number>(), order: Unit[] = [];
  const need = new Map(units.map(unit => [unit.id, staticNeed(unit)])), lbs = new Map(units.map(unit => [unit.id, lbOf(unit)]));
  const rank = (unit: Unit): number => unit.part.order * 4 + unit.half;
  const spread = (a: Unit, b: Unit): number => Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi);
  while (ready.length) {
    ready.sort((a, b) => need.get(b.id)! - need.get(a.id)! || lbs.get(a.id)! - lbs.get(b.id)! || rank(a) - rank(b));
    const unit = ready.shift()!;
    let y = lbs.get(unit.id)!;
    for (const earlier of order) {
      const ordered = edges.some(item => item.above === earlier.id && item.below === unit.id);
      // Two parts share a row only where their spans, each grown by `keep`, are disjoint (O3).
      if (ordered || spread(earlier, unit) <= 2 * keep + EPS) y = Math.max(y, rows.get(earlier.id)! + earlier.part.after);
    }
    rows.set(unit.id, y);
    order.push(unit);
    for (const item of edges) {
      if (item.above !== unit.id) continue;
      waiting.set(item.below, waiting.get(item.below)! - 1);
      if (waiting.get(item.below) === 0) ready.push(byId.get(item.below)!);
    }
  }

  // Concrete geometry, then the crossings of 2.1 by arithmetic on it. A lower tip moves down with the band below by the
  // growth `H` asks for, and every row lies above it once the gap has grown, so a lower leg or a drop reaches every row below its start.
  interface Horizontal { unit: string; part: Part; y: number; x0: number; x1: number }
  interface Vertical { part: Part; kind: PlanCrossing['kind']; x: number; y0: number; y1: number }
  const horizontals: Horizontal[] = [], verticals: Vertical[] = [];
  const planned: PlannedPart[] = [];
  for (const part of live) {
    const base = { id: part.id, link: part.link, order: part.order, upper: part.upper, lower: part.lower, depth: part.depth,
      ...(part.index !== undefined ? { index: part.index } : {}), ...(part.upperFirst !== undefined ? { upperFirst: part.upperFirst } : {}) };
    if (part.drop) {
      const jog = part.jogged ? (part.stand === 'lower' ? jogOf(part) : bandTop - jogDepth(part)) : undefined;
      verticals.push({ part, kind: 'drop', x: part.stand === 'lower' ? part.lower.x : part.upper.x, y0: part.stand === 'lower' ? jog! : part.upper.y, y1: Infinity });
      planned.push({ ...base, shape: 'drop', rows: [], stand: part.stand, ...(jog !== undefined ? { jog } : {}) });
      continue;
    }
    const middle = split.get(part.id);
    if (middle === undefined) {
      const y = rows.get(part.id)!;
      verticals.push({ part, kind: 'upper-leg', x: part.upper.x, y0: part.upper.y, y1: y },
        { part, kind: 'lower-leg', x: part.lower.x, y0: y, y1: Infinity });
      horizontals.push({ unit: part.id, part, y, x0: part.upper.x, x1: part.lower.x });
      planned.push({ ...base, shape: 'stepped', rows: [y] });
    } else {
      const first = rows.get(`${part.id}a`)!, second = rows.get(`${part.id}b`)!;
      verticals.push({ part, kind: 'upper-leg', x: part.upper.x, y0: part.upper.y, y1: first },
        { part, kind: 'middle-drop', x: middle, y0: first, y1: second },
        { part, kind: 'lower-leg', x: part.lower.x, y0: second, y1: Infinity });
      horizontals.push({ unit: `${part.id}a`, part, y: first, x0: part.upper.x, x1: middle },
        { unit: `${part.id}b`, part, y: second, x0: middle, x1: part.lower.x });
      planned.push({ ...base, shape: 'z', rows: [first, second], middle });
    }
  }
  const crossings: PlanCrossing[] = [];
  const between = (value: number, a: number, b: number): boolean => value > Math.min(a, b) + EPS && value < Math.max(a, b) - EPS;
  for (const run of horizontals) {
    for (const vertical of verticals) {
      if (vertical.part === run.part) continue;
      if (between(vertical.x, run.x0, run.x1) && between(run.y, vertical.y0, vertical.y1)) {
        crossings.push({ run: run.unit, vertical: vertical.part.id, kind: vertical.kind, at: { x: vertical.x, y: run.y } });
      }
    }
  }

  // H (Section 3): the rows packed from `low`, and every term anchored to the band below measured from `bandTop`.
  let demand = -Infinity, setBy = 'floor';
  const raise = (value: number, by: string): void => {
    if (value > demand + EPS) { demand = value; if (value > frame.floor + EPS) setBy = by; }
  };
  const partOf = new Map(live.map(part => [part.id, part]));
  for (const unit of units) {
    let actual = fixedNeed(unit);
    for (const crossing of crossings) {
      if (crossing.run === unit.id && crossing.kind === 'lower-leg') actual = Math.max(actual, keep + partOf.get(crossing.vertical)!.depth);
    }
    raise(rows.get(unit.id)! - low + actual, unit.id);
  }
  for (const drop of drops) raise(drop.upper.y - low + (drop.jogged && drop.stand === 'upper' ? jogDepth(drop) : drop.depth + (drop.jogged ? keep : 0)), drop.id);
  for (const item of residual) if (item.upper && item.lower) raise(item.upper.y - low + 2 * keep + (bandTop - item.lower.y), item.id);

  const height = Math.max(frame.floor, demand);
  return { low, bandTop, parts: planned.sort((a, b) => a.order - b.order), residual, crowded, order: order.map(unit => unit.id), crossings, height,
    demand: Number.isFinite(demand) ? demand : 0, growth: Math.max(0, height - (bandTop - low)), setBy,
    edges: edges.map(item => ({ ...item })) };
}

/** The height of a label's room below its row: the label, `normalGap` either side of it, and the stroke. */
function labelRoom(model: LayoutModel, link: LayoutLink): number {
  const text = model.document.links[link.sourceIndex]?.label;
  if (!text) return 0;
  const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
  return measured.height + 2 * LINK_LABEL_GEOMETRY.normalGap + linkStrokeWidth(link);
}

/**
 * Reads the parts of one tier gap (Section 1) and the frame they stand in from a placed model, and plans them.
 * The model is the one `allocateGapRuns` sees: after 7f, lane x fixed, stems planned. Nothing is written.
 */
export function tierGapPlan(model: LayoutModel, gap: TierGap): GapPlan {
  const gaps = tierGaps(model), cache = stemCache();
  const keep = nudgingDistance(model), half = routedStroke(model) / 2;
  const margin = GROUP_EDGE_LINK_CLEARANCE + half, stem = GROUP_LABEL_GEOMETRY.routerStem;
  const bandOf = (tier: number): Rect => model.tierBands.find(band => band.tier === tier)!.bounds!;
  const above = bandOf(gap.above), bandTop = bandOf(gap.below).y;
  const floor = Math.max(0, bandGap(model) - (gap.low - bottom(above)));
  const chords = new Set(model.frozenChords ?? []);

  const inputs: PlanInput[] = [], residual: ResidualPart[] = [];
  type Side = { x: number; y: number; from: number; kind: 'tip' | 'mouth'; source: string; faces: 'low' | 'high' };
  for (const [order, link] of model.links.entries()) {
    if (!drawn(link) || link.bundle !== undefined || link.removed === true || chords.has(link.id)) continue;
    const ends = [link.attachments!.from.node, link.attachments!.to.node];
    if (ends.some(node => model.document.groups[model.document.nodes[node]?.group ?? '']?.shape === 'bar')) continue;
    const stops = stopsOf(model, link);
    for (let index = 0; index * 2 + 1 < stops.length; index++) {
      const a = stops[index * 2]!, b = stops[index * 2 + 1]!;
      const spanLow = Math.min(a.point.y, b.point.y), spanHigh = Math.max(a.point.y, b.point.y);
      const found = gaps.filter(other => other.low > spanLow - EPS && other.high < spanHigh + EPS);
      const id = `${link.id}#${index}`;
      const span = { x0: Math.min(a.point.x, b.point.x), x1: Math.max(a.point.x, b.point.x) };
      const fail = (reason: ResidualReason): void => { residual.push({ id, link: link.id, order, reason, span }); };
      // A same-boundary U-turn (Section 1 item 6): both ports of a link with no lane face this gap from the same band, so the link
      // leaves one, turns inside the gap and enters the other. No gap stands between its stops, so the span test below never sees it.
      if (!found.length && stops.length === 2 && a.kind === 'port' && b.kind === 'port') {
        const from = findPort(model, link.attachments!.from), to = findPort(model, link.attachments!.to);
        const faces = (port: typeof from): boolean => port?.anchor !== undefined
          && (port.side === 'bottom' ? port.anchor.y <= gap.low + EPS && port.anchor.y >= above.y - EPS
            : port.side === 'top' && port.anchor.y >= bandTop - EPS && port.anchor.y <= bottom(bandOf(gap.below)) + EPS);
        if (from?.side === to?.side && faces(from) && faces(to)) fail('u-turn');
        continue;
      }
      if (!found.some(other => same(other.low, gap.low) && same(other.high, gap.high))) continue;
      if (a.kind === 'shared' || b.kind === 'shared') continue;
      if (found.length > 1) { fail('spans-two-gaps'); continue; }
      const side = (stop: typeof a, at: number): Side | 'lateral' | 'off' => {
        if (stop.kind === 'lane') {
          const edge = edgeOf(gap, stop.point);
          if (edge === undefined) return 'off';
          return { x: stop.point.x, y: edge === 'low' ? gap.low + stem : gap.high - stem, from: stop.point.y, kind: 'mouth',
            source: `lane|${stop.point.x}|${edge}`, faces: edge };
        }
        const port = findPort(model, link.attachments![at === 0 ? 'from' : 'to']);
        if (!port?.anchor || (port.side !== 'top' && port.side !== 'bottom')) return 'lateral';
        const depth = stemPlan(model, port, cache).depth, sign = port.side === 'bottom' ? 1 : -1;
        return { x: port.anchor.x, y: port.anchor.y + sign * depth, from: port.anchor.y, kind: 'tip',
          source: `${port.ref.node}|${port.side}|${port.anchor.x}`, faces: port.side === 'bottom' ? 'low' : 'high' };
      };
      const first = side(a, index === 0 ? 0 : 1), second = side(b, index * 2 + 1 === stops.length - 1 ? 1 : 0);
      if (first === 'lateral' || second === 'lateral') { fail('lateral-port'); continue; }
      if (first === 'off' || second === 'off') { fail('off-boundary'); continue; }
      const [upper, lower] = first.from <= second.from ? [first, second] : [second, first];
      if (upper.faces !== 'low' || lower.faces !== 'high') { fail('faces-away'); continue; }
      const strip = (item: Side): PlanEnd => ({ x: item.x, y: item.y, kind: item.kind, source: item.source });
      const room = labelRoom(model, link);
      inputs.push({ id, link: link.id, order, index, upperFirst: upper === first, upper: strip(upper), lower: strip(lower),
        ...(room ? { labelRoom: room } : {}) });
    }
  }

  // The obstacles of O5, each anchored to the band it belongs to. A lane that crosses the whole gap is a wall.
  const obstacles: PlanObstacle[] = [], blocks: PlanObstacle[] = [], walls: { x0: number; x1: number; owner?: string }[] = [];
  const rect = (box: Rect, clearance: number, owner?: string): void => {
    const x0 = box.x - clearance, x1 = right(box) + clearance, o = owner === undefined ? {} : { owner };
    const wall = box.y <= gap.low + EPS && bottom(box) >= gap.high - EPS;
    // A box hangs from the band above (it ends at or inside the gap) or from the band below (it starts inside the gap and ends at or
    // below its far boundary). One that ends below the gap is a need measured from the band below, never a lower bound (O5).
    const below = !wall && box.y > gap.low + EPS && bottom(box) > gap.low + EPS && bottom(box) >= gap.high - EPS;
    const need = clearance + bandTop - box.y;
    // The box stands in a leg's way whichever band it hangs from: its bound from the band it is anchored to, whatever the sign.
    if (wall) walls.push({ x0, x1, ...o });
    else if (below || box.y >= gap.high - EPS) blocks.push({ x0, x1, anchor: 'below', bound: need, ...o });
    else blocks.push({ x0, x1, anchor: 'above', bound: bottom(box) + clearance, ...o });
    if (wall) return;
    if (below || box.y >= gap.high - EPS) {
      if (need > 0) obstacles.push({ x0, x1, anchor: 'below', bound: need, ...o });
    } else if (bottom(box) + clearance > gap.low) obstacles.push({ x0, x1, anchor: 'above', bound: bottom(box) + clearance, ...o });
  };
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay') continue;
    rect(lane.bounds, keep, lane.owner.kind === 'link' ? lane.owner.id : undefined);
  }
  for (const bundle of model.bundles) {
    if (bundle.layer === 'overlay') continue;
    for (const part of bundle.envelopeParts ?? (bundle.envelope ? [bundle.envelope] : [])) rect(part, keep);
  }
  for (const obstacle of model.obstacles) {
    if (obstacle.layer !== 'overlay') rect(obstacle.bounds, keep, obstacle.owner.kind === 'link' ? obstacle.owner.id : undefined);
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds || label.layer === 'overlay' || label.role !== 'group') continue;
    const middle = label.bounds.y + label.bounds.height / 2;
    const clearance = GROUP_LABEL_LINK_CLEARANCE + half;
    const span = { x0: label.bounds.x - clearance, x1: right(label.bounds) + clearance };
    blocks.push(middle < (gap.low + gap.high) / 2 ? { ...span, anchor: 'above', bound: bottom(label.bounds) + clearance }
      : { ...span, anchor: 'below', bound: clearance + bandTop - label.bounds.y });
    if (middle < (gap.low + gap.high) / 2) {
      if (bottom(label.bounds) + clearance > gap.low) obstacles.push({ x0: label.bounds.x - clearance, x1: right(label.bounds) + clearance, anchor: 'above', bound: bottom(label.bounds) + clearance });
    } else if (clearance + bandTop - label.bounds.y > 0) {
      obstacles.push({ x0: label.bounds.x - clearance, x1: right(label.bounds) + clearance, anchor: 'below', bound: clearance + bandTop - label.bounds.y });
    }
  }
  for (const group of Object.values(model.groups)) {
    if (!group.bounds || !group.nodes.length) continue;
    const box = group.bounds, x0 = box.x - margin, x1 = right(box) + margin;
    if (bottom(box) <= gap.low + EPS && bottom(box) + margin > gap.low) obstacles.push({ x0, x1, anchor: 'above', bound: bottom(box) + margin });
    if (box.y >= gap.high - EPS && margin + bandTop - box.y > 0) obstacles.push({ x0, x1, anchor: 'below', bound: margin + bandTop - box.y });
  }
  // An across-frames mesh bus band stands in the gap on its bus edge and belongs to no group (mesh-bus.md, section 4): an O5 band anchored to
  // the row's sub-tier band over the bar's span, plus `k`. No planned row lies inside it. A band in a frame is inside a group box already.
  for (const held of model.busBands ?? []) {
    const bus = model.meshBuses?.find(item => item.id === held.bus);
    if (bus?.placement !== 'across-frames') continue;
    const x0 = held.bounds.x - keep, x1 = right(held.bounds) + keep;
    if (held.side === 'bottom' && bus.row === gap.above) {
      const bound = bottom(held.bounds) + keep;
      if (bound > gap.low) { obstacles.push({ x0, x1, anchor: 'above', bound }); }
    } else if (held.side === 'top' && bus.row === gap.below) {
      const bound = keep + bandTop - held.bounds.y;
      if (bound > 0) { obstacles.push({ x0, x1, anchor: 'below', bound }); }
    }
  }
  // A gap row keeps a node's obstacle reach off every body it passes under or beside (ticket 90), the shorter bodies of a row of unequal
  // heights among them: the plan seats a row from the lowest body edge of the band above (the highest of the band below), so its room
  // never depends on a neighbour's stem. Rows are seated from `low`/`bandTop`, so a body that ends short of them is met too.
  for (const node of Object.values(model.nodes)) {
    const box = node.bounds;
    if (!box || node.layer === 'overlay') continue;
    const reach = nodeObstacleReach(model, node), x0 = box.x - reach, x1 = right(box) + reach;
    if (bottom(box) <= gap.low + EPS && bottom(box) + reach > gap.low) obstacles.push({ x0, x1, anchor: 'above', bound: bottom(box) + reach });
    if (box.y >= gap.high - EPS && reach + bandTop - box.y > 0) obstacles.push({ x0, x1, anchor: 'below', bound: reach + bandTop - box.y });
  }
  // A canton frame is no group box, and it reaches into the gap: its margin and its title band stand below its last sub-tier
  // (or above its first), outside every member box. A canton that ends at this gap's upper band is an O5 band anchored to it,
  // one that starts at this gap's lower band is anchored to that, both with the group-edge margin. One that spans the gap is
  // no wall: its members' own boxes and lanes already are.
  for (const frame of model.frames ?? []) {
    if (frame.kind !== 'canton') continue;
    const box = frame.box, x0 = box.x - margin, x1 = right(box) + margin, tiers = cantonTiers(model, frame.id);
    if (tiers.last === gap.above) {
      if (bottom(box) + margin > gap.low) obstacles.push({ x0, x1, anchor: 'above', bound: bottom(box) + margin });
    } else if (tiers.first === gap.below) {
      const bound = margin + bandTop - box.y;
      if (bound > 0) obstacles.push({ x0, x1, anchor: 'below', bound });
    }
  }
  // A span that crosses a through-lane's reserved run is residual (Section 1 item 6).
  // A leg that stands over a shared run of another link (a junction bar across the gap, 7e) crosses geometry the plan does not own
  // (Section 1 item 5: a shared run keeps its own rules and is an obstacle to the plan): residual too.
  const bars = model.links.flatMap(link => [...(link.sharedRuns?.from ?? []), ...(link.sharedRuns?.to ?? [])]
    .filter(run => same(run.from.y, run.to.y) && run.from.y > gap.low - EPS && run.from.y < gap.high + EPS)
    .map(run => ({ x0: Math.min(run.from.x, run.to.x) - keep, x1: Math.max(run.from.x, run.to.x) + keep, owner: link.id })));
  const kept = inputs.filter(input => {
    const lo = Math.min(input.upper.x, input.lower.x), hi = Math.max(input.upper.x, input.lower.x);
    if (walls.some(wall => wall.owner !== input.link && hi > wall.x0 - EPS && lo < wall.x1 + EPS)) {
      residual.push({ id: input.id, link: input.link, order: input.order, reason: 'crosses-lane', span: { x0: lo, x1: hi } });
      return false;
    }
    if (bars.some(bar => bar.owner !== input.link && [input.upper.x, input.lower.x].some(x => x > bar.x0 + EPS && x < bar.x1 - EPS))) {
      residual.push({ id: input.id, link: input.link, order: input.order, reason: 'crosses-shared-run', span: { x0: lo, x1: hi } });
      return false;
    }
    return true;
  });

  // Ports outside the plan still stand in the gap: a run keeps off their stems (O4).
  const ends = new Set(kept.flatMap(input => [`${input.upper.x}|${input.upper.y}`, `${input.lower.x}|${input.lower.y}`]));
  const tips = facingTips(model, gap, cache).filter(item => !ends.has(`${item.tip.x}|${item.tip.y}`));
  return planGap(kept, { low: gap.low, bandTop, floor, keep, pitch: keep, edge: margin, obstacles, blocks,
    tips: tips.filter(item => item.side === 'bottom').map(item => item.tip),
    lowerTips: tips.filter(item => item.side === 'top').map(item => item.tip), residual,
    verticals: (model.meshBuses ?? []).filter(bus => bus.riser !== undefined && bus.cross !== undefined
      && model.meshBuses!.some(other => other.id === bus.joined && bus.row <= gap.above && gap.below <= other.row)).map(bus => bus.riser!.x) });
}

/**
 * The stems of the two bands that face the gap: an upper tip hangs from a bottom port of the band directly above it, a lower tip from a
 * top port of the band directly below. A stem of a band further away never reaches the gap.
 */
export function facingTips(model: LayoutModel, gap: TierGap, cache: StemCache = stemCache()): NestedTip[] {
  const band = (tier: number): Rect => model.tierBands.find(entry => entry.tier === tier)!.bounds!;
  const above = band(gap.above), below = band(gap.below);
  return nestedTips(model, cache).filter(item => item.side === 'bottom'
    ? item.anchor.y <= gap.low + EPS && item.anchor.y >= above.y - EPS
    : item.anchor.y >= below.y - EPS && item.anchor.y <= bottom(below) + EPS);
}

/** The plan of every tier gap of the model, low to high. */
export function tierGapPlans(model: LayoutModel): { gap: TierGap; plan: GapPlan }[] {
  return tierGaps(model).map(gap => ({ gap, plan: tierGapPlan(model, gap) }));
}

/**
 * The reserved geometry of one planned part, tip to tip, in the order its link visits it (Section 4): the upper leg, the run on
 * its row and the lower leg of a stepped part; a Z part's two rows and middle drop; the vertical of a drop, with its jog. An end
 * that is a mouth starts at the lane's terminal on the gap boundary, where the lane's own reserved run ends.
 */
export function plannedSegments(part: PlannedPart, gap: { low: number; high: number }): PathSegment[] {
  const at = (x: number, y: number): Point => ({ x, y });
  const { x: xu } = part.upper, { x: xl } = part.lower;
  const points: Point[] = [at(xu, part.upper.kind === 'mouth' ? gap.low : part.upper.y)];
  if (part.shape === 'drop') {
    if (part.jog !== undefined) points.push(at(xu, part.jog), at(xl, part.jog));
  } else if (part.shape === 'stepped') points.push(at(xu, part.rows[0]!), at(xl, part.rows[0]!));
  else points.push(at(xu, part.rows[0]!), at(part.middle!, part.rows[0]!), at(part.middle!, part.rows[1]!), at(xl, part.rows[1]!));
  points.push(at(xl, part.lower.kind === 'mouth' ? gap.high : part.lower.y));
  const chain = points.filter((point, index) => index === 0 || !same(point.x, points[index - 1]!.x) || !same(point.y, points[index - 1]!.y));
  const ordered = part.upperFirst === false ? [...chain].reverse() : chain;
  return ordered.slice(1).map((to, index) => ({ from: { ...ordered[index]! }, to: { ...to }, owner: { kind: 'link' as const, id: part.link } }));
}
