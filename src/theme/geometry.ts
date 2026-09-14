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

/** Radius of the mark stage 11 draws at each overlay endpoint, above the masked overlay layer. */
export const OVERLAY_ENDPOINT_RADIUS = 2;
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

/** The widest routed stroke a placement must keep clear; reservations may not assume less. */
export function routedStrokeWidth(model: Pick<LayoutModel, 'links'>): number {
  return Math.max(DEFAULT_STROKE_WIDTHS.path,
    ...model.links.filter(link => (link.layer ?? link.family) !== 'overlay').map(linkStrokeWidth));
}
