/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { Diagnostic, LayoutModel, LayoutStage, NormalisedDocument } from '../model/index.js';
import { resolve } from '../resolve/index.js';
import { sidesOne } from '../layout/sides-one.js';
import { sizeNodes } from '../layout/size.js';
import { skeleton } from '../layout/skeleton.js';
import { sidesTwo } from '../layout/sides-two.js';
import { rows } from '../layout/rows.js';
import { lanes } from '../layout/lanes.js';
import { flanks } from '../layout/flanks.js';
import { centre } from '../layout/centre.js';
import { bars } from '../layout/bars.js';
import { bundles } from '../layout/bundles.js';
import { bands } from '../layout/bands.js';
import { linkLabels } from '../layout/link-labels.js';
import { elkDeadlineMs, type CreateElkAttempt, type ElkClock } from '../layout/elk-worker.js';
import { route, ROUTE_BUDGET_MS, type CreateRouteAttempt } from '../route/index.js';
import { CommandDeadlineError, UNBOUNDED_BUDGET, type Budget } from './budget.js';

export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';

export interface LayoutProgress {
  stage: LayoutStage;
  /** Wall time this stage took, measured by the caller's clock. */
  durationMs: number;
  /** What the shared budget had left when the stage finished; `Infinity` when unbounded. */
  remainingMs: number;
}

export interface LayoutOptions {
  /**
   * Parse diagnostics, passed straight to `resolve`. Omitting them silently drops every source
   * path and warning the parser produced, so a CLI or any other orchestrator must pass them.
   */
  diagnostics?: readonly Diagnostic[];
  /** Stage 4. A Node caller passes `createNodeElkFactory()`; a browser caller the browser factory. */
  createElkAttempt?: CreateElkAttempt;
  /** Stage 8. Required only when the region rules leave a remainder. */
  createRouteAttempt?: CreateRouteAttempt;
  /** The command's one remaining-work budget. Every ELK attempt and the router draw from it. */
  budget?: Budget;
  /** Stage-4 policy ceiling; ADR-0006's node-count rule when omitted. */
  elkBudgetMs?: number;
  /** Stage-8 policy ceiling. */
  routeBudgetMs?: number;
  clock?: ElkClock;
  onProgress?: (progress: LayoutProgress) => void;
}

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  const clock = options.clock, now = (): number => clock ? clock.now() : Date.now();
  const budget = options.budget ?? UNBOUNDED_BUDGET;
  const report = (stage: LayoutStage, started: number): void =>
    options.onProgress?.({ stage, durationMs: now() - started, remainingMs: budget.remainingMs() });
  const step = <T>(stage: LayoutStage, run: () => T): T => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage);
    const started = now(), result = run();
    report(stage, started);
    return result;
  };

  const resolved = step('resolve', () => resolve(document, options.diagnostics ? { diagnostics: options.diagnostics } : {}));
  step('sides-one', () => sidesOne(resolved));
  step('size', () => sizeNodes(resolved));

  if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'skeleton');
  const skeletonStarted = now();
  await skeleton(resolved, {
    ...(options.createElkAttempt ? { createAttempt: options.createElkAttempt } : {}),
    ...(clock ? { clock } : {}),
    layoutBudgetMs: options.elkBudgetMs ?? elkDeadlineMs(Object.keys(resolved.nodes).length),
    budget,
  });
  report('skeleton', skeletonStarted);

  // sidesTwo freezes port topology and publishes the first protected snapshot; every region rule
  // below returns a new one, and the previous value must not be used again.
  let model = step('sides-two', () => sidesTwo(resolved));
  model = step('rows', () => rows(model));
  model = step('lanes', () => lanes(model));
  model = step('flanks', () => flanks(model));
  model = step('centre', () => centre(model));
  model = step('bars', () => bars(model));
  model = step('bundles', () => bundles(model));
  model = step('bands', () => bands(model));

  if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
  const routeStarted = now();
  model = await route(model, {
    ...(options.createRouteAttempt ? { createAttempt: options.createRouteAttempt } : {}),
    ...(clock ? { clock } : {}),
    // The router's own timer must be positive; the remainder was checked one line above, and a
    // 1 ms floor keeps the session honest rather than letting it fall back to a fresh 30 s.
    routeBudgetMs: Math.max(1, budget.share(options.routeBudgetMs ?? ROUTE_BUDGET_MS)),
  });
  report('route', routeStarted);

  return step('link-labels', () => linkLabels(model));
}
