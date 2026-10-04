/**
 * Counters of the repeated work inside the stage-7f placement attempt. They exist for tests and measurements only: nothing reads them to
 * decide anything, and they are never written into the layout model or its JSON. A leaf module, so any producer may count into it.
 *
 * Two kinds of counter. The cheap ones are plain increments and always run. The invalidation counters that need a read of the model
 * (`read`, `tierGapPlans`, `blockedChords`) run only when `ledger` is on or an `attemptTrace` was asked for; off, they cost one boolean test.
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
  /** Calls of `replayRegions` (the regions, the grid and the labels), on the draft and on every copy. */
  replays: number;
  /** Settled copies the chord step judged a move on (its baselines included). */
  settledTrials: number;
  /** Cheap trials of the chord step: a move made and read before a settled copy is paid for. */
  cheapTrials: number;
  /** Rounds of the fixed point of `growTierGaps` (each one settles a trial copy and reads the plans). */
  gapRounds: number;
  /** Runs of the placement stages 1 to 7e (the first, the fan re-runs, the side re-run). */
  placeRuns: number;
  /** Runs of the 7f placement attempt (the baseline and the side trial). */
  attempts: number;
  /** Rounds of the 7f loop, over all attempts, and how many of them ended with the close-up still open. */
  rounds: number;
  openRounds: number;
  /** Rounds in which the chord step moved a mover. */
  chordRoundsMoved: number;
  /** What the reseat of the lanes decided at the end of 7f. */
  reseat: { adopted: number; refused: number; none: number };
  /** Set by a test (or by the trace) to read the invalidations that need a read of the model. */
  ledger: boolean;
  /** Depth of `placementAttempt` runs now on the stack: a producer counts its 7f work only inside one. */
  in7f: number;
  /** Things a later pass undid or could have reserved. Each is counted at the pass that finds it. */
  invalidations: Invalidations;
  /** One entry for each run of the stages 1 to 7e, in order (the first, then the fan re-runs, then the side re-run). Filled only with the ledger on. */
  placements: PlacementEntry[];
  /** One entry for each run of the 7f attempt, in order (the baseline, then the side trial). Filled only with the ledger on, except the round counts. */
  attemptLog: AttemptEntry[];
}

/** What the stages 1 to 7e of one placement run lost: routed chords, and straight overlay links over all stages and at `centre` alone. */
export interface PlacementEntry { chordsLost: number; overlayLost: number; overlayGained: number; centreOverlayLost: number; centreOverlayGained: number }
/** What the 7f loop of one attempt did. */
export interface AttemptEntry {
  rounds: number; openRounds: number; chordRoundsMoved: number;
  overlayLost: number; overlayGained: number; alignedLost: number; bodiesOnFrozenChord: number;
}

export interface Invalidations {
  /** A round opened (the close-up moved 0.5 px or more) right after a round in which the chord step moved something. */
  closeUpReopened: number;
  /** A tier gap grown in a round after the first. */
  gapRegrown: number;
  /** Overlay links straight before a step of 7f (or of stages 7a to 7e, `pre`) and not after it, and the ones it made straight. */
  overlayStraightLost: number;
  overlayStraightGained: number;
  /** Routed links aligned (straight, on one axis) before a step of 7f and not after it. */
  routedAlignedLost: number;
  /** Routed chords (frame, cross) held before a stage of 7a to 7e and not after it, and the ones it gained. */
  preRoutedChordLost: number;
  preOverlayStraightLost: number;
  preOverlayStraightGained: number;
  /** Bodies that came to stand on a frozen chord during the 7f loop. */
  bodyOnFrozenChord: number;
  /** The held-axis probe would have moved a column, so the warnings were only refreshed. */
  heldProbeMoved: number;
  /** Tier gaps that still ask for room after the rounds of 7f. */
  shortGapsAfterRounds: number;
  /** A run of the overlay windows kept inside a 7f run (the draft and every copy). */
  overlayWindowsKept: number;
  /** A placement re-run: a fan re-run, a side re-run. */
  fanReruns: number;
  sideReruns: number;
  /** A 7f run that ended with the cantons not settled. */
  cantonNonConvergence: number;
}

const zeroInvalidations = (): Invalidations => ({ closeUpReopened: 0, gapRegrown: 0, overlayStraightLost: 0, overlayStraightGained: 0, routedAlignedLost: 0,
  preRoutedChordLost: 0, preOverlayStraightLost: 0, preOverlayStraightGained: 0, bodyOnFrozenChord: 0, heldProbeMoved: 0, shortGapsAfterRounds: 0,
  overlayWindowsKept: 0, fanReruns: 0, sideReruns: 0, cantonNonConvergence: 0 });

export const attemptCounters: AttemptCounters = { settleCalls: 0, centringPasses: 0, candidateCopies: 0, validationReplays: 0, replays: 0, settledTrials: 0,
  cheapTrials: 0, gapRounds: 0, placeRuns: 0, attempts: 0, rounds: 0, openRounds: 0, chordRoundsMoved: 0, reseat: { adopted: 0, refused: 0, none: 0 },
  ledger: false, in7f: 0, invalidations: zeroInvalidations(), placements: [], attemptLog: [] };

/** Zeroes every count. The `ledger` switch stays as the caller set it. */
export function resetAttemptCounters(): void {
  const c = attemptCounters;
  c.settleCalls = 0; c.centringPasses = 0; c.candidateCopies = 0; c.validationReplays = 0;
  c.replays = 0; c.settledTrials = 0; c.cheapTrials = 0; c.gapRounds = 0; c.placeRuns = 0;
  c.attempts = 0; c.rounds = 0; c.openRounds = 0; c.chordRoundsMoved = 0;
  c.reseat = { adopted: 0, refused: 0, none: 0 }; c.in7f = 0; c.invalidations = zeroInvalidations();
  c.placements = []; c.attemptLog = [];
}
