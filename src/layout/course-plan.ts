import type { Point, Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { flankPair } from './flanks.js';
import { chordKind } from './frame-paths.js';
import { laneSource, selectAnchorTier } from './lanes.js';
import { bandUnits, linkFacts, type EndFacts, type LinkFacts, type Unit } from './read/courses.js';

/**
 * The candidate builder, the planned polyline, the turn estimate and the crossing estimate of the course plan (architecture ticket 15, phases 2 and 3).
 * Everything here reads the model as stage 5 leaves it: boxes, anchors, port sides and unit orders. It reads no lane and no route, and it writes nothing.
 * The turns of a polyline are exact by construction (a corner is a corner); the turns of a link's natural course are an estimate, because 7a to 7f can
 * still align two ports (7c, 7e), seat a lane under its source, or admit a chord. The crossings are an estimate against the other links' natural polylines.
 */

/** The stem a port leaves along its face before it turns (CONTEXT, stem); the perimeter offset `e` of the design, Section 1. */
export const STEM = 15;
export const PERIMETER_OFFSET = 10.75;

const OUT: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const HEADINGS: Side[] = ['top', 'right', 'bottom', 'left'];
const BEND = 1000;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const samePoint = (a: Point, b: Point): boolean => near(a.x, b.x) && near(a.y, b.y);
const step = (p: Point, side: Side, by: number): Point => ({ x: p.x + OUT[side].x * by, y: p.y + OUT[side].y * by });

/** Drops repeated points and the middle point of three collinear ones. */
export function simplify(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) if (kept.length === 0 || !samePoint(kept.at(-1)!, point)) kept.push(point);
  const out: Point[] = [];
  for (const point of kept) {
    while (out.length >= 2) {
      const a = out.at(-2)!, b = out.at(-1)!;
      const collinear = near((b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x), 0);
      const sameWay = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) > 0;
      if (collinear && sameWay) out.pop(); else break;
    }
    out.push(point);
  }
  return out;
}

/** The corners of a polyline, counting a reversal as one, as `pathBends` does for a drawn path. */
export function polylineTurns(points: readonly Point[]): number {
  const p = simplify(points);
  return Math.max(0, p.length - 2);
}

/**
 * The orthogonal polyline with the fewest corners from `a` (leaving along `from`) to `b` (arriving along `into`), on the grid of the coordinates that matter:
 * both points, their middle and `extra`. Ties go to the shorter. A corner at `b` itself counts when the last run does not arrive along `into`.
 */
export function orthogonalRoute(a: Point, from: Side, b: Point, into: Side, extraX: readonly number[] = [], extraY: readonly number[] = []): Point[] {
  const unique = (values: number[]): number[] => [...new Set(values.map(value => Math.round(value * 1000) / 1000))].sort((u, v) => u - v);
  // One stem beyond each point on both axes gives the lines a U or a loop needs.
  const xs = unique([a.x, b.x, (a.x + b.x) / 2, a.x - STEM, a.x + STEM, b.x - STEM, b.x + STEM, ...extraX]);
  const ys = unique([a.y, b.y, (a.y + b.y) / 2, a.y - STEM, a.y + STEM, b.y - STEM, b.y + STEM, ...extraY]);
  const xi = (x: number): number => xs.findIndex(value => near(value, Math.round(x * 1000) / 1000));
  const yi = (y: number): number => ys.findIndex(value => near(value, Math.round(y * 1000) / 1000));
  const w = xs.length, h = ys.length;
  // The state is the point, the heading and whether the last move was a corner: two corners at one point would be a reversal, which a run cannot make.
  const id = (x: number, y: number, d: number, turned = 0): number => ((y * w + x) * 4 + d) * 2 + turned;
  const cost = new Float64Array(w * h * 8).fill(Infinity), prev = new Int32Array(w * h * 8).fill(-1), done = new Uint8Array(w * h * 8);
  const start = id(xi(a.x), yi(a.y), HEADINGS.indexOf(from));
  const goals = [id(xi(b.x), yi(b.y), HEADINGS.indexOf(into)), id(xi(b.x), yi(b.y), HEADINGS.indexOf(into), 1)];
  cost[start] = 0;
  for (;;) {
    let best = -1;
    for (let i = 0; i < cost.length; i++) if (!done[i] && cost[i]! < Infinity && (best < 0 || cost[i]! < cost[best]!)) best = i;
    if (best < 0 || goals.includes(best)) break;
    done[best] = 1;
    const turned = best % 2, d = Math.floor(best / 2) % 4, cell = Math.floor(best / 8), x = cell % w, y = (cell - x) / w;
    const relax = (to: number, by: number): void => { if (cost[best]! + by < cost[to]!) { cost[to] = cost[best]! + by; prev[to] = best; } };
    // Straight on to the next grid line.
    const dir = OUT[HEADINGS[d]!]!, nx = x + dir.x, ny = y + dir.y;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) relax(id(nx, ny, d, 0), Math.abs(xs[nx]! - xs[x]!) + Math.abs(ys[ny]! - ys[y]!));
    // A corner: a quarter turn either way, never a reversal.
    if (turned === 0) for (const turn of [1, 3]) relax(id(x, y, (d + turn) % 4, 1), BEND);
  }
  const goal = goals.reduce((best, item) => cost[item]! < cost[best]! ? item : best);
  if (!Number.isFinite(cost[goal]!)) return [a, b];
  const path: Point[] = [];
  for (let at = goal; at >= 0; at = prev[at]!) {
    const cell = Math.floor(at / 8), x = cell % w, y = (cell - x) / w;
    path.push({ x: xs[x]!, y: ys[y]! });
  }
  return simplify(path.reverse());
}

