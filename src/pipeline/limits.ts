/** The counts that bound a command's placement runs. A leaf module: the placement run and the environment both read it. */
import { PlacementRefusal } from '../layout/placement-refusal.js';

/** Most runs of placement a fan's pitch may cost after the first (ticket 89). */
export const FAN_ROUNDS = 2;
/** Most side rounds after the fan rounds: one offer, one retry (side-faces.md, Section 7). */
export const SIDE_ROUNDS = 2;
/**
 * Most placement re-runs of one command, fan and side together (side-faces.md, Section 7, *Budget*). A count, never set by the clock.
 * 3 = the two fan rounds and one side trial. On the private sheet (about 23 s quiet, 3 re-runs) the command ends about 14 s before the 60 s
 * deadline at 2 times slower, and a fourth re-run (2.7 s + 6.5 s of 7f, quiet) would not fit. The clock never chooses between layouts (ticket 141).
 */
export const MAX_RERUNS = 3;
/** A round asked for a placement past the command's budget (`MAX_RERUNS` + 1). A round refuses its trial on it; the first run is never refused. */
export class PlacementBudgetExceeded extends PlacementRefusal {
  constructor(readonly placements: number) { super('budget', `The command has placed ${placements} times, which is the most it may.`, { stage: 'place' }); }
}
