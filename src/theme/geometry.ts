import type { LayoutLink, LayoutModel, LayoutPath } from '../model/layout.js';

/** Shared by scoring and rendering; layout may store per-element overrides. */
export const DEFAULT_STROKE_WIDTHS = {
  /** Node body outline; Lucide's technical weight (ticket 34, from 2). */
  node: 1.5,
  path: 1.5,
  pill: 1,
  group: 1,
  /** Icon glyph stroke, the same technical weight as the body (ticket 34, from 2). */
  glyph: 1.5,
} as const;

/** Corner radii. Industry's radius token is 4 px (ticket 34: node from 8, group from 10, pill from 3). */
export const CORNER_RADII = {
  node: 4,
  group: 4,
  pill: 2,
  /** The icon tile inside a node keeps its small radius. */
  tile: 2,
} as const;

/**
 * The one effective stroke width of a link, used by placement, the gates, the scorer and the
 * renderer alike. Stage 1 resolves the author's `weight` multiplier onto the link, so every rule
 * that reserves stroke-aware space sees the real width before any path exists; a path built later
 * carries the same number, and an explicit path override still wins.
 */
export const linkStrokeWidth = (link: Pick<LayoutLink, 'path' | 'strokeWidth'>): number =>
  link.path?.strokeWidth ?? link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path;

/** The width a new path for this link must carry; omitted when it is the shared default. */
export function pathStrokeWidth(link: Pick<LayoutLink, 'path' | 'strokeWidth'>): Pick<LayoutPath, 'strokeWidth'> {
  const width = linkStrokeWidth(link);
  return width === DEFAULT_STROKE_WIDTHS.path ? {} : { strokeWidth: width };
}

/**
 * The dot a link end on an anonymous port is drawn with (`render.anonymousPortMarker: dot`). draw.io states it as
 * `oval` with this `endSize`; the SVG draws a circle of the same visual size. Paint only: no geometry reads it.
 */
export const ANONYMOUS_DOT_SIZE = 6;
/** Radius of the SVG circle that matches draw.io's `oval` marker of `ANONYMOUS_DOT_SIZE` on a stroke of this width (measured, draw.io 31.4.5: diameter = size + stroke width). */
export const anonymousDotRadius = (strokeWidth: number): number => (ANONYMOUS_DOT_SIZE + strokeWidth) / 2;

/** Radius of the mark stage 11 draws at each overlay endpoint, above the masked overlay layer. */
export const OVERLAY_ENDPOINT_RADIUS = 2;
/**
 * The visible gap an overlay line keeps beyond what is drawn at a port (architecture-2 ticket 23): past the endpoint dot when it
 * steps out of a face, and between two parallel overlay strokes on neighbouring tracks. Twice the endpoint mark's radius.
 */
export const OVERLAY_GAP = 2 * OVERLAY_ENDPOINT_RADIUS;
/**
 * The **overlay port clearance** of a link of this stroke (architecture-2 ticket 23, user 2026-10-23: *"it's better for link to step a
 * bit more from side of a node"*): how far the orthogonal branch of the overlay rule steps out of a port's outward face before it turns,
 * and the margin its ways round the pair keep from every shape. The widest thing drawn at the end is the dot of a bare end
 * (`anonymousDotRadius`, stroke + 6 px across), so the step clears that dot by `OVERLAY_GAP`: 7.75 px at the default 1.5 px stroke.
 * Placement and the overlay path derivation read this one function (R1).
 */
export const overlayPortClearance = (strokeWidth: number): number => anonymousDotRadius(strokeWidth) + OVERLAY_GAP;
/**
 * The **overlay track pitch** of two overlay strokes (architecture-2 ticket 23): the least distance between the centre lines of two
 * collinear overlay runs, half of each stroke plus `OVERLAY_GAP`. Two runs on one axis nearer than this, whose spans overlap or meet
 * end to end within it, share a track and read as one line.
 */
export const overlayTrackPitch = (one: number, two: number): number => (one + two) / 2 + OVERLAY_GAP;
/**
 * The one uniform margin between everything the diagram paints and the canvas edge (ticket 28). The
 * skeleton starts the canvas at this padding; stage 9 refits the canvas to the drawn union plus this
 * margin on every side, so growth during placement leaves no dead space and no side without margin.
 */
export const CANVAS_MARGIN = 12;
/**
 * A group title owns a link-free margin around its measured text. Placement keeps labels this far
 * from every reserved link geometry, routing treats the margin as part of the label obstacle, and
 * G3 fails a routed segment that enters it (maintainer M1 visual review, 2026-09-11).
 */
export const GROUP_LABEL_LINK_CLEARANCE = 8;
/**
 * Group boxes are geometry links respect (ADR-0013). A routed link never enters a group it does not
 * attach inside: stage 8 treats the foreign box, grown by this margin, as an obstacle and G2 fails a
 * segment inside it. No routed segment runs along any group edge from on or outside the box — parallel
 * to it and closer than this — and G6 fails one that does; turns inside a group's own padding and
 * perpendicular crossings at ports stay free.
 */
export const GROUP_EDGE_LINK_CLEARANCE = 10;

/**
 * The widest routed stroke a placement must keep clear; reservations may not assume less.
 *
 * Memoised on the link array, because placement asks for this number inside per-node, per-port and
 * per-pair loops, and the scan is over every link. One array identity has one answer: `family`,
 * `layer` and `strokeWidth` are written by `resolve` in stage 1 alone, the mutation transaction's
 * `semantics()` equality holds all three from stage 5 on, and a path built later carries its own
 * link's width (`pathStrokeWidth`, which `route/validate` enforces).
 *
 * The rule a future caller must keep: do not write `family`, `layer` or `strokeWidth` on a link
 * after stage 1 and then read this on the same array. Replace the array instead, as every
 * transaction does.
 */
const widestRoutedStroke = new WeakMap<readonly LayoutLink[], number>();
export function routedStrokeWidth(model: Pick<LayoutModel, 'links'>): number {
  const memo = widestRoutedStroke.get(model.links);
  if (memo !== undefined) return memo;
  let widest: number = DEFAULT_STROKE_WIDTHS.path;
  for (const link of model.links) {
    if ((link.layer ?? link.family) === 'overlay') continue;
    const width = linkStrokeWidth(link);
    if (width > widest) widest = width;
  }
  widestRoutedStroke.set(model.links, widest);
  return widest;
}