/** The estimated polyline of a link's natural course: its stems, and the fewest corners between them (the lanes and the rows are not drawn). */
export function naturalPolyline(from: Point, fromSide: Side, to: Point, toSide: Side): Point[] {
  // Two faces that look at each other across less than two stems share the room: each stem is half of it.
  const along = (to.x - from.x) * OUT[fromSide].x + (to.y - from.y) * OUT[fromSide].y;
  const stem = toSide === OPPOSITE[fromSide] && along > 0 && along < 2 * STEM ? along / 2 : STEM;
  if (toSide === OPPOSITE[fromSide] && along > 0 && near((to.x - from.x) * OUT[fromSide].y - (to.y - from.y) * OUT[fromSide].x, 0)) return [from, to];
  const sA = step(from, fromSide, stem), sB = step(to, toSide, stem);
  return simplify([from, ...orthogonalRoute(sA, fromSide, sB, OPPOSITE[toSide]), to]);
}

// ---- crossings ----------------------------------------------------------------------------------------------------------------------

/** The proper crossings of two polylines: interior points of both segments, so a shared end or a shared stem is no crossing. */
export function polylineCrossings(a: readonly Point[], b: readonly Point[]): number {
  let count = 0;
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p = a[i - 1]!, q = a[i]!, r = b[j - 1]!, s = b[j]!;
    const ax = q.x - p.x, ay = q.y - p.y, bx = s.x - r.x, by = s.y - r.y, cross = ax * by - ay * bx;
    if (near(cross, 0)) continue;
    const t = ((r.x - p.x) * by - (r.y - p.y) * bx) / cross, u = ((r.x - p.x) * ay - (r.y - p.y) * ax) / cross;
    if (t > 1e-3 && t < 1 - 1e-3 && u > 1e-3 && u < 1 - 1e-3) count++;
  }
  return count;
}

// ---- the natural course -------------------------------------------------------------------------------------------------------------

/** What the plan knows of the whole drawing: the facts of every covered link, the units, and the tier that 7c aligns the others to. */
export interface PlanContext {
  model: LayoutModel;
  facts: Map<string, LinkFacts>;
  units: Map<number, Unit[]>;
  anchorTier: number | undefined;
  /** The number of link ends at each port, by port key. */
  load: Map<string, number>;
}

const portKey = (ref: { node: string; ordinal: number; name?: string; anonymous?: boolean }): string => `${ref.node}|${ref.ordinal}|${ref.name ?? ''}|${ref.anonymous === true ? 'a' : 'n'}`;

