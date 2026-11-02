import type { Point } from '../model/geometry.js';
import type { LayoutLabel } from '../model/layout.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';

/**
 * A diagonal may cross text (ticket 162, ADR-0023, the owner's rule of 2026-10-31). This module holds the one predicate every
 * stage reads (R1): the title planner of 7f, the chord checks of 7f, the label room of 7f, stage 9's label placement and G3.
 * It imports no producer, so every reader may import it.
 */

/**
 * The least angle, in degrees, between a diagonal and each axis (the coordinator's ruling on ticket 162). A segment nearer an axis
 * reads as that axis and keeps the orthogonal rules, so a shallow chord never lies along a label's baseline or a title's letters.
 */
export const DIAGONAL_MIN_DEGREES = 10;
const SLOPE = Math.tan(DIAGONAL_MIN_DEGREES * Math.PI / 180);

/**
 * A segment that is a diagonal for this rule: a straight line at least `DIAGONAL_MIN_DEGREES` from both axes (an overlay chord, a
 * routed chord, a straight member).
 */
export function isDiagonal(segment: { from: Point; to: Point }): boolean {
  const dx = Math.abs(segment.to.x - segment.from.x), dy = Math.abs(segment.to.y - segment.from.y);
  return dx > PLACEMENT_EPS && dy > PLACEMENT_EPS && dy >= SLOPE * dx - PLACEMENT_EPS && dx >= SLOPE * dy - PLACEMENT_EPS;
}

/** The text a reader asks about: its role, and its owner where the role alone does not say whose it is. */
export type CrossedText = { role?: LayoutLabel['role']; owner?: { kind: string } };

/** A group title (a frame or canton title too), as the title planner and the chord checks ask before the title has a label. */
export const GROUP_TITLE: CrossedText = { role: 'group' };
/** A link's own authored label, as 7f asks before stage 9 has placed it. */
export const LINK_LABEL: CrossedText = { role: 'link', owner: { kind: 'link' } };

/**
 * The text a diagonal may cross: a group title, or a link label that its link owns. A multiplicity label (owned by a bundle), a bus
 * label, a node, description or pill label and the legend keep their rules.
 */
export function crossableText(text: CrossedText): boolean {
  return text.role === 'group' || (text.role === 'link' && text.owner?.kind === 'link');
}

/**
 * Whether this segment may cross this text: the segment is a diagonal and the text is a group title or a link label. Such a crossing
 * is allowed and is no fault; the text keeps its readability through its halo (stage 11). An orthogonal segment keeps its rules.
 */
export function diagonalMayCross(segment: { from: Point; to: Point }, text: CrossedText): boolean {
  return crossableText(text) && isDiagonal(segment);
}

/**
 * The link-free margin a text owns beyond its box: a group title keeps `GROUP_LABEL_LINK_CLEARANCE` clear of every link it may not be
 * crossed by; any other text keeps none. G3 reads it (R1).
 */
export function linkFreeMargin(text: CrossedText): number {
  return text.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0;
}
