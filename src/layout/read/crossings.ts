import type { Point } from '../../model/geometry.js';
import type { LayoutModel, PathSegment } from '../../model/layout.js';
import { EPS, intersection, samePoint } from '../../geometry/planar.js';

/**
 * Shared readers: how many crossings. "A crossing" is several quantities, and each is a named mode. They share
 * the geometric primitives (`intersection`, `samePoint` of `geometry/planar.ts`) and nothing else; a count of one mode
 * is no estimate of another's. The modes, with the readers that live elsewhere and keep their own meaning:
 *
 * | mode | counts | reader |
 * | --- | --- | --- |
 * | strict segment crossing | two segments that meet at a point that is no end of either | `strictCrossing` (here) |
 * | links crossed by one link | other links, once each, whatever the number of points | `crossingsOf` (here), the side judge |
 * | pairs of overlay paths | a pair once, a meeting at least `EPS` from the ends of both segments | `overlayCrossingPairs` (here), the 7f rank move |
 * | points of drawn overlay links | each distinct point, shared-port pairs excluded | `overlayCrossingPoints` (here), the overlay window |
 * | published routed crossings | the set of (pair, point) over routed segments | `metrics` in `src/score/metrics.ts` |
 * | order inversions between two tiers | routed links as centre lines, a sign flip | `regionCrossings` in `overlay-order.ts` |
 * | endpoint-order inversions | the bundle channel's | `bundleCrossings` in `bundle-paths.ts` |
 * | chord clearance | closeness of two chords, strokes included | `chordsApart` in `frame-paths.ts` |
 * | router plan | a gap crossing the interior of a rectangle | `gapCrosses` / `crossesInterior` in `route/plan.ts` |
 * | render note | a crossing the picture notes | `noteCrossings` in `render/index.ts` |
 */

/** Whether two routed segments cross strictly: crossing is allowed, closeness is not (G6). A meeting at an end of either is no crossing. */
export function strictCrossing(a: PathSegment, b: PathSegment): boolean {
  const point = intersection(a, b);
  return point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
}

/** How many other links a routed link crosses (no slack, both paths as published). Mode: links crossed by one link. */
export function crossingsOf(model: LayoutModel, id: string): number {
  const one = model.links.find(link => link.id === id)?.path?.segments;
  if (one === undefined) return 0;
  return model.links.filter(other => other.id !== id && other.path !== undefined && other.removed !== true
    && one.some(a => other.path!.segments.some(b => strictCrossing(a, b)))).length;
}

/** A path as the pair count reads it: its segments. */
export type Trace = readonly { from: { x: number; y: number }; to: { x: number; y: number } }[];

/**
 * Mode `pairs`. The pairs of paths that cross: one segment of one meets one segment of the other in a point that is inside both (at
 * least EPS from each end). A touch at an end, and parallel segments, are no crossing. A pair counts once, and a pair that shares a
 * port counts like any other. Read by the 7f rank move (`chord-clear.ts`).
 */
export function overlayCrossingPairs(paths: readonly Trace[]): number {
  let found = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const meets = paths[i]!.some(a => paths[j]!.some(b => {
      // A crossing lies inside both segments, so boxes that do not meet hold none.
      if (Math.max(a.from.x, a.to.x) < Math.min(b.from.x, b.to.x) || Math.max(b.from.x, b.to.x) < Math.min(a.from.x, a.to.x)
        || Math.max(a.from.y, a.to.y) < Math.min(b.from.y, b.to.y) || Math.max(b.from.y, b.to.y) < Math.min(a.from.y, a.to.y)) return false;
      const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
      const d = ax * by - ay * bx;
      if (Math.abs(d) < 1e-9) return false;
      const cx = b.from.x - a.from.x, cy = b.from.y - a.from.y;
      const t = (cx * by - cy * bx) / d, u = (cx * ay - cy * ax) / d;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      return t * la > EPS && (1 - t) * la > EPS && u * lb > EPS && (1 - u) * lb > EPS;
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
