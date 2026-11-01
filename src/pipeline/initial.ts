/**
 * The first placement run and the state the rounds start from. The ledger starts with what the test options force; a trunk join that the run finds blocked is declined by one
 * re-run, which shares `MAX_RERUNS` (mesh-bus.md, section 12.4).
 */
import type { LayoutModel } from '../model/index.js';
import { TrunkBlocked } from '../layout/placement-refusal.js';
import { nodeFloors as floorEntries, reserve as addReservations, courseEntries, declinedTrunksOf, declineTrunk, sideFaces, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import type { Env } from './env.js';
import type { State } from './state.js';

export async function firstState(env: Env): Promise<State> {
  const options = env.options;
// A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
// the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
let first!: LayoutModel;
// What every placement run is told to keep: the test's node floors first, then what the rounds keep.
let kept: Reservations = [...floorEntries(options.testNodeFloors ?? new Map(), 'initial', 0), ...sideFaces(options.testSideHints ?? new Map(), new Map(), 'initial', 0),
  // The courses every placement run reserves (ticket 15): the test's, or the ones the course round keeps.
  ...courseEntries(options.testCourses ?? [], undefined, 'initial', 0),
  // The links every placement run reserves as spanning chords (ticket 22): the test's, or the ones the span round keeps.
  ...spanEntries(options.testSpanHints ?? [], 'initial', 0),
  // Whether every placement run orders the ports of a face by the planned first turn (ticket 24): forced by the test option, or set by a kept turn round.
  ...turnEntries(options.testTurnOrder === true, options.testTurnLinks ?? [], false, 'initial', 0)];
// A trunk with no admissible side is declined by one placement re-run, which shares `MAX_RERUNS` (mesh-bus.md, section 12.4).
for (;;) {
  // The last run the budget allows declines every trunk, so that it cannot be blocked and no run past the budget is needed.
  if (env.reruns >= env.maxReruns) kept = addReservations(kept, declineTrunk(undefined, 'the placement budget is spent', env.placements));
  try { first = await env.timed('place', () => env.place(kept)); break; } catch (error) {
    if (!(error instanceof TrunkBlocked) || declinedTrunksOf(kept).has(error.key)) throw error;
    kept = addReservations(kept, declineTrunk(error.key, error.why, env.placements));
    env.reruns++;
    options.testSideTrace?.({ ev: 'trunk-blocked', key: error.key, reruns: env.reruns, left: env.maxReruns - env.reruns });
  }
}
// Stage 5 of this run chose each group's arrangement (ticket 51). Every later placement run of the command keeps that choice, not a new one.
if (first.groupArrangements !== undefined) {
  env.groupArrangements = JSON.parse(JSON.stringify(first.groupArrangements)) as typeof first.groupArrangements;
  if (first.staggerRows !== undefined) env.staggerRows = JSON.parse(JSON.stringify(first.staggerRows)) as typeof first.staggerRows;
}
return { kept7e: first, base: first, baseMoved: false, kept, cuts: [], sideNotes: [], keptNotes: [], promised: new Map(), refused: new Set(), trialLinks: new Map(), silent: false, sideRound: 0, unmovedRebuilt: false };
}
