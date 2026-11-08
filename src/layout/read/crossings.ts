import type { Point } from '../../model/geometry.js';
import type { LayoutModel } from '../../model/layout.js';
import { EPS, intersection, type Piece } from '../../geometry/planar.js';

/**
 * Shared readers: how many crossings. "A crossing" is several quantities, and each is a named mode. They share
 * the geometric primitives (`intersection` and `EPS` of `geometry/planar.ts`) and nothing else; a count of one mode
 * is no estimate of another's. The modes, with the readers that live elsewhere and keep their own meaning:
 *
 * | mode | counts | reader |
 * | --- | --- | --- |
 * | strict segment crossing | two segments that meet at a point that is no end of either | `strictCrossing` (here) |
 * | crossed polylines | two polylines with one strict segment crossing, a pair once | `polylinesCross` (here), the course round |
 * | links crossed by one link | other links, once each, whatever the number of points | `crossingsOf` (here), the side judge |
 * | pairs of overlay paths | a pair once, with one strict segment crossing | `overlayCrossingPairs` (here), the 7f rank move |
 * | points of drawn overlay links | each distinct point, shared-port pairs excluded | `overlayCrossingPoints` (here), the overlay window |
 * | published routed crossings | the set of (pair, point) over routed segments | `metrics` in `src/score/metrics.ts` |
 * | order inversions between two tiers | routed links as centre lines, a sign flip | `regionCrossings` in `overlay-order.ts` |
 * | endpoint-order inversions | the bundle channel's | `bundleCrossings` in `bundle-paths.ts` |
 * | chord clearance | closeness of two chords, strokes included | `chordsApart` in `frame-paths.ts` |
 * | router plan | a gap crossing the interior of a rectangle | `gapCrosses` / `crossesInterior` in `route/plan.ts` |
 * | render note | a crossing the picture notes | `noteCrossings` in `render/index.ts` |
 */

/**
 * Whether two segments cross strictly: crossing is allowed, closeness is not (G6). The one proper-crossing predicate (D-Q6). Each segment
 * has its two ends on opposite sides of the other's line, each end farther than the planar `EPS` from that line. The bound is a distance
 * in pixels, never a fraction of a segment, so a crossing 5 px inside a long segment counts. A meeting at an end of either is no crossing,
 * and neither is a pair that never leaves `EPS` of each other's line: a collinear overlap, a residue tilt, two near-parallel segments
 * (they do not depend on an exact zero determinant, DR-12 review).
 */
export function strictCrossing(a: Piece, b: Piece): boolean {
  return straddles(a, b) && straddles(b, a);
}
/** Whether the ends of `b` stand on opposite sides of the line of `a`, each farther than `EPS` from it. A segment with no length has no line. */
function straddles(a: Piece, b: Piece): boolean {
  const dx = a.to.x - a.from.x, dy = a.to.y - a.from.y, length = Math.hypot(dx, dy);
  if (length <= EPS) return false;
  const side = (p: Point): number => ((p.x - a.from.x) * dy - (p.y - a.from.y) * dx) / length;
  const one = side(b.from), two = side(b.to);
  return (one > EPS && two < -EPS) || (one < -EPS && two > EPS);
}

/** How many other links a routed link crosses (no slack, both paths as published). Mode: links crossed by one link. */
export function crossingsOf(model: LayoutModel, id: string): number {
  const one = model.links.find(link => link.id === id)?.path?.segments;
  if (one === undefined) return 0;
  return model.links.filter(other => other.id !== id && other.path !== undefined && other.removed !== true
    && one.some(a => other.path!.segments.some(b => strictCrossing(a, b)))).length;
}

/**
 * Mode `crossed polylines`. Whether two polylines, given by their points, cross: one piece of one crosses one piece of the other strictly
 * (`strictCrossing`). The aggregation is per pair: a pair that crosses at several points is one. A shared end or a shared stem is no
 * crossing. Read by the course round (`course-measure.ts`), which counts the links one polyline crosses.
 */
export function polylinesCross(a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    if (strictCrossing({ from: a[i - 1]!, to: a[i]! }, { from: b[j - 1]!, to: b[j]! })) return true;
  }
  return false;
}

/** A path as the pair count reads it: its segments. */
export type Trace = readonly { from: { x: number; y: number }; to: { x: number; y: number } }[];

/**
 * Mode `pairs`. The pairs of paths that cross: one segment of one crosses one segment of the other strictly (`strictCrossing`). A
 * touch at an end, and parallel segments, are no crossing. A pair counts once, and a pair that shares a port counts like any other. Read
 * by the 7f rank move (`chord-clear.ts`).
 */
export function overlayCrossingPairs(paths: readonly Trace[]): number {
  let found = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const meets = paths[i]!.some(a => paths[j]!.some(b => {
      // A crossing lies inside both segments, so boxes that do not meet hold none.
      if (Math.max(a.from.x, a.to.x) < Math.min(b.from.x, b.to.x) || Math.max(b.from.x, b.to.x) < Math.min(a.from.x, a.to.x)
        || Math.max(a.from.y, a.to.y) < Math.min(b.from.y, b.to.y) || Math.max(b.from.y, b.to.y) < Math.min(a.from.y, a.to.y)) return false;
      return strictCrossing(a, b);
    }));
    if (meets) found++;
  }
  return found;
}

/** The port a link end attaches to, as one string: two links that share it meet at its face and do not cross there. */
export const portKey = (end: { node: string; name?: string; ordinal?: number }): string => `${end.node}/${end.name ?? `#${end.ordinal}`}`;

/** An overlay link drawn as a polyline, with its bounding box and its two port keys read once. */
export interface Drawn { points: readonly Point[]; minX: number; maxX: number; minY: number; maxY: number; ports: readonly [string, string] }

export function drawn(points: readonly Point[], ports: readonly [string, string]): Drawn {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { points, minX, maxX, minY, maxY, ports };
}

const OWNER = { kind: 'link', id: '' } as const;

/**
 * Mode `points`. The crossings of two drawn links: the points where their segments meet, each counted once (a line through a bend point
 * meets two segments there). Links that share a port meet at its face and do not cross. A pair can count twice. Read by the overlay
 * window (`overlay-window.ts`) and the overlay placement's state (`overlay-place.ts`).
 */
export function drawnCrossings(one: Drawn, two: Drawn): number {
  if (one.minX > two.maxX + EPS || two.minX > one.maxX + EPS || one.minY > two.maxY + EPS || two.minY > one.maxY + EPS) return 0;
  if (one.ports[0] === two.ports[0] || one.ports[0] === two.ports[1] || one.ports[1] === two.ports[0] || one.ports[1] === two.ports[1]) return 0;
  const a = { from: one.points[0]!, to: one.points[0]!, owner: OWNER }, b = { from: two.points[0]!, to: two.points[0]!, owner: OWNER };
  let found: Point[] | undefined;
  for (let i = 1; i < one.points.length; i++) {
    a.from = one.points[i - 1]!; a.to = one.points[i]!;
    for (let j = 1; j < two.points.length; j++) {
      b.from = two.points[j - 1]!; b.to = two.points[j]!;
      const at = intersection(a, b);
      if (at && !found?.some(point => Math.abs(point.x - at.x) <= 2 * EPS && Math.abs(point.y - at.y) <= 2 * EPS)) (found ??= []).push(at);
    }
  }
  return found?.length ?? 0;
}

/** Mode `points`, over many: the crossings among drawn overlay links, each pair once. */
export function overlayCrossingPoints(paths: readonly Drawn[]): number {
  let count = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) count += drawnCrossings(paths[i]!, paths[j]!);
  return count;
}
