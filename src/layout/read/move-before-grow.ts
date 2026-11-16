import type { LayoutModel } from '../../model/layout.js';

/**
 * The one reader of `layout.moveBeforeGrow` (ADR-0027, an opt-in until ticket 15). True: the alignment of 7c moves a node inside the slack of
 * its row before it grows one, and its seat owns the body (`alignmentSeats`, the cap of 5 times). False, the default: a body grows in place
 * up to `ALIGNMENT_MAX_GROWTH` times its own width, and the centre rule gives back a stranded growth (`givenBack`, ticket 71).
 */
export function moveBeforeGrow(model: Pick<LayoutModel, 'document'>): boolean {
  return model.document.layout?.moveBeforeGrow === true;
}
