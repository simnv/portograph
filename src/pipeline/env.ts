/**
 * The environment of one `layout` command: the document, the options, the one budget, the clock and the counters that every placement run, bands run and route of the command
 * share. It decides no layout. A round reads it to place, band and route a trial, and to count what it spent.
 */
import type { LayoutModel, LayoutStage, NormalisedDocument, Size } from '../model/index.js';
// The placement run first: it loads the stages in the order the tests that mock a stage module depend on (it was the order of the imports of the old index).
import { place } from './place.js';
import { bands } from '../layout/bands.js';
import type { ElkClock } from '../layout/elk-worker.js';
import { lastAttempt } from '../layout/attempt-counters.js';
import type { Reservations } from '../layout/reservations.js';
import { route, ROUTE_BUDGET_MS } from '../route/index.js';
import { CommandDeadlineError, UNBOUNDED_BUDGET, type Budget } from './budget.js';
import type { LayoutOptions } from './options.js';
import type { FlatBlockGap, BlockBoxPad, BlockRowGap, GroupArrangement, GroupLift, StaggerRow } from '../model/layout.js';
import { FAN_ROUNDS, MAX_RERUNS } from './limits.js';

/** What stage 7f did to a model, with the copy of its first settled state (`lastAttempt`): phase 3b's trigger. */
export interface Banded { model: LayoutModel; moved: boolean; unmoved: LayoutModel | undefined }

export interface Env {
  /** Monotone block refusals from pre-freeze geometry, shared by subsequent runs. */
  declinedSolidBlocks?: Map<string, string>;
  /** Failed probes, each excluding a new named block; separate from the legacy optimisation budget. */
  blockProbes: number;
  /**
   * The placements of the stagger acceptance gate (D-Q4; dense-16x9 ticket 22): one plain placement plus at most one trial per chosen row, with
   * their trunk re-runs. Like the probes, outside the placement cap.
   */
  gateRuns: number;
  /**
   * While above 0, a placement that starts is an exempt trial's (the stagger gate's trials and the flat-gap choice, `initial.ts`, and the final flat-gap choice, `chooseFlatGapsAgain` in `driver.ts`): `place` credits
   * it to `gateRuns` before its cap check, every retry inside the trial included (dense-16x9 ticket 04 slice 3, review 1, finding 2). Absent or 0
   * otherwise.
   *
   * **The one owner rule (R4; review 2).** A placement is lifted from the cap once. A placement started inside an exempt trial is the trial's
   * credit (`gateRuns`); no other counter credits it again. So a solid-block refusal inside the trial declines its block as everywhere, but
   * counts no `blockProbes` (`placeFirst`).
   */
  exemptPlacing?: number;
  /** The stagger rows a round declined and placed again without (`keptStaggers` in `round.ts`, dense-16x9 ticket 22 review 3): each once at most in a command. */
  rebasedRows?: Set<string>;
  /** The placements of the far-end round (dense-16x9 ticket 07, at most `FAR_END_ORDER_RUNS`): its own count, outside the re-run budget and the placement cap, so the shared budget the other rounds spend does not starve the one round that reads their settled result. */
  farEndRuns: number;
  staggerRows?: StaggerRow[];
  /** Dense-16x9 ticket 04 slice 3: the gap the aspect choice gave each flat solid block (`aspectFlatGaps`, first in `initial.ts`, once more after the rounds in `chooseFlatGapsAgain`, ticket 42); absent: every flat gap at its floor. */
  flatBlockGaps?: FlatBlockGap[];
  /** The side paddings of the boxes of flat block members (`blockBoxPadsAsked`), read on a complete placement; absent: none. */
  blockBoxPads?: BlockBoxPad[];
  /** The least row gaps that flat block members ask (`blockRowGapsAsked`); absent: none. */
  blockRowGaps?: BlockRowGap[];
  /** Dense-16x9 ticket 29: the blocks a complete placement recorded under the cap, for the leg pitch of stage 6 (`steepBlocks`); absent: none known. */
  steepBlocks?: string[];
  /**
   * Dense-16x9 ticket 36, ruling B: the rows whose seat set a placement of this command withdrew, each with where and why. Stage 6 of every later
   * run declines them (`seatSetDeclined`, at `input`), so no row is decided again; absent: none.
   */
  seatSetDeclined?: Map<string, string>;
  /** Ticket 51: the arrangement stage 5 of the first placement run chose; every later run of the command keeps it (R1). */
  groupArrangements?: Record<string, GroupArrangement>;
  /** Ticket 51: true once the first placement run has completed; every later run keeps its arrangement and decides none. */
  arranged?: boolean;
  /** Ticket 51: the groups an earlier attempt of the first run staggered and a later stage refused, with the refusal; they stay rows. */
  declinedArrangements?: Map<string, string>;
  /** D-Q5: the group lifts every placement run applies as band input (`lift.ts`); absent before the decision. */
  groupLifts?: GroupLift[];
  /** Ticket 51: the groups stage 5 of the latest placement run staggered by its own choice (read when that run is refused). */
  arrangedRows?: string[];
  readonly document: NormalisedDocument;
  readonly options: LayoutOptions;
  readonly budget: Budget;
  readonly clock: ElkClock | undefined;
  /** Placement runs started so far (the first run and the re-runs); a started run is never given back. */
  placements: number;
  /** Placement re-runs started so far (the fan rounds, trunk declines and trials); the budget counts them. */
  reruns: number;
  readonly placeCap: number;
  readonly maxReruns: number;
  readonly stage3Sizes: WeakMap<LayoutModel, Map<string, Size>>;
  now(): number;
  report(stage: LayoutStage, started: number, trial?: true): void;
  step<T>(stage: LayoutStage, run: () => T, trial?: true): T;
  timed<T>(label: string, run: () => T | Promise<T>): Promise<T>;
  /** The deadline check of a trial. It ends the whole command and so never picks a layout (ticket 141). */
  trialAbort(stage: string): void;
  place(reservations: Reservations, abort?: (stage: string) => void): Promise<LayoutModel>;
  /** `publish` routes the model the command publishes; every other route is a judged model and keeps the ordinary overlay rule (ticket 152). */
  route(model: LayoutModel, trial?: true, publish?: true): Promise<LayoutModel>;
  /** Stage 7f on the baseline (`trial` unset) or on a trial's 7e model. */
  bands(model7e: LayoutModel, trial?: true): Promise<Banded>;
}

