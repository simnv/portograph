/**
 * The six rounds as descriptors (architecture 2, ticket 04): fan, span, course, side, turn and overlay. Each one is a table of what it measures, reserves, checks, judges, commits and
 * says when it is refused; `open` and `close` (round.ts) run a trial from it. A descriptor holds the round's own rules and nothing about the order of the rounds.
 */
import type { Course, Diagnostic, LayoutModel, Side, Size } from '../model/index.js';
import { portKey } from '../layout/sides-one.js';
import { endMode } from '../layout/course-rows.js';
import { contentInsets, measureNodeContent } from '../layout/size.js';
import { fanRoundDropped, fanRoundHolds, measureFans } from '../layout/fan-spread.js';
import { TrunkBlocked } from '../layout/placement-refusal.js';
import { PlacementRefusal, refusedAtBands } from '../layout/placement-refusal.js';
import { documentTierDistance, freezeRefusal } from '../layout/frame-paths.js';
import { transitTiers } from '../layout/lanes.js';
import { measureSpans } from '../layout/span-measure.js';
import { judgeSpanTrial } from '../layout/span-judge.js';
import { gainOf, judgeCourseTrial, judgeOverlayTrial, measureCourses, measureOverlayCourses } from '../layout/course-measure.js';
import { measureSides, refusedKey, type SideOffer } from '../layout/side-measure.js';
import { judgeTrial, predictedWorse, predictPublished, routedBends, trialNotes } from '../layout/side-judge.js';
import { bands } from '../layout/bands.js';
import { judgeTurnTrial, measureTurnOrder } from '../layout/turn-measure.js';
import { pitchGrowth, nodeFloors as floorEntries, courseEntries, laneOwners, promisedTurns, reserve as addReservations, sideFaces, sideHintsOf, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import { holds, holdsRouted } from '../layout/reservation-checks.js';
import type { ReservationFailure } from '../layout/reservations.js';
import type { Refusal, Round } from './round.js';
import type { Env } from './env.js';
import { FAN_ROUNDS, SIDE_ROUNDS } from './limits.js';
import type { State } from './state.js';

/** A refusal at the final 7e, with the ids of the reservations that did not hold. */
const ledgerRefusal = (failures: readonly ReservationFailure[], r: Omit<Refusal, 'at'>): Refusal => {
  const reservationIds = failures.map(failure => failure.id);
  return { at: 'ledger', ...r, reservationIds, error: new PlacementRefusal('ledger', r.why, { stage: '7e', reservationIds }) };
};
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
  id: 'fan', label: 'rerun-fan', routed: false, invalidation: 'fanReruns', children: [],
  budget: { protects: [], tie: 0, visits: child ? 1 : FAN_ROUNDS, again: !child, retries: [], reopens: false, floor: child ? 0 : FAN_ROUNDS },
  enabled: () => true,
  gain: () => [0, 0, 0],
  skip: () => undefined,
  // A fan floor can move the rows, and a trunk that the baseline placed may then have a foreign unit on both sides. The run that found it blocked is a
  // trial, so the round is cut and the baseline stands (a test cannot reach this: it needs a floor that reorders a row of the mesh).
  tolerates: (error, phase) => phase === 'place' && (child ? error instanceof PlacementRefusal : error instanceof TrunkBlocked),
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
    return broken.length > 0 ? ledgerRefusal(broken, { why: broken[0]!.why }) : undefined;
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

/** Whether the turn round runs at all: a forced turn order or forced courses (tests) have no turn round. */
export const turnRoundOn = (env: Env): boolean => env.options.testCourses === undefined && env.options.testTurnOrder === undefined;

type SpanOffer = ReturnType<typeof measureSpans>;
/**
 * The span round (architecture ticket 22, phase 3). It reads the 7f baseline and its routed result, offers a spanning chord to every link whose end sub-tiers
 * are not adjacent (`spanCandidate`: document tiers not consecutive, or consecutive with a rank band between, ticket 35) whose corridor is clear, places again with the span hints, and keeps the trial only on its routed result (`judgeSpanTrial`). It runs before the
 * course, side and overlay-course rounds, because a chord changes which routes are poor, and it shares their re-runs. A refused round leaves the sheet as it was.
 */
export const span: Round<SpanOffer> = {
  id: 'span', label: 'rerun-span', routed: true, children: [spanFan],
  // The round leaves a start to each round after it that has an offer on the baseline (course, side, turn): a trial that is refused has spent its placements, and must not
  // starve a round that would have run. Its fans inherit that.
  budget: { protects: ['course', 'side', 'turn'], tie: 0, visits: 1, again: false, retries: [], reopens: false, floor: 0 },
  // A forced hint (the test option) is the whole of the span round; otherwise the round runs here, before the course round.
  enabled: env => env.options.testCourses === undefined && env.options.testSpanHints === undefined,
  gain: () => [0, 0, 0],
  // No start is left for the offer (the re-runs are spent, or kept for the rounds this one protects): no hint is placed, each offered link keeps its lane, and the
  // freeze names it with `transit` as before. One note names the budget, so a sheet that would draw the chords with more re-runs says so (ticket 35).
  skip(env, s, o, left) {
    env.options.testSideTrace?.({ ev: 'span-refused', links: o.links, why: 'budget' });
    const why = left <= 0 ? `the command has made its ${env.maxReruns} placement re-runs` : `the ${left} placement re-run${left === 1 ? ' left is' : 's left are'} kept for the course, side and turn rounds`;
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SPAN_ROUND_SKIPPED', owners: o.links.map(id => ({ kind: 'link' as const, id })),
      message: `A span round was skipped: ${why}. ${o.links.length === 1 ? `The link ${o.links[0]} keeps its lane` : `The links ${o.links.join(', ')} keep their lanes`}.` });
  },
  // Only the placement's own refusals, as in every other round: the command deadline (also an ELK deadline) and a defect (a TypeError) end the command.
  tolerates: (error, phase) => phase === 'place' ? error instanceof PlacementRefusal : refusedAtBands(error),
  async measure(env, s) {
    const offer = measureSpans(s.base, s.routedBase!);
    env.options.testSideTrace?.({ ev: 'spans', offer, base: s.base, routedBase: s.routedBase });
    return offer.links.length === 0 ? undefined : offer;
  },
  // The trial reserves its chords on top of the ledger; the fans of the trial grow this one, and a kept trial keeps it.
  reserve: (env, s, o) => addReservations(s.kept, spanEntries(o.links, 'span', env.placements)),
  // 7f freezes the chords that are straight now and no other (`freezeChords`), so a hinted link that is not straight here (the freeze refuses it, as `leg` when a neighbour's
  // leg crowds it at the pitch the trial gave) is lost: the trial is refused here, before 7f and the route. The placement above is spent, so nothing is given back.
  holdsAt7e(_env, _s, o, ledger, trial7e) {
    const failed = holds(ledger, trial7e);
    const lost = failed.filter(failure => failure.kind === 'spanChord' && o.links.includes(failure.link!)).map(failure => failure.link!);
    if (lost.length > 0) {
      return ledgerRefusal(failed.filter(failure => failure.kind === 'spanChord' && o.links.includes(failure.link!)), { why: 'promise', detail: `the freeze would not hold ${lost.join(', ')}: ${lost.map(id => { const item = trial7e.links.find(other => other.id === id); return item === undefined ? 'missing' : freezeRefusal(trial7e, item) ?? 'not straight'; }).join(', ')} (before 7f)` });
    }
    // A reservation kept by an earlier round must hold at the trial's final 7e as well (ticket 22 left that open).
    const otherLost = failed.filter(failure => !lost.includes(failure.link!) || failure.kind !== 'spanChord');
    return otherLost.length > 0 ? ledgerRefusal(otherLost, { why: 'promise', detail: `a kept reservation does not hold: ${otherLost[0]!.why} (before 7f)` }) : undefined;
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
      // Two counts: the document tier gaps (1 for a link across one gap with a rank band between its ends, ticket 35) and the sub-tier gaps the chord crosses.
      const gaps = documentTierDistance(t.trial, link) ?? crossed.length + 1;
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SPAN_CHORD_TAKEN', owners: [{ kind: 'link', id }],
        message: `The link ${id} takes a spanning chord over ${gaps} document tier ${gaps === 1 ? 'gap' : 'gaps'} (${crossed.length + 1} sub-tier gaps), through ${crossed.length} transited ${crossed.length === 1 ? 'band' : 'bands'} (sub-tier ${crossed.join(', ')}).` });
    }
  },
  refuse(env, _s, o, r) {
    const [why, detail] = r.at === 'place' ? ['placement', r.error!.message] : r.at === 'fallback' ? ['placement', 'ELK fell back during the span trial']
      : r.at === 'bands' ? ['placement', `stage 7f rejected them (${r.error!.message})`] : [r.why, r.detail];
    env.options.testSideTrace?.({ ev: 'span-refused', links: o.links, why, detail });
  },
};

