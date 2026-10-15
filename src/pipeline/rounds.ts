/**
 * The six rounds as descriptors (architecture 2, ticket 04): fan, span, course, side, turn and overlay. Each one is a table of what it measures, reserves, checks, judges, commits and
 * says when it is refused; `attempt` (round.ts) runs a trial from it. A descriptor holds the round's own rules and nothing about the order of the rounds.
 */
import type { Course, Diagnostic, Size } from '../model/index.js';
import { portKey } from '../layout/sides-one.js';
import { endMode } from '../layout/course-rows.js';
import { fanRoundDropped, fanRoundHolds, measureFans } from '../layout/fan-spread.js';
import { TrunkBlocked } from '../layout/side-hints.js';
import { PlacementRefusal, refusedAtBands } from '../layout/placement-refusal.js';
import { freezeRefusal } from '../layout/frame-paths.js';
import { transitTiers } from '../layout/lanes.js';
import { measureSpans } from '../layout/span-measure.js';
import { judgeSpanTrial } from '../layout/span-judge.js';
import { judgeCourseTrial, measureCourses } from '../layout/course-measure.js';
import { measureSides } from '../layout/side-measure.js';
import { roundLimit, turnReserve } from '../layout/turn-measure.js';
import { pitchGrowth, nodeFloors as floorEntries, courseEntries, reserve as addReservations, sideHintsOf, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import { holds, holdsRouted } from '../layout/reservation-checks.js';
import { attempt, type Round } from './round.js';
import { CommandDeadlineError } from './budget.js';
import type { Env } from './env.js';
import { FAN_ROUNDS } from './limits.js';
import type { State } from './state.js';

/** A fan re-run was cut: the fans keep the pitch of the last completed placement. */
const cutNote = (why: string): Diagnostic => ({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_CUT',
  message: `A fan re-run was cut: ${why}. The fans keep the pitch of the last completed placement, and this layout may differ from one made with more time.` });

/**
 * The fan round (ticket 89). A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing: the placed chords say the pitch
 * each face needs, and placement runs again with those floors until no face needs more. It is judged at 7e alone. The re-runs are bounded by the fan limit alone, and no re-run
 * reads the clock (ticket 141). A re-run that makes ELK fall back (an ELK error, never a timeout) is dropped: the placement already made stands (ticket 89 review).
 * `child` is the same round inside a span trial: it works on the trial's tentative state, takes any refusal of the placement as the span's, and checks no ledger of its own
 * (the span checks the ledger once, at its final 7e).
 */
const fanRound = (child: boolean): Round<{ grown: Reservations }> => ({
  id: 'fan', label: 'rerun-fan', routed: false, abort: child, invalidation: 'fanReruns',
  // A fan floor can move the rows, and a trunk that the baseline placed may then have a foreign unit on both sides. The run that found it blocked is a
  // trial, so the round is cut and the baseline stands (a test cannot reach this: it needs a floor that reorders a row of the mesh).
  tolerates: (error, phase) => phase === 'place' && (child ? isRefusable(error) : error instanceof TrunkBlocked),
  async measure(env, s) {
    const measure = await env.timed('measureFans', () => measureFans(s.kept7e));
    const grown = pitchGrowth(s.kept, measure.floors, child ? 'span' : 'fan', env.placements);
    return grown.length === 0 ? undefined : { grown };
  },
  reserve: (_env, s, o) => addReservations(s.kept, o.grown),
  holdsAt7e(_env, s, _o, ledger, trial7e) {
    if (!fanRoundHolds(s.kept7e, trial7e)) return { at: 'ledger', why: 'the fan round does not hold', note: fanRoundDropped(s.kept7e, trial7e) };
    // Every active reservation holds at the final 7e of the re-run, or the re-run is dropped.
    const broken = child ? [] : holds(ledger, trial7e);
    return broken.length > 0 ? { at: 'ledger', why: broken[0]!.why } : undefined;
  },
  judge: () => undefined,
  commit(_env, s, _o, t) { s.kept7e = t.trial7e; s.kept = t.ledger; },
  refuse(_env, s, _o, r) {
    if (child) return;
    s.cuts.push(r.note ?? cutNote(r.at === 'place' ? 'a trunk join was blocked by the moved rows, and the re-run was dropped'
      : r.at === 'fallback' ? 'ELK fell back during it, and the re-run was dropped' : `it broke a reservation (${r.why})`));
  },
});
export const fan = fanRound(false);
const spanFan = fanRound(true);

/** Any error but the command deadline: the span round is an offer, and a trial the placement cannot build is refused, whatever the cause. */
const isRefusable = (error: unknown): error is Error => error instanceof Error && !(error instanceof CommandDeadlineError);
/** The span round's label of a refusal: `placement` for an expected one, `error` for anything else (the trace names it, so a sweep finds a defect). */
const spanCode = (error: Error): 'placement' | 'error' => error instanceof PlacementRefusal && error.code !== 'centring' && error.code !== 'budget' ? 'placement' : 'error';
/** Whether the turn round runs at all: a forced turn order or forced courses (tests) have no turn round. */
export const turnRoundOn = (env: Env): boolean => env.options.testCourses === undefined && env.options.testTurnOrder === undefined;

type SpanOffer = ReturnType<typeof measureSpans> & { max: number };
/**
 * The span round (architecture ticket 22, phase 3). It reads the 7f baseline and its routed result, offers a spanning chord to every link between document tiers that
 * are not consecutive whose corridor is clear, places again with the span hints, and keeps the trial only on its routed result (`judgeSpanTrial`). It runs before the
 * course, side and overlay-course rounds, because a chord changes which routes are poor, and it shares their re-runs. A refused round leaves the sheet as it was.
 */
export const span: Round<SpanOffer> = {
  id: 'span', label: 'rerun-span', routed: true, abort: true,
  tolerates: (error) => isRefusable(error),
  async measure(env, s) {
    const offer = measureSpans(s.base, s.routedBase!);
    env.options.testSideTrace?.({ ev: 'spans', offer, base: s.base, routedBase: s.routedBase });
    if (offer.links.length === 0) return undefined;
    // The round leaves one re-run to each round after it that has an offer on the baseline (course, side): a trial that is refused has spent its placements, and must not
    // starve a round that main would have run.
    const max = roundLimit(env.maxReruns, turnReserve(s.base, turnRoundOn(env))) - (measureCourses(s.base, s.routedBase!).courses.length > 0 ? 1 : 0) - (measureSides(s.base, s.kept7e, s.refused).hints.size > 0 ? 1 : 0);
    if (s.reruns >= max) { env.options.testSideTrace?.({ ev: 'span-refused', links: offer.links, why: 'budget' }); return undefined; }
    return { ...offer, max };
  },
  // The trial reserves its chords on top of the ledger; the fans of the trial grow this one, and a kept trial keeps it.
  reserve: (env, s, o) => addReservations(s.kept, spanEntries(o.links, 'span', env.placements)),
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement (ticket 89): the chords of this trial are measured as the fan
  // rounds measure the first placement, and the trial places again with the floors they ask for. The re-runs are the command's (MAX_RERUNS).
  async settle(env, s, o, ledger, trial7e) {
    const tentative: State = { ...s, kept7e: trial7e, kept: ledger, fallbackFrom: s.kept7e };
    try {
      for (let round = 0; round < FAN_ROUNDS && tentative.reruns < o.max; round++) {
        const offer = await spanFan.measure(env, tentative);
        if (offer === undefined) break;
        const refused = await attempt(env, tentative, spanFan, offer);
        if (refused === undefined) continue;
        if (refused.at === 'ledger') break;
        return refused;
      }
    } finally { s.reruns = tentative.reruns; }
    return { trial7e: tentative.kept7e, ledger: tentative.kept };
  },
  // 7f freezes the chords that are straight now and no other (`freezeChords`), so a hinted link that is not straight here (the freeze refuses it, as `leg` when a neighbour's
  // leg crowds it at the pitch the trial gave) is lost: the trial is refused here, before 7f and the route. The placement above is spent, so nothing is given back.
  holdsAt7e(_env, _s, o, ledger, trial7e) {
    const failed = holds(ledger, trial7e);
    const lost = failed.filter(failure => failure.kind === 'spanChord' && o.links.includes(failure.link!)).map(failure => failure.link!);
    if (lost.length > 0) {
      return { at: 'ledger', why: 'promise', detail: `the freeze would not hold ${lost.join(', ')}: ${lost.map(id => { const item = trial7e.links.find(other => other.id === id); return item === undefined ? 'missing' : freezeRefusal(trial7e, item) ?? 'not straight'; }).join(', ')} (before 7f)` };
    }
    // A reservation kept by an earlier round must hold at the trial's final 7e as well (ticket 22 left that open).
    const otherLost = failed.filter(failure => !lost.includes(failure.link!) || failure.kind !== 'spanChord');
    return otherLost.length > 0 ? { at: 'ledger', why: 'promise', detail: `a kept reservation does not hold: ${otherLost[0]!.why} (before 7f)` } : undefined;
  },
  judge(env, s, o, t) {
    const verdict = judgeSpanTrial(s.routedBase!, t.routedTrial, o.links);
    env.options.testSideTrace?.({ ev: 'span-trial', verdict, trial: t.trial, routedTrial: t.routedTrial, routedBase: s.routedBase, offer: o });
    if (!verdict.kept) return { at: 'verdict', why: verdict.reason!, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) };
    const broken = holdsRouted(s.kept, t.routedTrial);
    return broken.length > 0 ? { at: 'promise', why: 'promise', detail: `a kept course publishes more turns than it promised (${broken.map(failure => failure.link).join(', ')})` } : undefined;
  },
  commit(_env, s, o, t) {
    s.kept = t.ledger;
    s.base = t.trial; s.kept7e = t.trial7e; s.routedFinal = t.routedTrial; s.routedBase = t.routedTrial;
    s.baseMoved = t.moved; s.baseUnmoved = t.unmoved;
    for (const id of o.links) {
      const link = t.trial.links.find(item => item.id === id)!;
      const crossed = transitTiers(t.trial, link);
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SPAN_CHORD_TAKEN', owners: [{ kind: 'link', id }],
        message: `The link ${id} takes a spanning chord over ${crossed.length + 1} tier gaps, through ${crossed.length} transited ${crossed.length === 1 ? 'band' : 'bands'} (sub-tier ${crossed.join(', ')}).` });
    }
  },
  refuse(env, _s, o, r) {
    const [why, detail] = r.at === 'place' ? [spanCode(r.error!), r.error!.message] : r.at === 'fallback' ? ['placement', 'ELK fell back during the span trial']
      : r.at === 'bands' ? [spanCode(r.error!), `stage 7f rejected them (${r.error!.message})`] : [r.why, r.detail];
    env.options.testSideTrace?.({ ev: 'span-refused', links: o.links, why, detail });
  },
};

