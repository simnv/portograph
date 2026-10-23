import type { PathSegment, Point, Rect } from '../model/index.js';
import { EPS, bottom, pointSegmentDistance, rectDistance, rectOverlap, right, segmentRect, segmentRectDistance } from './planar.js';

/**
 * A rectangle `width` x `height` turned by `degrees` about `centre` (architecture-2 ticket 20): the area the text of a turned
 * label really occupies. Its upright box is `orientedBounds`.
 */
export interface OrientedBox { centre: Point; width: number; height: number; degrees: number }

/**
 * The area a label is tested by: its stored upright box, or the turned rectangle of a label whose heading is not 0 or ±90.
 * Every predicate below takes either. Two upright boxes go to the `planar.ts` predicates unchanged, so an upright label gives
 * exactly the results it gave before ticket 20.
 */
export type Area = Rect | OrientedBox;

export const isOriented = (area: Area): area is OrientedBox => 'degrees' in area;

/** The four corners of `box`, in order round the rectangle. */
export function orientedCorners(box: OrientedBox): Point[] {
  const radians = box.degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const hw = box.width / 2, hh = box.height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => ({ x: box.centre.x + a! * cos - b! * sin, y: box.centre.y + a! * sin + b! * cos }));
}

/** The upright box of `box`. */
export function orientedBounds(box: OrientedBox): Rect {
  const radians = box.degrees * Math.PI / 180, cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const width = box.width * cos + box.height * sin, height = box.width * sin + box.height * cos;
  return { x: box.centre.x - width / 2, y: box.centre.y - height / 2, width, height };
}

const rectCorners = (box: Rect): Point[] => [{ x: box.x, y: box.y }, { x: right(box), y: box.y }, { x: right(box), y: bottom(box) }, { x: box.x, y: bottom(box) }];
const corners = (area: Area): Point[] => isOriented(area) ? orientedCorners(area) : rectCorners(area);

/** The edge normals of a convex polygon (not normalised; a zero edge gives none). */
function axes(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, dx = b.x - a.x, dy = b.y - a.y, size = Math.hypot(dx, dy);
    if (size > 0) result.push({ x: -dy / size, y: dx / size });
  }
  return result;
}

function project(points: readonly Point[], axis: Point): [number, number] {
  let low = Infinity, high = -Infinity;
  for (const p of points) { const at = p.x * axis.x + p.y * axis.y; low = Math.min(low, at); high = Math.max(high, at); }
  return [low, high];
}

/**
 * The separating-axis test of two convex polygons: the least overlap of their projections over the edge normals of both, in pixels.
 * Positive when they overlap by that much on every axis, zero or negative when one axis separates them (touching gives zero).
 */
function overlapDepth(a: readonly Point[], b: readonly Point[]): number {
  let depth = Infinity;
  for (const axis of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, axis), [b0, b1] = project(b, axis);
    depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0));
  }
  return depth;
}

/** True when the two areas overlap by more than `EPS` (open overlap, as `rectOverlap`). */
export function areaOverlap(a: Area, b: Area): boolean {
  if (!isOriented(a) && !isOriented(b)) return rectOverlap(a, b);
  return overlapDepth(corners(a), corners(b)) > EPS;
}

/** True when segment `s` meets the closed area, contact within `EPS` included (as `segmentRect`). */
export function areaSegment(s: PathSegment, area: Area): boolean {
  if (!isOriented(area)) return segmentRect(s, area);
  return overlapDepth([s.from, s.to], orientedCorners(area)) >= -EPS;
}

/** The distance between the closed polygons `a` and `b`, zero when they meet. */
function polygonDistance(a: readonly Point[], b: readonly Point[]): number {
  if (overlapDepth(a, b) >= -EPS) return 0;
  const owner: PathSegment['owner'] = { kind: 'link', id: '' };
  const edges = (points: readonly Point[]): PathSegment[] => points.length === 2
    ? [{ from: points[0]!, to: points[1]!, owner }]
    : points.map((p, i) => ({ from: p, to: points[(i + 1) % points.length]!, owner }));
  let best = Infinity;
  for (const p of a) for (const edge of edges(b)) best = Math.min(best, pointSegmentDistance(p, edge));
  for (const p of b) for (const edge of edges(a)) best = Math.min(best, pointSegmentDistance(p, edge));
  return best;
}

/** The distance between two areas, zero when they meet (as `rectDistance`). */
export function areaDistance(a: Area, b: Area): number {
  if (!isOriented(a) && !isOriented(b)) return rectDistance(a, b);
  return polygonDistance(corners(a), corners(b));
}

/** The distance from segment `s` to the area, zero when it meets it (as `segmentRectDistance`). */
export function areaSegmentDistance(s: PathSegment, area: Area): number {
  if (!isOriented(area)) return segmentRectDistance(s, area);
  return polygonDistance([s.from, s.to], orientedCorners(area));
}

/** True when every corner of the area lies in `box`, within `EPS`. */
export function areaInside(area: Area, box: Rect): boolean {
  return corners(area).every(p => p.x >= box.x - EPS && p.x <= right(box) + EPS && p.y >= box.y - EPS && p.y <= bottom(box) + EPS);
}

/** The upright box of an area. */
export const areaBounds = (area: Area): Rect => isOriented(area) ? orientedBounds(area) : area;
