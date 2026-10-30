import type { Point } from '../model/geometry.js';
import type { LayoutLabel } from '../model/layout.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * A diagonal may cross text (ticket 162, ADR-0023, the owner's rule of 2026-10-31). This module holds the one predicate every
 * stage reads (R1): the title planner of 7f, the chord checks of 7f, the label room of 7f, stage 9's label placement and G3.
 * It imports no producer, so every reader may import it.
 */

/** A segment with no axis: a straight, non-orthogonal line (an overlay chord, a routed chord, a straight member). */
export function isDiagonal(segment: { from: Point; to: Point }): boolean {
  return Math.abs(segment.to.x - segment.from.x) > PLACEMENT_EPS && Math.abs(segment.to.y - segment.from.y) > PLACEMENT_EPS;
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