/** The node floors a kept side or course ledger keeps: the stage-3 size of each node with a hinted port, so a later trial does not re-size a node a kept trial moved. */
const keptFloors = (env: Env, s: State): Map<string, Size> => {
  const floors = new Map<string, Size>();
  for (const key of sideHintsOf(s.kept).keys()) {
    const [node] = JSON.parse(key) as [string];
    const size = env.stage3Sizes.get(s.kept7e)?.get(node);
    if (size !== undefined) floors.set(node, { ...size });
  }
  return floors;
};
/** The nodes whose end of a course changes face keep their size (P9): the capacity estimate of the face they leave must not re-size them. `skirtsU` leaves out an end that leaves by a U part, whose content grows with its face. */
const pinMovedEnds = (env: Env, s: State, floors: Map<string, Size>, courses: readonly Course[], skirtsU: boolean): void => {
  for (const course of courses) {
    const link = s.kept7e.links.find(item => item.id === course.link)!;
    for (const which of ['from', 'to'] as const) {
      const size = env.stage3Sizes.get(s.kept7e)?.get(link.attachments![which].node);
      if (size !== undefined && (!skirtsU || endMode(course, which) !== 'u') && course[which].face !== (s.kept7e.nodes[link.attachments![which].node]!.ports.find(port => portKey(port.ref) === portKey(link.attachments![which]))?.side)) floors.set(link.attachments![which].node, { ...size });
    }
  }
};
const promisedTurnsOf = (promised: ReadonlyMap<string, { turns: number }>): Map<string, number> => new Map([...promised].map(([id, item]) => [id, item.turns] as const));
/** A bypass that cannot be reserved stays a remainder of stage 8 and is named, once, with the reason (`ROW_BYPASS_DECLINED`). */
export const noteDeclined = (s: State, offer: CourseOffer): void => {
  for (const item of offer.declined) {
    if (s.sideNotes.some(note => note.code === 'ROW_BYPASS_DECLINED' && note.owners?.some(owner => owner.kind === 'link' && owner.id === item.link))) continue;
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_DECLINED', owners: [{ kind: 'link', id: item.link }], message: `The link ${item.link} has no row bypass: ${item.why}.` });
  }
};

