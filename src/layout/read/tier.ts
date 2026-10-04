import type { LayoutModel } from '../../model/layout.js';

/**
 * Shared readers: which tier a node or a cell stands in. The sub-tier number lives on the group; a node reaches it through
 * the group its document entry names. Eleven passes used to spell this out in a local `tierOf`, with four return conventions.
 * Two other local readers kept the name and mean something else (`growthPlan` in `bands.ts` answers a tier's row of groups,
 * `readDraft` in `overlay-order.ts` answers the index of the tier among the placed ones); they stay where they are.
 */

/** The sub-tier of the group that holds `id`. The group must be tiered: use it after tiers are assigned and not for a flank. */
export function nodeTier(model: LayoutModel, id: string): number {
  return model.groups[model.document.nodes[id]!.group]!.tier!;
}

/** The sub-tier of the group that holds `id`, or `undefined` when the group has none (a flank, or a model before tiers). */
export function nodeTierIfAny(model: LayoutModel, id: string): number | undefined {
  return model.groups[model.document.nodes[id]!.group]?.tier;
}

/** The sub-tier of a cell (a group id). The cell must be tiered. */
export function cellTier(model: LayoutModel, cell: string): number {
  return model.groups[cell]!.tier!;
}
