import type { LayoutGroup, LayoutModel } from '../../model/layout.js';

/**
 * Why `node`, a member of the rank cell `cell`, can stand in no other slot of its row without stage 4 deciding again, or undefined (dense-16x9 ticket
 * 36, slice 3): every link of the node, of any layer, ends in the sub-tier directly below the cell. So it has no feed from above and no peer link in
 * the row, and the stage-4 premises read its slot only through the rows below (`below` of the reader). Read by the writer and by `rowOrderFailure`.
 */
export function openMemberFault(model: LayoutModel, cell: LayoutGroup, node: string): string | undefined {
  const tierOf = (id: string): number | undefined => model.groups[model.document.nodes[id]?.group ?? '']?.tier;
  const tiers = [...new Set(Object.values(model.groups).filter(group => !group.flank && group.nodes.length > 0 && group.tier !== undefined).map(group => group.tier!))].sort((a, b) => a - b);
  const next = tiers[tiers.indexOf(cell.tier!) + 1];
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || (ends.from.node !== node && ends.to.node !== node)) continue;
    const other = ends.from.node === node ? ends.to.node : ends.from.node;
    if (other === node) return `its link ${link.id} ends on itself`;
    if (cell.nodes.includes(other)) return `its link ${link.id} is a peer link in the row`;
    if (next === undefined || tierOf(other) !== next) return `its link ${link.id} ends on ${other}, outside the sub-tier directly below`;
  }
  return undefined;
}

/** The open members of the cell `row` (its `rowOrder` entry's `open`), empty for a row with none. */
export function openMembers(reservations: readonly { kind: string; payload: unknown }[] | undefined, row: string): ReadonlySet<string> {
  const entry = (reservations ?? []).find(item => item.kind === 'rowOrder' && (item.payload as { cell?: string }).cell === row);
  return new Set((entry?.payload as { open?: readonly string[] } | undefined)?.open ?? []);
}