export function planContext(model: LayoutModel): PlanContext {
  const load = new Map<string, number>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments) for (const end of [link.attachments.from, link.attachments.to]) load.set(portKey(end), (load.get(portKey(end)) ?? 0) + 1);
  return { model, facts: linkFacts(model), units: bandUnits(model), anchorTier: selectAnchorTier(model), load };
}

/**
 * Whether 7c or 7e is expected to put the two ports of a link on one x: they already are, or the link is a centring feed (the sides face, the far end stands
 * farther from the anchor tier, neither end is in a flank), the far port has no other link, and the link is the first child of its parent port by x.
 */
function expectsAlignment(context: PlanContext, facts: LinkFacts): boolean {
  const { from, to } = facts;
  if (Math.abs(from.anchor.x - to.anchor.x) <= 0.5) return true;
  if (context.anchorTier === undefined || from.tier === to.tier) return false;
  const model = context.model, link = facts.link;
  const parentRef = laneSource(model, link), parent = parentRef === link.attachments!.from ? from : to, child = parent === from ? to : from;
  const below = child.tier > parent.tier;
  if (parent.side !== (below ? 'bottom' : 'top') || child.side !== (below ? 'top' : 'bottom')) return false;
  if ([parent.group, child.group].some(group => model.groups[group]?.flank !== undefined)) return false;
  if ((context.load.get(portKey(child.ref)) ?? 0) > 1) return false;
  // A node stands under one parent only: when several of its ports on the facing side carry a link, 7c seats it under one feed and the others jog.
  const linked = model.nodes[child.node]!.ports.filter(port => port.side === child.side && (context.load.get(portKey(port.ref)) ?? 0) > 0);
  if (linked.length > 1) return false;
  // A parent port with several children lets the first by x stand under it; the others fan.
  const siblings = [...context.facts.values()].filter(other => other.link.attachments && [other.from, other.to].some(end => portKey(end.ref) === portKey(parent.ref)))
    .map(other => (portKey(other.from.ref) === portKey(parent.ref) ? other.to : other.from).anchor.x);
  return siblings.length <= 1 || Math.min(...siblings) === child.anchor.x;
}

/** The natural course of one link: its polyline, its turns, and what the estimate assumed. */
export interface NaturalCourse { points: Point[]; turns: number; chord: boolean; aligned: boolean; lane: boolean }

export function naturalCourse(context: PlanContext, facts: LinkFacts): NaturalCourse {
  const { from, to } = facts;
  const model = context.model;
  // A flank link to its stored primary is levelled by 7b (`alignFlanks`) and drawn as one run. Any other chord is read from orders alone: stage 5 has no final y, and a chord is refused by bodies, titles and corridors that 7f settles. A link takes the
  // straight technique when it is a chord candidate (`chordKind`: one frame, or two frames on consecutive document tiers with facing sides), crosses no
  // sub-tier it does not end in, and has no node or unit between its ends in their row or band.
  const chord = flankPair(model, facts.link) !== undefined
    || chordKind(model, facts.link) !== undefined && facts.crossed.length === 0 && facts.between.length === 0 && !facts.rowBetween;
  if (chord) return { points: [from.anchor, to.anchor], turns: 0, chord: true, aligned: false, lane: false };
  const aligned = expectsAlignment(context, facts);
  // Seat the far end under the near one where centring is expected to, as 7c does.
  const parentRef = laneSource(model, facts.link), parentIsFrom = parentRef === facts.link.attachments!.from;
  const target = aligned && Math.abs(from.anchor.x - to.anchor.x) > 0.5
    ? (parentIsFrom ? { from: from.anchor, to: { x: from.anchor.x, y: to.anchor.y } } : { from: { x: to.anchor.x, y: from.anchor.y }, to: to.anchor }) : { from: from.anchor, to: to.anchor };
  const points = naturalPolyline(target.from, from.side, target.to, to.side);
  // A transit lane that cannot stand under its source costs two more corners (design, Section 1: the natural course).
  const lane = facts.crossed.length > 0 && facts.sourceCovered;
  // A link that passes a node of its own row, or a unit of its band, leaves the band and comes back: two more corners.
  const skirt = facts.rowBetween || (facts.from.tier === facts.to.tier && facts.between.length > 0);
  return { points, turns: polylineTurns(points) + (lane ? 2 : 0) + (skirt ? 2 : 0), chord: false, aligned, lane };
}