/**
 * The size a node is pinned at when a round moves some of its ports to other faces (`moved`, by `portKey`): its stage-3 size, never below the content it holds
 * with the ports on their new faces. A pill on a new face sets that face's inset (`contentInsets`), and a card counts both side insets in its width, so the
 * stage-3 size alone can be short of the content and the trial is refused at publication (snack-theme ticket 159). `undefined` when no stage-3 size is known.
 */
const movedFloor = (env: Env, s: State, id: string, moved: ReadonlyMap<string, Side>): Size | undefined => {
  const size = env.stage3Sizes.get(s.kept7e)?.get(id), node = s.kept7e.nodes[id];
  if (size === undefined || node === undefined) return undefined;
  const content = measureNodeContent(s.kept7e.document.nodes[id]!, s.kept7e.document.groups, contentInsets(node.ports, port => moved.get(portKey(port.ref)) ?? port.side ?? port.sizingSide));
  return { width: Math.max(size.width, content.width), height: Math.max(size.height, content.height) };
};
/** The node floors a kept side or course ledger keeps: the size of each node with a hinted port (`movedFloor`), so a later trial does not re-size a node a kept trial moved. */
const keptFloors = (env: Env, s: State): Map<string, Size> => {
  const floors = new Map<string, Size>(), hints = sideHintsOf(s.kept);
  for (const key of hints.keys()) {
    const [node] = JSON.parse(key) as [string];
    const size = movedFloor(env, s, node, hints);
    if (size !== undefined) floors.set(node, size);
  }
  return floors;
};
/**
 * The nodes whose end of a course changes face keep their size (P9): the capacity estimate of the face they leave must not re-size them. `skirtsU` leaves out an end
 * that leaves by a U part, whose content grows with its face. The pin is `movedFloor`: never below the content with the end on its new face.
 */
