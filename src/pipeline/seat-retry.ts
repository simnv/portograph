import type { Diagnostic, LayoutModel } from '../model/layout.js';
import type { Reservations } from '../layout/reservations.js';
import { producerRefusal } from '../layout/placement-refusal.js';
import { staggerRefusal } from '../layout/stagger.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import type { Env } from './env.js';
import { withdrawnSeatRows } from '../layout/seat-set.js';

/**
 * The most placements one command runs again for withdrawn seat sets (dense-16x9 ticket 36, ruling B). Each one declines at least one row
 * that no placement of the command declined before, so the count of seat sets bounds the loop too; the constant states the bound as a count
 * (R4). The forced-on corpus (559 sheets, 2026-11-17) measured 29 retries on 18 sheets, at most 5 in one command over all its
 * loop runs, and no loop run reached the bound.
 */
export const SEAT_SET_RETRIES = 4;

/** The diagnostic of a retry the bound stops: the rows still withdrawn keep the room their sets reserved. */
export const SEAT_SET_RETRY_BOUND = 'SEAT_SET_RETRY_BOUND';
/** The diagnostic of a retry whose placement was refused: the placement before it stands, with its withdrawal. */
export const SEAT_SET_RETRY_REFUSED = 'SEAT_SET_RETRY_REFUSED';

/** What the retry reads and writes of the command, so the loop is one state table with one invariant (`initial.ts` gives the real ones). */
export interface SeatRetryPort<S> {
  /** Places the command once more with the current declines (one complete placement run). */
  place(): Promise<LayoutModel>;
  /** The rows the command declines now (the input of stage 6). */
  declined(): ReadonlyMap<string, string>;
  /** Adds rows to the declines of the command. */
  decline(rows: ReadonlyMap<string, string>): void;
  /** The command state a refused retry gives back (`snapshotEnv`, `restoreEnv`). */
  snapshot(): S;
  restore(state: S): void;
  /** Whether a placement error is a refusal of that placement (the retry ends on it), not an error of the command. */
  refused(error: unknown): boolean;
}

export interface SeatRetryResult { model: LayoutModel; retries: number; notes: Diagnostic[] }

/**
 * Ruling B: a placement that withdrew a seat set leaves room for a set that no longer stands, so the command places once more with that row
 * declined, and the row is never decided again in the command. The outcomes, one state table:
 * - the placement withdrew no row the command has not declined: it stands (the retry holds, or none was needed);
 * - the retry withdraws another row (or a set on a row that came into scope): that row is declined too, and the command places once more;
 * - the retry is refused: the command state goes back to before it (`restore`), and the placement before it stands, named (`SEAT_SET_RETRY_REFUSED`);
 * - the bound: past `SEAT_SET_RETRIES` the last placement stands, named (`SEAT_SET_RETRY_BOUND`).
 * The invariant of every result: no `seatSet` entry for a row the command declined; every withdrawal named (`SEAT_SET_WITHDRAWN` in the run that
 * withdrew it, `SEAT_SET_DECLINED` with clause `withdrawn` in every later run); the result is a published placement, so its restore passes.
 */
export async function retryWithdrawnSeatSets<S>(first: LayoutModel, port: SeatRetryPort<S>): Promise<SeatRetryResult> {
  let model = first, retries = 0;
  const notes: Diagnostic[] = [];
  for (;;) {
    const fresh = [...withdrawnSeatRows(model)].filter(([row]) => !port.declined().has(row)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!fresh.length) return { model, retries, notes };
    const rows = fresh.map(([row]) => row).join(', ');
    if (retries >= SEAT_SET_RETRIES) {
      notes.push({ stage: 'placement', severity: 'warning', code: SEAT_SET_RETRY_BOUND, owners: fresh.map(([row]) => ({ kind: 'group', id: row })),
        message: `The command placed ${SEAT_SET_RETRIES} times again for withdrawn seat sets; the seat sets of ${rows} stay withdrawn, with the room they reserved.` });
      return { model, retries, notes };
    }
    const saved = port.snapshot();
    port.decline(new Map(fresh));
    retries++;
    try { model = await port.place(); } catch (error) {
      if (!port.refused(error)) throw error;
      port.restore(saved);
      notes.push({ stage: 'placement', severity: 'warning', code: SEAT_SET_RETRY_REFUSED, owners: fresh.map(([row]) => ({ kind: 'group', id: row })),
        message: `The placement without the withdrawn seat sets of ${rows} was refused (${(error as Error).message}); the placement before it stands.` });
      return { model, retries, notes };
    }
  }
}

type Banded = Awaited<ReturnType<Env['bands']>>;

/**
 * A placed model and its 7f run, with ruling B applied at 7f: when the 7f run withdraws a seat set, the ledger `ledger` is placed once more with
 * that row declined and banded again (`retryWithdrawnSeatSets`), each placement credited outside the cap (`env.exemptPlacing`), as the room rounds
 * are. The state it writes is the declines of the command (`env.seatSetDeclined`) and the placement it returns; a refused retry gives back both.
 * The baseline of the driver and every routed trial of a round read 7f through it, so no kept 7f result keeps room for a withdrawn set. The
 * placements `initial.ts` compares do not (scope V): a compared placement carries its withdrawal and the next placement decides the set again.
 */
export async function bandsWithoutWithdrawnSeats(env: Env, ledger: Reservations, placed: LayoutModel, trial: boolean, notes: Diagnostic[]): Promise<{ placed: LayoutModel; banded: Banded }> {
  const band = (model: LayoutModel): Promise<Banded> => trial ? env.bands(model, true) : env.bands(model);
  let banded = await band(placed);
  // Only a run that withdrew a set retries (a set exists only with `layout.moveBeforeGrow`).
  if (!withdrawnSeatRows(banded.model).size) return { placed, banded };
  const result = await retryWithdrawnSeatSets(banded.model, {
    place: async () => {
      env.exemptPlacing = (env.exemptPlacing ?? 0) + 1;
      try { placed = await env.timed('place', () => env.place(ledger, trial ? env.trialAbort : undefined)); } finally { env.exemptPlacing--; }
      banded = await band(placed);
      return banded.model;
    },
    declined: () => env.seatSetDeclined ?? new Map(),
    decline: rows => { env.seatSetDeclined = new Map([...(env.seatSetDeclined ?? []), ...rows]); },
    snapshot: () => ({ declined: env.seatSetDeclined, placed, banded }),
    restore: saved => {
      if (saved.declined === undefined) delete env.seatSetDeclined; else env.seatSetDeclined = saved.declined;
      placed = saved.placed; banded = saved.banded;
    },
    refused: error => staggerRefusal(error) || producerRefusal(error),
  });
  attemptCounters.seatRetries += result.retries;
  notes.push(...result.notes);
  return { placed, banded };
}

