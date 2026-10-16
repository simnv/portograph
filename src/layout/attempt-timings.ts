import type { LayoutModel } from '../model/layout.js';

declare const performance: { now(): number };

/**
 * Timings of the sub-steps inside a settled trial of the 7f chord step (architecture 2, ticket 05, phase 0). A measurement only: nothing reads
 * it to decide anything, it writes nothing into the layout model or its JSON, and a run with `on` false pays one boolean test per call.
 * A leaf module, like `attempt-counters.ts`. A test turns `on` on and reads `trials`.
 *
 * A step is recorded by its exclusive time (its own time less the steps it contains) and its inclusive time, and only inside a trial.
 */
export interface StepTime { calls: number; own: number; total: number }
export interface TrialTiming { steps: Map<string, StepTime>; total: number }

/** Observers a test may set, to read the model at the points the measurement needs. Called only when `on` is true. */
export interface TimingHooks {
  /** The draft, just after `settleRound` of a round, before the linkless step: the state the settled trials of the round are judged against. */
  base?(draft: LayoutModel): void;
  /** The start of a round of the 7f loop. */
  round?(draft: LayoutModel): void;
  /** A settled trial: the probe before `follow` ran on it, and after. */
  enter?(probe: LayoutModel): void;
  exit?(probe: LayoutModel): void;
}

export const attemptTimings: {
  on: boolean;
  trials: TrialTiming[];
  hooks: TimingHooks;
  current: TrialTiming | undefined;
  stack: { child: number }[];
} = { on: false, trials: [], hooks: {}, current: undefined, stack: [] };

export function resetAttemptTimings(): void {
  attemptTimings.trials = []; attemptTimings.current = undefined; attemptTimings.stack = []; attemptTimings.hooks = {};
}

function record(trial: TrialTiming, label: string, own: number, total: number): void {
  const step = trial.steps.get(label) ?? { calls: 0, own: 0, total: 0 };
  step.calls++; step.own += own; step.total += total;
  trial.steps.set(label, step);
}

/** Runs `fn`; with timings on and a trial open, adds its time to the step `label`. */
export function timed<T>(label: string, fn: () => T): T {
  const t = attemptTimings, trial = t.current;
  if (!t.on || trial === undefined) return fn();
  const start = performance.now(), frame = { child: 0 };
  t.stack.push(frame);
  try { return fn(); } finally {
    t.stack.pop();
    const total = performance.now() - start;
    record(trial, label, total - frame.child, total);
    const parent = t.stack[t.stack.length - 1];
    if (parent !== undefined) parent.child += total;
  }
}

/** Opens a trial record (a settled copy: its copy, its `follow` and its verdict) around `fn`. A trial inside a trial is not opened. */
export function timedTrial<T>(fn: () => T): T {
  const t = attemptTimings;
  if (!t.on || t.current !== undefined) return fn();
  const trial: TrialTiming = { steps: new Map(), total: 0 }, start = performance.now();
  t.current = trial; t.stack = [];
  try { return fn(); } finally {
    trial.total = performance.now() - start;
    t.current = undefined; t.stack = [];
    t.trials.push(trial);
  }
}
