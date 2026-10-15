/**
 * The legacy scheduling of the rounds (architecture 2, ticket 04, steps 4 to 9): the order, the budget rules (`spanMax`, `roundLimit`/`turnReserve`, `turnRoundRuns`) and the
 * course and side arbitration that the single admission rule of the driver replaces.
 */
import { measureSides } from '../layout/side-measure.js';
import { routedBends } from '../layout/side-judge.js';
import { beats, gainOf, measureOverlayCourses } from '../layout/course-measure.js';
import { roundLimit, turnReserve, turnRoundRuns } from '../layout/turn-measure.js';
import type { Env } from './env.js';
import { FAN_ROUNDS, SIDE_ROUNDS } from './limits.js';
import { attempt } from './round.js';
import { course, fan, noteDeclined, overlay, side, span, turn } from './rounds.js';
import type { State } from './state.js';

export async function legacySchedule(env: Env, s: State): Promise<void> {
  const options = env.options;
  // The re-runs are bounded by FAN_ROUNDS alone, and no re-run reads the clock (ticket 141): the same input gives the same layout at any speed.
  // The command deadline ends the whole command with an error (`step`, `route`, `trialAbort`) and never picks a layout. A re-run that makes ELK
  // fall back (an ELK error, never a timeout: a timeout ends the command) is dropped: the placement already made stands (ticket 89 review).
  for (let round = 0; round < FAN_ROUNDS && env.placements < env.placeCap; round++) {
    const offer = await fan.measure(env, s);
    if (offer === undefined || await attempt(env, s, fan, offer) !== undefined) break;
  }
  // Side rounds (side-faces.md, Section 19). 7f runs on the kept model first: its output is the baseline, the model the command publishes when no
  // trial is kept. A measure reads the baseline. One batched trial reaches 7f per command; it is kept only on its routed result. Every bound is a
  // count (SIDE_ROUNDS, MAX_RERUNS); the clock only ends the whole command at its deadline (ticket 141).
  // The abort check of 7f, the baseline's and the trial's: the command deadline, checked between the passes. It ends the whole command, so it never picks a layout (ticket 141).
  const banded = await env.bands(s.kept7e);
  s.base = banded.model; s.baseMoved = banded.moved; s.baseUnmoved = banded.unmoved;
  // `publish` routes the model the command publishes. Every other route is a judged model, and keeps the ordinary overlay rule, so the
  // opt-in `layout.overlayOverBodies` (ticket 152) changes no side-round decision.
  // The course round (ticket 15, phase 4) runs before the side round and shares its re-runs. It reads the baseline's routed result, offers perimeter courses
  // for the links whose route is a poor one, places again with the courses reserved in stage 5, and keeps the trial only on its routed result.
  // Phase 3b's unmoved offer is a side trial too: when 7f moved the placement and the base has no offer, an offer of the unmoved copy may stand (the filter reads it).
  const unmovedMayStand = (): boolean => s.baseMoved && (s.baseUnmoved === undefined || measureSides(s.baseUnmoved, s.kept7e, s.refused).hints.size > 0);
  // The turn round (ticket 24, Section 10) runs after these rounds, on what they keep. When it has an offer on the baseline a round reads, that round leaves it one re-run,
  // as it leaves one to every round after it. A forced turn order or forced courses (tests) have no turn round.
  const turnRoundOn = options.testCourses === undefined && options.testTurnOrder === undefined;
  const reserve = (): number => turnReserve(s.base, turnRoundOn);
  const courseRound = async (given?: Parameters<typeof noteDeclined>[1]): Promise<void> => {
    const offer = given ?? await course.measure(env, s);
    // The legacy path measures the offer itself, and the round names it a second time (dropped with the legacy scheduling).
    if (given !== undefined) { options.testSideTrace?.({ ev: 'courses', offer: given, base: s.base, routedBase: s.routedBase }); noteDeclined(s, given); }
    if (offer === undefined) return;
    if (env.reruns >= roundLimit(env.maxReruns, reserve())) { options.testSideTrace?.({ ev: 'course-skipped', offer, reruns: env.reruns }); return; }
    await attempt(env, s, course, offer);
  };
  // The two rounds share the re-runs, and both are judged by the user's order on what they publish. A course kept first would take away the offer a side round
  // reads on the baseline (the 3b pattern), so where the budget allows both, the side round goes first and the course round reads its result. Where it allows one,
  // the offer whose promise gains more takes it (a side offer that only the unmoved copy has promises nothing and wins).
  let courseDeferred = false;
  if (options.testCourses === undefined) {
    s.routedBase = await env.route(s.base);
    // A forced hint (the test option) is the whole of the span round; otherwise the round runs here, before the course round.
    if (options.testSpanHints === undefined) { const offer = await span.measure(env, s); if (offer !== undefined) await attempt(env, s, span, offer); }
    const offer = await course.measure(env, s);
    if (offer !== undefined) {
      const sideOffer = measureSides(s.base, s.kept7e, s.refused), bends = routedBends(s.routedBase);
      const sideStands = sideOffer.hints.size > 0 || unmovedMayStand();
      if (!sideStands) await courseRound(offer);
      else if (env.reruns + 2 <= env.maxReruns) courseDeferred = true;
      else {
        const courseGain = gainOf([...offer.promised].map(([, item]) => [item.base.turns === Infinity ? undefined : item.base.turns, item.turns] as [number | undefined, number]));
        const sideGain = gainOf([...sideOffer.promised.values()].map(item => [bends.get(item.link), item.bends] as [number | undefined, number]));
        if (sideOffer.hints.size > 0 && beats(courseGain, sideGain)) await courseRound(offer);
        else options.testSideTrace?.({ ev: 'course-skipped', offer, reruns: env.reruns });
      }
    }
  }
  for (let round = 0; round < SIDE_ROUNDS; round++) {
    const offer = await side.measure(env, s);
    if (offer === undefined) break;
    if (env.reruns >= roundLimit(env.maxReruns, reserve())) {
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${env.maxReruns} placement re-runs.` });
      break;
    }
    // A kept trial ends the round (one trial reaches 7f per command), and so does a refusal at 7f or after it; a refusal of the placement or the 7e checks tries the next round.
    const refusal = await attempt(env, s, side, offer);
    if (refusal === undefined || !['place', 'ledger', 'predict'].includes(refusal.at)) break;
  }
  if (courseDeferred) await courseRound();
  // The turn round (architecture ticket 24, Section 10). On the kept result of the span, course and side rounds: when the planned first turns would reorder the ports of a
  // face, placement runs once more with the turn order and the trial is kept only when the published result is better by the unified order. It takes one re-run of the
  // shared budget and leaves one to the overlay round when that round has an offer. A refused or skipped trial leaves the layout as the baseline made it, with no note.
  // The turn round (architecture ticket 24, Section 10) takes one re-run of the shared budget and leaves one to the overlay round when that round has an offer.
  if (turnRoundOn) {
    const offer = await turn.measure(env, s);
    if (offer !== undefined) {
      const overlayOffer = options.testOverlayCourses !== false ? measureOverlayCourses(s.base, offer.current) : undefined;
      const overlayAhead = overlayOffer !== undefined && overlayOffer.courses.length > 0;
      const left = env.maxReruns - env.reruns;
      // The turn offer moves no bend and no turn by design, so it promises none: with one re-run left and both offers it runs only if the overlay offer promises nothing either.
      const overlayGain = overlayAhead ? gainOf([...overlayOffer.promised].map(([, item]) => [item.base === Infinity ? undefined : item.base, item.turns] as [number | undefined, number])) : [0, 0, 0];
      if (!turnRoundRuns(left, overlayAhead, overlayGain, beats)) {
        s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ROUND_SKIPPED', message: `The turn round was skipped: the command has ${left <= 0 ? 'made its' : 'one left of its'} ${env.maxReruns} placement re-runs${left <= 0 ? '' : ', for the overlay round'}.` });
      } else await attempt(env, s, turn, offer);
    }
  }
  // The overlay round (ticket 15, phase 7; the user's decision on Q1). After the routed rounds, on their kept result: an overlay that a routed chord would not take is
  // offered a perimeter course on side faces, reserved in stage 5 of one more placement run and kept only when its published result is not worse by the unified order.
  // It shares `MAX_RERUNS` with the other rounds and takes only a re-run they left (user, 2026-10-05: an extra re-run cost NTP +141 % and was refused there).
  // A refused trial leaves the layout as it was.
  if (options.testCourses === undefined && options.testOverlayCourses !== false) {
    const offer = await overlay.measure(env, s);
    if (offer !== undefined && env.reruns >= env.maxReruns) options.testSideTrace?.({ ev: 'overlay-skipped', offer: offer.offer, reruns: env.reruns });
    else if (offer !== undefined) await attempt(env, s, overlay, offer);
  }
}