// ---- the candidates -----------------------------------------------------------------------------------------------------------------

export type CandidateKind = 'natural' | 'perimeter-left' | 'perimeter-right';
export interface Candidate { kind: CandidateKind; points: Point[]; turns: number; from: Side; to: Side; padding: number; lateral: number }

/**
 * How one end joins a perimeter lane on side `s`: by a lateral face `s` when the node stands at the edge of its row and its unit at the edge of its band
 * (a side run), else by its own top or bottom face with a padding row when its group is the outer rank of its frame. Nothing else is offered.
 */
function endOption(end: EndFacts, s: 'left' | 'right'): { face: Side; at: Point; padding: boolean } | undefined {
  if (end.edge[s] && end.unitEdge[s]) {
    const x = s === 'left' ? end.box.x : end.box.x + end.box.width;
    return { face: s, at: { x, y: end.side === s ? end.anchor.y : end.box.y + end.box.height / 2 }, padding: false };
  }
  if (end.side === 'top' && end.firstRank) return { face: 'top', at: end.anchor, padding: true };
  if (end.side === 'bottom' && end.lastRank) return { face: 'bottom', at: end.anchor, padding: true };
  return undefined;
}

/** The perimeter x on side `s`: beyond every unit of the sub-tiers from one end to the other, by the offset `e`. */
export function perimeterX(context: PlanContext, facts: LinkFacts, s: 'left' | 'right'): number {
  const lo = Math.min(facts.from.tier, facts.to.tier), hi = Math.max(facts.from.tier, facts.to.tier);
  const boxes = [...context.units.entries()].filter(([tier]) => tier >= lo && tier <= hi).flatMap(([, list]) => list.map(unit => unit.box));
  return s === 'left' ? Math.min(...boxes.map(box => box.x)) - PERIMETER_OFFSET : Math.max(...boxes.map(box => box.x + box.width)) + PERIMETER_OFFSET;
}

export function perimeterCandidate(context: PlanContext, facts: LinkFacts, s: 'left' | 'right'): Candidate | undefined {
  const a = endOption(facts.from, s), b = endOption(facts.to, s);
  if (a === undefined || b === undefined) return undefined;
  const x = perimeterX(context, facts, s);
  const leg = (end: { face: Side; at: Point; padding: boolean }, outward: boolean): Point[] => {
    // From the end to the lane (outward), or the other way; the lane is a vertical line at `x`.
    if (end.padding) {
      const stem = step(end.at, end.face, STEM), q = { x, y: stem.y };
      const run = orthogonalRoute(stem, end.face, q, s);
      return outward ? [end.at, ...run] : [...orthogonalRoute(q, OPPOSITE[s], stem, OPPOSITE[end.face]), end.at];
    }
    const q = { x, y: end.at.y };
    return outward ? [end.at, q] : [q, end.at];
  };
  const first = leg(a, true), second = leg(b, false);
  const points = simplify([...first, ...second]);
  const lateral = [a, b].filter(item => !item.padding).length, padding = [a, b].filter(item => item.padding).length;
  return { kind: s === 'left' ? 'perimeter-left' : 'perimeter-right', points, turns: polylineTurns(points), from: a.face, to: b.face, padding, lateral };
}

/** The candidates of a link: its natural course first, then the perimeter courses its ends admit. A link with no trigger has the natural course alone. */
export function candidatesFor(context: PlanContext, facts: LinkFacts, natural: NaturalCourse): Candidate[] {
  const list: Candidate[] = [{ kind: 'natural', points: natural.points, turns: natural.turns, from: facts.from.side, to: facts.to.side, padding: 0, lateral: 0 }];
  if (facts.triggers.length === 0) return list;
  for (const s of ['left', 'right'] as const) {
    const candidate = perimeterCandidate(context, facts, s);
    if (candidate !== undefined) list.push(candidate);
  }
  return list;
}
