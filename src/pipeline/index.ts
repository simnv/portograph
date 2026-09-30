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
import { CommandDeadlineError, UNBOUNDED_BUDGET, type Budget } from './budget.js';
// After the stages: the modules below reach the centring module, whose import order the tests that mock it depend on.
import { declinedFanDiagnostics, fanRoundDropped, fanRoundHolds, measureFans, type FanMeasure } from '../layout/fan-spread.js';
import { chordClearances, isRoutedChord } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { SideHintRefusal, sideHintDiagnostics, type SideHints } from '../layout/side-hints.js';
import { measureSides, refusedKey, type SideOffer } from '../layout/side-measure.js';
import { judgeTrial, predictedWorse, predictPublished, routedBends, trialNotes } from '../layout/side-judge.js';


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
  /** Test only. Side hints for every placement run (port key to `left` or `right`); no measure offers one yet (ticket 115). */
  testSideHints?: SideHints;
  /** Test only: called after the side trial is judged, with the offer, the two routed models and the verdict. */
  testSideProbe?: (event: { offer: SideOffer; routedBase: LayoutModel; routedTrial: LayoutModel; verdict: ReturnType<typeof judgeTrial> }) => void;
  /** Test only. Stage-3 node size floors for every placement run: the sizes a measured run built its skeleton graph from (side-faces.md, Section 8). */
  testNodeFloors?: ReadonlyMap<string, Size>;
  /** Test only. Replaces `MAX_RERUNS` for one command. */
  testMaxReruns?: number;
  /** Test only. Called with the wall time of each placement run, measure, 7f, route and score-ready stage, and the budget left (ticket 115 timing). */
  testTiming?: (label: string, durationMs: number, remainingMs: number) => void;
  /** Test only (the side probe of ticket 117). Called with the offer, and with the trial and its verdict; it changes nothing. */
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

  /** Stages 1 to 7e, the placement the chords are decided on before 7f grows a gap, and so the placement a fan is measured on. `floors` are port pitches a fan of chords needs on a face (ticket 89); the first run has none. */
  const stage3Sizes = new WeakMap<LayoutModel, Map<string, Size>>();
  const place = async (floors: FanMeasure['floors'], hints = options.testSideHints, nodeFloors = options.testNodeFloors, abort?: (stage: string) => void, laneKeys: ReadonlySet<string> = new Set()): Promise<LayoutModel> => {
    const stepIn = <T>(stage: LayoutStage, run: () => T): T => { abort?.(stage); return step(stage, run); };
    const resolved = stepIn('resolve', () => resolve(document, options.diagnostics ? { diagnostics: options.diagnostics } : {}));
    stepIn('sides-one', () => sidesOne(resolved, hints, laneKeys));
    for (const [id, pitch] of floors) resolved.nodes[id]!.sidePitch = { ...resolved.nodes[id]!.sidePitch, ...pitch };
    // A hinted node keeps the size the measured run gave it, so the skeleton input is the same (a floor on `size`, not on `sizeFloor`, which alignment reads).
    for (const [id, size] of nodeFloors ?? []) resolved.nodes[id]!.size = { ...size };
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
    let model = stepIn('sides-two', () => sidesTwo(resolved, nodeFloors));
    model = stepIn('rows', () => rows(model));
    model = stepIn('lanes', () => lanes(model));
    model = stepIn('flanks', () => flanks(model));
    model = stepIn('centre', () => centre(model));
    model = stepIn('bars', () => bars(model));
    model = stepIn('bundles', () => bundles(model));
    stage3Sizes.set(model, sizes);
    return model;
  };
  // A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
  // the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
  let model = await timed('place', () => place(new Map()));
  let reruns = 0;
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
      message: `A side round was cut: ${why}. The baseline (stage 7f of the last kept placement) stands, and this layout may differ from one made with more time.` });
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
    reruns++;
    const trial = await timed('rerun-fan', () => place(next));
    if (trial.fallbackUsed && !model.fallbackUsed) {
      cut('ELK fell back during it, and the re-run was dropped'); break;
    }
    if (!fanRoundHolds(model, trial)) { cuts.push(fanRoundDropped(model, trial)); break; }
    model = trial; floors = next;
  }
  // Side rounds (side-faces.md, Section 19). 7f runs on the kept model first: its output is the baseline, the model the command publishes when no
  // trial is kept. A measure reads the baseline. One batched trial reaches 7f per command; it is kept only on its routed result. Every bound is a
  // count (SIDE_ROUNDS, MAX_RERUNS); the clock only ends the whole command at its deadline (ticket 141).
  // The abort check of 7f, the baseline's and the trial's: the command deadline, checked between the passes. It ends the whole command, so it never picks a layout (ticket 141).
  const trialAbort = (stage: string): void => { if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, stage); };
  let kept7e = model;
  let base = await timed('bands', () => step('bands', () => bands(kept7e, () => trialAbort('bands'))));
  let hints = new Map<string, 'left' | 'right'>(options.testSideHints ?? []);
  let laneKeys = new Set<string>();
  const promised: SideOffer['promised'] = new Map(), refused = new Set<string>(), sideNotes: Diagnostic[] = [];
  const trialLinks = new Map<string, string>();
  const refuse = (keys: Iterable<string>, side: ReadonlyMap<string, 'left' | 'right'>, reason: string): void => {
    for (const key of keys) {
      refused.add(refusedKey(key, side.get(key)!));
      const link = promised.get(key)?.link ?? trialLinks.get(key);
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_REFUSED',
        message: `The side hint ${side.get(key)} on ${portName(key)} was refused: ${reason}.`, ...(link === undefined ? {} : { owners: [{ kind: 'link' as const, id: link }] }) });
    }
  };
  const routeModel = async (m: LayoutModel, trial?: true): Promise<LayoutModel> => {
    if (budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'route');
    const started = now();
    const routed = await timed(trial === undefined ? 'route' : 'route-trial', () => route(m, {
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
  for (let round = 0; round < SIDE_ROUNDS; round++) {
    const offer = await timed('measureSides', () => measureSides(base, kept7e, refused));
    options.testSideTrace?.({ ev: 'offer', round, offer, base, kept7e });
    if (offer.capped) sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_PROBE_CAPPED', message: 'The side measure stopped at its probe cap; the links after it were not probed.' });
    if (offer.hints.size === 0) break;
    if (reruns >= maxReruns) {
      sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_ROUND_SKIPPED', message: `A side round was skipped: the command has made its ${maxReruns} placement re-runs.` });
      break;
    }
    const all = new Map([...hints, ...offer.hints]);
    for (const [key, item] of offer.promised) trialLinks.set(key, item.link);
    const nodeFloors = new Map(options.testNodeFloors ?? []);
    for (const key of all.keys()) {
      const [node] = JSON.parse(key) as [string];
      // The 7e model keys the size cache, never the baseline (a new object: the lookup would give undefined with no error).
      const size = stage3Sizes.get(kept7e)?.get(node);
      if (size !== undefined) nodeFloors.set(node, { ...size });
    }
    const allLanes = new Set([...laneKeys, ...[...offer.promised].filter(([, item]) => item.shape === 'lane').map(([key]) => key)]);
    let trial7e: LayoutModel;
    reruns++;
    try { trial7e = await timed('rerun-side', () => place(floors, all, nodeFloors, trialAbort, allLanes)); } catch (error) {
      // Only the layout's own refusals drop the offer; anything else (a TypeError) is a bug and must surface.
      if (!(error instanceof SideHintRefusal || error instanceof SkeletonError || error instanceof BundleFeasibilityError)) throw error;
      refuse(offer.hints.keys(), offer.hints, `the placement run rejected it (${error.message})`);
      continue;
    }
    if (trial7e.fallbackUsed && !kept7e.fallbackUsed) {
      cutSide('ELK fell back during it, and the re-run was dropped'); break;
    }
    // A port hinted for the straight shape of a routed link (this round's, or kept) must hold its chord at the trial's 7e. Otherwise it would be routed with
    // no lane (`sideLaneCandidate`) and no chord, and the router would find its route (review M1, ticket 117).
    const chordLost = [...new Map([...promised, ...offer.promised])].filter(([, item]) => {
      const link = trial7e.links.find(candidate => candidate.id === item.link);
      return item.shape === 'straight' && link !== undefined && link.layer === 'routed' && !isRoutedChord(trial7e, link);
    });
    if (chordLost.length > 0) {
      const own = chordLost.map(([key]) => key).filter(key => offer.hints.has(key));
      refuse(own.length > 0 && own.length === chordLost.length ? own : offer.hints.keys(), all,
        `a port hinted for a chord does not hold its chord at stage 7e (${[...new Set(chordLost.map(([, item]) => item.link))].join(', ')})`);
      continue;
    }
    // A port hinted for the routed L must own a source-aligned side lane at the trial's 7e (ticket 119). Without one the router would find its route (an
    // exterior corridor gives three bends), so the hint is refused before 7f.
    const laneLost = [...new Map([...promised, ...offer.promised])].filter(([, item]) => item.shape === 'lane'
      && !trial7e.lanes.some(lane => lane.kind === 'side' && lane.owner.kind === 'link' && lane.owner.id === item.link && lane.aligned === true));
    if (laneLost.length > 0) {
      const own = laneLost.map(([key]) => key).filter(key => offer.hints.has(key));
      refuse(own.length > 0 && own.length === laneLost.length ? own : offer.hints.keys(), all,
        `a port hinted for a side lane has no source-aligned lane at stage 7e (${[...new Set(laneLost.map(([, item]) => item.link))].join(', ')})`);
      continue;
    }
    const hintedLinks = new Map([...offer.promised.values()].map(item => [item.link, item.bends] as const));
    // The predictor prunes only when another round and another re-run remain, and only the hints it calls worse (Section 19.3).
    if (round + 1 < SIDE_ROUNDS && reruns < maxReruns) {
      const worse = predictedWorse(predictPublished(trial7e, kept7e, base), base, hintedLinks.keys());
      const pruned = [...offer.hints.keys()].filter(key => worse.away.includes(key) || worse.links.includes(offer.promised.get(key)?.link ?? ''));
      if (pruned.length > 0) { refuse(pruned, all, 'the prediction from the moves of stage 7f gives it more bends than the baseline'); continue; }
    }
    let trial: LayoutModel, routedTrial: LayoutModel;
    try {
      trial = await timed('bands-trial', () => step('bands', () => bands(trial7e, () => trialAbort('bands')), true));
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
    if (!verdict.kept) { refuse(offer.hints.keys(), all, verdict.reason); break; }
    // Kept: the trial is the baseline now. The notes name what the net count accepted.
    keptNotes.push(...trialNotes(routedBase, routedTrial, verdict, hintedLinks.keys()));
    base = trial; kept7e = trial7e; hints = all; laneKeys = allLanes; routedFinal = routedTrial;
    for (const [key, item] of offer.promised) promised.set(key, item);
    break; // one trial reaches 7f per command
  }
  for (const [key, item] of promised) {
    const side = hints.get(key);
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
    if (now < STRAIGHT_PATH_CLEARANCE.path - 1e-6 && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Stage 7f moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  const published = routedFinal ?? routedBase ?? await routeModel(model);
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
