/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { Diagnostic, LayoutModel, NormalisedDocument, Size } from '../model/index.js';
import { portKey } from '../layout/sides-one.js';
import { PlacementRefusal, refusedAtBands } from '../layout/placement-refusal.js';
import { linkLabels } from '../layout/link-labels.js';
import type { LayoutOptions } from './options.js';
import { createEnv } from './env.js';
import { FAN_ROUNDS, MAX_RERUNS, SIDE_ROUNDS } from './limits.js';
import type { State } from './state.js';
import { attempt } from './round.js';
import { course, fan, noteDeclined, portName, side, span, turn } from './rounds.js';
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, measureFans } from '../layout/fan-spread.js';
import { chordClearances } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { TrunkBlocked, sideHintDiagnostics } from '../layout/side-hints.js';
import { turnMissed } from '../layout/turn-order.js';
import { measureSides } from '../layout/side-measure.js';
import { routedBends } from '../layout/side-judge.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { beats, gainOf, judgeOverlayTrial, measureOverlayCourses } from '../layout/course-measure.js';
import { roundLimit, turnReserve, turnRoundRuns } from '../layout/turn-measure.js';
import { nodeFloors as floorEntries, reserve as addReservations, courseEntries, declinedTrunksOf, declineTrunk, sideFaces, sideHintsOf, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import { holds, holdsRouted } from '../layout/reservation-checks.js';


export { MAX_RERUNS, PlacementBudgetExceeded } from './limits.js';
export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';

export type { LayoutOptions, LayoutProgress } from './options.js';

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  const env = createEnv(document, options);
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
  // the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
  let first!: LayoutModel;
  let reruns = 0;
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
    if (reruns >= (options.testMaxReruns ?? MAX_RERUNS)) kept = addReservations(kept, declineTrunk(undefined, 'the placement budget is spent', env.placements));
    try { first = await env.timed('place', () => env.place(kept)); break; } catch (error) {
      if (!(error instanceof TrunkBlocked) || declinedTrunksOf(kept).has(error.key)) throw error;
      kept = addReservations(kept, declineTrunk(error.key, error.why, env.placements));
      reruns++;
      options.testSideTrace?.({ ev: 'trunk-blocked', key: error.key, reruns, left: (options.testMaxReruns ?? MAX_RERUNS) - reruns });
    }
  }
  const s: State = { kept7e: first, base: first, baseMoved: false, kept, reruns, cuts: [], sideNotes: [], keptNotes: [], promised: new Map(), refused: new Set(), trialLinks: new Map(), silent: false, sideRound: 0 };
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
    if (s.reruns >= roundLimit(env.maxReruns, reserve())) { options.testSideTrace?.({ ev: 'course-skipped', offer, reruns: s.reruns }); return; }
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
      else if (s.reruns + 2 <= env.maxReruns) courseDeferred = true;
      else {
        const courseGain = gainOf([...offer.promised].map(([, item]) => [item.base.turns === Infinity ? undefined : item.base.turns, item.turns] as [number | undefined, number]));
        const sideGain = gainOf([...sideOffer.promised.values()].map(item => [bends.get(item.link), item.bends] as [number | undefined, number]));
        if (sideOffer.hints.size > 0 && beats(courseGain, sideGain)) await courseRound(offer);
        else options.testSideTrace?.({ ev: 'course-skipped', offer, reruns: s.reruns });
      }
    }
  }
  for (let round = 0; round < SIDE_ROUNDS; round++) {
    const offer = await side.measure(env, s);
    if (offer === undefined) break;
    if (s.reruns >= roundLimit(env.maxReruns, reserve())) {
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
      const left = env.maxReruns - s.reruns;
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
    const current = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
    const overlayOffer = measureOverlayCourses(s.base, current);
    options.testSideTrace?.({ ev: 'overlay-courses', offer: overlayOffer, base: s.base, routedBase: current });
    if (overlayOffer.courses.length > 0 && s.reruns >= env.maxReruns) options.testSideTrace?.({ ev: 'overlay-skipped', offer: overlayOffer, reruns: s.reruns });
    else if (overlayOffer.courses.length > 0) {
      const nodeFloors = new Map<string, Size>();
      for (const key of sideHintsOf(s.kept).keys()) {
        const [node] = JSON.parse(key) as [string];
        const size = env.stage3Sizes.get(s.kept7e)?.get(node);
        if (size !== undefined) nodeFloors.set(node, { ...size });
      }
      // A node whose overlay end changes face keeps its size (P9): the capacity estimate of the face it leaves must not re-size it.
      for (const course of overlayOffer.courses) {
        const link = s.kept7e.links.find(item => item.id === course.link)!;
        for (const which of ['from', 'to'] as const) {
          const size = env.stage3Sizes.get(s.kept7e)?.get(link.attachments![which].node);
          if (size !== undefined && course[which].face !== s.kept7e.nodes[link.attachments![which].node]!.ports.find(port => portKey(port.ref) === portKey(link.attachments![which]))?.side) nodeFloors.set(link.attachments![which].node, { ...size });
        }
      }
      const names = overlayOffer.courses.map(course => course.link);
      const refuseOverlays = (why: string): void => { options.testSideTrace?.({ ev: 'overlay-refused', links: names, why }); };
      let trial7e: LayoutModel | undefined;
      s.reruns++;
      const trialLedger = addReservations(s.kept, [...floorEntries(nodeFloors, 'overlay', env.placements),
        ...courseEntries(overlayOffer.courses, new Map([...overlayOffer.promised].map(([id, item]) => [id, item.turns] as const)), 'overlay', env.placements)]);
      try { trial7e = await env.timed('rerun-overlay', () => env.place(trialLedger, env.trialAbort)); } catch (error) {
        if (!(error instanceof PlacementRefusal) || error.code === 'budget') throw error;
        refuseOverlays(`the placement run rejected them (${error.message})`);
      }
      if (trial7e !== undefined && trial7e.fallbackUsed && !s.kept7e.fallbackUsed) { refuseOverlays('ELK fell back during the overlay trial'); trial7e = undefined; }
      const overlayBroken = trial7e === undefined ? [] : holds(trialLedger, trial7e);
      if (overlayBroken.length > 0) { refuseOverlays(`a reservation does not hold at stage 7e (${overlayBroken[0]!.why})`); trial7e = undefined; }
      if (trial7e !== undefined) {
        try {
          const trial = (await env.bands(trial7e!, true)).model;
          const routedTrial = await env.route(trial, true);
          const verdict = judgeOverlayTrial(current, routedTrial, overlayOffer);
          options.testSideTrace?.({ ev: 'overlay-trial', verdict, trial, routedTrial, routedBase: current });
          // The overlay judge reads the overlay links only; a course kept earlier keeps its promise through this trial too.
          const overlayLost = verdict.kept ? holdsRouted(s.kept, routedTrial) : [];
          if (overlayLost.length > 0) refuseOverlays(`a kept course publishes more turns than it promised (${overlayLost.map(failure => failure.link).join(', ')})`);
          else if (verdict.kept) {
            s.base = trial; s.kept7e = trial7e; s.routedFinal = routedTrial; s.kept = trialLedger;
            for (const course of overlayOffer.courses) {
              const was = overlayOffer.promised.get(course.link)!;
              s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: course.link }],
                message: `The overlay link ${course.link} takes a course round the outside: ${was.turns} turns promised, ${was.base} on the baseline.` });
            }
          } else refuseOverlays(verdict.reason);
        } catch (error) {
          if (!refusedAtBands(error)) throw error;
          refuseOverlays(`stage 7f rejected them (${error.message})`);
        }
      }
    }
  }
  for (const [key, item] of s.promised) {
    const side = sideHintsOf(s.kept).get(key);
    if (side === undefined) continue;
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_TAKEN',
      message: `The port ${portName(key)} takes the side ${side}: the ${item.shape} shape of ${item.link} (${item.bends} bends).`, owners: [{ kind: 'link', id: item.link }] });
  }
  s.sideNotes.push(...s.keptNotes);
  // Read on the 7e model that publishes: the kept one, or the kept trial's.
  const declined = declinedFanDiagnostics(measureFans(s.kept7e).declined);
  const atFreeze = chordClearances(s.kept7e);
  s.kept7e = s.base;
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed.
  const lost: Diagnostic[] = [...sideHintDiagnostics(s.kept7e)];
  for (const [pair, now] of chordClearances(s.kept7e)) {
    const before = atFreeze.get(pair);
    if (now < STRAIGHT_PATH_CLEARANCE.path - PLACEMENT_EPS && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Placement moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  // With the setting on, the kept model is routed once more to publish: a judged route carries the ordinary overlay paths.
  const published = s.kept7e.document.layout?.overlayOverBodies === true ? await env.route(s.kept7e, undefined, true) : s.routedFinal ?? s.routedBase ?? await env.route(s.kept7e);
  // A course that publishes more turns than its candidate promised is named; the promise is the polyline its own lane geometry reserved.
  for (const failure of holdsRouted(s.kept, published)) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'COURSE_SHAPE_LOST', owners: [{ kind: 'link', id: failure.link! }],
      message: `The link ${failure.link} has ${failure.got === undefined ? 'no route' : `${failure.got} turns`} on its course, ${failure.max} were promised.` });
  }
  lost.push(...turnMissed(published));
  // A hinted link of a kept trial has no more bends than on the baseline (the judgment tested it); this names a break of that rule.
  if (s.routedFinal !== undefined && s.routedBase !== undefined) {
    const before = routedBends(s.routedBase), after = routedBends(s.routedFinal);
    for (const [key, item] of s.promised) {
      if ((after.get(item.link) ?? Infinity) > (before.get(item.link) ?? Infinity)) lost.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST',
        message: `The hinted link ${item.link} (port ${portName(key)}) has more bends than on the baseline (${before.get(item.link)}).`, owners: [{ kind: 'link', id: item.link }] });
    }
  }

  return env.timed('link-labels', () => env.step('link-labels', () => linkLabels(published, [...s.cuts, ...s.sideNotes, ...declined, ...lost])));
}
