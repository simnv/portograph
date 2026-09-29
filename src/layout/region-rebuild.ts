import type { LayoutModel, TierBand } from '../model/layout.js';
import { centreDraft, createCentreBudget, flagUnverifiedCentring, type CentreBudget } from './centre.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildFlankPaths, flankPathCandidate } from './flanks.js';
import { rebuildRowPaths, rowPathCandidate } from './row-paths.js';
import { rebuildRegions } from './regions.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildBarDrops, shapeBars } from './bars.js';
import { prepareBundleGeometry } from './bundle-geometry.js';
import { rebuildBundlePaths } from './bundle-paths.js';
import { moveGroup, rebuildBands, span, union } from './skeleton-geometry.js';

const barStages = ['bars', 'bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'];

function reserveBarBandGrowth(draft: LayoutModel, before: readonly TierBand[]): void {
  const barTiers = new Set(Object.values(draft.groups)
    .filter(group => draft.document.groups[group.id]!.shape === 'bar').map(group => group.tier!));
  const oldHeights = new Map(before.map(band => [band.tier, band.bounds!.height]));
  let downstreamShift = 0;
  for (const band of [...draft.tierBands].sort((a, b) => a.tier - b.tier)) {
    if (downstreamShift > 0) {
      for (const group of Object.values(draft.groups).filter(group => group.tier === band.tier)) {
        moveGroup(draft, group, 0, downstreamShift);
      }
    }
    if (barTiers.has(band.tier)) {
      downstreamShift += Math.max(0, band.bounds!.height - (oldHeights.get(band.tier) ?? band.bounds!.height));
    }
  }
  if (downstreamShift > 0) rebuildBands(draft);
}

function rebuildBarGeometry(draft: LayoutModel, before: readonly TierBand[] = draft.tierBands.map(band => ({
  ...band, groups: [...band.groups], bounds: { ...band.bounds! },
}))): void {
  shapeBars(draft);
  rebuildBands(draft);
  reserveBarBandGrowth(draft, before);
  if (!Object.keys(draft.groups).length) return;
  const occupied = union([...Object.values(draft.groups).map(group => group.bounds!), ...(draft.frames ?? []).map(frame => frame.box)]), old = draft.canvas ?? occupied;
  const x = Math.min(old.x, occupied.x), y = Math.min(old.y, occupied.y);
  // `span` for the same reason `rebuildBoxes` uses it: `Canvas may only expand` is exact, and a
  // width recovered from an absolute edge can land one ULP inside the canvas it was built from.
  draft.canvas = {
    x, y,
    width: span(x, Math.max(old.x + old.width, occupied.x + occupied.width)),
    height: span(y, Math.max(old.y + old.height, occupied.y + occupied.height)),
  };
}

/**
 * Ordered replay for later placement producers. Boxes must already contain their moved nodes.
 * Reuse the caller's budget across all replays. This function never allocates lane x or owns a
 * transaction. The checked transaction invokes this finalizer after geometry callbacks. Callbacks
 * use individual geometry producers; the transaction owns derived row/flank path writes.
 */
export function rebuildRegionGeometry(draft: LayoutModel, budget?: CentreBudget, beforeBarBands?: readonly TierBand[], bundlesReady = ['bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'].includes(draft.stage)): void {
  if (bundlesReady) {
    for (const link of draft.links) if (link.bundle) delete link.path;
    for (const bundle of draft.bundles) { delete bundle.rows; delete bundle.envelope; delete bundle.centreline; delete bundle.envelopeParts; }
    prepareBundleGeometry(draft);
    budget ??= createCentreBudget();
  }
  const barsReady = barStages.includes(draft.stage) || beforeBarBands !== undefined;
  if (barsReady) rebuildBarGeometry(draft, beforeBarBands);
  rebuildRegions(draft);
  rebuildLaneExtents(draft);
  if (budget) {
    centreDraft(draft, budget);
    if (bundlesReady) prepareBundleGeometry(draft);
    if (barsReady) rebuildBarGeometry(draft);
    rebuildRegions(draft);
    rebuildLaneExtents(draft);
  }
  rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
  for (const link of draft.links) if (rowPathCandidate(draft, link) || flankPathCandidate(draft, link)) delete link.path;
  rebuildRowPaths(draft);
  rebuildFlankPaths(draft);
  if (barsReady) rebuildBarDrops(draft);
  if (bundlesReady) rebuildBundlePaths(draft);
  if (budget) flagUnverifiedCentring(draft);
}
