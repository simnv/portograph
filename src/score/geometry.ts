import type { PathSegment, Point, Rect } from '../model/index.js';

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
  if (!h && !v) return undefined;
  const coordinate = (p: Point): number => h ? p.x : p.y;
  const low = Math.max(Math.min(coordinate(a.from), coordinate(a.to)), Math.min(coordinate(b.from), coordinate(b.to)));
  const high = Math.min(Math.max(coordinate(a.from), coordinate(a.to)), Math.max(coordinate(b.from), coordinate(b.to)));
  if (high <= low + EPS) return undefined;
  return { from: h ? { x: low, y: a.from.y } : { x: a.from.x, y: low }, to: h ? { x: high, y: a.from.y } : { x: a.from.x, y: high }, owner: a.owner };
}
