/**
 * The shape of a round and the one function that runs a trial of it. A round is a table of descriptors (`rounds.ts`): what it measures on the kept baseline, what it reserves,
 * what must hold at the final 7e, how a routed trial is judged, what a kept trial changes and what a refused one says. `attempt` is the only code that places, bands and routes a
 * trial; a round decides nothing about the order of the placements, which is the driver's.
 */
import type { Diagnostic, LayoutModel } from '../model/index.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import type { Reservations } from '../layout/reservations.js';
import type { Env } from './env.js';
import type { State, Trial } from './state.js';

export type RoundId = 'fan' | 'span' | 'course' | 'side' | 'turn' | 'overlay';
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
  /** A note that a refusal publishes as it is (the fan round's dropped note). */
  note?: Diagnostic;
}

/** What a settled trial hands on: its final 7e model and the ledger it was placed with. */
export interface Settled { trial7e: LayoutModel; ledger: Reservations }

export interface Round<O> {
  readonly id: RoundId;
  /** The `testTiming` label of the round's placement run. */
  readonly label: string;
  /** False for a round that is judged on the 7e model alone (the fan round): it has no 7f run and no route. */
  readonly routed: boolean;
  /** Whether the trial's placement and 7f runs check the command deadline between their stages. */
  readonly abort: boolean;
  readonly invalidation?: 'fanReruns' | 'sideReruns';
  /** Whether the round answers `error` of its placement run (`place`) or its 7f run and route (`bands`) with a refusal; every other error is a defect and propagates. */
  tolerates(error: unknown, phase: 'place' | 'bands'): boolean;
  /** The offer on the kept baseline, or `undefined` when the round has none. */
  measure(env: Env, s: State): Promise<O | undefined>;
  /** The ledger the trial is placed with: what `s.kept` keeps, plus what the offer reserves. */
  reserve(env: Env, s: State, o: O): Reservations;
  /** Work between the placement and the checks that places again (the span's fans); it may end the trial. */
  settle?(env: Env, s: State, o: O, ledger: Reservations, trial7e: LayoutModel): Promise<Settled | Refusal>;
  /** What the ledger and the round's own promises require at the final 7e, before 7f and the route. */
  holdsAt7e(env: Env, s: State, o: O, ledger: Reservations, trial7e: LayoutModel): Refusal | undefined;
  /** The side predictor: refuse a trial from its 7e model before 7f is paid for. */
  predict?(env: Env, s: State, o: O, trial7e: LayoutModel): Refusal | undefined;
  /** Work before the trial's route that the judge needs (the routed baseline). */
  ready?(env: Env, s: State): Promise<void>;
  /** The verdict on the trial: `undefined` keeps it. A round with `routed: false` is judged at 7e. */
  judge(env: Env, s: State, o: O, t: Trial): Refusal | undefined;
  /** Make the trial the kept state. */
  commit(env: Env, s: State, o: O, t: Trial): void;
  /** Say why the trial ended: the notes, the trace and the refused keys of the round. */
  refuse(env: Env, s: State, o: O, r: Refusal): void;
}

/** Run one trial of `round` on the offer `o`: reserve, place, check, band, route, judge, commit. Returns `undefined` when the trial was kept, else the refusal. */
export async function attempt<O>(env: Env, s: State, round: Round<O>, o: O): Promise<Refusal | undefined> {
  const refuse = (r: Refusal): Refusal => { round.refuse(env, s, o, r); return r; };
  let ledger = round.reserve(env, s, o);
  s.reruns++;
  if (round.invalidation !== undefined) attemptCounters.invalidations[round.invalidation]++;
  let trial7e: LayoutModel;
  try { trial7e = await env.timed(round.label, () => env.place(ledger, round.abort ? env.trialAbort : undefined)); } catch (error) {
    if (!round.tolerates(error, 'place')) throw error;
    return refuse({ at: 'place', why: (error as Error).message, error: error as Error });
  }
  if (trial7e.fallbackUsed && !(s.fallbackFrom ?? s.kept7e).fallbackUsed) return refuse({ at: 'fallback', why: `ELK fell back during the ${round.id} trial` });
  if (round.settle !== undefined) {
    const settled = await round.settle(env, s, o, ledger, trial7e);
    if ('at' in settled) return refuse(settled);
    ({ ledger, trial7e } = settled);
  }
  const held = round.holdsAt7e(env, s, o, ledger, trial7e) ?? round.predict?.(env, s, o, trial7e);
  if (held !== undefined) return refuse(held);
  let t: Trial;
  if (!round.routed) t = { ledger, trial7e, trial: trial7e, routedTrial: trial7e, moved: false, unmoved: undefined };
  else {
    try {
      await round.ready?.(env, s);
      const banded = await env.bands(trial7e, true);
      t = { ledger, trial7e, trial: banded.model, routedTrial: await env.route(banded.model, true), moved: banded.moved, unmoved: banded.unmoved };
    } catch (error) {
      if (!round.tolerates(error, 'bands')) throw error;
      return refuse({ at: 'bands', why: (error as Error).message, error: error as Error });
    }
  }
  const verdict = round.judge(env, s, o, t);
  if (verdict !== undefined) return refuse(verdict);
  round.commit(env, s, o, t);
  return undefined;
}
