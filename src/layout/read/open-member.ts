import type { LayoutGroup, LayoutModel } from '../../model/layout.js';
import type { PortRef } from '../../model/document.js';
import { portId } from '../skeleton-graph.js';
import { isCantonFrame } from './canton.js';

/**
 * Why the sheet opens no member at all, or undefined (review 2 of slice 3): the slot of an open member is a freedom of `layout.moveBeforeGrow` only, and
 * an authored row order stands (`layout.feedOrder: false`, `layout.corridorRowOrder: false`, the settings `readsBelow` of stage 4 reads). The writer
 * (`withOpen`) and every read of the record (`openMemberFault`) read these clauses here.
 */
export function openScopeFault(model: LayoutModel): string | undefined {
  const layout = model.document.layout;
  if (layout?.moveBeforeGrow !== true) return 'the sheet does not opt in (layout.moveBeforeGrow)';
  if (layout.feedOrder === false) return 'the author keeps the row orders (layout.feedOrder: false)';
  if (layout.corridorRowOrder === false) return 'the author keeps the row orders (layout.corridorRowOrder: false)';
  return undefined;
}

/**
 * Why `node`, a member of the rank cell `cell`, can stand in no other slot of its row without stage 4 deciding again, or undefined (dense-16x9 ticket
 * 36, slice 3): the sheet opens members (`openScopeFault`), every link of the node, of any layer, leaves its bottom face and ends on the top face of a
 * node in the sub-tier directly below the cell, no end of a link has an authored port order (the author seats that port; a slot change would leave it
 * out of the order of its far ends), and the cell stands in no canton (a canton is author-fixed, D1). So it has no feed from above and no peer link in
 * the row, and the stage-4 premises read its slot only through the rows below (`below` of the reader; `openSlotHeld`). Read by the writer and by
 * `rowOrderFailure`.
 */
export function openMemberFault(model: LayoutModel, cell: LayoutGroup, node: string): string | undefined {
  const scope = openScopeFault(model);
  if (scope !== undefined) return scope;
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
    const port = (ref: PortRef) => model.nodes[ref.node]?.ports.find(item => portId(item.ref) === portId(ref));
    const near = port(mine), far = port(theirs);
    if (near?.side !== 'bottom') return `its link ${link.id} leaves its ${near?.side ?? 'unplaced'} face`;
    if (far?.side !== 'top') return `its link ${link.id} ends on a ${far?.side ?? 'unplaced'} face of ${other}`;
    for (const [end, ref] of [[near, mine], [far, theirs]] as const)
      if (end.authorOrder !== undefined) return `its link ${link.id} ends on ${ref.node}.${ref.name}, a port with an authored order`;
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
