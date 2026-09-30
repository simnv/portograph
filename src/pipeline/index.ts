/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { Diagnostic, LayoutModel, LayoutStage, NormalisedDocument, Side, Size } from '../model/index.js';
import { resolve } from '../resolve/index.js';
import { sidesOne } from '../layout/sides-one.js';
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
import { CommandDeadlineError, POST_PLACEMENT_RESERVE_MS, UNBOUNDED_BUDGET, type Budget } from './budget.js';
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, fanRoundDropped, fanRoundHolds, measureFans, type FanMeasure } from '../layout/fan-spread.js';
import { chordClearances, isRoutedChord } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { hintsFacingAway, SideHintRefusal, sideHintDiagnostics, type SideHints } from '../layout/side-hints.js';
import { bendTotals, measureSides, overlayCrossingsAt, plannedBends, refusedKey, type SideOffer } from '../layout/side-measure.js';
import { overlayBlockers } from '../layout/overlay-paths.js';


/** Most runs of placement a fan's pitch may cost after the first (ticket 89). */
const FAN_ROUNDS = 2;
/** What one fan re-run costs to 7e and 7f, without the chord step. A re-run starts only with this plus the post-placement reserve left
 * before the hard command deadline; the number never scales with the first run's time, so the layout does not depend on machine speed (ticket 112). */
const FAN_RERUN_MS = 8000;
const fanGateMs = POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS;
/** Most side rounds after the fan rounds: one offer, one retry (side-faces.md, Section 7). */
const SIDE_ROUNDS = 2;
/**
 * Most placement re-runs of one command, fan and side together (side-faces.md, Section 7, *Budget*). A count, never set by the clock.
 * PROVISIONAL (ticket 115): 3 = the two fan rounds and one side trial. The value is to be the largest count whose whole command, projected
 * on a machine 2 times slower, finishes 2 s or more before the 30 s deadline; the coordinator's timing run on the private sheet sets it.
 */
export const MAX_RERUNS = 3;
/** `node.name#ordinal`, or `node.#ordinal` for an anonymous port, from a port key. */
const portName = (key: string): string => {
  const [node, anonymous, name, ordinal] = JSON.parse(key) as [string, boolean, string | null, number];
  return `${node}.${anonymous ? '' : name}#${ordinal}`;
};
const straightChords = (model: LayoutModel): number => model.links.filter(link => isRoutedChord(model, link)).length;

export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';

