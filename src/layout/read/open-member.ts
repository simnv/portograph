import type { LayoutGroup, LayoutModel } from '../../model/layout.js';
import type { PortRef } from '../../model/document.js';
import { portId } from '../skeleton-graph.js';
import { isCantonFrame } from './canton.js';

/**
 * Why `node`, a member of the rank cell `cell`, can stand in no other slot of its row without stage 4 deciding again, or undefined (dense-16x9 ticket
 * 36, slice 3): every link of the node, of any layer, leaves its bottom face and ends on the top face of a node in the sub-tier directly below the
 * cell, and the cell stands in no canton (a canton is author-fixed, D1). So it has no feed from above and no peer link in the row, and the stage-4
 * premises read its slot only through the rows below (`below` of the reader; `openSlotHeld`). Read by the writer and by `rowOrderFailure`.
 */
export function openMemberFault(model: LayoutModel, cell: LayoutGroup, node: string): string | undefined {
  for (let frame = cell.frame; frame !== undefined; frame = model.document.frames?.[frame]?.parent) if (isCantonFrame(model, frame)) return `${cell.id} stands in a canton`;
  const tierOf = (id: string): number | undefined => model.groups[model.document.nodes[id]?.group ?? '']?.tier;
  const tiers = [...new Set(Object.values(model.groups).filter(group => !group.flank && group.nodes.length > 0 && group.tier !== undefined).map(group => group.tier!))].sort((a, b) => a - b);
  const next = tiers[tiers.indexOf(cell.tier!) + 1];
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || (ends.from.node !== node && ends.to.node !== node)) continue;
    const [mine, theirs] = ends.from.node === node ? [ends.from, ends.to] : [ends.to, ends.from], other = theirs.node;
    if (other === node) return `its link ${link.id} ends on itself`;
    if (cell.nodes.includes(other)) return `its link ${link.id} is a peer link in the row`;
    if (next === undefined || tierOf(other) !== next) return `its link ${link.id} ends on ${other}, outside the sub-tier directly below`;
    const side = (ref: PortRef) => model.nodes[ref.node]?.ports.find(port => portId(port.ref) === portId(ref))?.side;
    const near = side(mine), far = side(theirs);
    if (near !== 'bottom') return `its link ${link.id} leaves its ${near ?? 'unplaced'} face`;
    if (far !== 'top') return `its link ${link.id} ends on a ${far ?? 'unplaced'} face of ${other}`;
  }
  return undefined;
}

/**
 * The first place (0-based) of the row `order` at which `node` would change what stage 4 decides below the cell `cell`, or undefined when no slot does
 * (dense-16x9 ticket 36, slice 3): `below` is stage 4's own reader (`belowReader`: the pair under the cell, the feed order of each row it feeds, the
 * frame orders). The one proof of the writer (`withOpen`) and of every read of the record (`rowOrderFailure`, review 1 of slice 3); each slot once (R4).
 */
export function openSlotHeld(cell: LayoutGroup, node: string, order: readonly string[], below: (cell: LayoutGroup, order: readonly string[]) => string,
  today: string = below(cell, order)): number | undefined {
  const rest = order.filter(id => id !== node);
  for (let slot = 0; slot <= rest.length; slot++) {
    const variant = [...rest.slice(0, slot), node, ...rest.slice(slot)];
    if (variant.some((id, i) => id !== order[i]) && below(cell, variant) !== today) return slot;
  }
  return undefined;
}

/** The open members of the cell `row` (its `rowOrder` entry's `open`), empty for a row with none. */
export function openMembers(reservations: readonly { kind: string; payload: unknown }[] | undefined, row: string): ReadonlySet<string> {
  const entry = (reservations ?? []).find(item => item.kind === 'rowOrder' && (item.payload as { cell?: string }).cell === row);
  return new Set((entry?.payload as { open?: readonly string[] } | undefined)?.open ?? []);
}
