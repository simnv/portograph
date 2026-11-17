import type { LayoutGroup, LayoutLink, LayoutModel, LayoutPort } from '../../model/layout.js';
import { findPort } from '../row-paths.js';

/**
 * The two ports of a link the rows rule may read as an equation of a seat set (dense-16x9 ticket 36, slice 1), or undefined: a routed link with
 * both port anchors, and no solid-block chord (the block reservation owns a chord: `blockFaces`). `readRow` reads its candidates through it, and
 * the record's provenance (`seatSetFault`, `seatSetDeclinedFault`) proves every stored equation by it (review 3 of ticket 36a).
 */
export function equationEnds(model: LayoutModel, link: LayoutLink): [LayoutPort, LayoutPort] | undefined {
  if (!link.attachments || link.layer !== 'routed' || link.solidBlock) return undefined;
  const a = findPort(model, link.attachments.from), b = findPort(model, link.attachments.to);
  return a?.anchor && b?.anchor ? [a, b] : undefined;
}

/**
 * What the rows rule may read the link between the member port `port` of the row `group` and the port `far` outside it as, by the facts of the
 * placement that do not move (sides, the bundle mark, frames and tiers), or undefined: a `feed` (the member's top port under a bottom port of a
 * node of the same frame on a tier above, no bundle member; a seat or a declined feed), or a `side` (any other link through the member's top or
 * bottom face; a hold, when it stood vertical at stage 6). `readRow` and the record's provenance read it alike.
 */
export function equationKind(model: LayoutModel, group: LayoutGroup, link: LayoutLink, port: LayoutPort, far: LayoutPort): 'feed' | 'side' | undefined {
  const farGroup = model.groups[model.document.nodes[far.ref.node]!.group];
  if (port.side === 'top' && far.side === 'bottom' && !link.bundle && farGroup !== undefined && farGroup.frame === group.frame && farGroup.tier! < group.tier!) return 'feed';
  return port.side === 'top' || port.side === 'bottom' ? 'side' : undefined;
}
