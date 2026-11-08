/**
 * The one reader of the feeding chain of a fan wrap (decision review 2026-11, D-Q4, ticket 07). Stage 5 decides the chain once and
 * stores its units on the stagger row (`StaggerRow.chain`); the centre rule (7c), its replays, the feed split and the alignment
 * allowance read it here and decide nothing again (R1).
 */
import type { LayoutModel } from '../../model/layout.js';

/**
 * The column unit of a group, as `columnTiers` forms it: the top-level frame that holds a rank cell, the group itself for a one-rank
 * group, and for a flank the unit of the group it flanks (a flank moves with that group).
 */
export function columnUnitId(model: LayoutModel, groupId: string): string {
  const group = model.groups[groupId]!;
  if (group.flank) return columnUnitId(model, group.flank.of);
  let frame = group.frame;
  if (frame === undefined) return group.id;
  while (model.document.frames?.[frame]?.parent !== undefined) frame = model.document.frames[frame]!.parent!;
  return frame;
}

/**
 * The unit id of the wrapped block whose stored feeding chain holds `node`, or undefined. A held node does not grow for an alignment
 * (`alignmentAllowance`), and 7c centres it only on its feeds inside the chain or into that block (`centringFeeds`). Chains are disjoint.
 */
export function chainBlockOf(model: LayoutModel, node: string): string | undefined {
  const rows = model.staggerRows?.filter(row => row.chain?.length);
  if (!rows?.length) return undefined;
  const unit = columnUnitId(model, model.document.nodes[node]!.group);
  const row = rows.find(item => item.chain!.includes(unit));
  return row === undefined ? undefined : columnUnitId(model, row.group);
}