type CourseOffer = ReturnType<typeof measureCourses>;
/**
 * The course round (ticket 15, phase 4). It reads the baseline's routed result, offers perimeter courses for the links whose route is a poor one, places again with the courses
 * reserved in stage 5, and keeps the trial only on its routed result. A refused course round leaves the layout as the baseline made it, with no note (the trace names the reason),
 * so a sheet it does not change is byte for byte as it was.
 */
export const course: Round<CourseOffer> = {
  id: 'course', label: 'rerun-course', routed: true, abort: true,
  // A course moves columns the baseline never moved. A centring that cannot hold its feeds there is the course's refusal, not a bug of the baseline.
  tolerates: (error, phase) => phase === 'place' ? error instanceof PlacementRefusal && error.code !== 'budget' : refusedAtBands(error),
  async measure(env, s) {
    s.routedBase = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
    const offer = measureCourses(s.base, s.routedBase);
    env.options.testSideTrace?.({ ev: 'courses', offer, base: s.base, routedBase: s.routedBase });
    noteDeclined(s, offer);
    return offer.courses.length === 0 ? undefined : offer;
  },
  reserve(env, s, o) {
    // The node floors of a kept course trial stay under this one (a later side trial keeps them, or it would re-size the nodes the course moved).
    const nodeFloors = keptFloors(env, s);
    // A node whose end leaves by a U part is not pinned: its face moves from a lateral side to the bottom, and its content grows with it (P9 asks for few moves, not for none).
    pinMovedEnds(env, s, nodeFloors, o.courses, true);
    // A row bypass (ticket 24, phase 5) puts the closing link in the slot on its turn side: the trial carries the turn order, or its stems would cross the straight link of the gap.
    const bypassLinks = o.courses.filter(item => item.kind === 'bypass').map(item => item.link);
    return addReservations(s.kept, [...floorEntries(nodeFloors, 'course', env.placements),
      ...courseEntries(o.courses, promisedTurnsOf(o.promised), 'course', env.placements),
      ...turnEntries(false, bypassLinks, false, 'course', env.placements)]);
  },
  // Every active reservation holds at the trial's final 7e, the kept ones of earlier rounds with the new courses, before 7f and the route.
  holdsAt7e(_env, _s, _o, ledger, trial7e) {
    const broken = holds(ledger, trial7e);
    return broken.length > 0 ? { at: 'ledger', why: `a reservation does not hold at stage 7e (${broken[0]!.why})` } : undefined;
  },
  judge(env, s, o, t) {
    const verdict = judgeCourseTrial(s.routedBase!, t.routedTrial, promisedTurnsOf(o.promised));
    env.options.testSideTrace?.({ ev: 'course-trial', verdict, trial: t.trial, routedTrial: t.routedTrial, routedBase: s.routedBase });
    // A course kept earlier keeps its promise through this trial as well.
    const lost = verdict.kept ? holdsRouted(s.kept, t.routedTrial) : [];
    if (lost.length > 0) return { at: 'promise', why: `a kept course publishes more turns than it promised (${lost.map(failure => failure.link).join(', ')})` };
    return verdict.kept ? undefined : { at: 'verdict', why: `${verdict.reason}` };
  },
  commit(_env, s, o, t) {
    if (s.routedFinal === undefined) s.routedBase = t.routedTrial;
    s.base = t.trial; s.kept7e = t.trial7e; s.routedFinal = t.routedTrial;
    s.baseMoved = t.moved; s.baseUnmoved = t.unmoved; s.kept = t.ledger;
    for (const item of o.courses) {
      const was = o.promised.get(item.link)!;
      if (item.kind === 'bypass') {
        s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_PLANNED', owners: [{ kind: 'link', id: item.link }],
          message: `The link ${item.link} takes a bypass along the ${item.edge} edge of its row: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
        continue;
      }
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: item.link }],
        message: `The link ${item.link} takes a course ${item.kind === 'shared-port' ? 'onto the pill of its shared port' : item.runs.includes('gap') ? 'through a column gap' : 'round the outside'}: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
    }
  },
  refuse(env, _s, o, r) {
    const why = r.at === 'place' ? `the placement run rejected them (${r.why})` : r.at === 'fallback' ? 'ELK fell back during the course trial'
      : r.at === 'bands' ? `stage 7f rejected them (${r.why})` : r.why;
    env.options.testSideTrace?.({ ev: 'course-refused', links: o.courses.map(item => item.link), why });
  },
};
