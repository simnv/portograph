/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { Course, Diagnostic, LayoutModel, LayoutStage, NormalisedDocument, Side, Size } from '../model/index.js';
import { resolve } from '../resolve/index.js';
import { portKey, sidesOne } from '../layout/sides-one.js';
import { endMode, movesPort } from '../layout/course-rows.js';
import { sizeNodes } from '../layout/size.js';
import { skeleton, SkeletonError } from '../layout/skeleton.js';
import { BundleFeasibilityError } from '../layout/bundle-paths.js';
import { sidesTwo } from '../layout/sides-two.js';
import { rows } from '../layout/rows.js';
import { lanes } from '../layout/lanes.js';
import { flanks } from '../layout/flanks.js';
import { centre } from '../layout/centre.js';
import { bars } from '../layout/bars.js';
import { bundles } from '../layout/bundles.js';
import { bands } from '../layout/bands.js';
import { linkLabels } from '../layout/link-labels.js';
import { elkDeadlineMs, type CreateElkAttempt, type ElkClock } from '../layout/elk-worker.js';
import { route, ROUTE_BUDGET_MS, type CreateRouteAttempt } from '../route/index.js';
import { CommandDeadlineError, UNBOUNDED_BUDGET, type Budget } from './budget.js';
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, fanRoundDropped, fanRoundHolds, measureFans } from '../layout/fan-spread.js';
import { chordClearances, freezeRefusal } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { SideHintRefusal, TrunkBlocked, sideHintDiagnostics, type SideHints } from '../layout/side-hints.js';
import { measureSides, refusedKey, type SideOffer } from '../layout/side-measure.js';
import { judgeTrial, predictedWorse, predictPublished, routedBends, trialNotes } from '../layout/side-judge.js';
import type { AttemptTraceEvent } from '../layout/placement-attempt.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { attemptCounters, lastAttempt } from '../layout/attempt-counters.js';
import { measureSpans } from '../layout/span-measure.js';
import { judgeSpanTrial } from '../layout/span-judge.js';
import { transitTiers } from '../layout/lanes.js';
import { beats, gainOf, judgeCourseTrial, judgeOverlayTrial, measureCourses, measureOverlayCourses } from '../layout/course-measure.js';
import { turnMissed } from '../layout/turn-order.js';
import { judgeTurnTrial, measureTurnOrder, roundLimit, turnReserve, turnRoundRuns } from '../layout/turn-measure.js';
import { pitchFloorsOf, nodeFloors as floorEntries, pitchGrowth, nodeFloorsOf, reserve as addReservations, courseEntries, coursesOf, declinedTrunksOf, holds, holdsRouted, promisedTurns, declineTrunk, laneKeysOf, laneOwners, sideFaces, sideHintsOf, spanEntries, spansOf, turnEntries, turnOf, type Reservations } from '../layout/reservations.js';
import { countStage, ledgerOn, ledgerSnapshot, startPlacementEntry, type LedgerSnapshot } from '../layout/attempt-ledger.js';


/** Most runs of placement a fan's pitch may cost after the first (ticket 89). */
const FAN_ROUNDS = 2;
/** Most side rounds after the fan rounds: one offer, one retry (side-faces.md, Section 7). */
const SIDE_ROUNDS = 2;
/**
 * Most placement re-runs of one command, fan and side together (side-faces.md, Section 7, *Budget*). A count, never set by the clock.
 * 3 = the two fan rounds and one side trial. On the private sheet (about 23 s quiet, 3 re-runs) the command ends about 14 s before the 60 s
 * deadline at 2 times slower, and a fourth re-run (2.7 s + 6.5 s of 7f, quiet) would not fit. The clock never chooses between layouts (ticket 141).
 */
export const MAX_RERUNS = 3;
/** A round asked for a placement past the command's budget (`MAX_RERUNS` + 1). A round refuses its trial on it; the first run is never refused. */
export class PlacementBudgetExceeded extends Error {
  constructor(readonly placements: number) { super(`The command has placed ${placements} times, which is the most it may.`); }
}
/** `node.name#ordinal`, or `node.#ordinal` for an anonymous port, from a port key. */
const portName = (key: string): string => {
  const [node, anonymous, name, ordinal] = JSON.parse(key) as [string, boolean, string | null, number];
  return `${node}.${anonymous ? '' : name}#${ordinal}`;
};

export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';

export interface LayoutProgress {
  stage: LayoutStage;
  /** True for the stage of a side trial (its 7f and its route), which the command reports a second time. */
  trial?: true;
  /** Wall time this stage took, measured by the caller's clock. */
  durationMs: number;
  /** What the shared budget had left when the stage finished; `Infinity` when unbounded. */
  remainingMs: number;
}

