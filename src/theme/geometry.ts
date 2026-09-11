import type { LayoutLink, LayoutModel, LayoutPath } from '../model/layout.js';

/** Shared by scoring and rendering; layout may store per-element overrides. */
export const DEFAULT_STROKE_WIDTHS = {
  node: 2,
  path: 1.5,
  pill: 1,
  group: 1,
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
 * A group title owns a link-free margin around its measured text. Placement keeps labels this far
 * from every reserved link geometry, routing treats the margin as part of the label obstacle, and
 * G3 fails a routed segment that enters it (maintainer M1 visual review, 2026-09-11).
 */
export const GROUP_LABEL_LINK_CLEARANCE = 8;

/** The widest routed stroke a placement must keep clear; reservations may not assume less. */
export function routedStrokeWidth(model: Pick<LayoutModel, 'links'>): number {
  return Math.max(DEFAULT_STROKE_WIDTHS.path,
    ...model.links.filter(link => (link.layer ?? link.family) !== 'overlay').map(linkStrokeWidth));
}
