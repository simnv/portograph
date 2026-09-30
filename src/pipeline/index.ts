/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { Diagnostic, LayoutModel, LayoutStage, NormalisedDocument, Side } from '../model/index.js';
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
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, measureFans, type FanMeasure } from '../layout/fan-spread.js';
import { chordClearances, isFrameStraight } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';


/** Most runs of placement a fan's pitch may cost after the first (ticket 89). */
const FAN_ROUNDS = 2;
/** What a probe must leave in the budget: this many runs to 7e for stage 7f, and a fixed reserve for routing (ticket 89 review). */
const FAN_PROBE_FACTOR = 4;
const FAN_ROUTE_RESERVE_MS = 5000;
const straightChords = (model: LayoutModel): number => model.links.filter(link => isFrameStraight(model, link)).length;

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
  /** Stage 8 throws on a skipped required checkpoint instead of removing the link; for tests of the router's reservations. */
  strictCheckpoints?: boolean;
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

  /** Stages 1 to 7e, the placement the chords are decided on before 7f grows a gap, and so the placement a fan is measured on. `floors` are port pitches a fan of chords needs on a face (ticket 89); the first run has none. */
  const place = async (floors: FanMeasure['floors']): Promise<LayoutModel> => {
    const resolved = step('resolve', () => resolve(document, options.diagnostics ? { diagnostics: options.diagnostics } : {}));
    step('sides-one', () => sidesOne(resolved));
    for (const [id, pitch] of floors) resolved.nodes[id]!.sidePitch = { ...resolved.nodes[id]!.sidePitch, ...pitch };
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
    return model;
  };
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
  // the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
  const placeStarted = now();
  let model = await place(new Map());
  // A probe runs only while the budget could still pay for it, for stage 7f (a few times a run to 7e) and for routing after it, and
  // a probe that meets the deadline or makes ELK fall back is dropped: the placement already made stands (ticket 89 review).
  const firstMs = now() - placeStarted;
  const affordable = (): boolean => budget.remainingMs() > FAN_PROBE_FACTOR * firstMs + FAN_ROUTE_RESERVE_MS;
  let floors: FanMeasure['floors'] = new Map();
  for (let round = 0; round < FAN_ROUNDS && affordable(); round++) {
    const measure = measureFans(model);
    const next: FanMeasure['floors'] = new Map(floors);
    let grew = false;
    for (const [id, pitch] of measure.floors) for (const [side, value] of Object.entries(pitch) as [Side, number][]) {
      if (value > (next.get(id)?.[side] ?? 0)) { next.set(id, { ...next.get(id), [side]: value }); grew = true; }
    }
    if (!grew) break;
    let trial: LayoutModel;
    try { trial = await place(next); } catch (error) {
      if (error instanceof CommandDeadlineError) break;
      throw error;
    }
    if ((trial.fallbackUsed && !model.fallbackUsed) || (trial.deadlineHit && !model.deadlineHit)) break;
    if (straightChords(trial) < straightChords(model)) break;
    model = trial; floors = next;
  }
  const declined = declinedFanDiagnostics(measureFans(model).declined);
  const atFreeze = chordClearances(model);
  model = step('bands', () => bands(model));
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed.
  const lost: Diagnostic[] = [];
  for (const [pair, now] of chordClearances(model)) {
    const before = atFreeze.get(pair);
    if (now < STRAIGHT_PATH_CLEARANCE.path - 1e-6 && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Stage 7f moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
  const routeStarted = now();
  model = await route(model, {
    ...(options.createRouteAttempt ? { createAttempt: options.createRouteAttempt } : {}),
    ...(clock ? { clock } : {}),
    ...(options.strictCheckpoints ? { strictCheckpoints: true } : {}),
    // The router's own timer must be positive; the remainder was checked one line above, and a
    // 1 ms floor keeps the session honest rather than letting it fall back to a fresh 30 s.
    routeBudgetMs: Math.max(1, budget.share(options.routeBudgetMs ?? ROUTE_BUDGET_MS)),
  });
  report('route', routeStarted);

  return step('link-labels', () => linkLabels(model, [...declined, ...lost]));
}