export interface LayoutOptions {
  /**
   * Parse diagnostics, passed straight to `resolve`. Omitting them silently drops every source
   * path and warning the parser produced, so a CLI or any other orchestrator must pass them.
   */
  diagnostics?: readonly Diagnostic[];
  /** Stage 4. A Node caller passes `createNodeElkFactory()`; a browser caller the browser factory. */
  createElkAttempt?: CreateElkAttempt;
  /** Stage 8. Required only when the region rules leave a remainder. */
  createRouteAttempt?: CreateRouteAttempt;
  /** The command's one remaining-work budget. Every ELK attempt and the router draw from it. */
  budget?: Budget;
  /** Stage-4 policy ceiling; ADR-0006's node-count rule when omitted. */
  elkBudgetMs?: number;
  /** Stage-8 policy ceiling. */
  routeBudgetMs?: number;
  /** Stage 8 throws on a skipped required checkpoint instead of removing the link; for tests of the router's reservations. */
  strictCheckpoints?: boolean;
  clock?: ElkClock;
  onProgress?: (progress: LayoutProgress) => void;
  /** Opt-in per-pass trace of the 7f placement attempt (pass, short model hash, verdict). Off by default; never written into the layout. */
  attemptTrace?: (event: AttemptTraceEvent) => void;
  /** Test only. Side hints for every placement run (port key to `left` or `right`); no measure offers one yet (ticket 115). */
  testSideHints?: SideHints;
  /** Test only: called after the side trial is judged, with the offer, the two routed models and the verdict. */
  testSideProbe?: (event: { offer: SideOffer; routedBase: LayoutModel; routedTrial: LayoutModel; verdict: ReturnType<typeof judgeTrial> }) => void;
  /** Test only. Stage-3 node size floors for every placement run: the sizes a measured run built its skeleton graph from (side-faces.md, Section 8). */
  testNodeFloors?: ReadonlyMap<string, Size>;
  /** Test only. Courses (ticket 15) for every placement run, before the course round has any say. */
  testCourses?: readonly Course[];
  /** Test only (architecture ticket 24, phase 2). `true` forces the turn order on every placement run: stage 5 orders the ports of a face by the planned first turn of their links. */
  testTurnOrder?: boolean;
  /** Test only (ticket 24): the links whose faces every placement run orders by their turns, and no other face (see `LayoutModel.turnLinks`). */
  testTurnLinks?: readonly string[];
  /** Test only. `false` skips the overlay round (ticket 15, phase 7): the overlay links keep the chord or the derived path they had before the rule of Q1. */
  testOverlayCourses?: boolean;
  /** Test only (architecture ticket 22, phase 2): the ids of the links that every placement run reserves as spanning chords, before the span round has any say. */
  testSpanHints?: readonly string[];
  /** Test only. Replaces `MAX_RERUNS` for one command. */
  testMaxReruns?: number;
  /** Test only. Called with the wall time of each placement run, measure, 7f, route and score-ready stage, and the budget left (ticket 115 timing). */
  testTiming?: (label: string, durationMs: number, remainingMs: number) => void;
  /** Test only (the side probe of ticket 117). Called with the offer, and with the trial and its verdict; it changes nothing. */
  /** Test only: rebuild the unmoved baseline even when the filter finds no offer (counts the filter's misses). */
  testRebuildAlways?: boolean;
  testSideTrace?: (event: Record<string, unknown>) => void;
}

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  const clock = options.clock, now = (): number => clock ? clock.now() : Date.now();
  const budget = options.budget ?? UNBOUNDED_BUDGET;
  const report = (stage: LayoutStage, started: number, trial?: true): void =>
    options.onProgress?.({ stage, ...(trial === undefined ? {} : { trial }), durationMs: now() - started, remainingMs: budget.remainingMs() });
  const step = <T>(stage: LayoutStage, run: () => T, trial?: true): T => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage);
    const started = now(), result = run();
    report(stage, started, trial);
    return result;
  };

  const timed = async <T>(label: string, run: () => T | Promise<T>): Promise<T> => {
    if (options.testTiming === undefined) return run();
    const started = now(), result = await run();
    options.testTiming(label, now() - started, budget.remainingMs());
    return result;
  };

  /** Stages 1 to 7e, the placement the chords are decided on before 7f grows a gap, and so the placement a fan is measured on. `reservations` hold the port pitches a fan of chords needs on a face (ticket 89); the first run has none. */
  const stage3Sizes = new WeakMap<LayoutModel, Map<string, Size>>();
  let placements = 0;
  // The cap on placements per command: the first run and the effective re-run budget (the fan rounds at the start run within FAN_ROUNDS even with a budget of 0).
  const placeCap = Math.max(options.testMaxReruns ?? MAX_RERUNS, FAN_ROUNDS) + 1;
  const place = async (reservations: Reservations, abort?: (stage: string) => void): Promise<LayoutModel> => {
    // The one assertion of the placement budget: a command places at most MAX_RERUNS + 1 times (the first run and the re-runs), whatever round asks. A slot is released
    // only before a run starts; a run that has started is spent, even when stage 7a refuses it at once, so `placements` never goes down.
    if (placements >= placeCap) throw new PlacementBudgetExceeded(placements);
    placements++; attemptCounters.placeStarts++;
    const stepIn = <T>(stage: LayoutStage, run: () => T): T => { abort?.(stage); return step(stage, run); };
    // The trunk joins a placement run found blocked (mesh-bus.md, section 12.4) are declined in the next: the ledger names them, or all of them once the budget is spent.
    const declinedTrunks = declinedTrunksOf(reservations);
    const resolved = stepIn('resolve', () => resolve(document, { ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...(declinedTrunks.size || declinedTrunks.all ? { declinedTrunks } : {}) }));
    if (reservations.length > 0) resolved.reservations = JSON.parse(JSON.stringify(reservations)) as Reservations;
    const courses = coursesOf(reservations), spans = spansOf(reservations);
    // A course face ranks above a hint (ticket 15): each end that does not keep its natural face names the port and the face.
    const courseFaces = new Map<string, Side>();
    for (const course of courses) {
      const link = resolved.links.find(item => item.id === course.link);
      for (const which of ['from', 'to'] as const) {
        const ref = link?.attachments?.[which] ?? link?.[which];
        if (ref !== undefined && 'ordinal' in ref && movesPort(course, which)) courseFaces.set(portKey(ref), course[which].face);
      }
    }
    for (const link of resolved.links) if (spans.has(link.id)) link.spanHint = true;
    const turn = turnOf(reservations);
    if (turn.all) resolved.turnOrder = true;
    else if (turn.links.length > 0) { resolved.turnOrder = true; resolved.turnLinks = [...turn.links]; }
    const hints = sideHintsOf(reservations), laneKeys = laneKeysOf(reservations);
    stepIn('sides-one', () => sidesOne(resolved, hints, laneKeys, courseFaces));
    if (courses.length) resolved.courses = JSON.parse(JSON.stringify(courses)) as Course[];
    // An approach (ticket 15, phase 6) is stored on the link and in its course; the port keeps its side.
    for (const course of courses) {
      const link = resolved.links.find(item => item.id === course.link);
      if (link === undefined) continue;
      for (const which of ['from', 'to'] as const) {
        const approach = course[which].approach;
        if (approach !== undefined) link.approach = { ...link.approach, [which]: approach };
      }
    }
    for (const [id, pitch] of pitchFloorsOf(reservations)) resolved.nodes[id]!.sidePitch = { ...resolved.nodes[id]!.sidePitch, ...pitch };
    // A hinted node keeps the size the measured run gave it, so the skeleton input is the same (a floor on `size`, not on `sizeFloor`, which alignment reads).
    const nodeFloors = nodeFloorsOf(reservations);
    for (const [id, size] of nodeFloors) resolved.nodes[id]!.size = { ...size };
    stepIn('size', () => sizeNodes(resolved));
    const sizes = new Map(Object.entries(resolved.nodes).map(([id, node]) => [id, { ...node.size! }] as const));

    abort?.('skeleton');
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'skeleton');
    const skeletonStarted = now();
    await skeleton(resolved, {
      ...(options.createElkAttempt ? { createAttempt: options.createElkAttempt } : {}),
      ...(clock ? { clock } : {}),
      layoutBudgetMs: options.elkBudgetMs ?? elkDeadlineMs(Object.keys(resolved.nodes).length),
      budget,
    });
    report('skeleton', skeletonStarted);

    // sidesTwo freezes port topology and publishes the first protected snapshot; every region rule
    // below returns a new one, and the previous value must not be used again.
    attemptCounters.placeRuns++;
    // The ledger reads the routed chords and the straight overlay links after each stage, only when a test or the trace asked for it.
    const ledger = ledgerOn(options.attemptTrace !== undefined);
    let model = stepIn('sides-two', () => sidesTwo(resolved, nodeFloors.size > 0 ? nodeFloors : undefined));
    let seen: LedgerSnapshot | undefined = ledger ? ledgerSnapshot(model) : undefined;
    const entry = ledger ? startPlacementEntry() : undefined;
    const account = (stage: string): void => { if (seen === undefined || entry === undefined) return; const now = ledgerSnapshot(model); countStage(stage, seen, now, entry); seen = now; };
    model = stepIn('rows', () => rows(model)); account('rows');
    model = stepIn('lanes', () => lanes(model)); account('lanes');
    model = stepIn('flanks', () => flanks(model)); account('flanks');
    model = stepIn('centre', () => centre(model)); account('centre');
    model = stepIn('bars', () => bars(model)); account('bars');
    model = stepIn('bundles', () => bundles(model)); account('bundles');
    stage3Sizes.set(model, sizes);
    return model;
  };
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
  // the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
  let model!: LayoutModel;
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
    if (reruns >= (options.testMaxReruns ?? MAX_RERUNS)) kept = addReservations(kept, declineTrunk(undefined, 'the placement budget is spent', placements));
    try { model = await timed('place', () => place(kept)); break; } catch (error) {
      if (!(error instanceof TrunkBlocked) || declinedTrunksOf(kept).has(error.key)) throw error;
      kept = addReservations(kept, declineTrunk(error.key, error.why, placements));
      reruns++;
      options.testSideTrace?.({ ev: 'trunk-blocked', key: error.key, reruns, left: (options.testMaxReruns ?? MAX_RERUNS) - reruns });
    }
  }
  // The re-runs are bounded by FAN_ROUNDS alone, and no re-run reads the clock (ticket 141): the same input gives the same layout at any speed.
  // The command deadline ends the whole command with an error (`step`, `route`, `trialAbort`) and never picks a layout. A re-run that makes ELK
  // fall back (an ELK error, never a timeout: a timeout ends the command) is dropped: the placement already made stands (ticket 89 review).
  const cuts: Diagnostic[] = [];
  const cut = (why: string): void => {
    cuts.push({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_CUT',
      message: `A fan re-run was cut: ${why}. The fans keep the pitch of the last completed placement, and this layout may differ from one made with more time.` });
  };
  const cutSide = (why: string): void => {
    cuts.push({ stage: 'placement', severity: 'warning', code: 'SIDE_ROUND_CUT',
      message: `A side round was cut: ${why}. The last kept placement stands, and this layout may differ from one made with more time.` });
  };
  for (let round = 0; round < FAN_ROUNDS && placements < placeCap; round++) {
    const measure = await timed('measureFans', () => measureFans(model));
    const grown = pitchGrowth(kept, measure.floors, 'fan', placements);
    if (grown.length === 0) break;
    const next = addReservations(kept, grown);
    reruns++; attemptCounters.invalidations.fanReruns++;
    // A fan floor can move the rows, and a trunk that the baseline placed may then have a foreign unit on both sides. The run that found it blocked is a
    // trial, so the round is cut and the baseline stands (a test cannot reach this: it needs a floor that reorders a row of the mesh).
    let trial: LayoutModel;
    try { trial = await timed('rerun-fan', () => place(next)); } catch (error) {
      if (!(error instanceof TrunkBlocked)) throw error;
      cut('a trunk join was blocked by the moved rows, and the re-run was dropped'); break;
    }
    if (trial.fallbackUsed && !model.fallbackUsed) {
      cut('ELK fell back during it, and the re-run was dropped'); break;
    }
    if (!fanRoundHolds(model, trial)) { cuts.push(fanRoundDropped(model, trial)); break; }
    model = trial; kept = next;
  }
  // Side rounds (side-faces.md, Section 19). 7f runs on the kept model first: its output is the baseline, the model the command publishes when no
  // trial is kept. A measure reads the baseline. One batched trial reaches 7f per command; it is kept only on its routed result. Every bound is a
  // count (SIDE_ROUNDS, MAX_RERUNS); the clock only ends the whole command at its deadline (ticket 141).
  // The abort check of 7f, the baseline's and the trial's: the command deadline, checked between the passes. It ends the whole command, so it never picks a layout (ticket 141).
  const trialAbort = (stage: string): void => { if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage); };
  let kept7e = model;
  let base = await timed('bands', () => step('bands', () => bands(kept7e, () => trialAbort('bands'), options.attemptTrace)));
  // What the 7f run of the baseline did, for phase 3b's trigger; a kept course trial replaces it with its own run's.
  let baseMoved = lastAttempt.moved, baseUnmoved = lastAttempt.unmoved;
  const promised: SideOffer['promised'] = new Map(), refused = new Set<string>(), sideNotes: Diagnostic[] = [];
  const trialLinks = new Map<string, string>();
  // The extra trial of the unmoved baseline's offer (phase 3b) publishes no refusal note: its kept result never offered the hint.
  let silent = false;
  const refuse = (keys: Iterable<string>, side: ReadonlyMap<string, 'left' | 'right'>, reason: string): void => {
    for (const key of keys) {
      refused.add(refusedKey(key, side.get(key)!));
      if (silent) continue;
      const link = promised.get(key)?.link ?? trialLinks.get(key);
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_REFUSED',
        message: `The side hint ${side.get(key)} on ${portName(key)} was refused: ${reason}.`, ...(link === undefined ? {} : { owners: [{ kind: 'link' as const, id: link }] }) });
    }
  };
  // `publish` routes the model the command publishes. Every other route is a judged model, and keeps the ordinary overlay rule, so the
  // opt-in `layout.overlayOverBodies` (ticket 152) changes no side-round decision.
  const routeModel = async (m: LayoutModel, trial?: true, publish?: true): Promise<LayoutModel> => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
    const started = now();
    const routed = await timed(trial === undefined ? 'route' : 'route-trial', () => route(m, {
      ...(publish === undefined ? { ordinaryOverlay: true } : {}),
      ...(options.createRouteAttempt ? { createAttempt: options.createRouteAttempt } : {}),
      ...(clock ? { clock } : {}),
      ...(options.strictCheckpoints ? { strictCheckpoints: true } : {}),
      // The router's own timer must be positive; the remainder was checked above, and a 1 ms floor keeps the session honest rather than letting
      // it fall back to a fresh full policy.
      routeBudgetMs: Math.max(1, budget.share(options.routeBudgetMs ?? ROUTE_BUDGET_MS)),
    }));
    report('route', started, trial);
    return routed;
  };
  const maxReruns = options.testMaxReruns ?? MAX_RERUNS;
  let routedBase: LayoutModel | undefined, routedFinal: LayoutModel | undefined;
  const keptNotes: Diagnostic[] = [];
  // The course round (ticket 15, phase 4) runs before the side round and shares its re-runs. It reads the baseline's routed result, offers perimeter courses
  // for the links whose route is a poor one, places again with the courses reserved in stage 5, and keeps the trial only on its routed result.
  // Phase 3b's unmoved offer is a side trial too: when 7f moved the placement and the base has no offer, an offer of the unmoved copy may stand (the filter reads it).
  const unmovedMayStand = (): boolean => baseMoved && (baseUnmoved === undefined || measureSides(baseUnmoved, kept7e, refused).hints.size > 0);
  // The turn round (ticket 24, Section 10) runs after these rounds, on what they keep. When it has an offer on the baseline a round reads, that round leaves it one re-run,
  // as it leaves one to every round after it. A forced turn order or forced courses (tests) have no turn round.
  const turnRoundOn = options.testCourses === undefined && options.testTurnOrder === undefined;
  const reserve = (): number => turnReserve(base, turnRoundOn);
  // A bypass that cannot be reserved stays a remainder of stage 8 and is named, once, with the reason (`ROW_BYPASS_DECLINED`).
  const noteDeclined = (offer: ReturnType<typeof measureCourses>): void => {
    for (const item of offer.declined) {
      if (sideNotes.some(note => note.code === 'ROW_BYPASS_DECLINED' && note.owners?.some(owner => owner.kind === 'link' && owner.id === item.link))) continue;
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_DECLINED', owners: [{ kind: 'link', id: item.link }], message: `The link ${item.link} has no row bypass: ${item.why}.` });
    }
  };
  const courseRound = async (given?: ReturnType<typeof measureCourses>): Promise<void> => {
    routedBase = given === undefined ? routedFinal ?? routedBase ?? await routeModel(base) : routedBase;
    const offer = given ?? measureCourses(base, routedBase!);
    options.testSideTrace?.({ ev: 'courses', offer, base, routedBase });
    noteDeclined(offer);
    if (offer.courses.length === 0) return;
    if (reruns >= roundLimit(maxReruns, reserve())) { options.testSideTrace?.({ ev: 'course-skipped', offer, reruns }); return; }
    // The node floors of a kept course trial stay under this one (a later side trial keeps them, or it would re-size the nodes the course moved).
    const nodeFloors = new Map<string, Size>();
    for (const key of sideHintsOf(kept).keys()) {
      const [node] = JSON.parse(key) as [string];
      const size = stage3Sizes.get(kept7e)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    for (const course of offer.courses) {
      const link = kept7e.links.find(item => item.id === course.link)!;
      for (const which of ['from', 'to'] as const) {
        const size = stage3Sizes.get(kept7e)?.get(link.attachments![which].node);
        // A node whose end leaves by a U part is not pinned: its face moves from a lateral side to the bottom, and its content grows with it (P9 asks for few moves, not for none).
        if (size !== undefined && endMode(course, which) !== 'u' && course[which].face !== (kept7e.nodes[link.attachments![which].node]!.ports.find(port => portKey(port.ref) === portKey(link.attachments![which]))?.side)) nodeFloors.set(link.attachments![which].node, { ...size });
      }
    }
    reruns++;
    // A row bypass (ticket 24, phase 5) puts the closing link in the slot on its turn side: the trial carries the turn order, or its stems would cross the straight link of the gap.
    const bypassLinks = offer.courses.filter(course => course.kind === 'bypass').map(course => course.link);
    const trialLedger = addReservations(kept, [...floorEntries(nodeFloors, 'course', placements),
      ...courseEntries(offer.courses, new Map([...offer.promised].map(([id, item]) => [id, item.turns] as const)), 'course', placements),
      ...turnEntries(false, bypassLinks, false, 'course', placements)]);
    const names = offer.courses.map(course => course.link);
    // A refused course round leaves the layout as the baseline made it, with no note (the trace names the reason), so a sheet it does not change is byte for byte as it was.
    const courseRefusal = (why: string): void => { options.testSideTrace?.({ ev: 'course-refused', links: names, why }); };
    let trial7e: LayoutModel | undefined;
    try { trial7e = await timed('rerun-course', () => place(trialLedger, trialAbort)); } catch (error) {
      // A course moves columns the baseline never moved. A centring that cannot hold its feeds there is the course's refusal, not a bug of the baseline.
      if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError
        || (error instanceof Error && error.message.startsWith('Centring invariant violated')))) throw error;
      courseRefusal(`the placement run rejected them (${error.message})`);
    }
    if (trial7e !== undefined && trial7e.fallbackUsed && !kept7e.fallbackUsed) {
      courseRefusal('ELK fell back during the course trial'); trial7e = undefined;
    }
    if (trial7e !== undefined) {
      try {
        const trial = await timed('bands-trial', () => step('bands', () => bands(trial7e!, () => trialAbort('bands'), options.attemptTrace), true));
        const trialMoved = lastAttempt.moved, trialUnmoved = lastAttempt.unmoved;
        const routedTrial = await routeModel(trial, true);
        const verdict = judgeCourseTrial(routedBase!, routedTrial, new Map([...offer.promised].map(([id, item]) => [id, item.turns] as const)));
        options.testSideTrace?.({ ev: 'course-trial', verdict, trial, routedTrial, routedBase });
        if (verdict.kept) {
          if (routedFinal === undefined) routedBase = routedTrial;
        base = trial; kept7e = trial7e; routedFinal = routedTrial;
          baseMoved = trialMoved; baseUnmoved = trialUnmoved; kept = trialLedger;
          for (const course of offer.courses) {
            const was = offer.promised.get(course.link)!;
            if (course.kind === 'bypass') {
              sideNotes.push({ stage: 'placement', severity: 'info', code: 'ROW_BYPASS_PLANNED', owners: [{ kind: 'link', id: course.link }],
                message: `The link ${course.link} takes a bypass along the ${course.edge} edge of its row: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
              continue;
            }
            sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: course.link }],
              message: `The link ${course.link} takes a course ${course.kind === 'shared-port' ? 'onto the pill of its shared port' : course.runs.includes('gap') ? 'through a column gap' : 'round the outside'}: ${was.turns} turns promised, ${was.base.turns === Infinity ? 'removed' : was.base.turns} on the baseline.` });
          }
        } else {
          courseRefusal(`${verdict.reason}`);
        }
      } catch (error) {
        if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
        courseRefusal(`stage 7f rejected them (${error.message})`);
      }
    }
  };
  // The span round (architecture ticket 22, phase 3). It reads the 7f baseline and its routed result, offers a spanning chord to every link between document tiers that
  // are not consecutive whose corridor is clear, places again with the span hints, and keeps the trial only on its routed result (`judgeSpanTrial`). It runs before the
  // course, side and overlay-course rounds, because a chord changes which routes are poor, and it shares their re-runs. A refused round leaves the sheet as it was.
  const spanRound = async (): Promise<boolean> => {
    const offer = measureSpans(base, routedBase!);
    options.testSideTrace?.({ ev: 'spans', offer, base, routedBase });
    if (offer.links.length === 0) return false;
    // The round leaves one re-run to each round after it that has an offer on the baseline (course, side): a trial that is refused has spent its placements, and must not
    // starve a round that main would have run.
    const spanMax = roundLimit(maxReruns, reserve()) - (measureCourses(base, routedBase!).courses.length > 0 ? 1 : 0) - (measureSides(base, kept7e, refused).hints.size > 0 ? 1 : 0);
    if (reruns >= spanMax) { options.testSideTrace?.({ ev: 'span-refused', links: offer.links, why: 'budget' }); return false; }
    reruns++;
    const spanRefusal = (why: string, detail: string): void => { options.testSideTrace?.({ ev: 'span-refused', links: offer.links, why, detail }); };
    // The trial reserves its chords on top of the ledger; the fans of the trial grow this one, and a kept trial keeps it.
    let trialFloors = addReservations(kept, spanEntries(offer.links, 'span', placements));
    let trial7e: LayoutModel | undefined;
    try { trial7e = await timed('rerun-span', () => place(trialFloors, trialAbort)); } catch (error) {
      // The span round is an offer: a trial that the placement cannot build is refused, whatever the cause, and the sheet stays as the baseline made it. Only the command
      // deadline ends the command. The trace names the error, so a sweep that greps `span-refused` for `error` finds a defect.
      if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
      spanRefusal(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError ? 'placement' : 'error', error.message);
      return false;
    }
    if (trial7e.fallbackUsed && !kept7e.fallbackUsed) { spanRefusal('placement', 'ELK fell back during the span trial'); return false; }
    // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement (ticket 89): the chords of this trial are measured as the fan
    // rounds measure the first placement, and the trial places again with the floors they ask for. The re-runs are the command's (MAX_RERUNS).
    for (let round = 0; round < FAN_ROUNDS && reruns < spanMax; round++) {
      const measure = await timed('measureFans', () => measureFans(trial7e!));
      const grown = pitchGrowth(trialFloors, measure.floors, 'span', placements);
      if (grown.length === 0) break;
      const next = addReservations(trialFloors, grown);
      reruns++; attemptCounters.invalidations.fanReruns++;
      let again: LayoutModel;
      try { again = await timed('rerun-fan', () => place(next, trialAbort)); } catch (error) {
        if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
        spanRefusal(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError ? 'placement' : 'error', error.message); return false;
      }
      if (again.fallbackUsed && !kept7e.fallbackUsed) { spanRefusal('placement', 'ELK fell back during the span trial'); return false; }
      if (!fanRoundHolds(trial7e, again)) break;
      trial7e = again; trialFloors = next;
    }
    // 7f freezes the chords that are straight now and no other (`freezeChords`), so a hinted link that is not straight here (the freeze refuses it, as `leg` when a neighbour's
    // leg crowds it at the pitch the trial gave) is lost: the trial is refused here, before 7f and the route.
    // The placement above is spent, so nothing is given back.
    const lost = holds(trialFloors, trial7e!, entry => entry.kind === 'spanChord' && offer.links.includes(entry.payload.link)).map(failure => failure.link!);
    if (lost.length > 0) { spanRefusal('promise', `the freeze would not hold ${lost.join(', ')}: ${lost.map(id => { const item = trial7e!.links.find(other => other.id === id); return item === undefined ? 'missing' : freezeRefusal(trial7e!, item) ?? 'not straight'; }).join(', ')} (before 7f)`); return false; }
    try {
      const trial = await timed('bands-trial', () => step('bands', () => bands(trial7e!, () => trialAbort('bands'), options.attemptTrace), true));
      const trialMoved = lastAttempt.moved, trialUnmoved = lastAttempt.unmoved;
      const routedTrial = await routeModel(trial, true);
      const verdict = judgeSpanTrial(routedBase!, routedTrial, offer.links);
      options.testSideTrace?.({ ev: 'span-trial', verdict, trial, routedTrial, routedBase, offer });
      if (!verdict.kept) { spanRefusal(verdict.reason!, verdict.detail); return false; }
      kept = trialFloors;
      base = trial; kept7e = trial7e; routedFinal = routedTrial; routedBase = routedTrial;
      baseMoved = trialMoved; baseUnmoved = trialUnmoved;
      for (const id of offer.links) {
        const link = trial.links.find(item => item.id === id)!;
        const crossed = transitTiers(trial, link);
        sideNotes.push({ stage: 'placement', severity: 'info', code: 'SPAN_CHORD_TAKEN', owners: [{ kind: 'link', id }],
          message: `The link ${id} takes a spanning chord over ${crossed.length + 1} tier gaps, through ${crossed.length} transited ${crossed.length === 1 ? 'band' : 'bands'} (sub-tier ${crossed.join(', ')}).` });
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error instanceof CommandDeadlineError) throw error;
      spanRefusal(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError ? 'placement' : 'error', `stage 7f rejected them (${error.message})`);
      return false;
    }
  };
  // The two rounds share the re-runs, and both are judged by the user's order on what they publish. A course kept first would take away the offer a side round
  // reads on the baseline (the 3b pattern), so where the budget allows both, the side round goes first and the course round reads its result. Where it allows one,
  // the offer whose promise gains more takes it (a side offer that only the unmoved copy has promises nothing and wins).
  let courseDeferred = false;
  if (options.testCourses === undefined) {
    routedBase = await routeModel(base);
    // A forced hint (the test option) is the whole of the span round; otherwise the round runs here, before the course round.
    if (options.testSpanHints === undefined) await spanRound();
    const offer = measureCourses(base, routedBase);
    options.testSideTrace?.({ ev: 'courses', offer, base, routedBase });
    noteDeclined(offer);
    if (offer.courses.length > 0) {
      const sideOffer = measureSides(base, kept7e, refused), bends = routedBends(routedBase);
      const sideStands = sideOffer.hints.size > 0 || unmovedMayStand();
      if (!sideStands) await courseRound(offer);
      else if (reruns + 2 <= maxReruns) courseDeferred = true;
      else {
        const courseGain = gainOf([...offer.promised].map(([, item]) => [item.base.turns === Infinity ? undefined : item.base.turns, item.turns] as [number | undefined, number]));
        const sideGain = gainOf([...sideOffer.promised.values()].map(item => [bends.get(item.link), item.bends] as [number | undefined, number]));
        if (sideOffer.hints.size > 0 && beats(courseGain, sideGain)) await courseRound(offer);
        else options.testSideTrace?.({ ev: 'course-skipped', offer, reruns });
      }
    }
  }
  for (let round = 0; round < SIDE_ROUNDS; round++) {
    silent = false; // only the round-0 extra trial is silent; a later round publishes its refusals
    let offer = await timed('measureSides', () => measureSides(base, kept7e, refused));
    // No offer on the kept 7f result. If a 7f move changed the placement, the unmoved baseline may have had one that the move removed: it runs as one
    // extra side trial, judged on routed results like any other, so the kept result stands unless a real trial beats it (architecture ticket 15, phase 3b).
    // The settled copy 7f judged its first move against is only a filter: it is the round-0 state plus one settle, not the state 7f would publish without
    // moves. When its offer is empty the trial is skipped; otherwise the true unmoved baseline is rebuilt (silently: no progress event, no attempt trace, since
    // this run is never published) and the trial starts from the rebuilt offer. With no copy, the rebuild runs. Nothing is built when no re-run is left.
    let unmovedOffer = false, filtered: boolean | undefined;
    if (round === 0 && offer.hints.size === 0 && baseMoved && reruns < maxReruns) {
      if (baseUnmoved !== undefined) filtered = measureSides(baseUnmoved, kept7e, refused).hints.size > 0;
      if (filtered !== false || options.testRebuildAlways === true) {
        const unmoved = await timed('bands-unmoved', () => bands(kept7e, () => trialAbort('bands'), undefined, false));
        offer = await timed('measureSides', () => measureSides(unmoved, kept7e, refused));
        unmovedOffer = offer.hints.size > 0;
        silent = unmovedOffer;
      }
    }
    options.testSideTrace?.({ ev: 'offer', round, offer, base, kept7e, unmoved: unmovedOffer, filtered });
    if (offer.capped) sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_PROBE_CAPPED', message: 'The side measure stopped at its probe cap; the links after it were not probed.' });
    if (offer.hints.size === 0) break;
    if (reruns >= roundLimit(maxReruns, reserve())) {
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${maxReruns} placement re-runs.` });
      break;
    }
    const all = new Map([...sideHintsOf(kept), ...offer.hints]);
    for (const [key, item] of offer.promised) trialLinks.set(key, item.link);
    const nodeFloors = new Map<string, Size>();
    for (const key of all.keys()) {
      const [node] = JSON.parse(key) as [string];
      // The 7e model keys the size cache, never the baseline (a new object: the lookup would give undefined with no error).
      const size = stage3Sizes.get(kept7e)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    let trial7e: LayoutModel;
    // The faces stay with the ledger when the trial is kept; the size floors of a side trial do not (a later round measures its own).
    const faces = [...sideFaces(offer.hints, offer.promised, 'side', placements),
      ...laneOwners([...offer.promised].filter(([, item]) => item.shape === 'lane').map(([key]) => key), offer.hints, offer.promised, 'side', placements)];
    const trialLedger = addReservations(kept, [...floorEntries(nodeFloors, 'side', placements), ...faces]);
    reruns++; attemptCounters.invalidations.sideReruns++;
    try { trial7e = await timed('rerun-side', () => place(trialLedger, trialAbort)); } catch (error) {
      // Only the layout's own refusals drop the offer; anything else (a TypeError) is a bug and must surface.
      if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
      refuse(offer.hints.keys(), offer.hints, `the placement run rejected it (${error.message})`);
      continue;
    }
    if (trial7e.fallbackUsed && !kept7e.fallbackUsed) {
      cutSide('ELK fell back during it, and the re-run was dropped'); break;
    }
    // The ledger answers for the faces and lanes of the trial (this round's and the kept ones) at its final 7e, before 7f and the route: a port hinted for the straight shape
    // of a routed link must hold its chord (otherwise the router would find its route, review M1, ticket 117), and a port hinted for the routed L must own a source-aligned
    // side lane (an exterior corridor gives three bends, ticket 119).
    const failed = holds(trialLedger, trial7e, entry => entry.kind === 'sideFace' || entry.kind === 'laneOwner');
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
    const hintedLinks = new Map([...offer.promised.values()].map(item => [item.link, item.bends] as const));
    // The predictor prunes only when another round and another re-run remain, and only the hints it calls worse (Section 19.3).
    if (!unmovedOffer && round + 1 < SIDE_ROUNDS && reruns < maxReruns) {
      const worse = predictedWorse(predictPublished(trial7e, kept7e, base), base, hintedLinks.keys());
      const pruned = [...offer.hints.keys()].filter(key => worse.away.includes(key) || worse.links.includes(offer.promised.get(key)?.link ?? ''));
      if (pruned.length > 0) { refuse(pruned, all, 'the prediction from the moves of stage 7f gives it more bends than the baseline'); continue; }
    }
    let trial: LayoutModel, routedTrial: LayoutModel;
    try {
      trial = await timed('bands-trial', () => step('bands', () => bands(trial7e, () => trialAbort('bands'), options.attemptTrace), true));
      routedBase ??= await routeModel(base);
      routedTrial = await routeModel(trial, true);
    } catch (error) {
      if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
      refuse(offer.hints.keys(), offer.hints, `its stage 7f rejected it (${error.message})`);
      break;
    }
    const verdict = judgeTrial({ routedBase, routedTrial, kept7e, trial7e, hinted: hintedLinks, lanes: new Set([...offer.promised.values()].filter(item => item.shape === 'lane').map(item => item.link)) });
    options.testSideTrace?.({ ev: 'trial', verdict, base, kept7e, trial7e, trial, routedBase, routedTrial, hinted: hintedLinks });
    options.testSideProbe?.({ offer, routedBase, routedTrial, verdict });
    // A kept course keeps its promise through the side round as well: a side trial that makes a course link publish more turns than it promised is refused.
    const brokenPromise = verdict.kept ? holdsRouted(kept, routedTrial).map(failure => failure.link!) : [];
    if (brokenPromise.length > 0) { refuse(offer.hints.keys(), all, `a course link publishes more turns than it promised (${brokenPromise.join(', ')})`); break; }
    if (!verdict.kept) { refuse(offer.hints.keys(), all, verdict.reason); break; }
    // Kept: the trial is the baseline now. The notes name what the net count accepted.
    keptNotes.push(...trialNotes(routedBase, routedTrial, verdict, hintedLinks.keys()));
    base = trial; kept7e = trial7e; kept = addReservations(kept, faces); routedFinal = routedTrial;
    for (const [key, item] of offer.promised) promised.set(key, item);
    break; // one trial reaches 7f per command
  }
  if (courseDeferred) await courseRound();
  // The turn round (architecture ticket 24, Section 10). On the kept result of the span, course and side rounds: when the planned first turns would reorder the ports of a
  // face, placement runs once more with the turn order and the trial is kept only when the published result is better by the unified order. It takes one re-run of the
  // shared budget and leaves one to the overlay round when that round has an offer. A refused or skipped trial leaves the layout as the baseline made it, with no note.
  if (turnRoundOn) {
    const offer = measureTurnOrder(base);
    options.testSideTrace?.({ ev: 'turns', offer, base });
    const names = offer.faces.map(face => `${face.node}.${face.side}`);
    const refuseTurns = (why: string): void => { options.testSideTrace?.({ ev: 'turn-refused', faces: names, why }); };
    if (offer.faces.length > 0) {
      const current = routedFinal ?? routedBase ?? await routeModel(base);
      const overlayOffer = options.testOverlayCourses !== false ? measureOverlayCourses(base, current) : undefined;
      const overlayAhead = overlayOffer !== undefined && overlayOffer.courses.length > 0;
      const left = maxReruns - reruns;
      // The turn offer moves no bend and no turn by design, so it promises none: with one re-run left and both offers it runs only if the overlay offer promises nothing either.
      const overlayGain = overlayAhead ? gainOf([...overlayOffer.promised].map(([, item]) => [item.base === Infinity ? undefined : item.base, item.turns] as [number | undefined, number])) : [0, 0, 0];
      if (!turnRoundRuns(left, overlayAhead, overlayGain, beats)) {
        sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ROUND_SKIPPED', message: `The turn round was skipped: the command has ${left <= 0 ? 'made its' : 'one left of its'} ${maxReruns} placement re-runs${left <= 0 ? '' : ', for the overlay round'}.` });
      } else {
        const nodeFloors = new Map<string, Size>();
        for (const key of sideHintsOf(kept).keys()) {
          const [node] = JSON.parse(key) as [string];
          const size = stage3Sizes.get(kept7e)?.get(node);
          if (size !== undefined) nodeFloors.set(node, { ...size });
        }
        let trial7e: LayoutModel | undefined;
        reruns++;
        // The ledger a kept trial keeps asks for no change of a face; the trial's own asks for one (the turn order must move a face, or the trial is refused).
        const keptTurn = addReservations(kept, [...floorEntries(nodeFloors, 'turn', placements), ...turnEntries(true, [], false, 'turn', placements)]);
        const trialLedger = addReservations(keptTurn, turnEntries(true, [], true, 'turn', placements));
        try { trial7e = await timed('rerun-turn', () => place(trialLedger, trialAbort)); } catch (error) {
          if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError || error instanceof PlacementBudgetExceeded
            || (error instanceof Error && error.message.startsWith('Centring invariant violated')))) throw error;
          refuseTurns(`the placement run rejected it (${error.message})`);
        }
        if (trial7e !== undefined && trial7e.fallbackUsed && !kept7e.fallbackUsed) { refuseTurns('ELK fell back during the turn trial'); trial7e = undefined; }
        // The offer was decided before any placement; this is left only when the measure and stage 5 disagree about a face. The placement is spent (no re-run is given back).
        if (trial7e !== undefined && holds(trialLedger, trial7e, entry => entry.kind === 'turnOrder').length > 0) { refuseTurns('the turn order moved no face'); trial7e = undefined; }
        if (trial7e !== undefined) {
          try {
            const trial = await timed('bands-trial', () => step('bands', () => bands(trial7e!, () => trialAbort('bands'), options.attemptTrace), true));
            const routedTrial = await routeModel(trial, true);
            const verdict = judgeTurnTrial(current, routedTrial, promisedTurns(kept));
            options.testSideTrace?.({ ev: 'turn-trial', verdict, trial, routedTrial, routedBase: current });
            if (verdict.kept) {
              base = trial; kept7e = trial7e; routedFinal = routedTrial; kept = keptTurn;
              for (const face of trial7e.freeze!.turnOrder!) {
                sideNotes.push({ stage: 'placement', severity: 'info', code: 'TURN_ORDER_TAKEN', owners: [{ kind: 'node', id: face.node }],
                  message: `The ports of the ${face.side} face of ${face.node} take the order of their planned first turns: ${verdict.before!.bent} bent links, ${verdict.before!.turns} turns and ${verdict.before!.crossings} crossings on the baseline, ${verdict.after!.bent}, ${verdict.after!.turns} and ${verdict.after!.crossings} after.` });
              }
            } else refuseTurns(verdict.reason);
          } catch (error) {
            if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
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
    const current = routedFinal ?? routedBase ?? await routeModel(base);
    const overlayOffer = measureOverlayCourses(base, current);
    options.testSideTrace?.({ ev: 'overlay-courses', offer: overlayOffer, base, routedBase: current });
    if (overlayOffer.courses.length > 0 && reruns >= maxReruns) options.testSideTrace?.({ ev: 'overlay-skipped', offer: overlayOffer, reruns });
    else if (overlayOffer.courses.length > 0) {
      const nodeFloors = new Map<string, Size>();
      for (const key of sideHintsOf(kept).keys()) {
        const [node] = JSON.parse(key) as [string];
        const size = stage3Sizes.get(kept7e)?.get(node);
        if (size !== undefined) nodeFloors.set(node, { ...size });
      }
      // A node whose overlay end changes face keeps its size (P9): the capacity estimate of the face it leaves must not re-size it.
      for (const course of overlayOffer.courses) {
        const link = kept7e.links.find(item => item.id === course.link)!;
        for (const which of ['from', 'to'] as const) {
          const size = stage3Sizes.get(kept7e)?.get(link.attachments![which].node);
          if (size !== undefined && course[which].face !== kept7e.nodes[link.attachments![which].node]!.ports.find(port => portKey(port.ref) === portKey(link.attachments![which]))?.side) nodeFloors.set(link.attachments![which].node, { ...size });
        }
      }
      const names = overlayOffer.courses.map(course => course.link);
      const refuseOverlays = (why: string): void => { options.testSideTrace?.({ ev: 'overlay-refused', links: names, why }); };
      let trial7e: LayoutModel | undefined;
      reruns++;
      const trialLedger = addReservations(kept, [...floorEntries(nodeFloors, 'overlay', placements),
        ...courseEntries(overlayOffer.courses, new Map([...overlayOffer.promised].map(([id, item]) => [id, item.turns] as const)), 'overlay', placements)]);
      try { trial7e = await timed('rerun-overlay', () => place(trialLedger, trialAbort)); } catch (error) {
        if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError
          || (error instanceof Error && error.message.startsWith('Centring invariant violated')))) throw error;
        refuseOverlays(`the placement run rejected them (${error.message})`);
      }
      if (trial7e !== undefined && trial7e.fallbackUsed && !kept7e.fallbackUsed) { refuseOverlays('ELK fell back during the overlay trial'); trial7e = undefined; }
      if (trial7e !== undefined) {
        try {
          const trial = await timed('bands-trial', () => step('bands', () => bands(trial7e!, () => trialAbort('bands'), options.attemptTrace), true));
          const routedTrial = await routeModel(trial, true);
          const verdict = judgeOverlayTrial(current, routedTrial, overlayOffer);
          options.testSideTrace?.({ ev: 'overlay-trial', verdict, trial, routedTrial, routedBase: current });
          if (verdict.kept) {
            base = trial; kept7e = trial7e; routedFinal = routedTrial; kept = trialLedger;
            for (const course of overlayOffer.courses) {
              const was = overlayOffer.promised.get(course.link)!;
              sideNotes.push({ stage: 'placement', severity: 'info', code: 'COURSE_TAKEN', owners: [{ kind: 'link', id: course.link }],
                message: `The overlay link ${course.link} takes a course round the outside: ${was.turns} turns promised, ${was.base} on the baseline.` });
            }
          } else refuseOverlays(verdict.reason);
        } catch (error) {
          if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
          refuseOverlays(`stage 7f rejected them (${error.message})`);
        }
      }
    }
  }
  for (const [key, item] of promised) {
    const side = sideHintsOf(kept).get(key);
    if (side === undefined) continue;
    sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_TAKEN',
      message: `The port ${portName(key)} takes the side ${side}: the ${item.shape} shape of ${item.link} (${item.bends} bends).`, owners: [{ kind: 'link', id: item.link }] });
  }
  sideNotes.push(...keptNotes);
  // Read on the 7e model that publishes: the kept one, or the kept trial's.
  const declined = declinedFanDiagnostics(measureFans(kept7e).declined);
  const atFreeze = chordClearances(kept7e);
  model = base;
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed.
  const lost: Diagnostic[] = [...sideHintDiagnostics(model)];
  for (const [pair, now] of chordClearances(model)) {
    const before = atFreeze.get(pair);
    if (now < STRAIGHT_PATH_CLEARANCE.path - PLACEMENT_EPS && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Placement moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  // With the setting on, the kept model is routed once more to publish: a judged route carries the ordinary overlay paths.
  const published = model.document.layout?.overlayOverBodies === true ? await routeModel(model, undefined, true) : routedFinal ?? routedBase ?? await routeModel(model);
  // A course that publishes more turns than its candidate promised is named; the promise is the polyline its own lane geometry reserved.
  for (const failure of holdsRouted(kept, published)) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'COURSE_SHAPE_LOST', owners: [{ kind: 'link', id: failure.link! }],
      message: `The link ${failure.link} has ${failure.got === undefined ? 'no route' : `${failure.got} turns`} on its course, ${failure.max} were promised.` });
  }
  lost.push(...turnMissed(published));
  // A hinted link of a kept trial has no more bends than on the baseline (the judgment tested it); this names a break of that rule.
  if (routedFinal !== undefined && routedBase !== undefined) {
    const before = routedBends(routedBase), after = routedBends(routedFinal);
    for (const [key, item] of promised) {
      if ((after.get(item.link) ?? Infinity) > (before.get(item.link) ?? Infinity)) lost.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST',
        message: `The hinted link ${item.link} (port ${portName(key)}) has more bends than on the baseline (${before.get(item.link)}).`, owners: [{ kind: 'link', id: item.link }] });
    }
  }

  return timed('link-labels', () => step('link-labels', () => linkLabels(published, [...cuts, ...sideNotes, ...declined, ...lost])));
}
