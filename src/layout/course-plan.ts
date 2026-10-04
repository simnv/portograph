import type { Point, Side } from '../model/geometry.js';

/**
 * The polyline readers of the course plan (architecture ticket 15, phases 2 to 4): the corners and the proper crossings of orthogonal polylines, and the
 * fewest-corner route between two stems. The turns of a polyline are exact by construction (a corner is a corner). The decision itself is in
 * `course-measure.ts`, which reads the 7f baseline and its routed result; the estimate of the natural course from stage 5 was dropped (the redesign of 2026-10-05).
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
