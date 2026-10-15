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
import { endMode } from '../layout/course-rows.js';
import { PlacementRefusal, refusedAtBands } from '../layout/placement-refusal.js';
import { bands } from '../layout/bands.js';
import { linkLabels } from '../layout/link-labels.js';
import { CommandDeadlineError } from './budget.js';
import type { LayoutOptions } from './options.js';
import { createEnv } from './env.js';
import { FAN_ROUNDS, MAX_RERUNS, SIDE_ROUNDS } from './limits.js';
import type { State } from './state.js';
import { attempt } from './round.js';
import { fan } from './rounds.js';
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, fanRoundHolds, measureFans } from '../layout/fan-spread.js';
import { chordClearances, freezeRefusal } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { TrunkBlocked, sideHintDiagnostics } from '../layout/side-hints.js';
import { turnMissed } from '../layout/turn-order.js';
import { measureSides, refusedKey } from '../layout/side-measure.js';
import { judgeTrial, predictedWorse, predictPublished, routedBends, trialNotes } from '../layout/side-judge.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import { measureSpans } from '../layout/span-measure.js';
import { judgeSpanTrial } from '../layout/span-judge.js';
import { transitTiers } from '../layout/lanes.js';
import { beats, gainOf, judgeCourseTrial, judgeOverlayTrial, measureCourses, measureOverlayCourses } from '../layout/course-measure.js';
import { judgeTurnTrial, measureTurnOrder, roundLimit, turnReserve, turnRoundRuns } from '../layout/turn-measure.js';
import { pitchGrowth, nodeFloors as floorEntries, reserve as addReservations, courseEntries, declinedTrunksOf, promisedTurns, declineTrunk, laneOwners, sideFaces, sideHintsOf, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import { holds, holdsRouted } from '../layout/reservation-checks.js';


export { MAX_RERUNS, PlacementBudgetExceeded } from './limits.js';
/** The span round's label of a refusal: `placement` for an expected one, `error` for anything else (the trace names it, so a sweep finds a defect). */
const spanCode = (error: Error): 'placement' | 'error' => error instanceof PlacementRefusal && error.code !== 'centring' && error.code !== 'budget' ? 'placement' : 'error';
const portName = (key: string): string => {
  const [node, anonymous, name, ordinal] = JSON.parse(key) as [string, boolean, string | null, number];
  return `${node}.${anonymous ? '' : name}#${ordinal}`;
};

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
  const s: State = { kept7e: first, base: first, baseMoved: false, kept, reruns, cuts: [], sideNotes: [], keptNotes: [], promised: new Map(), refused: new Set(), trialLinks: new Map(), silent: false };
  // The re-runs are bounded by FAN_ROUNDS alone, and no re-run reads the clock (ticket 141): the same input gives the same layout at any speed.
  // The command deadline ends the whole command with an error (`step`, `route`, `trialAbort`) and never picks a layout. A re-run that makes ELK
  // fall back (an ELK error, never a timeout: a timeout ends the command) is dropped: the placement already made stands (ticket 89 review).
  const cutSide = (why: string): void => {
    s.cuts.push({ stage: 'placement', severity: 'warning', code: 'SIDE_ROUND_CUT',
      message: `A side round was cut: ${why}. The last kept placement stands, and this layout may differ from one made with more time.` });
  };
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
  const refuse = (keys: Iterable<string>, side: ReadonlyMap<string, 'left' | 'right'>, reason: string): void => {
    for (const key of keys) {
      s.refused.add(refusedKey(key, side.get(key)!));
      if (s.silent) continue;
      const link = s.promised.get(key)?.link ?? s.trialLinks.get(key);
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_REFUSED',
        message: `The side hint ${side.get(key)} on ${portName(key)} was refused: ${reason}.`, ...(link === undefined ? {} : { owners: [{ kind: 'link' as const, id: link }] }) });
    }
  };
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
  // A bypass that cannot be reserved stays a remainder of stage 8 and is named, once, with the reason (`ROW_BYPASS_DECLINED`).
  const noteDeclined = (offer: ReturnType<typeof measureCourses>): void => {
    for (const item of offer.declined) {
      if (s.sideNotes.some(note => note.code === 'ROW_BYPASS_DECLINED' && note.owners?.some(owner => owner.kind === 'link' && owner.id === item.link))) continue;
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_DECLINED', owners: [{ kind: 'link', id: item.link }], message: `The link ${item.link} has no row bypass: ${item.why}.` });
    }
  };
  const courseRound = async (given?: ReturnType<typeof measureCourses>): Promise<void> => {
    if (given === undefined) s.routedBase = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
    const offer = given ?? measureCourses(s.base, s.routedBase!);
    options.testSideTrace?.({ ev: 'courses', offer, base: s.base, routedBase: s.routedBase });
    noteDeclined(offer);
    if (offer.courses.length === 0) return;
    if (s.reruns >= roundLimit(env.maxReruns, reserve())) { options.testSideTrace?.({ ev: 'course-skipped', offer, reruns: s.reruns }); return; }
    // The node floors of a kept course trial stay under this one (a later side trial keeps them, or it would re-size the nodes the course moved).
    const nodeFloors = new Map<string, Size>();
    for (const key of sideHintsOf(s.kept).keys()) {
      const [node] = JSON.parse(key) as [string];
      const size = env.stage3Sizes.get(s.kept7e)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    for (const course of offer.courses) {
      const link = s.kept7e.links.find(item => item.id === course.link)!;
      for (const which of ['from', 'to'] as const) {
        const size = env.stage3Sizes.get(s.kept7e)?.get(link.attachments![which].node);
        // A node whose end leaves by a U part is not pinned: its face moves from a lateral side to the bottom, and its content grows with it (P9 asks for few moves, not for none).
        if (size !== undefined && endMode(course, which) !== 'u' && course[which].face !== (s.kept7e.nodes[link.attachments![which].node]!.ports.find(port => portKey(port.ref) === portKey(link.attachments![which]))?.side)) nodeFloors.set(link.attachments![which].node, { ...size });
      }
    }
    s.reruns++;
    // A row bypass (ticket 24, phase 5) puts the closing link in the slot on its turn side: the trial carries the turn order, or its stems would cross the straight link of the gap.
    const bypassLinks = offer.courses.filter(course => course.kind === 'bypass').map(course => course.link);
    const trialLedger = addReservations(s.kept, [...floorEntries(nodeFloors, 'course', env.placements),
      ...courseEntries(offer.courses, new Map([...offer.promised].map(([id, item]) => [id, item.turns] as const)), 'course', env.placements),
      ...turnEntries(false, bypassLinks, false, 'course', env.placements)]);
    const names = offer.courses.map(course => course.link);
    // A refused course round leaves the layout as the baseline made it, with no note (the trace names the reason), so a sheet it does not change is byte for byte as it was.
    const courseRefusal = (why: string): void => { options.testSideTrace?.({ ev: 'course-refused', links: names, why }); };
    let trial7e: LayoutModel | undefined;
    try { trial7e = await env.timed('rerun-course', () => env.place(trialLedger, env.trialAbort)); } catch (error) {
      // A course moves columns the baseline never moved. A centring that cannot hold its feeds there is the course's refusal, not a bug of the baseline.
      if (!(error instanceof PlacementRefusal) || error.code === 'budget') throw error;
      courseRefusal(`the placement run rejected them (${error.message})`);
    }
    if (trial7e !== undefined && trial7e.fallbackUsed && !s.kept7e.fallbackUsed) {
      courseRefusal('ELK fell back during the course trial'); trial7e = undefined;
    }
    // Every active reservation holds at the trial's final 7e, the kept ones of earlier rounds with the new courses, before 7f and the route.
    const courseBroken = trial7e === undefined ? [] : holds(trialLedger, trial7e);
    if (courseBroken.length > 0) { courseRefusal(`a reservation does not hold at stage 7e (${courseBroken[0]!.why})`); trial7e = undefined; }
    if (trial7e !== undefined) {
      try {
        const { model: trial, moved: trialMoved, unmoved: trialUnmoved } = await env.bands(trial7e!, true);
        const routedTrial = await env.route(trial, true);
        const verdict = judgeCourseTrial(s.routedBase!, routedTrial, new Map([...offer.promised].map(([id, item]) => [id, item.turns] as const)));
        options.testSideTrace?.({ ev: 'course-trial', verdict, trial, routedTrial, routedBase: s.routedBase });
        // A course kept earlier keeps its promise through this trial as well.
        const courseLost = verdict.kept ? holdsRouted(s.kept, routedTrial) : [];
        if (courseLost.length > 0) courseRefusal(`a kept course publishes more turns than it promised (${courseLost.map(failure => failure.link).join(', ')})`);
        else if (verdict.kept) {
          if (s.routedFinal === undefined) s.routedBase = routedTrial;
        s.base = trial; s.kept7e = trial7e; s.routedFinal = routedTrial;
          s.baseMoved = trialMoved; s.baseUnmoved = trialUnmoved; s.kept = trialLedger;
          for (const course of offer.courses) {
            const was = offer.promised.get(course.link)!;
            if (course.kind === 'bypass') {
              s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_PLANNED', owners: [{ kind: 'link', id: course.link }],
                message: `The link ${course.link} takes a bypass along the ${course.edge} edge of its row: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
              continue;
            }
            s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: course.link }],
              message: `The link ${course.link} takes a course ${course.kind === 'shared-port' ? 'onto the pill of its shared port' : course.runs.includes('gap') ? 'through a column gap' : 'round the outside'}: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
          }
        } else {
          courseRefusal(`${verdict.reason}`);
        }
      } catch (error) {
        if (!refusedAtBands(error)) throw error;
        courseRefusal(`stage 7f rejected them (${error.message})`);
      }
    }
  };
  // The span round (architecture ticket 22, phase 3). It reads the 7f baseline and its routed result, offers a spanning chord to every link between document tiers that
  // are not consecutive whose corridor is clear, places again with the span hints, and keeps the trial only on its routed result (`judgeSpanTrial`). It runs before the
  // course, side and overlay-course rounds, because a chord changes which routes are poor, and it shares their re-runs. A refused round leaves the sheet as it was.
  const spanRound = async (): Promise<boolean> => {
    const offer = measureSpans(s.base, s.routedBase!);
    options.testSideTrace?.({ ev: 'spans', offer, base: s.base, routedBase: s.routedBase });
    if (offer.links.length === 0) return false;
    // The round leaves one re-run to each round after it that has an offer on the baseline (course, side): a trial that is refused has spent its placements, and must not
    // starve a round that main would have run.
    const spanMax = roundLimit(env.maxReruns, reserve()) - (measureCourses(s.base, s.routedBase!).courses.length > 0 ? 1 : 0) - (measureSides(s.base, s.kept7e, s.refused).hints.size > 0 ? 1 : 0);
    if (s.reruns >= spanMax) { options.testSideTrace?.({ ev: 'span-refused', links: offer.links, why: 'budget' }); return false; }
    s.reruns++;
    const spanRefusal = (why: string, detail: string): void => { options.testSideTrace?.({ ev: 'span-refused', links: offer.links, why, detail }); };
    // The trial reserves its chords on top of the ledger; the fans of the trial grow this one, and a kept trial keeps it.
    let trialFloors = addReservations(s.kept, spanEntries(offer.links, 'span', env.placements));
    let trial7e: LayoutModel | undefined;
    try { trial7e = await env.timed('rerun-span', () => env.place(trialFloors, env.trialAbort)); } catch (error) {
      // The span round is an offer: a trial that the placement cannot build is refused, whatever the cause, and the sheet stays as the baseline made it. Only the command
      // deadline ends the command. The trace names the error, so a sweep that greps `span-refused` for `error` finds a defect.
      if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
      spanRefusal(spanCode(error), error.message);
      return false;
    }
    if (trial7e.fallbackUsed && !s.kept7e.fallbackUsed) { spanRefusal('placement', 'ELK fell back during the span trial'); return false; }
    // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement (ticket 89): the chords of this trial are measured as the fan
    // rounds measure the first placement, and the trial places again with the floors they ask for. The re-runs are the command's (MAX_RERUNS).
    for (let round = 0; round < FAN_ROUNDS && s.reruns < spanMax; round++) {
      const measure = await env.timed('measureFans', () => measureFans(trial7e!));
      const grown = pitchGrowth(trialFloors, measure.floors, 'span', env.placements);
      if (grown.length === 0) break;
      const next = addReservations(trialFloors, grown);
      s.reruns++; attemptCounters.invalidations.fanReruns++;
      let again: LayoutModel;
      try { again = await env.timed('rerun-fan', () => env.place(next, env.trialAbort)); } catch (error) {
        if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
        spanRefusal(spanCode(error), error.message); return false;
      }
      if (again.fallbackUsed && !s.kept7e.fallbackUsed) { spanRefusal('placement', 'ELK fell back during the span trial'); return false; }
      if (!fanRoundHolds(trial7e, again)) break;
      trial7e = again; trialFloors = next;
    }
    // 7f freezes the chords that are straight now and no other (`freezeChords`), so a hinted link that is not straight here (the freeze refuses it, as `leg` when a neighbour's
    // leg crowds it at the pitch the trial gave) is lost: the trial is refused here, before 7f and the route.
    // The placement above is spent, so nothing is given back.
    const spanFailed = holds(trialFloors, trial7e!);
    const lost = spanFailed.filter(failure => failure.kind === 'spanChord' && offer.links.includes(failure.link!)).map(failure => failure.link!);
    if (lost.length > 0) { spanRefusal('promise', `the freeze would not hold ${lost.join(', ')}: ${lost.map(id => { const item = trial7e!.links.find(other => other.id === id); return item === undefined ? 'missing' : freezeRefusal(trial7e!, item) ?? 'not straight'; }).join(', ')} (before 7f)`); return false; }
    // A reservation kept by an earlier round must hold at the trial's final 7e as well (ticket 22 left that open).
    const otherLost = spanFailed.filter(failure => !lost.includes(failure.link!) || failure.kind !== 'spanChord');
    if (otherLost.length > 0) { spanRefusal('promise', `a kept reservation does not hold: ${otherLost[0]!.why} (before 7f)`); return false; }
    try {
      const { model: trial, moved: trialMoved, unmoved: trialUnmoved } = await env.bands(trial7e!, true);
      const routedTrial = await env.route(trial, true);
      const verdict = judgeSpanTrial(s.routedBase!, routedTrial, offer.links);
      options.testSideTrace?.({ ev: 'span-trial', verdict, trial, routedTrial, routedBase: s.routedBase, offer });
      if (!verdict.kept) { spanRefusal(verdict.reason!, verdict.detail); return false; }
      const spanBroken = holdsRouted(s.kept, routedTrial);
      if (spanBroken.length > 0) { spanRefusal('promise', `a kept course publishes more turns than it promised (${spanBroken.map(failure => failure.link).join(', ')})`); return false; }
      s.kept = trialFloors;
      s.base = trial; s.kept7e = trial7e; s.routedFinal = routedTrial; s.routedBase = routedTrial;
      s.baseMoved = trialMoved; s.baseUnmoved = trialUnmoved;
      for (const id of offer.links) {
        const link = trial.links.find(item => item.id === id)!;
        const crossed = transitTiers(trial, link);
        s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SPAN_CHORD_TAKEN', owners: [{ kind: 'link', id }],
          message: `The link ${id} takes a spanning chord over ${crossed.length + 1} tier gaps, through ${crossed.length} transited ${crossed.length === 1 ? 'band' : 'bands'} (sub-tier ${crossed.join(', ')}).` });
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
      spanRefusal(spanCode(error), `stage 7f rejected them (${error.message})`);
      return false;
    }
  };
  // The two rounds share the re-runs, and both are judged by the user's order on what they publish. A course kept first would take away the offer a side round
  // reads on the baseline (the 3b pattern), so where the budget allows both, the side round goes first and the course round reads its result. Where it allows one,
  // the offer whose promise gains more takes it (a side offer that only the unmoved copy has promises nothing and wins).
  let courseDeferred = false;
  if (options.testCourses === undefined) {
    s.routedBase = await env.route(s.base);
    // A forced hint (the test option) is the whole of the span round; otherwise the round runs here, before the course round.
    if (options.testSpanHints === undefined) await spanRound();
    const offer = measureCourses(s.base, s.routedBase);
    options.testSideTrace?.({ ev: 'courses', offer, base: s.base, routedBase: s.routedBase });
    noteDeclined(offer);
    if (offer.courses.length > 0) {
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
    s.silent = false; // only the round-0 extra trial is silent; a later round publishes its refusals
    let offer = await env.timed('measureSides', () => measureSides(s.base, s.kept7e, s.refused));
    // No offer on the kept 7f result. If a 7f move changed the placement, the unmoved baseline may have had one that the move removed: it runs as one
    // extra side trial, judged on routed results like any other, so the kept result stands unless a real trial beats it (architecture ticket 15, phase 3b).
    // The settled copy 7f judged its first move against is only a filter: it is the round-0 state plus one settle, not the state 7f would publish without
    // moves. When its offer is empty the trial is skipped; otherwise the true unmoved baseline is rebuilt (silently: no progress event, no attempt trace, since
    // this run is never published) and the trial starts from the rebuilt offer. With no copy, the rebuild runs. Nothing is built when no re-run is left.
    let unmovedOffer = false, filtered: boolean | undefined;
    if (round === 0 && offer.hints.size === 0 && s.baseMoved && s.reruns < env.maxReruns) {
      if (s.baseUnmoved !== undefined) filtered = measureSides(s.baseUnmoved, s.kept7e, s.refused).hints.size > 0;
      if (filtered !== false || options.testRebuildAlways === true) {
        const unmoved = await env.timed('bands-unmoved', () => bands(s.kept7e, () => env.trialAbort('bands'), undefined, false));
        offer = await env.timed('measureSides', () => measureSides(unmoved, s.kept7e, s.refused));
        unmovedOffer = offer.hints.size > 0;
        s.silent = unmovedOffer;
      }
    }
    options.testSideTrace?.({ ev: 'offer', round, offer, base: s.base, kept7e: s.kept7e, unmoved: unmovedOffer, filtered });
    if (offer.capped) s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_PROBE_CAPPED', message: 'The side measure stopped at its probe cap; the links after it were not probed.' });
    if (offer.hints.size === 0) break;
    if (s.reruns >= roundLimit(env.maxReruns, reserve())) {
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${env.maxReruns} placement re-runs.` });
      break;
    }
    const all = new Map([...sideHintsOf(s.kept), ...offer.hints]);
    for (const [key, item] of offer.promised) s.trialLinks.set(key, item.link);
    const nodeFloors = new Map<string, Size>();
    for (const key of all.keys()) {
      const [node] = JSON.parse(key) as [string];
      // The 7e model keys the size cache, never the baseline (a new object: the lookup would give undefined with no error).
      const size = env.stage3Sizes.get(s.kept7e)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    let trial7e: LayoutModel;
    // The faces stay with the ledger when the trial is kept; the size floors of a side trial do not (a later round measures its own).
    const faces = [...sideFaces(offer.hints, offer.promised, 'side', env.placements),
      ...laneOwners([...offer.promised].filter(([, item]) => item.shape === 'lane').map(([key]) => key), offer.hints, offer.promised, 'side', env.placements)];
    const trialLedger = addReservations(s.kept, [...floorEntries(nodeFloors, 'side', env.placements), ...faces]);
    s.reruns++; attemptCounters.invalidations.sideReruns++;
    try { trial7e = await env.timed('rerun-side', () => env.place(trialLedger, env.trialAbort)); } catch (error) {
      // Only the layout's own refusals drop the offer; anything else (a TypeError) is a bug and must surface.
      if (!refusedAtBands(error)) throw error;
      refuse(offer.hints.keys(), offer.hints, `the placement run rejected it (${error.message})`);
      continue;
    }
    if (trial7e.fallbackUsed && !s.kept7e.fallbackUsed) {
      cutSide('ELK fell back during it, and the re-run was dropped'); break;
    }
    // The ledger answers for the faces and lanes of the trial (this round's and the kept ones) at its final 7e, before 7f and the route: a port hinted for the straight shape
    // of a routed link must hold its chord (otherwise the router would find its route, review M1, ticket 117), and a port hinted for the routed L must own a source-aligned
    // side lane (an exterior corridor gives three bends, ticket 119).
    const failed = holds(trialLedger, trial7e);
    const chordLost = failed.filter(failure => failure.kind === 'sideFace');
    if (chordLost.length > 0) {
      const own = chordLost.map(failure => failure.key!).filter(key => offer.hints.has(key));
      refuse(own.length > 0 && own.length === chordLost.length ? own : offer.hints.keys(), all,
        `a port hinted for a chord does not hold its chord at stage 7e (${[...new Set(chordLost.map(failure => failure.link))].join(', ')})`);
      continue;
    }
    const laneLost = failed.filter(failure => failure.kind === 'laneOwner');
    if (laneLost.length > 0) {
      const own = laneLost.map(failure => failure.key!).filter(key => offer.hints.has(key));
      refuse(own.length > 0 && own.length === laneLost.length ? own : offer.hints.keys(), all,
        `a port hinted for a side lane has no source-aligned lane at stage 7e (${[...new Set(laneLost.map(failure => failure.link))].join(', ')})`);
      continue;
    }
    const otherFailed = failed.filter(failure => failure.kind !== 'sideFace' && failure.kind !== 'laneOwner');
    if (otherFailed.length > 0) { refuse(offer.hints.keys(), all, `a reservation does not hold at stage 7e (${otherFailed[0]!.why})`); continue; }
    const hintedLinks = new Map([...offer.promised.values()].map(item => [item.link, item.bends] as const));
    // The predictor prunes only when another round and another re-run remain, and only the hints it calls worse (Section 19.3).
    if (!unmovedOffer && round + 1 < SIDE_ROUNDS && s.reruns < env.maxReruns) {
      const worse = predictedWorse(predictPublished(trial7e, s.kept7e, s.base), s.base, hintedLinks.keys());
      const pruned = [...offer.hints.keys()].filter(key => worse.away.includes(key) || worse.links.includes(offer.promised.get(key)?.link ?? ''));
      if (pruned.length > 0) { refuse(pruned, all, 'the prediction from the moves of stage 7f gives it more bends than the baseline'); continue; }
    }
    let trial: LayoutModel, routedTrial: LayoutModel;
    try {
      trial = (await env.bands(trial7e, true)).model;
      s.routedBase ??= await env.route(s.base);
      routedTrial = await env.route(trial, true);
    } catch (error) {
      if (!refusedAtBands(error)) throw error;
      refuse(offer.hints.keys(), offer.hints, `its stage 7f rejected it (${error.message})`);
      break;
    }
    const verdict = judgeTrial({ routedBase: s.routedBase, routedTrial, kept7e: s.kept7e, trial7e, hinted: hintedLinks, lanes: new Set([...offer.promised.values()].filter(item => item.shape === 'lane').map(item => item.link)) });
    options.testSideTrace?.({ ev: 'trial', verdict, base: s.base, kept7e: s.kept7e, trial7e, trial, routedBase: s.routedBase, routedTrial, hinted: hintedLinks });
    options.testSideProbe?.({ offer, routedBase: s.routedBase, routedTrial, verdict });
    // A kept course keeps its promise through the side round as well: a side trial that makes a course link publish more turns than it promised is refused.
    const brokenPromise = verdict.kept ? holdsRouted(s.kept, routedTrial).map(failure => failure.link!) : [];
    if (brokenPromise.length > 0) { refuse(offer.hints.keys(), all, `a course link publishes more turns than it promised (${brokenPromise.join(', ')})`); break; }
    if (!verdict.kept) { refuse(offer.hints.keys(), all, verdict.reason); break; }
    // Kept: the trial is the baseline now. The notes name what the net count accepted.
    s.keptNotes.push(...trialNotes(s.routedBase, routedTrial, verdict, hintedLinks.keys()));
    s.base = trial; s.kept7e = trial7e; s.kept = addReservations(s.kept, faces); s.routedFinal = routedTrial;
    for (const [key, item] of offer.promised) s.promised.set(key, item);
    break; // one trial reaches 7f per command
  }
  if (courseDeferred) await courseRound();
  // The turn round (architecture ticket 24, Section 10). On the kept result of the span, course and side rounds: when the planned first turns would reorder the ports of a
  // face, placement runs once more with the turn order and the trial is kept only when the published result is better by the unified order. It takes one re-run of the
  // shared budget and leaves one to the overlay round when that round has an offer. A refused or skipped trial leaves the layout as the baseline made it, with no note.
  if (turnRoundOn) {
    const offer = measureTurnOrder(s.base);
    options.testSideTrace?.({ ev: 'turns', offer, base: s.base });
    const names = offer.faces.map(face => `${face.node}.${face.side}`);
    const refuseTurns = (why: string): void => { options.testSideTrace?.({ ev: 'turn-refused', faces: names, why }); };
    if (offer.faces.length > 0) {
      const current = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
      const overlayOffer = options.testOverlayCourses !== false ? measureOverlayCourses(s.base, current) : undefined;
      const overlayAhead = overlayOffer !== undefined && overlayOffer.courses.length > 0;
      const left = env.maxReruns - s.reruns;
      // The turn offer moves no bend and no turn by design, so it promises none: with one re-run left and both offers it runs only if the overlay offer promises nothing either.
      const overlayGain = overlayAhead ? gainOf([...overlayOffer.promised].map(([, item]) => [item.base === Infinity ? undefined : item.base, item.turns] as [number | undefined, number])) : [0, 0, 0];
      if (!turnRoundRuns(left, overlayAhead, overlayGain, beats)) {
        s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ROUND_SKIPPED', message: `The turn round was skipped: the command has ${left <= 0 ? 'made its' : 'one left of its'} ${env.maxReruns} placement re-runs${left <= 0 ? '' : ', for the overlay round'}.` });
      } else {
        const nodeFloors = new Map<string, Size>();
        for (const key of sideHintsOf(s.kept).keys()) {
          const [node] = JSON.parse(key) as [string];
          const size = env.stage3Sizes.get(s.kept7e)?.get(node);
          if (size !== undefined) nodeFloors.set(node, { ...size });
        }
        let trial7e: LayoutModel | undefined;
        s.reruns++;
        // The ledger a kept trial keeps asks for no change of a face; the trial's own asks for one (the turn order must move a face, or the trial is refused).
        const keptTurn = addReservations(s.kept, [...floorEntries(nodeFloors, 'turn', env.placements), ...turnEntries(true, [], false, 'turn', env.placements)]);
        const trialLedger = addReservations(keptTurn, turnEntries(true, [], true, 'turn', env.placements));
        try { trial7e = await env.timed('rerun-turn', () => env.place(trialLedger, env.trialAbort)); } catch (error) {
          if (!(error instanceof PlacementRefusal)) throw error;
          refuseTurns(`the placement run rejected it (${error.message})`);
        }
        if (trial7e !== undefined && trial7e.fallbackUsed && !s.kept7e.fallbackUsed) { refuseTurns('ELK fell back during the turn trial'); trial7e = undefined; }
        // The offer was decided before any placement; this is left only when the measure and stage 5 disagree about a face. The placement is spent (no re-run is given back).
        const turnFailed = trial7e === undefined ? [] : holds(trialLedger, trial7e);
        if (turnFailed.length > 0) { refuseTurns(turnFailed[0]!.kind === 'turnOrder' ? turnFailed[0]!.why : `a reservation does not hold at stage 7e (${turnFailed[0]!.why})`); trial7e = undefined; }
        if (trial7e !== undefined) {
          try {
            const trial = (await env.bands(trial7e!, true)).model;
            const routedTrial = await env.route(trial, true);
            const verdict = judgeTurnTrial(current, routedTrial, promisedTurns(s.kept));
            options.testSideTrace?.({ ev: 'turn-trial', verdict, trial, routedTrial, routedBase: current });
            if (verdict.kept) {
              s.base = trial; s.kept7e = trial7e; s.routedFinal = routedTrial; s.kept = keptTurn;
              for (const face of trial7e.freeze!.turnOrder!) {
                s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ORDER_TAKEN', owners: [{ kind: 'node', id: face.node }],
                  message: `The ports of the ${face.side} face of ${face.node} take the order of their planned first turns: ${verdict.before!.bent} bent links, ${verdict.before!.turns} turns and ${verdict.before!.crossings} crossings on the baseline, ${verdict.after!.bent}, ${verdict.after!.turns} and ${verdict.after!.crossings} after.` });
              }
            } else refuseTurns(verdict.reason);
          } catch (error) {
            if (!refusedAtBands(error)) throw error;
            refuseTurns(`stage 7f rejected it (${error.message})`);
          }
        }
      }
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
