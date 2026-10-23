import type { NormalisedDocument } from '../model/document.js';
import type { LayoutLink } from '../model/layout.js';

/**
 * The one predicate behind the dot of `render.anonymousPortMarker` (ADR-0002, R1): which ends of a link are bare, that is end on an
 * anonymous port, and so closed by a dot. The SVG and the draw.io writer both ask it, so they cannot disagree. A link of either
 * family has the same answer; an overlay end that is bare takes the dot in place of its small end mark, so one dot shows.
 */
export function dotEnds(document: Pick<NormalisedDocument, 'render'>, link: Pick<LayoutLink, 'attachments'>): readonly ('from' | 'to')[] {
  if (document.render?.anonymousPortMarker === 'none' || link.attachments === undefined) return [];
  return (['from', 'to'] as const).filter(end => link.attachments![end].anonymous === true);
}
