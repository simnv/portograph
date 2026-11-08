import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { effectiveLayer, linkPort } from '../score/model.js';
import { isRoutedChord } from './frame-paths.js';
import { EPS } from '../geometry/planar.js';
import { overlayEnd, overlayEndpoint } from './overlay-paths.js';

/**
 * The path-end rule (D-Q7, audit T-05), by producer. Every reader of a link end reads this module:
 * the stage-8 validator, G7 `endpoint-anchor`, the score's incident-segment test, the SVG and draw.io.
 *
 * - A **stem-built** path (orthogonal, bundle, merge, and a straight link drawn anchor to anchor with
 *   its stems) ends on the port **anchor**. The pill is painted over the inner half of the stem.
 * - A **chord-built** path (an overlay path, and a routed chord: straight, fan family, direct family)
 *   ends on the port's own **outward face** (`overlayEndpoint`). The overlay layer is masked out of
 *   the pill, and a chord has no stem, so a run inside the pill would never be drawn.
 *
 * An end on an **approach** (ticket 15, phase 6) is read from the virtual port `linkPort` gives: its
 * anchor stands on the pill's tangential edge, so the anchor and the face are one point.
 */

/** Whether `link` is chord-built: its path ends on the port faces, not on the anchors. */
export const chordBuilt = (model: LayoutModel, link: LayoutLink): boolean =>
  effectiveLayer(link) !== 'routed' || isRoutedChord(model, link);

/**
 * The point the published path of `link` must start (`from`) or end (`to`) on: the anchor for a
 * stem-built path, the outward face for a chord-built one. An end with no side has no face and keeps
 * its anchor. `undefined` when the end names a missing port or a port with no anchor.
 */
export function pathEnd(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): Point | undefined {
  const port = linkPort(model, link, end);
  if (port?.anchor === undefined) return undefined;
  return (chordBuilt(model, link) ? overlayEndpoint(model.nodes[port.ref.node], port) : undefined) ?? port.anchor;
}

/**
 * Where the stroke of `link` is seen to end at `end`: the point every renderer pins or marks the end
 * on. A chord-built path and an end on an approach already end on that point, so it is the path end.
 * A stem-built path on a port that draws a pill is seen from the first point where it leaves the
 * pill: the pill's outward face on the path's own stem, or the stem end itself when the stem is
 * shorter than the pill's half depth and the path turns or runs on inside the pill (a 15 px stem
 * beside a 31 px pill). On an anonymous port, or a port that draws no pill, the stroke runs to the
 * path end itself. The renderers draw the reserved path; this point only says where the visible part
 * of it begins, and it is always a point of the path. `undefined` when the link has no path.
 */
export function visibleEnd(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): Point | undefined {
  const segments = link.path?.segments;
  if (!segments?.length) return undefined;
  const first = end === 'from' ? segments[0]! : segments.at(-1)!;
  const at = end === 'from' ? first.from : first.to, stemEnd = end === 'from' ? first.to : first.from;
  // A hand-built model may state no attachments; its end is then the path end, as the renderers always drew it.
  if (link.attachments === undefined || link.approach?.[end] !== undefined || chordBuilt(model, link)) return at;
  const port = linkPort(model, link, end), node = port ? model.nodes[port.ref.node] : undefined;
  if (!port?.pill || port.ref.anonymous === true || !port.side || !node) return at;
  const pill = overlayEnd(node, port);
  if (pill === undefined) return at;
  // Depth along the stem, from the path end outward: the face stands at the pill's half depth.
  const depth = (point: Point): number => (point.x - at.x) * pill.out.x + (point.y - at.y) * pill.out.y;
  return depth(stemEnd) < depth(pill.face) - EPS ? stemEnd : pill.face;
}
