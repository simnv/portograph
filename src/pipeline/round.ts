/**
 * The shape of a round and the two functions that run a trial of it. A round is a table of descriptors (`rounds.ts`): what it measures on the kept baseline, what it reserves,
 * what must hold at the final 7e, how a routed trial is judged, what a kept trial changes and what a refused one says. `open` places the trial and `close` checks, bands, routes,
 * judges and commits it; a round decides nothing about the order of the placements, which is the driver's.
 */
import type { Diagnostic, LayoutModel } from '../model/index.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import { producerRefusal } from '../layout/placement-refusal.js';
import { staggerRefusal } from '../layout/stagger.js';
import { declineStagger, reserve as addReservations, type Reservations } from '../layout/reservations.js';
import { holds } from '../layout/reservation-checks.js';
import type { Env } from './env.js';
import type { State, Trial } from './state.js';

export type RoundId = 'fan' | 'span' | 'course' | 'side' | 'turn' | 'overlay' | 'farEnd';
/** Where a trial ended: the placement run, the ELK fallback check, the ledger at 7e, the side predictor, stage 7f or the route, the judge's verdict, or a kept promise at the route. */
export type RefusalAt = 'place' | 'fallback' | 'ledger' | 'predict' | 'bands' | 'verdict' | 'promise';

export interface Refusal {
  at: RefusalAt;
  why: string;
  /** The side keys the refusal answers for (the side round). */
  keys?: readonly string[];
  /** The error of a refused placement or 7f run. */
  error?: Error;
  detail?: string;
  /** The ids of the reservations that did not hold (a refusal at the final 7e). */
  reservationIds?: readonly string[];
  /** A note that a refusal publishes as it is (the fan round's dropped note). */
  note?: Diagnostic;
}

/** What the driver needs to ration the placements. A round costs one start per trial; the driver decides which trials get one. */
export interface RoundBudget {
  /** The rounds whose live offers this round leaves a start to before it takes one. A child round inherits the protections of its parent. */
  protects: readonly RoundId[];
  /** Wins a tie of promised gain against a sibling that wants the same start: the higher value. */
  tie: number;
  /** Most trials one round makes in a command: a trial that was refused early, with the state as it was, tries again on a fresh measure. */
  visits: number;
  /** Whether a kept trial gives the round another visit (the fan), and which refusals do (the side round's early ones). */
  again: boolean;
  retries: readonly RefusalAt[];
  /** Whether a trial of a later sibling may give the round an offer it had no first, so that it is measured again after it (the side round after a course). */
  reopens: boolean;
  /** Starts the round has even when the command's budget is lower: the fan's two. */
  floor: number;
  /** The round's starts are its own (`env.farEndRuns`, at most `floor`): they spend neither the command's re-runs nor its placement cap (the far-end round). */
  own?: true;
}

