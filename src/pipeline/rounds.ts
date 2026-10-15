/**
 * The six rounds as descriptors (architecture 2, ticket 04): fan, span, course, side, turn and overlay. Each one is a table of what it measures, reserves, checks, judges, commits and
 * says when it is refused; `attempt` (round.ts) runs a trial from it. A descriptor holds the round's own rules and nothing about the order of the rounds.
 */
import type { Diagnostic } from '../model/index.js';
import { fanRoundDropped, fanRoundHolds, measureFans } from '../layout/fan-spread.js';
import { TrunkBlocked } from '../layout/side-hints.js';
import { pitchGrowth, reserve as addReservations, type Reservations } from '../layout/reservations.js';
import { holds } from '../layout/reservation-checks.js';
import type { Round } from './round.js';

/** A fan re-run was cut: the fans keep the pitch of the last completed placement. */
const cutNote = (why: string): Diagnostic => ({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_CUT',
  message: `A fan re-run was cut: ${why}. The fans keep the pitch of the last completed placement, and this layout may differ from one made with more time.` });

/**
 * The fan round (ticket 89). A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing: the placed chords say the pitch
 * each face needs, and placement runs again with those floors until no face needs more. It is judged at 7e alone. The re-runs are bounded by the fan limit alone, and no re-run
 * reads the clock (ticket 141). A re-run that makes ELK fall back (an ELK error, never a timeout) is dropped: the placement already made stands (ticket 89 review).
 */
export const fan: Round<{ grown: Reservations }> = {
  id: 'fan', label: 'rerun-fan', routed: false, abort: false, invalidation: 'fanReruns',
  // A fan floor can move the rows, and a trunk that the baseline placed may then have a foreign unit on both sides. The run that found it blocked is a
  // trial, so the round is cut and the baseline stands (a test cannot reach this: it needs a floor that reorders a row of the mesh).
  tolerates: (error, phase) => phase === 'place' && error instanceof TrunkBlocked,
  async measure(env, s) {
    const measure = await env.timed('measureFans', () => measureFans(s.kept7e));
    const grown = pitchGrowth(s.kept, measure.floors, 'fan', env.placements);
    return grown.length === 0 ? undefined : { grown };
  },
  reserve: (_env, s, o) => addReservations(s.kept, o.grown),
  holdsAt7e(_env, s, o, ledger, trial7e) {
    if (!fanRoundHolds(s.kept7e, trial7e)) return { at: 'ledger', why: 'the fan round does not hold', note: fanRoundDropped(s.kept7e, trial7e) };
    // Every active reservation holds at the final 7e of the re-run, or the re-run is dropped.
    const broken = holds(ledger, trial7e);
    return broken.length > 0 ? { at: 'ledger', why: broken[0]!.why } : undefined;
  },
  judge: () => undefined,
  commit(_env, s, _o, t) { s.kept7e = t.trial7e; s.kept = t.ledger; },
  refuse(_env, s, _o, r) {
    s.cuts.push(r.note ?? cutNote(r.at === 'place' ? 'a trunk join was blocked by the moved rows, and the re-run was dropped'
      : r.at === 'fallback' ? 'ELK fell back during it, and the re-run was dropped' : `it broke a reservation (${r.why})`));
  },
};
