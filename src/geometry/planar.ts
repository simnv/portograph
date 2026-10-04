import type { PathSegment, Point, Rect } from '../model/index.js';

/**
 * The tolerance published geometry is compared at: does this rectangle contain, overlap or touch
 * that one, at a few ULP of a coordinate (stress ticket 13).
 *
 * It is **not** the tolerance placement measures a reservation at. That one is ten times coarser and
 * lives in `src/layout/tolerance.ts` as `PLACEMENT_EPS`, and every comparison of that meaning reads the name. Meeting one of those and this one in the same reading is the
 * trap stress ticket 19 named: two numbers answering two questions, not two opinions about one.
 */
export const EPS = 1e-7;
export const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;
export const samePoint = (a: Point, b: Point): boolean => near(a.x, b.x) && near(a.y, b.y);
export const right = (r: Rect): number => r.x + r.width;
export const bottom = (r: Rect): number => r.y + r.height;
export const area = (r: Rect): number => r.width * r.height;
export const contains = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && right(inner) <= right(outer) + EPS && bottom(inner) <= bottom(outer) + EPS;
export const pointRect = (p: Point): Rect => ({ ...p, width: 0, height: 0 });
export const rectOverlap = (a: Rect, b: Rect): boolean => Math.min(right(a), right(b)) - Math.max(a.x, b.x) > EPS && Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > EPS;
export const rectDistance = (a: Rect, b: Rect): number => Math.hypot(Math.max(a.x - right(b), b.x - right(a), 0), Math.max(a.y - bottom(b), b.y - bottom(a), 0));
export const length = (s: PathSegment): number => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
export const bounds = (s: PathSegment): Rect => ({ x: Math.min(s.from.x, s.to.x), y: Math.min(s.from.y, s.to.y), width: Math.abs(s.to.x - s.from.x), height: Math.abs(s.to.y - s.from.y) });
export const horizontal = (s: PathSegment): boolean => near(s.from.y, s.to.y);
export const vertical = (s: PathSegment): boolean => near(s.from.x, s.to.x);
export function pointSegmentDistance(p: Point, s: PathSegment): number {
  const dx = s.to.x - s.from.x, dy = s.to.y - s.from.y;
  const t = Math.max(0, Math.min(1, ((p.x - s.from.x) * dx + (p.y - s.from.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - s.from.x - t * dx, p.y - s.from.y - t * dy);
}
/** Closed rectangle intersection, including boundary contact. */
export function segmentRect(s: PathSegment, r: Rect): boolean {
  let low = 0, high = 1;
  for (const [origin, delta, min, max] of [[s.from.x, s.to.x - s.from.x, r.x, right(r)], [s.from.y, s.to.y - s.from.y, r.y, bottom(r)]]) {
    if (origin === undefined || delta === undefined || min === undefined || max === undefined) continue;
    if (delta === 0) { if (origin < min - EPS || origin > max + EPS) return false; }
    // Expand the rectangle in pixels; never add pixel EPS to dimensionless slab parameters.
    else { const a = (min - EPS - origin) / delta, b = (max + EPS - origin) / delta; low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b)); }
  }
  return low <= high;
}
export function segmentRectDistance(s: PathSegment, r: Rect): number {
  if (segmentRect(s, r)) return 0;
  return Math.min(rectDistance(pointRect(s.from), r), rectDistance(pointRect(s.to), r),
    ...[{ x: r.x, y: r.y }, { x: right(r), y: r.y }, { x: r.x, y: bottom(r) }, { x: right(r), y: bottom(r) }].map(p => pointSegmentDistance(p, s)));
}
export function intersection(a: PathSegment, b: PathSegment): Point | undefined {
  const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
  const cross = ax * by - ay * bx;
  if (cross === 0) return undefined;
  const dx = b.from.x - a.from.x, dy = b.from.y - a.from.y;
  const t = (dx * by - dy * bx) / cross, u = (dx * ay - dy * ax) / cross;
  const toleranceA = EPS / Math.hypot(ax, ay), toleranceB = EPS / Math.hypot(bx, by);
  if (t < -toleranceA || t > 1 + toleranceA || u < -toleranceB || u > 1 + toleranceB) return undefined;
  return { x: a.from.x + t * ax, y: a.from.y + t * ay };
}
export function segmentDistance(a: PathSegment, b: PathSegment): number {
  if (intersection(a, b)) return 0;
  return Math.min(pointSegmentDistance(a.from, b), pointSegmentDistance(a.to, b), pointSegmentDistance(b.from, a), pointSegmentDistance(b.to, a));
}
export function boundingBox(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}
export function overlapSegment(a: PathSegment, b: PathSegment): PathSegment | undefined {
  const h = horizontal(a) && horizontal(b) && near(a.from.y, b.from.y);
  const v = vertical(a) && vertical(b) && near(a.from.x, b.from.x);
  if (h || v) {
    const coordinate = (p: Point): number => h ? p.x : p.y;
    const low = Math.max(Math.min(coordinate(a.from), coordinate(a.to)), Math.min(coordinate(b.from), coordinate(b.to)));
    const high = Math.min(Math.max(coordinate(a.from), coordinate(a.to)), Math.max(coordinate(b.from), coordinate(b.to)));
    if (high <= low + EPS) return undefined;
    return { from: h ? { x: low, y: a.from.y } : { x: a.from.x, y: low }, to: h ? { x: high, y: a.from.y } : { x: a.from.x, y: high }, owner: a.owner };
  }
  // Any other collinear pair — a declared straight bundle member against another on the same line
  // (ADR-0017) — is measured along its own direction, so a steep overlap is not lost to an axis. The
  // test is symmetric: both directions are normalised, and each segment's endpoints must lie on the
  // other's line, so the answer cannot depend on which segment is passed first.
  const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
  const lengthA = Math.hypot(ax, ay), lengthB = Math.hypot(bx, by);
  if (lengthA <= EPS || lengthB <= EPS) return undefined;
  const ux = ax / lengthA, uy = ay / lengthA, vx = bx / lengthB, vy = by / lengthB;
  if (Math.abs(ux * vy - uy * vx) > EPS) return undefined;
  const offsetFrom = (origin: Point, nx: number, ny: number) => (p: Point): number => (p.x - origin.x) * -ny + (p.y - origin.y) * nx;
  const onA = offsetFrom(a.from, ux, uy), onB = offsetFrom(b.from, vx, vy);
  if ([b.from, b.to].some(p => Math.abs(onA(p)) > EPS) || [a.from, a.to].some(p => Math.abs(onB(p)) > EPS)) return undefined;
  const along = (p: Point): number => (p.x - a.from.x) * ux + (p.y - a.from.y) * uy;
  const low = Math.max(Math.min(along(a.from), along(a.to)), Math.min(along(b.from), along(b.to)));
  const high = Math.min(Math.max(along(a.from), along(a.to)), Math.max(along(b.from), along(b.to)));
  if (high <= low + EPS) return undefined;
  const at = (d: number): Point => ({ x: a.from.x + ux * d, y: a.from.y + uy * d });
  return { from: at(low), to: at(high), owner: a.owner };
}

/**
 * Whether a chain of axis-aligned runs ever walks back along a run it already drew. An exact
 * reversal of the step before is only the simplest way to do it: two runs that share a line and
 * overlap retrace each other however many corners lie between them. One interval sweep per exact
 * line answers it for the whole chain, and stays linear however many runs share the line.
 *
 * Two pieces of one route may touch at a bend, never share length. Two lines closer than `EPS` are
 * the same line, so those groups are swept together as well — in real geometry there are none.
 *
 * `route/validate` fails a published path for this, and `layout/overlay-paths` refuses a candidate
 * for it, so the producer and the validator read one rule.
 */
export function retracingRuns(runs: readonly { from: Point; to: Point }[]): boolean {
  type Span = { low: number; high: number };
  const overlaps = (spans: Span[]): boolean => {
    let reach = -Infinity;
    for (const span of [...spans].sort((a, b) => a.low - b.low)) {
      if (span.low < reach - EPS) return true;
      reach = Math.max(reach, span.high);
    }
    return false;
  };
  for (const along of [true, false]) {
    const lines = new Map<number, Span[]>();
    for (const run of runs) {
      if (along ? !near(run.from.y, run.to.y) : !near(run.from.x, run.to.x)) continue;
      const line = along ? run.from.y : run.from.x;
      const a = along ? run.from.x : run.from.y, b = along ? run.to.x : run.to.y;
      const group = lines.get(line) ?? [];
      group.push({ low: Math.min(a, b), high: Math.max(a, b) });
      lines.set(line, group);
    }
    const values = [...lines.keys()].sort((a, b) => a - b);
    for (const [index, value] of values.entries()) {
      if (overlaps(lines.get(value)!)) return true;
      for (let next = index + 1; next < values.length && values[next]! - value <= EPS; next++) {
        if (overlaps([...lines.get(value)!, ...lines.get(values[next]!)!])) return true;
      }
    }
  }
  return false;
}
