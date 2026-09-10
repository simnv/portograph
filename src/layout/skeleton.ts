import type { LayoutModel } from '../model/layout.js';
import { createBrowserElkFactory, elkDeadlineMs, ElkDeadlineError, runElkAttempt, systemElkClock,
  type CreateElkAttempt, type ElkClock } from './elk-worker.js';
import { buildSkeletonGraph } from './skeleton-graph.js';
import { placeFlanksAndPeers, readSkeleton, rebuildBands, stackBands, validateSkeletonBands } from './skeleton-geometry.js';
export { buildSkeletonGraph } from './skeleton-graph.js';
export { validateSkeletonBands } from './skeleton-geometry.js';
export interface SkeletonOptions {
  createAttempt?: CreateElkAttempt;
  clock?: ElkClock;
  layoutBudgetMs?: number;
}
export class SkeletonError extends Error {
  constructor(message: string) { super(message); this.name = 'SkeletonError'; }
}
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

/** Stage 4 commits geometry only after ordered, nonoverlapping tier bands pass validation. */
export async function skeleton(model: LayoutModel, options: SkeletonOptions = {}): Promise<LayoutModel> {
  if (model.stage !== 'size') throw new SkeletonError('Skeleton requires the size stage');
  const clock = options.clock ?? systemElkClock, started = clock.now();
  const createAttempt = options.createAttempt ?? createBrowserElkFactory();
  const budget = options.layoutBudgetMs ?? elkDeadlineMs(Object.keys(model.nodes).length);
  if (!Number.isFinite(budget) || budget <= 0) throw new SkeletonError('ELK deadline must be positive and finite');
  let work = copy(model);
  try {
    try {
      const result = await runElkAttempt(buildSkeletonGraph(work), createAttempt, budget, clock);
      try {
        readSkeleton(work, result);
        rebuildBands(work, false);
        const errors = validateSkeletonBands(work, false);
        if (errors.length) throw new SkeletonError(errors.join('; '));
      } catch (error) {
        work.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'ELK_INVALID_PARTITIONS', message: String(error) });
        throw error;
      }
    } catch (error) {
      const diagnostics = work.diagnostics;
      work = copy(model);
      work.diagnostics = diagnostics;
      work.fallbackUsed = true;
      if (error instanceof ElkDeadlineError) work.deadlineHit = true;
      work.diagnostics.push({ stage: 'placement', severity: 'warning',
        code: error instanceof ElkDeadlineError ? 'ELK_DEADLINE' : 'ELK_FALLBACK',
        message: `Partitioned skeleton failed; laying out each tier band: ${String(error)}` });
      const tiers = [...new Set(Object.values(work.groups).filter(group => !group.flank).map(group => group.tier!))].sort((a, b) => a - b);
      for (const tier of tiers) {
        try {
          const result = await runElkAttempt(buildSkeletonGraph(work, tier), createAttempt, budget, clock);
          readSkeleton(work, result, tier);
          // Other bands may still be unplaced. Validate this band's output independently.
          const groups = Object.values(work.groups).filter(group => !group.flank && group.tier === tier);
          const bandModel = { ...work, groups: Object.fromEntries(groups.map(group => [group.id, group])) };
          rebuildBands(bandModel, false);
          const errors = validateSkeletonBands(bandModel, false, tier);
          if (errors.length) throw new SkeletonError(errors.join('; '));
        } catch (error) {
          if (error instanceof ElkDeadlineError) work.deadlineHit = true;
          throw new SkeletonError(`Fallback tier ${tier} failed: ${String(error)}`);
        }
      }
      stackBands(work, false);
    }
    placeFlanksAndPeers(work);
    const errors = validateSkeletonBands(work);
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