const pinMovedEnds = (env: Env, s: State, floors: Map<string, Size>, courses: readonly Course[], skirtsU: boolean): void => {
  for (const course of courses) {
    const link = s.kept7e.links.find(item => item.id === course.link)!;
    for (const which of ['from', 'to'] as const) {
      const end = link.attachments![which];
      if ((skirtsU && endMode(course, which) === 'u') || course[which].face === s.kept7e.nodes[end.node]!.ports.find(port => portKey(port.ref) === portKey(end))?.side) continue;
      const size = movedFloor(env, s, end.node, new Map([[portKey(end), course[which].face]]));
      if (size !== undefined) floors.set(end.node, size);
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
/** The trials of the course round in one command: the offer, and the offer without its step courses after a refusal. */
export const COURSE_VISITS = 2;
/**
 * The course round (ticket 15, phase 4). It reads the baseline's routed result, offers perimeter courses for the links whose route is a poor one, places again with the courses
 * reserved in stage 5, and keeps the trial only on its routed result. A refused course round leaves the layout as the baseline made it, with no note (the trace names the reason),
 * so a sheet it does not change is byte for byte as it was.
 */
export const course: Round<CourseOffer> = {
  id: 'course', label: 'rerun-course', routed: true, children: [],
  // Two visits at most (R4): a refused trial that held a step course next to a poor-route course gets one more trial without the step courses (architecture-2
  // ticket 09, follow-up), so that a step never costs the course of a poor route. Any other refused trial ends the round: `measure` finds no second offer.
  budget: { protects: ['turn'], tie: 0, visits: COURSE_VISITS, again: false, retries: ['place', 'fallback', 'ledger', 'bands', 'verdict', 'promise'], reopens: false, floor: 0 },
  enabled: env => env.options.testCourses === undefined,
  async live(_env, s) { return measureCourses(s.base, s.routedFinal ?? s.routedBase!).courses.length > 0; },
  gain: (_env, _s, o) => gainOf([...o.promised].map(([, item]) => [item.base.turns === Infinity ? undefined : item.base.turns, item.turns] as [number | undefined, number])),
  skip(env, _s, o) { env.options.testSideTrace?.({ ev: 'course-skipped', offer: o, reruns: env.reruns }); },
  tolerates: (error, phase) => phase === 'place' ? error instanceof PlacementRefusal && error.code !== 'budget' : refusedAtBands(error),
  async measure(env, s) {
    if (s.courseRetry === 'none') return undefined;
    s.routedBase = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
    const offer = measureCourses(s.base, s.routedBase, new Set(), s.courseRetry !== 'without-steps');
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
    return broken.length > 0 ? ledgerRefusal(broken, { why: `a reservation does not hold at stage 7e (${broken[0]!.why})` }) : undefined;
  },
  judge(env, s, o, t) {
    const verdict = judgeCourseTrial(s.routedBase!, t.routedTrial, promisedTurnsOf(o.promised), new Set(o.steps));
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
  refuse(env, s, o, r) {
    s.courseRetry = s.courseRetry === undefined && o.steps.length > 0 && o.steps.length < o.courses.length ? 'without-steps' : 'none';
    const why = r.at === 'place' ? `the placement run rejected them (${r.why})` : r.at === 'fallback' ? 'ELK fell back during the course trial'
      : r.at === 'bands' ? `stage 7f rejected them (${r.why})` : r.why;
    env.options.testSideTrace?.({ ev: 'course-refused', links: o.courses.map(item => item.link), why });
  },
};

/** `node.name#ordinal`, or `node.#ordinal` for an anonymous port, from a port key. */
export const portName = (key: string): string => {
  const [node, anonymous, name, ordinal] = JSON.parse(key) as [string, boolean, string | null, number];
  return `${node}.${anonymous ? '' : name}#${ordinal}`;
};
const cutSide = (s: State, why: string): void => {
  s.cuts.push({ stage: 'placement', severity: 'warning', code: 'SIDE_ROUND_CUT',
    message: `A side round was cut: ${why}. The last kept placement stands, and this layout may differ from one made with more time.` });
};
/** The side hints a refusal drops from the offer (the round never offers them again), named in a note unless the extra trial of the unmoved baseline refused them: its kept result never offered the hint. */
const refuseHints = (s: State, keys: Iterable<string>, side: ReadonlyMap<string, 'left' | 'right'>, reason: string): void => {
  for (const key of keys) {
    s.refused.add(refusedKey(key, side.get(key)!));
    if (s.silent) continue;
    const link = s.promised.get(key)?.link ?? s.trialLinks.get(key);
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_REFUSED',
      message: `The side hint ${side.get(key)} on ${portName(key)} was refused: ${reason}.`, ...(link === undefined ? {} : { owners: [{ kind: 'link' as const, id: link }] }) });
  }
};

/** The links the offer promises, once each. */
const hintedLinks = (o: SideTrialOffer): string[] => [...new Set([...o.offer.promised.values()].map(item => item.link))];

/** The side offer of a round, with what the round works out while it runs: the faces it reserves and its verdict. */
export interface SideTrialOffer { offer: SideOffer; round: number; unmoved: boolean; faces?: Reservations; verdict?: ReturnType<typeof judgeTrial> }
/**
 * The side round (side-faces.md, Section 19). 7f runs on the kept model first: its output is the baseline, the model the command publishes when no trial is kept. A measure reads
 * the baseline. One batched trial reaches 7f per command; it is kept only on its routed result.
 */
export const side: Round<SideTrialOffer> = {
  id: 'side', label: 'rerun-side', routed: true, invalidation: 'sideReruns', children: [],
  // A refusal of the placement or the 7e checks leaves the state as it was: the round measures again and tries once more. A kept trial ends it (one trial reaches 7f per command).
  budget: { protects: ['turn'], tie: 1, visits: SIDE_ROUNDS, again: false, retries: ['place', 'ledger', 'predict'], reopens: true, floor: 0 },
  enabled: () => true,
  async live(_env, s) { return measureSides(s.base, s.kept7e, s.refused).hints.size > 0; },
  // The unmoved offer promises nothing and takes the start from a course that promises something (phase 3b).
  gain(_env, s, o) {
    const bends = s.routedBase === undefined ? new Map<string, number>() : routedBends(s.routedBase);
    return o.unmoved ? [Infinity, 0, 0] : gainOf([...o.offer.promised.values()].map(item => [bends.get(item.link), item.bends] as [number | undefined, number]));
  },
  skip(env, s) { s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${env.maxReruns} placement re-runs.` }); },
  tolerates: (error) => refusedAtBands(error),
  async measure(env, s) {
    const round = s.sideRound;
    s.silent = false; // only the round-0 extra trial is silent; a later round publishes its refusals
    let offer = await env.timed('measureSides', () => measureSides(s.base, s.kept7e, s.refused));
    // No offer on the kept 7f result. If a 7f move changed the placement, the unmoved baseline may have had one that the move removed: it runs as one
    // extra side trial, judged on routed results like any other, so the kept result stands unless a real trial beats it (architecture ticket 15, phase 3b).
    // The settled copy 7f judged its first move against is only a filter: it is the round-0 state plus one settle, not the state 7f would publish without
    // moves. When its offer is empty the trial is skipped; otherwise the true unmoved baseline is rebuilt (silently: no progress event, no attempt trace, since
    // this run is never published) and the trial starts from the rebuilt offer. With no copy, the rebuild runs. Nothing is built when no re-run is left.
    let unmoved = false, filtered: boolean | undefined;
    if (round === 0 && offer.hints.size === 0 && s.baseMoved && !s.unmovedRebuilt && env.reruns < env.maxReruns) {
      if (s.baseUnmoved !== undefined) filtered = measureSides(s.baseUnmoved, s.kept7e, s.refused).hints.size > 0;
      if (filtered !== false || env.options.testRebuildAlways === true) {
        s.unmovedRebuilt = true;
        const rebuilt = await env.timed('bands-unmoved', () => bands(s.kept7e, () => env.trialAbort('bands'), undefined, false));
        offer = await env.timed('measureSides', () => measureSides(rebuilt, s.kept7e, s.refused));
        unmoved = offer.hints.size > 0;
        s.silent = unmoved;
      }
    }
    env.options.testSideTrace?.({ ev: 'offer', round, offer, base: s.base, kept7e: s.kept7e, unmoved, filtered });
    if (offer.capped && !s.sideNotes.some(note => note.code === 'SIDE_PROBE_CAPPED')) s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_PROBE_CAPPED', message: 'The side measure stopped at its probe cap; the links after it were not probed.' });
    if (offer.hints.size === 0) return undefined;
    for (const [key, item] of offer.promised) s.trialLinks.set(key, item.link);
    return { offer, round, unmoved };
  },
  reserve(env, s, o) {
    s.sideRound++;
    const nodeFloors = new Map<string, Size>(), hints = new Map([...sideHintsOf(s.kept), ...o.offer.hints]);
    for (const key of hints.keys()) {
      const [node] = JSON.parse(key) as [string];
      // The 7e model keys the size cache, never the baseline (a new object: the lookup would give undefined with no error).
      const size = movedFloor(env, s, node, hints);
      if (size !== undefined) nodeFloors.set(node, size);
    }
    // The faces stay with the ledger when the trial is kept; the size floors of a side trial do not (a later round measures its own).
    o.faces = [...sideFaces(o.offer.hints, o.offer.promised, 'side', env.placements),
      ...laneOwners([...o.offer.promised].filter(([, item]) => item.shape === 'lane').map(([key]) => key), o.offer.hints, o.offer.promised, 'side', env.placements)];
    return addReservations(s.kept, [...floorEntries(nodeFloors, 'side', env.placements), ...o.faces]);
  },
  // The ledger answers for the faces and lanes of the trial (this round's and the kept ones) at its final 7e, before 7f and the route: a port hinted for the straight shape
  // of a routed link must hold its chord (otherwise the router would find its route, review M1, ticket 117), and a port hinted for the routed L must own a source-aligned
  // side lane (an exterior corridor gives three bends, ticket 119).
  holdsAt7e(_env, _s, o, ledger, trial7e) {
    const failed = holds(ledger, trial7e);
    const own = (lost: typeof failed): readonly string[] => {
      const keys = lost.map(failure => failure.key!).filter(key => o.offer.hints.has(key));
      return keys.length > 0 && keys.length === lost.length ? keys : [...o.offer.hints.keys()];
    };
    const links = (lost: typeof failed): string => [...new Set(lost.map(failure => failure.link))].join(', ');
    const chordLost = failed.filter(failure => failure.kind === 'sideFace');
    if (chordLost.length > 0) return ledgerRefusal(chordLost, { keys: own(chordLost), why: `a port hinted for a chord does not hold its chord at stage 7e (${links(chordLost)})` });
    const laneLost = failed.filter(failure => failure.kind === 'laneOwner');
    if (laneLost.length > 0) return ledgerRefusal(laneLost, { keys: own(laneLost), why: `a port hinted for a side lane has no source-aligned lane at stage 7e (${links(laneLost)})` });
    const otherFailed = failed.filter(failure => failure.kind !== 'sideFace' && failure.kind !== 'laneOwner');
    return otherFailed.length > 0 ? ledgerRefusal(otherFailed, { why: `a reservation does not hold at stage 7e (${otherFailed[0]!.why})` }) : undefined;
  },
  // The predictor prunes only when another round and another re-run remain, and only the hints it calls worse (Section 19.3).
  predict(env, s, o, trial7e) {
    if (o.unmoved || o.round + 1 >= SIDE_ROUNDS || env.reruns >= env.maxReruns) return undefined;
    const worse = predictedWorse(predictPublished(trial7e, s.kept7e, s.base), s.base, hintedLinks(o));
    const pruned = [...o.offer.hints.keys()].filter(key => worse.away.includes(key) || worse.links.includes(o.offer.promised.get(key)?.link ?? ''));
    return pruned.length > 0 ? { at: 'predict', keys: pruned, why: 'the prediction from the moves of stage 7f gives it more bends than the baseline' } : undefined;
  },
  async ready(env, s) { s.routedBase ??= await env.route(s.base); },
  judge(env, s, o, t) {
    const hinted = new Map([...o.offer.promised.values()].map(item => [item.link, item.bends] as const));
    const verdict = judgeTrial({ routedBase: s.routedBase!, routedTrial: t.routedTrial, kept7e: s.kept7e, trial7e: t.trial7e, hinted, lanes: new Set([...o.offer.promised.values()].filter(item => item.shape === 'lane').map(item => item.link)) });
    o.verdict = verdict;
    env.options.testSideTrace?.({ ev: 'trial', verdict, base: s.base, kept7e: s.kept7e, trial7e: t.trial7e, trial: t.trial, routedBase: s.routedBase, routedTrial: t.routedTrial, hinted });
    env.options.testSideProbe?.({ offer: o.offer, routedBase: s.routedBase!, routedTrial: t.routedTrial, verdict });
    // A kept course keeps its promise through the side round as well: a side trial that makes a course link publish more turns than it promised is refused.
    const broken = verdict.kept ? holdsRouted(s.kept, t.routedTrial).map(failure => failure.link!) : [];
    if (broken.length > 0) return { at: 'promise', why: `a course link publishes more turns than it promised (${broken.join(', ')})` };
    return verdict.kept ? undefined : { at: 'verdict', why: verdict.reason };
  },
  // Kept: the trial is the baseline now. The notes name what the net count accepted.
  commit(_env, s, o, t) {
    s.keptNotes.push(...trialNotes(s.routedBase!, t.routedTrial, o.verdict!, hintedLinks(o)));
    s.base = t.trial; s.kept7e = t.trial7e; s.kept = addReservations(s.kept, o.faces!); s.routedFinal = t.routedTrial;
    for (const [key, item] of o.offer.promised) s.promised.set(key, item);
  },
  refuse(_env, s, o, r) {
    if (r.at === 'fallback') { cutSide(s, 'ELK fell back during it, and the re-run was dropped'); return; }
    refuseHints(s, r.keys ?? o.offer.hints.keys(), o.offer.hints,
      r.at === 'place' ? `the placement run rejected it (${r.why})` : r.at === 'bands' ? `its stage 7f rejected it (${r.why})` : r.why);
  },
};

type TurnOffer = { offer: ReturnType<typeof measureTurnOrder>; current: LayoutModel; keptTurn?: Reservations; verdict?: ReturnType<typeof judgeTurnTrial> };
/**
 * The turn round (architecture ticket 24, Section 10). On the kept result of the span, course and side rounds: when the planned first turns would reorder the ports of a
 * face, placement runs once more with the turn order and the trial is kept only when the published result is better by the unified order. A refused or skipped trial
 * leaves the layout as the baseline made it, with no note.
 */
export const turn: Round<TurnOffer> = {
  id: 'turn', label: 'rerun-turn', routed: true, children: [],
  // The turn offer moves no bend and no turn by design, so it promises none: with one start left and an overlay offer it runs only if the overlay offer promises nothing either.
  budget: { protects: [], tie: 0, visits: 1, again: false, retries: [], reopens: false, floor: 0 },
  enabled: turnRoundOn,
  async live(_env, s) { return measureTurnOrder(s.base).faces.length > 0; },
  gain: () => [0, 0, 0],
  skip(env, s, _o, left) {
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ROUND_SKIPPED', message: `The turn round was skipped: the command has ${left <= 0 ? 'made its' : 'one left of its'} ${env.maxReruns} placement re-runs${left <= 0 ? '' : ', for the overlay round'}.` });
  },
  tolerates: (error, phase) => phase === 'place' ? error instanceof PlacementRefusal : refusedAtBands(error),
  async measure(env, s) {
    const offer = measureTurnOrder(s.base);
    env.options.testSideTrace?.({ ev: 'turns', offer, base: s.base });
    if (offer.faces.length === 0) return undefined;
    return { offer, current: s.routedFinal ?? s.routedBase ?? await env.route(s.base) };
  },
  reserve(env, s, o) {
    // The ledger a kept trial keeps asks for no change of a face; the trial's own asks for one (the turn order must move a face, or the trial is refused).
    o.keptTurn = addReservations(s.kept, [...floorEntries(keptFloors(env, s), 'turn', env.placements), ...turnEntries(true, [], false, 'turn', env.placements)]);
    return addReservations(o.keptTurn, turnEntries(true, [], true, 'turn', env.placements));
  },
  // The offer was decided before any placement; this is left only when the measure and stage 5 disagree about a face. The placement is spent (no re-run is given back).
  holdsAt7e(_env, _s, _o, ledger, trial7e) {
    const failed = holds(ledger, trial7e);
    return failed.length > 0 ? ledgerRefusal(failed, { why: failed[0]!.kind === 'turnOrder' ? failed[0]!.why : `a reservation does not hold at stage 7e (${failed[0]!.why})` }) : undefined;
  },
  judge(env, s, o, t) {
    const verdict = judgeTurnTrial(o.current, t.routedTrial, promisedTurns(s.kept));
    o.verdict = verdict;
    env.options.testSideTrace?.({ ev: 'turn-trial', verdict, trial: t.trial, routedTrial: t.routedTrial, routedBase: o.current });
    return verdict.kept ? undefined : { at: 'verdict', why: verdict.reason };
  },
  commit(_env, s, o, t) {
    s.base = t.trial; s.kept7e = t.trial7e; s.routedFinal = t.routedTrial; s.kept = o.keptTurn!;
    const verdict = o.verdict!;
    for (const face of t.trial7e.freeze!.turnOrder!) {
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ORDER_TAKEN', owners: [{ kind: 'node', id: face.node }],
        message: `The ports of the ${face.side} face of ${face.node} take the order of their planned first turns: ${verdict.before!.bent} bent links, ${verdict.before!.turns} turns and ${verdict.before!.crossings} crossings on the baseline, ${verdict.after!.bent}, ${verdict.after!.turns} and ${verdict.after!.crossings} after.` });
    }
  },
  refuse(env, _s, o, r) {
    const why = r.at === 'place' ? `the placement run rejected it (${r.why})` : r.at === 'fallback' ? 'ELK fell back during the turn trial'
      : r.at === 'bands' ? `stage 7f rejected it (${r.why})` : r.why;
    env.options.testSideTrace?.({ ev: 'turn-refused', faces: o.offer.faces.map(face => `${face.node}.${face.side}`), why });
  },
};

type OverlayOffer = { offer: ReturnType<typeof measureOverlayCourses>; current: LayoutModel };
/**
 * The overlay round (ticket 15, phase 7; the user's decision on Q1). After the routed rounds, on their kept result: an overlay that a routed chord would not take is offered a
 * perimeter course on side faces, reserved in stage 5 of one more placement run and kept only when its published result is not worse by the unified order. A refused trial
 * leaves the layout as it was.
 */
export const overlay: Round<OverlayOffer> = {
  id: 'overlay', label: 'rerun-overlay', routed: true, children: [],
  budget: { protects: [], tie: 1, visits: 1, again: false, retries: [], reopens: false, floor: 0 },
  enabled: env => env.options.testCourses === undefined && env.options.testOverlayCourses !== false,
  gain: (_env, _s, o) => gainOf([...o.offer.promised].map(([, item]) => [item.base === Infinity ? undefined : item.base, item.turns] as [number | undefined, number])),
  skip(env, _s, o) { env.options.testSideTrace?.({ ev: 'overlay-skipped', offer: o.offer, reruns: env.reruns }); },
  tolerates: (error, phase) => phase === 'place' ? error instanceof PlacementRefusal && error.code !== 'budget' : refusedAtBands(error),
  async measure(env, s) {
    const current = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
    const offer = measureOverlayCourses(s.base, current);
    env.options.testSideTrace?.({ ev: 'overlay-courses', offer, base: s.base, routedBase: current });
    return offer.courses.length === 0 ? undefined : { offer, current };
  },
  reserve(env, s, o) {
    const nodeFloors = keptFloors(env, s);
    // A node whose overlay end changes face keeps its size (P9): the capacity estimate of the face it leaves must not re-size it.
    pinMovedEnds(env, s, nodeFloors, o.offer.courses, false);
    return addReservations(s.kept, [...floorEntries(nodeFloors, 'overlay', env.placements),
      ...courseEntries(o.offer.courses, promisedTurnsOf(o.offer.promised), 'overlay', env.placements)]);
  },
  holdsAt7e(_env, _s, _o, ledger, trial7e) {
    const broken = holds(ledger, trial7e);
    return broken.length > 0 ? ledgerRefusal(broken, { why: `a reservation does not hold at stage 7e (${broken[0]!.why})` }) : undefined;
  },
  judge(env, s, o, t) {
    const verdict = judgeOverlayTrial(o.current, t.routedTrial, o.offer);
    env.options.testSideTrace?.({ ev: 'overlay-trial', verdict, trial: t.trial, routedTrial: t.routedTrial, routedBase: o.current });
    // The overlay judge reads the overlay links only; a course kept earlier keeps its promise through this trial too.
    const lost = verdict.kept ? holdsRouted(s.kept, t.routedTrial) : [];
    if (lost.length > 0) return { at: 'promise', why: `a kept course publishes more turns than it promised (${lost.map(failure => failure.link).join(', ')})` };
    return verdict.kept ? undefined : { at: 'verdict', why: verdict.reason };
  },
  commit(_env, s, o, t) {
    s.base = t.trial; s.kept7e = t.trial7e; s.routedFinal = t.routedTrial; s.kept = t.ledger;
    for (const item of o.offer.courses) {
      const was = o.offer.promised.get(item.link)!;
      s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: item.link }],
        message: `The overlay link ${item.link} takes a course round the outside: ${was.turns} turns promised, ${was.base} on the baseline.` });
    }
  },
  refuse(env, _s, o, r) {
    const why = r.at === 'place' ? `the placement run rejected them (${r.why})` : r.at === 'fallback' ? 'ELK fell back during the overlay trial'
      : r.at === 'bands' ? `stage 7f rejected them (${r.why})` : r.why;
    env.options.testSideTrace?.({ ev: 'overlay-refused', links: o.offer.courses.map(item => item.link), why });
  },
};
