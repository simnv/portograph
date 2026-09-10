import type { LayoutModel } from '../model/layout.js';
import { centreDraft, type CentreBudget } from './centre.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildFlankPaths, flankPathCandidate } from './flanks.js';
import { rebuildRowPaths, rowPathCandidate } from './row-paths.js';
import { rebuildRegions } from './regions.js';
import { rebuildNodeGeometry } from './node-geometry.js';

/**
 * Ordered replay for later placement producers. Boxes must already contain their moved nodes.
 * Reuse the caller's budget across all replays. This function never allocates lane x or owns a
 * transaction. The checked transaction invokes this finalizer after geometry callbacks. Callbacks
 * use individual geometry producers; the transaction owns derived row/flank path writes.
 */
export function rebuildRegionGeometry(draft: LayoutModel, budget?: CentreBudget): void {
  rebuildRegions(draft);
  rebuildLaneExtents(draft);
  if (budget) {
    centreDraft(draft, budget);
    rebuildRegions(draft);
    rebuildLaneExtents(draft);
  }
  rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
  for (const link of draft.links) if (rowPathCandidate(draft, link) || flankPathCandidate(draft, link)) delete link.path;
  rebuildRowPaths(draft);
  rebuildFlankPaths(draft);
}
