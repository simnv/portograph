/**
 * What the rounds of one command share. `State` is the kept placement (the 7e model, the 7f baseline built on it, the routed results of both) and the ledger, the counters and
 * the notes a round leaves behind. `Trial` is one round's try: its ledger, its 7e model, its 7f model, its routed model and what 7f did. A round reads the state, runs a trial,
 * and either commits it into the state or leaves the state as it was.
 */
import type { Diagnostic, LayoutModel } from '../model/index.js';
import type { Reservations } from '../layout/reservations.js';
import type { SideOffer } from '../layout/side-measure.js';

export interface State {
  /** The kept result of stages 1 to 7e: the model a measure reads, and the key of the stage-3 sizes. */
  kept7e: LayoutModel;
  /** Set on a trial's tentative state (the span's fans): the model whose ELK fallback a re-run is compared with. */
  fallbackFrom?: LayoutModel;
  /** The kept result of stage 7f on `kept7e`: the baseline every offer is measured on. */
  base: LayoutModel;
  /** The routed baseline, and the routed result of the last kept trial. */
  routedBase?: LayoutModel;
  routedFinal?: LayoutModel;
  /** What the 7f run of the baseline did, for phase 3b's trigger: whether it moved the placement, and its first settled copy. */
  baseMoved: boolean;
  baseUnmoved?: LayoutModel | undefined;
  /** The ledger every placement run is told to keep. */
  kept: Reservations;
  /** The fan rounds' and the side round's cut notes, the notes of the kept rounds, and the notes of the side trials that were kept. */
  cuts: Diagnostic[];
  sideNotes: Diagnostic[];
  keptNotes: Diagnostic[];
  /** The side round: what each kept hint promised, the refused offers, the link of each hinted port, and whether the extra trial of the unmoved baseline is running. */
  promised: SideOffer['promised'];
  refused: Set<string>;
  trialLinks: Map<string, string>;
  silent: boolean;
  /** The side measures made so far: the index of the round that measures next. */
  sideRound: number;
  /** Whether the unmoved baseline was rebuilt for a side offer: it is rebuilt at most once in a command. */
  unmovedRebuilt: boolean;
  /**
   * The course round's second trial, set when its first trial is refused: `without-steps` when that trial held a step course beside a poor-route course (the
   * second trial offers the poor routes alone), `none` otherwise (a second trial would repeat the first). Absent before the first refusal.
   */
  courseRetry?: 'without-steps' | 'none';
}

/** One try of a round, built from its ledger: the 7e result, the 7f result, the routed result and what 7f did. */
export interface Trial {
  ledger: Reservations;
  trial7e: LayoutModel;
  trial: LayoutModel;
  routedTrial: LayoutModel;
  moved: boolean;
  unmoved: LayoutModel | undefined;
}