export interface Round<O> {
  readonly id: RoundId;
  /** The `testTiming` label of the round's placement run. */
  readonly label: string;
  /** False for a round that is judged on the 7e model alone (the fan round): it has no 7f run and no route. */
  readonly routed: boolean;
  readonly invalidation?: 'fanReruns' | 'sideReruns';
  readonly budget: RoundBudget;
  /** The rounds that run inside a trial of this one, on its tentative state (the span's fans). */
  readonly children: readonly AnyRound[];
  /** Whether the options of the command let the round run at all. */
  enabled(env: Env): boolean;
  /** Whether the round has an offer on the kept baseline. It measures quietly: no trace, no note. Only the rounds that another round protects need it. */
  live?(env: Env, s: State): Promise<boolean>;
  /** The gain the offer promises, compared lexicographically: links restored, bent links saved, turns saved. */
  gain(env: Env, s: State, o: O): readonly number[];
  /** Say that the round had an offer and was given no start. */
  skip(env: Env, s: State, o: O, left: number): void;
  /**
   * Whether the round answers `error` of its placement run (`place`) or its 7f run and route (`bands`) with a refusal; every other error is a defect and propagates.
   * A producer refusal (`producerRefusal`) withdraws the trial of every round before this is asked (DR-11), so a round need not name it.
   */
  tolerates(error: unknown, phase: 'place' | 'bands'): boolean;
  /** The offer on the kept baseline, or `undefined` when the round has none. */
  measure(env: Env, s: State): Promise<O | undefined>;
  /** The ledger the trial is placed with: what `s.kept` keeps, plus what the offer reserves. */
  reserve(env: Env, s: State, o: O): Reservations;
  /** What the ledger and the round's own promises require at the final 7e, before 7f and the route. */
  holdsAt7e(env: Env, s: State, o: O, ledger: Reservations, trial7e: LayoutModel): Refusal | undefined;
  /** The side predictor: refuse a trial from its 7e model before 7f is paid for. */
  predict?(env: Env, s: State, o: O, trial7e: LayoutModel): Refusal | undefined;
  /** Async preflight check on the 7e model before stage 7f (`bands`) runs. */
  preflight?(env: Env, s: State, o: O, trial7e: LayoutModel): Promise<Refusal | undefined>;
  /** Work before the trial's route that the judge needs (the routed baseline). */
  ready?(env: Env, s: State): Promise<void>;
  /** The verdict on the trial: `undefined` keeps it. A round with `routed: false` is judged at 7e. */
  judge(env: Env, s: State, o: O, t: Trial): Refusal | undefined;
  /** Make the trial the kept state. */
  commit(env: Env, s: State, o: O, t: Trial): void;
  /** Say why the trial ended: the notes, the trace and the refused keys of the round. */
  refuse(env: Env, s: State, o: O, r: Refusal): void;
}
// A round is stored with the offer type it measures; the driver hands a round only the offers that round measured.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRound = Round<any>;

/** A trial that was placed: the ledger it was placed with and its 7e model. */
export interface Opened { ledger: Reservations; trial7e: LayoutModel }

/**
 * Whether `error` of a trial's run withdraws the trial: a producer refusal in every round (DR-11), a stagger refusal at 7f in every round (the
 * trial's stagger rows do not hold there, dense-16x9 ticket 22 review), else what the round tolerates.
 */
const withdraws = <O>(round: Round<O>, error: unknown, phase: 'place' | 'bands'): boolean =>
  producerRefusal(error) || (phase === 'bands' && staggerRefusal(error)) || round.tolerates(error, phase);

const refuse = <O>(env: Env, s: State, round: Round<O>, o: O, r: Refusal): Refusal => { round.refuse(env, s, o, r); return r; };

/**
 * An unrouted round's trial that holds stagger rows, checked at 7f (dense-16x9 ticket 22, reviews 1 and 2). Such a round commits its 7e unbanded, and the
 * next baseline runs 7f on it (`driver.ts`, `baseline`), so its 7f runs here as a trial first: no round commits a placement that the next baseline refuses.
 * - `undefined`: 7f keeps the trial.
 * - A stagger row is kept only when the placement that follows from it can be kept. A stagger refusal that names a row of the trial (its own chord corridor,
 *   say, after the fan floors moved its hub ports) declines that row by name in the ledger (`staggerDeclined`: every later run reads it, none decides it
 *   again), and the baseline is placed once more, from the kept ledger, without it. That placement is returned: the round keeps it in place of its trial.
 *   Each row is declined once at most, so a sheet with N rows places at most N more times (R4); those placements stand outside the cap with the acceptance
 *   gate's (`env.gateRuns`), as its consequence.
 * - Any other stagger or producer refusal at 7f refuses the trial (`at: 'bands'`), and the baseline stands. No routing pass.
 */