export interface LayoutProgress {
  stage: LayoutStage;
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
  /** Test only. Side hints for every placement run (port key to `left` or `right`); no measure offers one yet (ticket 115). */
  testSideHints?: SideHints;
  /** Test only. Stage-3 node size floors for every placement run: the sizes a measured run built its skeleton graph from (side-faces.md, Section 8). */
  testNodeFloors?: ReadonlyMap<string, Size>;
  /** Test only. Replaces `MAX_RERUNS` for one command. */
  testMaxReruns?: number;
  /** Test only. Called with the wall time of each placement run, measure, 7f, route and score-ready stage, and the budget left (ticket 115 timing). */
  testTiming?: (label: string, durationMs: number, remainingMs: number) => void;
}

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  const clock = options.clock, now = (): number => clock ? clock.now() : Date.now();
  const budget = options.budget ?? UNBOUNDED_BUDGET;
  const report = (stage: LayoutStage, started: number): void =>
    options.onProgress?.({ stage, durationMs: now() - started, remainingMs: budget.remainingMs() });
  const step = <T>(stage: LayoutStage, run: () => T): T => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage);
    const started = now(), result = run();
    report(stage, started);
    return result;
  };

  const timed = async <T>(label: string, run: () => T | Promise<T>): Promise<T> => {
    if (options.testTiming === undefined) return run();
    const started = now(), result = await run();
    options.testTiming(label, now() - started, budget.remainingMs());
    return result;
  };

  /** Stages 1 to 7e, the placement the chords are decided on before 7f grows a gap, and so the placement a fan is measured on. `floors` are port pitches a fan of chords needs on a face (ticket 89); the first run has none. */
  const stage3Sizes = new WeakMap<LayoutModel, Map<string, Size>>();
  const place = async (floors: FanMeasure['floors'], hints = options.testSideHints, nodeFloors = options.testNodeFloors): Promise<LayoutModel> => {
    const resolved = step('resolve', () => resolve(document, options.diagnostics ? { diagnostics: options.diagnostics } : {}));
    step('sides-one', () => sidesOne(resolved, hints));
    for (const [id, pitch] of floors) resolved.nodes[id]!.sidePitch = { ...resolved.nodes[id]!.sidePitch, ...pitch };
    // A hinted node keeps the size the measured run gave it, so the skeleton input is the same (a floor on `size`, not on `sizeFloor`, which alignment reads).
    for (const [id, size] of nodeFloors ?? []) resolved.nodes[id]!.size = { ...size };
    step('size', () => sizeNodes(resolved));
    const sizes = new Map(Object.entries(resolved.nodes).map(([id, node]) => [id, { ...node.size! }] as const));

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
    let model = step('sides-two', () => sidesTwo(resolved, nodeFloors));
    model = step('rows', () => rows(model));
    model = step('lanes', () => lanes(model));
    model = step('flanks', () => flanks(model));
    model = step('centre', () => centre(model));
    model = step('bars', () => bars(model));
    model = step('bundles', () => bundles(model));
    stage3Sizes.set(model, sizes);
    return model;
  };
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
  // the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
  let model = await timed('place', () => place(new Map()));
  let reruns = 0;
  // The re-runs are bounded by FAN_ROUNDS alone. The clock is read only against the hard command deadline: a re-run starts only when
  // the post-placement reserve plus one re-run (the fan gate) remains; otherwise it is cut, and a warning says so (ticket 112). A probe that meets the deadline
  // or makes ELK fall back is dropped too: the placement already made stands (ticket 89 review).
  const cuts: Diagnostic[] = [];
  const cut = (why: string): void => {
    cuts.push({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_CUT',
      message: `A fan re-run was cut: ${why}. The fans keep the pitch of the last completed placement, and this layout may differ from one made with more time.` });
  };
  const cutSide = (why: string): void => {
    cuts.push({ stage: 'placement', severity: 'warning', code: 'SIDE_ROUND_CUT',
      message: `A side round was cut: ${why}. The hints of the last kept placement stand, and this layout may differ from one made with more time.` });
  };
  let floors: FanMeasure['floors'] = new Map();
  for (let round = 0; round < FAN_ROUNDS; round++) {
    const measure = await timed('measureFans', () => measureFans(model));
    const next: FanMeasure['floors'] = new Map(floors);
    let grew = false;
    for (const [id, pitch] of measure.floors) for (const [side, value] of Object.entries(pitch) as [Side, number][]) {
      if (value > (next.get(id)?.[side] ?? 0)) { next.set(id, { ...next.get(id), [side]: value }); grew = true; }
    }
    if (!grew) break;
    options.testTiming?.('gate-fan', 0, budget.remainingMs());
    if (budget.remainingMs() < fanGateMs) { cut('the command deadline leaves less than the reserve for one re-run, 7f, routing and scoring'); break; }
    let trial: LayoutModel;
    reruns++;
    try { trial = await timed('rerun-fan', () => place(next)); } catch (error) {
      if (error instanceof CommandDeadlineError) { cut('the command deadline was reached during it'); break; }
      throw error;
    }
    if ((trial.fallbackUsed && !model.fallbackUsed) || (trial.deadlineHit && !model.deadlineHit)) {
      cut('ELK fell back or met its time limit during it, and the re-run was dropped'); break;
    }
    if (!fanRoundHolds(model, trial)) { cuts.push(fanRoundDropped(model, trial)); break; }
    model = trial; floors = next;
  }
  // Side rounds (side-faces.md, Section 7, part 2): only when a measure offers a hint. A dropped trial leaves the model, the floors and the old
  // hints as they were. Every bound is a count (SIDE_ROUNDS, MAX_RERUNS); the clock is read only against the hard-deadline gate.
  let hints = new Map<string, 'left' | 'right'>(options.testSideHints ?? []);
  const promised: SideOffer['promised'] = new Map(), refused = new Set<string>(), sideNotes: Diagnostic[] = [];
  const refuse = (keys: Iterable<string>, side: ReadonlyMap<string, 'left' | 'right'>, reason: string): void => {
    for (const key of keys) {
      refused.add(refusedKey(key, side.get(key)!));
      const link = promised.get(key)?.link ?? trialLinks.get(key);
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_REFUSED',
        message: `The side hint ${side.get(key)} on ${portName(key)} was refused: ${reason}.`, ...(link === undefined ? {} : { owners: [{ kind: 'link' as const, id: link }] }) });
    }
  };
  const trialLinks = new Map<string, string>();
  for (let round = 0; round < SIDE_ROUNDS; round++) {
    const offer = await timed('measureSides', () => measureSides(model, refused));
    if (offer.capped) sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_PROBE_CAPPED', message: 'The side measure stopped at its probe cap; the links after it were not probed.' });
    if (offer.hints.size === 0) break;
    if (reruns >= (options.testMaxReruns ?? MAX_RERUNS)) {
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${options.testMaxReruns ?? MAX_RERUNS} placement re-runs.` });
      break;
    }
    options.testTiming?.('gate-side', 0, budget.remainingMs());
    if (budget.remainingMs() < fanGateMs) { cutSide('the command deadline leaves less than the reserve for one re-run, 7f, routing and scoring'); break; }
    const all = new Map([...hints, ...offer.hints]);
    for (const [key, item] of offer.promised) trialLinks.set(key, item.link);
    const nodeFloors = new Map(options.testNodeFloors ?? []);
    for (const key of all.keys()) {
      const [node] = JSON.parse(key) as [string];
      const size = stage3Sizes.get(model)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    let trial: LayoutModel;
    reruns++;
    try { trial = await timed('rerun-side', () => place(floors, all, nodeFloors)); } catch (error) {
      if (error instanceof CommandDeadlineError) { cutSide('the command deadline was reached during it'); break; }
      // Only the layout's own refusals drop the offer; anything else (a TypeError) is a bug and must surface.
      if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
      refuse(offer.hints.keys(), offer.hints, `the placement run rejected it (${error.message})`);
      continue;
    }
    if ((trial.fallbackUsed && !model.fallbackUsed) || (trial.deadlineHit && !model.deadlineHit)) {
      cutSide('ELK fell back or met its time limit during it, and the re-run was dropped'); break;
    }
    const blockers = overlayBlockers(trial), awayBefore = new Set(hintsFacingAway(model).map(item => item.key));
    // A hint that already faced away on the kept model is not this trial's failure.
    const away = new Set(hintsFacingAway(trial).map(item => item.key).filter(key => !awayBefore.has(key)));
    const promisedAll = new Map([...promised, ...offer.promised]);
    const failed = [...all.keys()].filter(key => away.has(key) || (promisedAll.has(key)
      && plannedBends(trial, trial.links.find(link => link.id === promisedAll.get(key)!.link)!, blockers) > promisedAll.get(key)!.bends));
    const before = bendTotals(model), after = bendTotals(trial);
    // A hint must not add an overlay crossing at a moved port: it is real in the drawing, and no other test of the round sees it.
    const movedNodes = new Set([...offer.hints.keys()].map(key => (JSON.parse(key) as [string])[0]));
    if (failed.length === 0 && (after.bent < before.bent || (after.bent === before.bent && after.total < before.total))
      && straightChords(trial) >= straightChords(model)
      && overlayCrossingsAt(trial, movedNodes) <= overlayCrossingsAt(model, movedNodes)) {
      model = trial; hints = all;
      for (const [key, item] of offer.promised) promised.set(key, item);
      continue;
    }
    if (failed.some(key => hints.has(key))) refuse(offer.hints.keys(), all, 'a new hint broke an old one');
    else if (failed.length > 0) refuse(failed.filter(key => offer.hints.has(key)), all, 'its shape was lost in the next placement run');
    else refuse(offer.hints.keys(), all, 'every shape held, but the next placement run gave no gain');
  }
  for (const [key, item] of promised) {
    const side = hints.get(key);
    if (side === undefined) continue;
    sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_TAKEN',
      message: `The port ${portName(key)} takes the side ${side}: the ${item.shape} shape of ${item.link} (${item.bends} bends).`, owners: [{ kind: 'link', id: item.link }] });
  }
  const declined = declinedFanDiagnostics(measureFans(model).declined);
  const atFreeze = chordClearances(model);
  model = await timed('bands', () => step('bands', () => bands(model, budget)));
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed.
  const lost: Diagnostic[] = [...sideHintDiagnostics(model)];
  // The round judged a hinted shape at 7e; 7f can move a body onto it. Name every hinted link that now has more bends than the round promised.
  const lostBlockers = promised.size > 0 ? overlayBlockers(model) : undefined;
  for (const [key, item] of promised) {
    const link = model.links.find(candidate => candidate.id === item.link);
    if (link !== undefined && plannedBends(model, link, lostBlockers) > item.bends) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST',
        message: `The hinted link ${item.link} (port ${portName(key)}) has more bends after stage 7f than the side round promised (${item.bends}).`, owners: [{ kind: 'link', id: item.link }] });
    }
  }
  for (const [pair, now] of chordClearances(model)) {
    const before = atFreeze.get(pair);
    if (now < STRAIGHT_PATH_CLEARANCE.path - 1e-6 && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Stage 7f moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
  const routeStarted = now();
  model = await timed('route', () => route(model, {
    ...(options.createRouteAttempt ? { createAttempt: options.createRouteAttempt } : {}),
    ...(clock ? { clock } : {}),
    ...(options.strictCheckpoints ? { strictCheckpoints: true } : {}),
    // The router's own timer must be positive; the remainder was checked one line above, and a
    // 1 ms floor keeps the session honest rather than letting it fall back to a fresh 30 s.
    routeBudgetMs: Math.max(1, budget.share(options.routeBudgetMs ?? ROUTE_BUDGET_MS)),
  }));
  report('route', routeStarted);

  return timed('link-labels', () => step('link-labels', () => linkLabels(model, [...cuts, ...sideNotes, ...declined, ...lost])));
}
