/** The counts that bound a command's placement runs. A leaf module: the placement run and the environment both read it. */
import { PlacementRefusal } from '../layout/placement-refusal.js';

/** Most runs of placement a fan's pitch may cost after the first (ticket 89). */
export const FAN_ROUNDS = 2;
/** Most side rounds after the fan rounds: one offer, one retry (side-faces.md, Section 7). */
export const SIDE_ROUNDS = 2;
/**
 * Most placement re-runs of one command, fan and side together (side-faces.md, Section 7, *Budget*). A count, never set by the clock.
 * 3 = the two fan rounds and one side trial. On the private sheet (about 23 s quiet, 3 re-runs) the command ended about 14 s before the former 60 s
 * deadline at 2 times slower (the deadline is 120 s since 2026-11-01), and a fourth re-run (2.7 s + 6.5 s of 7f, quiet) would not have fit the former deadline; the count stays 3. The clock never chooses between layouts (ticket 141).
 */
export const MAX_RERUNS = 3;
/** A round asked for a placement past the command's budget (`MAX_RERUNS` + 1). A round refuses its trial on it; the first run is never refused. */
export class PlacementBudgetExceeded extends PlacementRefusal {
  constructor(readonly placements: number) { super('budget', `The command has placed ${placements} times, which is the most it may.`, { stage: 'place' }); }
}
/**
 * Most placement runs of the far-end round in one run of the stages (dense-16x9 ticket 07): the first proposal and the one retry that reads the final positions of a trial that
 * did not settle. The count is the round's own: it is outside the shared re-run budget (`MAX_RERUNS`) and the placement cap, and a sheet with no stale face makes no run. A group
 * lift or a width trial makes a further `Env`, each with its own count (R4: the clock never sets it). Measured on the corpus (ticket 07, review 1): 1 run fixes 7 of the 16 G5
 * sheets of main, 2 and 4 runs fix the same 10 and cost +16.6 % and +21.9 % of corpus time; the third and fourth run changed no geometry.
 */
export const FAR_END_ORDER_RUNS = 2;
