/**
 * Counters of the repeated work inside the stage-7f placement attempt. They exist for tests and measurements only: nothing reads them to
 * decide anything, and they are never written into the layout model or its JSON. A leaf module, so any producer may count into it.
 */
export interface AttemptCounters {
  /** Calls of one round of the tier-gap growth and the canton close-up (`settleRound`). */
  settleCalls: number;
  /** Passes of the centring producer (each spends one pass of an eight-pass budget). */
  centringPasses: number;
  /** Copies of the model made to try something on: a chord step, a probe, a settled trial, a producer replay. */
  candidateCopies: number;
  /** Replays of a producer by a validator, to see that a published model is its own fixed point. */
  validationReplays: number;
}

export const attemptCounters: AttemptCounters = { settleCalls: 0, centringPasses: 0, candidateCopies: 0, validationReplays: 0 };

export function resetAttemptCounters(): void {
  attemptCounters.settleCalls = 0; attemptCounters.centringPasses = 0;
  attemptCounters.candidateCopies = 0; attemptCounters.validationReplays = 0;
}
