import type { LayoutLink, LayoutModel } from '../../model/layout.js';

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

/**
 * The sub-tiers whose bands stand strictly between the ends of a routed link, in order from its authored source to its target: the tiers it
 * transits. The one reader of that question: the lanes of 7a (`lanes.ts`), the `transit` refusal of `chordVerdict` and the span candidate on
 * consecutive document tiers (`rankBandBetween`) all read it.
 */
export function transitTiers(model: LayoutModel, link: LayoutLink): number[] {
  if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) return [];
  const a = nodeTier(model, link.attachments.from.node), b = nodeTier(model, link.attachments.to.node);
  return model.tierBands.map(band => band.tier).filter(tier => tier > Math.min(a, b) && tier < Math.max(a, b)).sort((u, v) => a < b ? u - v : v - u);
}
