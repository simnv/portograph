import { seatBlockOrder } from './solid-block-proto.js';
import type { LayoutModel } from '../model/layout.js';
import { createBrowserElkFactory, elkDeadlineMs, ElkDeadlineError, runElkAttempt, systemElkClock,
  type CreateElkAttempt, type ElkClock } from './elk-worker.js';
import { UNBOUNDED_BUDGET, type Budget } from '../pipeline/budget.js';
import { PlacementRefusal } from './placement-refusal.js';
import { buildSkeletonGraph } from './skeleton-graph.js';
import { orderByOverlay, orderFramesByOverlay } from './overlay-order.js';
import { orderByCorridors, validateRowOrderDecisions } from './corridor-order.js';
import { orderByFeeds, settlePullsAndFeeds, validateFeedOrders, withdrawBrokenGroupOrders } from './feed-order.js';
import { packGridGroups, placeFlanksAndPeers, readSkeleton, rebuildBands, stackBands, validateSkeletonBands } from './skeleton-geometry.js';
export { buildSkeletonGraph } from './skeleton-graph.js';
export { validateSkeletonBands } from './skeleton-geometry.js';
export interface SkeletonOptions {
  createAttempt?: CreateElkAttempt;
  clock?: ElkClock;
  layoutBudgetMs?: number;
  /**
   * The command's shared remainder. Partitioning and every fallback band draw from it, so a
   * sequence of legal attempts cannot add up to more than the command was given (ADR-0006).
   */
  budget?: Budget;
}
export class SkeletonError extends PlacementRefusal {
  constructor(message: string) { super('skeleton', message, { stage: 'skeleton' }); this.name = 'SkeletonError'; }
}
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

/** Stage 4 commits geometry only after ordered, nonoverlapping tier bands pass validation. */
export async function skeleton(model: LayoutModel, options: SkeletonOptions = {}): Promise<LayoutModel> {
  if (model.stage !== 'size') throw new SkeletonError('Skeleton requires the size stage');
  const clock = options.clock ?? systemElkClock, started = clock.now();
  const createAttempt = options.createAttempt ?? createBrowserElkFactory();
  const policy = options.layoutBudgetMs ?? elkDeadlineMs(Object.keys(model.nodes).length);
  if (!Number.isFinite(policy) || policy <= 0) throw new SkeletonError('ELK deadline must be positive and finite');
  const shared = options.budget ?? UNBOUNDED_BUDGET;
  /** Every attempt, partitioned or fallback, takes the smaller of the policy and what is left. */
  const attemptMs = (): number => {
    const remaining = shared.share(policy);
    if (remaining <= 0) throw new ElkDeadlineError(0);
    return remaining;
  };
  let work = copy(model);
  try {
    try {
      const result = await runElkAttempt(buildSkeletonGraph(work), createAttempt, attemptMs(), clock);
      try {
        readSkeleton(work, result);
        // A grid is taller than the ribbon ELK sized its band for, so the bands are re-stacked
        // before they are judged. An input with no grid group keeps ELK's geometry untouched.
        if (packGridGroups(work)) stackBands(work, false); else rebuildBands(work, false);
        const errors = validateSkeletonBands(work, false);
        if (errors.length) throw new SkeletonError(errors.join('; '));
      } catch (error) {
        work.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'ELK_INVALID_PARTITIONS', message: String(error) });
        throw error;
      }
    } catch (error) {
      // A deadline is not a fallback trigger (ticket 141): what ELK finishes in time must not choose between two layouts. It ends the command.
      if (error instanceof ElkDeadlineError) { work.deadlineHit = true; throw error; }
      const diagnostics = work.diagnostics;
      work = copy(model);
      work.diagnostics = diagnostics;
      work.fallbackUsed = true;
      work.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'ELK_FALLBACK',
        message: `Partitioned skeleton failed; laying out each tier band: ${String(error)}` });
      const tiers = [...new Set(Object.values(work.groups).filter(group => !group.flank).map(group => group.tier!))].sort((a, b) => a - b);
      for (const tier of tiers) {
        try {
          const result = await runElkAttempt(buildSkeletonGraph(work, tier), createAttempt, attemptMs(), clock);
          readSkeleton(work, result, tier);
          packGridGroups(work, tier);
          // Other bands may still be unplaced. Validate this band's output independently.
          const groups = Object.values(work.groups).filter(group => !group.flank && group.tier === tier);
          const bandModel = { ...work, groups: Object.fromEntries(groups.map(group => [group.id, group])) };
          rebuildBands(bandModel, false);
          const errors = validateSkeletonBands(bandModel, false, tier);
          if (errors.length) throw new SkeletonError(errors.join('; '));
        } catch (error) {
          if (error instanceof ElkDeadlineError) { work.deadlineHit = true; throw error; }
          throw new SkeletonError(`Fallback tier ${tier} failed: ${String(error)}`);
        }
      }
      stackBands(work, false);
    }
    // Overlay links weigh the order ELK chose (ranked-groups spec 3.2); sides-two reads the result.
    orderByOverlay(work);
    if (work.fanFamilies?.some(family => family.kind === 'solid')) seatBlockOrder(work);
    // The free rows then take the order the corridors through them cross least (ticket 17); the record is checked below.
    orderByCorridors(work);
    // The rank cells and the child frames then take the order their feeds give (ticket 25): the ledger's `rowOrder`, checked below.
    orderByFeeds(work);
    placeFlanksAndPeers(work, columns => { orderFramesByOverlay(work, columns); });
    // A far-end pull whose far node the frame order then put on the other side is undone (ticket 22 review). A withdrawn pull turns a
    // free row that may feed a cell, so the feed orders are read again, and a re-seated cell may move the far node of another pull: the
    // two repeat until no pull is withdrawn (ticket 25 re-check).
    settlePullsAndFeeds(work);
    // A group order of the joint order (ticket 72) that the frame order broke is withdrawn by name before the check (R6).
    withdrawBrokenGroupOrders(work);
    const errors = [...validateSkeletonBands(work), ...validateRowOrderDecisions(work), ...validateFeedOrders(work)];
    if (errors.length) throw new SkeletonError(errors.join('; '));
    work.stage = 'skeleton';
    work.runtime.stages.push({ stage: 'skeleton', durationMs: clock.now() - started });
    Object.assign(model, work);
    return model;
  } catch (error) {
    model.diagnostics = work.diagnostics;
    if (work.fallbackUsed) model.fallbackUsed = true;
    if (work.deadlineHit) model.deadlineHit = true;
    model.diagnostics.push({ stage: 'placement', severity: 'error', code: 'ELK_SKELETON_FAILED', message: String(error) });
    model.runtime.stages.push({ stage: 'skeleton', durationMs: clock.now() - started });
    throw error;
  }
}