async function keptStaggers<O>(env: Env, s: State, round: Round<O>, ledger: Reservations, trial7e: LayoutModel): Promise<Opened | Refusal | undefined> {
  let replaced = false;
  for (;;) {
    if (!trial7e.staggerRows?.length) return replaced ? { ledger, trial7e } : undefined;
    try { await env.bands(trial7e, true); return replaced ? { ledger, trial7e } : undefined; } catch (error) {
      if (!withdraws(round, error, 'bands')) throw error;
      const rows = trial7e.staggerRows.map(row => row.group);
      const named = staggerRefusal(error) ? [...new Set(error.owners.flatMap(owner => owner.kind === 'group' && rows.includes(owner.id) ? [owner.id] : []))].sort() : [];
      if (!named.length) return { at: 'bands', why: (error as Error).message, error: error as Error };
      ledger = addReservations(replaced ? ledger : s.kept, named.flatMap(group => declineStagger(group, (error as Error).message, round.id, env.placements)));
      replaced = true;
      const placedBefore = env.placements;
      try { trial7e = await env.timed(round.label, () => env.place(ledger, env.trialAbort)); } catch (again) {
        env.gateRuns += env.placements - placedBefore;
        if (!withdraws(round, again, 'place')) throw again;
        return { at: 'place', why: (again as Error).message, error: again as Error };
      }
      env.gateRuns += env.placements - placedBefore;
      if (trial7e.fallbackUsed && !(s.fallbackFrom ?? s.kept7e).fallbackUsed) return { at: 'fallback', why: `ELK fell back during the ${round.id} trial` };
    }
  }
}

/** Reserve and place a trial of `round` on the offer `o`. A started placement is never given back. */
export async function open<O>(env: Env, s: State, round: Round<O>, o: O): Promise<Opened | Refusal> {
  const ledger = round.reserve(env, s, o);
  if (round.budget.own === true) { env.farEndRuns++; attemptCounters.farEndStarts++; } else env.reruns++;
  if (round.invalidation !== undefined) attemptCounters.invalidations[round.invalidation]++;
  let trial7e: LayoutModel;
  try { trial7e = await env.timed(round.label, () => env.place(ledger, env.trialAbort)); } catch (error) {
    if (!withdraws(round, error, 'place')) throw error;
    return refuse(env, s, round, o, { at: 'place', why: (error as Error).message, error: error as Error });
  }
  if (trial7e.fallbackUsed && !(s.fallbackFrom ?? s.kept7e).fallbackUsed) return refuse(env, s, round, o, { at: 'fallback', why: `ELK fell back during the ${round.id} trial` });
  return { ledger, trial7e };
}

/** Check, band, route, judge and commit a placed trial. Returns `undefined` when the trial was kept, else the refusal. */
export async function close<O>(env: Env, s: State, round: Round<O>, o: O, { ledger, trial7e }: Opened): Promise<Refusal | undefined> {
  if (!round.routed && trial7e.staggerRows?.length) {
    const staggered = await keptStaggers(env, s, round, ledger, trial7e);
    if (staggered !== undefined && 'at' in staggered) return refuse(env, s, round, o, staggered);
    if (staggered !== undefined) {
      // The baseline placed again without the declined rows stands in for the trial: the round keeps it, and its next visit measures again
      // on it. Its own ledger is checked; the round's rules read a trial of the old baseline, which this is not.
      const broken = holds(staggered.ledger, staggered.trial7e);
      if (broken.length) return refuse(env, s, round, o, { at: 'ledger', why: broken[0]!.why, reservationIds: broken.map(item => item.id) });
      round.commit(env, s, o, { ...staggered, trial: staggered.trial7e, routedTrial: staggered.trial7e, moved: false, unmoved: undefined });
      s.rebased = (s.rebased ?? 0) + 1;
      return undefined;
    }
  }
  const held = round.holdsAt7e(env, s, o, ledger, trial7e) ?? round.predict?.(env, s, o, trial7e);
  if (held !== undefined) return refuse(env, s, round, o, held);
  let t: Trial;
  if (!round.routed) {
    t = { ledger, trial7e, trial: trial7e, routedTrial: trial7e, moved: false, unmoved: undefined };
  } else {
    try {
      const preflight = await round.preflight?.(env, s, o, trial7e);
      if (preflight !== undefined) return refuse(env, s, round, o, preflight);
      const banded = await env.bands(trial7e, true);
      await round.ready?.(env, s);
      t = { ledger, trial7e, trial: banded.model, routedTrial: await env.route(banded.model, true), moved: banded.moved, unmoved: banded.unmoved };
    } catch (error) {
      if (!withdraws(round, error, 'bands')) throw error;
      return refuse(env, s, round, o, { at: 'bands', why: (error as Error).message, error: error as Error });
    }
  }
  const verdict = round.judge(env, s, o, t);
  if (verdict !== undefined) return refuse(env, s, round, o, verdict);
  round.commit(env, s, o, t);
  return undefined;
}