export function createEnv(document: NormalisedDocument, options: LayoutOptions): Env {
  const clock = options.clock, now = (): number => clock ? clock.now() : Date.now();
  const budget = options.budget ?? UNBOUNDED_BUDGET;
  const report: Env['report'] = (stage, started, trial) =>
    options.onProgress?.({ stage, ...(trial === undefined ? {} : { trial }), durationMs: now() - started, remainingMs: budget.remainingMs() });
  const step: Env['step'] = (stage, run, trial) => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage);
    const started = now(), result = run();
    report(stage, started, trial);
    return result;
  };
  const timed: Env['timed'] = async (label, run) => {
    if (options.testTiming === undefined) return run();
    const started = now(), result = await run();
    options.testTiming(label, now() - started, budget.remainingMs());
    return result;
  };
  const trialAbort = (stage: string): void => { if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage); };
  const env: Env = {
    document, options, budget, clock, now, report, step, timed, trialAbort, placements: 0, reruns: 0, blockProbes: 0, gateRuns: 0, farEndRuns: 0, stage3Sizes: new WeakMap(), maxReruns: options.testMaxReruns ?? MAX_RERUNS,
    // The cap on placements per command: the first run and the effective re-run budget (the fan rounds at the start run within FAN_ROUNDS even with a budget of 0).
    placeCap: Math.max(options.testMaxReruns ?? MAX_RERUNS, FAN_ROUNDS) + 1,
    place: (reservations, abort) => place(env, reservations, abort),
    route: async (model, trial, publish) => {
      if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
      const started = now();
      const routed = await timed(trial === undefined ? 'route' : 'route-trial', () => route(model, {
        ...(publish === undefined ? { ordinaryOverlay: true } : {}),
        ...(options.createRouteAttempt ? { createAttempt: options.createRouteAttempt } : {}),
        ...(clock ? { clock } : {}),
        ...(options.strictCheckpoints ? { strictCheckpoints: true } : {}),
        // The router's own timer must be positive; the remainder was checked above, and a 1 ms floor keeps the session honest rather than letting
        // it fall back to a fresh full policy.
        routeBudgetMs: Math.max(1, budget.share(options.routeBudgetMs ?? ROUTE_BUDGET_MS)),
        commandOver: () => budget.remainingMs() <= 0,
      }));
      report('route', started, trial);
      return routed;
    },
    bands: async (model7e, trial) => {
      const banded = await timed(trial === undefined ? 'bands' : 'bands-trial', () => step('bands', () => bands(model7e, () => trialAbort('bands'), options.attemptTrace), trial));
      return { model: banded, moved: lastAttempt.moved, unmoved: lastAttempt.unmoved };
    },
  };
  return env;
}
