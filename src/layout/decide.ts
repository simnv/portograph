import type { Diagnostic, LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { parallelClearance, portOrder } from '../score/gates.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import type { Segment } from '../score/model.js';
import { columnShifts, holdColumnAxes, holdMemberWalls, packBesideRows } from './columns.js';
import { blockedChords } from './frame-paths.js';
import { lanesHoldTheirChild, rebuildLaneExtents, type LaneFollow } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { saveGroups } from './overlay-order.js';
import { moveGroup } from './skeleton-geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { tierGapPlans } from './gap-plan.js';
import { centreViolations } from './centre.js';
import { reserveLinkLabelRoom, type LinkLabelShortfall } from './bands.js';
import { attemptCounters } from './attempt-counters.js';
import { judges, compare, gains, holds as readingHolds, lazyCount, lostStraight, profiles, read, reading, refusal, tapVerdict, widthWithin, type Reading } from './objective.js';

/**
 * The decision loop of stage 7f (architecture ticket 13, phase 3). Three kinds of optional discrete choice are made here, and nowhere else:
 *
 * | kind | candidates | judge today (`judges`, objective.ts) | derived |
 * | --- | --- | --- | --- |
 * | `chord-clear` | the x a group, a frame or a node may take, nearest first (`choose`) | cheap: `settled`; then `settled` or `settledRanked` on a settled copy | once, on a settled copy (`follow`) |
 * | `linkless` | the one x a group with no link steps to (`chooseStep`) | `keepSet` | in place, the replay follows |
 * | `lane-reseat` | all corridors that follow their child, as one (`chooseReseat`) | `laneReseat` | once, on a copy that has the grid and the labels replayed |
 *
 * Every judge of the table is read from `judges` in objective.ts; phase 4 switches that table to the `unified` profile in that one place. The generators (which x
 * a mover may try, the walls and the budgets) stay with the callers: `stepOverChords`, `stepOutOfChords`, `reseatLanes`.
 */

/** The three kinds of choice. */
export type CandidateKind = 'chord-clear' | 'linkless' | 'lane-reseat';

/** How many candidate x a group or a node tries, nearest first, before it stays (ticket 77). */
const CHORD_TRIALS = 24;

/** How many candidates that pass the cheap checks are judged on a settled copy, nearest first: each one costs a round of the pipeline (ticket 110). */
const SETTLED_TRIALS = 6;

/** The most a slide may grow a canton (and the canvas) beyond its wall, and the share of the canvas width all slides together may add (ticket 80). */
export const SLIDE_GROWTH = 40, CANVAS_GROWTH_SHARE = 0.05;
/**
 * The share of the canvas that the growth of all moves together may take, for a lower rank (ticket 146): at least one move's worth, SLIDE_GROWTH. A
 * canvas of a few hundred pixels would otherwise allow less than one move (5 % of 277 px is 14 px), and a small sheet could never step a rank.
 */
export const rankShare = (budget: { base: number }): number => Math.max(SLIDE_GROWTH, CANVAS_GROWTH_SHARE * budget.base);

/** The growth the slides of a model have spent, against the canvas width when the first slide was asked. */
export const spent = new WeakMap<LayoutModel, { base: number; grown: number }>();

export { overlayCrossingPairs as overlayCrossings } from './read/crossings.js';

/** A move of a lower rank, as the choice reads it (ticket 146). */
export interface RankMove { dx: number; crossings: number; straight: number; /** The straight overlay links the move bends: 0 when absent. */ bent?: number }

/**
 * The move of a lower rank that stays (ticket 146, user decision): a move that adds an overlay crossing, or does not leave more
 * straight overlay links than `base`, is never taken. Of the rest the most straight links win (user decision, 2026-09-30: client
 * overlay links are direct lines; `straight` is the net count, so a move that bends one link and straightens three is taken), then, on
 * a tie in that count, the move that bends no straight link (a crossing gain alone never pays for a bent link), then the fewest
 * crossings, then the nearest move, then the smaller dx.
 */
export function pickRankMove<T extends RankMove>(moves: readonly T[], base: { crossings: number; straight: number }): T | undefined {
  const by = profiles.rankMove;
  const against = reading({ overlay: { straight: base.straight, bent: 0, turns: 0 }, crossings: lazyCount(() => base.crossings), crossingMode: 'pairs' });
  const readMove = (move: T): Reading => reading({ overlay: { straight: move.straight, bent: move.bent ?? 0, turns: 0 }, crossings: lazyCount(() => move.crossings), crossingMode: 'pairs', tie: [Math.abs(move.dx), move.dx] });
  const pick = moves.map(move => ({ move, now: readMove(move) })).filter(({ now }) => refusal(now, against, by.gates) === undefined)
    .sort((a, b) => compare(a.now, b.now, by))[0]?.move;
  tapVerdict('pickRankMove', () => `${moves.length} ${base.crossings}/${base.straight} ${pick === undefined ? '-' : `${pick.dx} ${pick.straight} ${pick.crossings}`}`);
  return pick;
}

/** A reading of a model that has settled (what a move must not lose or add, read off the geometry as it stands), and the findings the gates and the tier-gap plan would make. */
interface Verdict extends Reading {
  crowded: Set<string>;
  disordered: Set<string>;
  residuals: Set<string>;
  /** The farthest a group moves when the column rules are asked of the settled model: 0 at their fixed point (ticket 67). */
  drift: number;
}

/** What a candidate leaves, and what the model had without it: the straight overlay count, the overlay crossings. */
interface Judged { bent: number; count: number; crossings: number; base: { crossings: number; straight: number }; verdict?: Verdict | undefined }

/** A copy of the model to try something on. Counted, so a test can read how much trying one attempt does. */
export const candidateCopy = (model: LayoutModel): LayoutModel => { attemptCounters.candidateCopies++; return JSON.parse(JSON.stringify(model)) as LayoutModel; };

const routedLinks = (model: LayoutModel): LayoutLink[] =>
  model.links.filter(link => link.layer === 'routed' && link.attachments && link.removed !== true && link.technique !== 'stub');

/**
 * What a move must not lose or add: the overlay links drawn as one segment, the routed links that run on one axis or hold a straight chord (a
 * drop that stays vertical stays straight), and the pairs of overlay links whose paths cross (ticket 146), counted on the first ask only.
 */
const readOverlays = (model: LayoutModel, overlays: readonly LayoutLink[]): Reading => read(model, { overlays, routed: { straight: 'aligned' }, crossings: 'pairs' });

/**
 * The pairs of routed links that stand closer than G6 allows, on the paths a placement model states. It is the gate's own predicate
 * (`parallelClearance`), asked of the links that already have a path: the rest are routed later and are no pair yet.
 */
function crowded(model: LayoutModel): Set<string> {
  const found = new Set<string>();
  const routed: Segment[] = routedLinks(model).filter(link => link.path !== undefined)
    .flatMap(link => link.path!.segments.map((segment, index) => ({ segment, link, index, stroke: linkStrokeWidth(link) })));
  parallelClearance(model, routed, (_gate, _code, elements) => { found.add([...elements].sort().join('|')); });
  return found;
}

/** The nodes whose ports stand out of the order of their far ends (G5), on the anchors a placement model states. */
function disordered(model: LayoutModel): Set<string> {
  const found = new Set<string>();
  portOrder(model, Object.values(model.nodes), new Set(routedLinks(model)), (_gate, code, elements) => { found.add(`${code}:${elements.join('|')}`); });
  return found;
}

/** The tier-gap parts the plan declines: the placement proxy for a routed crossing the router would have to make. */
const residuals = (model: LayoutModel): Set<string> => new Set(model.diagnostics
  .filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' || item.code === 'TIER_GAP_ROW_CYCLE')
  .map(item => `${item.code}:${JSON.stringify(item.owners ?? [])}`));

/**
 * The creep the rounds of 7f end under (`CANTON_CREEP` of the mutation step): a settled model that drifts less than this is at rest.
 * A slide is judged against the larger of this and the drift the model had before it, so a creep of a fraction of a pixel does not
 * turn the guard off.
 */
const REST = 0.5;

/**
 * How far the column rules move a group, asked of a copy of a settled model (ticket 67's fixed point: 0 when they move nothing). The
 * pipeline does not ask them again after 7f, so a slide they would undo is a position they do not accept. `Infinity` when they fail.
 */
function drift(model: LayoutModel): number {
  try {
    const clone = candidateCopy(model), before = new Map(Object.values(clone.groups).map(group => [group.id, { ...group.bounds! }]));
    columnShifts(clone, 0);
    packBesideRows(clone);
    holdMemberWalls(clone);
    holdColumnAxes(clone, 0);
    return Math.max(0, ...Object.values(clone.groups).map(group => {
      const was = before.get(group.id)!;
      return Math.max(Math.abs(group.bounds!.x - was.x), Math.abs(group.bounds!.y - was.y));
    }));
  } catch {
    return Infinity;
  }
}

/**
 * The settled copy that judged the last move the step kept (architecture ticket 13, phase 2): the copy of the model with every move so far made,
 * after `follow` ran on it. `baseDiagnostics` is how many diagnostics the model held when the copy was taken, and `original` the copy's own
 * diagnostic objects at that moment (a replay filters the list and appends to it, so what stands in the copy's list afterwards is told by identity); `result` is what `follow` returned.
 */
export interface AdoptedCopy { copy: LayoutModel; baseDiagnostics: number; original: ReadonlySet<Diagnostic>; result: unknown }

const verdict = (model: LayoutModel, overlays: readonly LayoutLink[]): Verdict =>
  ({ ...read(model, { overlays, routed: { straight: 'aligned' }, crossings: 'pairs', growth: true }), crowded: crowded(model), disordered: disordered(model), residuals: residuals(model), drift: drift(model) });

/** Whether every finding `after` states was stated by `before`. */
const nothingNew = (before: ReadonlySet<string>, after: ReadonlySet<string>): boolean => [...after].every(item => before.has(item));

/**
 * The growth a cell's frame edge may take when its bodies move (ticket 80): the frame stands off the outermost body, so the frame, the
 * canton derived from it and the canvas widen by what the edge moves out. Capped for one move and for all of them together.
 */
export function edge(model: LayoutModel): { base: number; grown: number } {
  const found = spent.get(model) ?? { base: model.canvas?.width ?? 0, grown: 0 };
  spent.set(model, found);
  return found;
}

/** The decision of the chord step for one call: the baseline it keeps, the settled copies it judged on, and the choice it makes (`choose`). */
export interface ChordDecision {
  /**
   * Try the candidates nearest first, and keep the one that leaves the most straight overlays on the settled copy (the nearest of
   * equals): the nearest move can clear one chord and leave a wider one, and a mover that has moved is not moved again. At most
   * SETTLED_TRIALS candidates are judged on a settled copy. `place(dx)` moves the mover by dx, `undo` takes it back. Returns whether one stayed.
   */
  choose(key: string, candidates: readonly number[], at: number, place: (dx: number) => void, undo: () => void, nodes: readonly string[],
    holds: (x: number) => boolean, extra?: () => boolean, rank?: string): boolean;
  /** Whether any trial ran: each one rebuilds labels a group at a time and so moves them to the end of the list. */
  tried(): boolean;
  /** What the last lower-rank move that stayed did, for the diagnostic; it is taken once. */
  takePicked(): { dx: number; crossings: number; straight: number; gain: number; after: number } | undefined;
  /** The settled copy that judged the last move that stayed: the step hands it back (`out.adopted`). */
  adopted(): AdoptedCopy | undefined;
}

export function chordDecision(model: LayoutModel, follow: ((probe: LayoutModel) => unknown) | undefined, overlays: readonly LayoutLink[], history: Set<string>): ChordDecision {
  /** What the last lower-rank move that stayed did: for the diagnostic. */
  let picked: { dx: number; crossings: number; straight: number; gain: number; after: number } | undefined;
  /** Takes one settled copy of a lower rank cell's budget; false when the budget is spent. */
  const spend = (cell: string): boolean => {
    // Held in `history`, so the budget lasts over the rounds and the runs of 7f that share it (Q114).
    let used = 0;
    while (history.has(`rank-spent:${cell}:${used}`)) used++;
    if (used >= SETTLED_TRIALS) return false;
    history.add(`rank-spent:${cell}:${used}`);
    return true;
  };
  let tried = false;
  /** The verdict on the settled copy of the model as it stands, without a move. It holds until a move stays. */
  let baseline: Verdict | undefined;
  /** The settled copy each verdict was read on, and the verdict of the last move that stayed: the step hands that copy back (`out.adopted`). */
  const copies = new WeakMap<Verdict, AdoptedCopy>();
  let lastKept: Verdict | undefined;

  /** The verdict on a settled copy of the model as it stands now, or `undefined` when the copy cannot be settled. */
  const settled = (): Verdict | undefined => {
    try {
      const probe = candidateCopy(model), baseDiagnostics = model.diagnostics.length, original = new Set(probe.diagnostics);
      attemptCounters.settledTrials++;
      const result = follow!(probe);
      const read = verdict(probe, overlays);
      copies.set(read, { copy: probe, baseDiagnostics, original, result });
      return read;
    } catch {
      return undefined;
    }
  };
  /**
   * The straight overlay count of the settled copy of the model with the move made, when it stands better than the settled copy
   * without the move; `undefined` when it does not. Without a `follow` there is no settled copy, and the count is the caller's own.
   */
  const holdsSettled = (redo: () => void, undo: () => void, nodes: readonly string[], fallback: Judged, ranked: boolean): Judged | undefined => {
    if (follow === undefined) return fallback;
    const after = settled();
    if (baseline === undefined) {
      undo();
      rebuildNodeGeometry(model, nodes, 'current');
      baseline = settled();
      redo();
      rebuildNodeGeometry(model, nodes, 'current');
    }
    // The straight count rises; a lower rank adds no crossing (ticket 146, user decision); no straight routed link is lost. A bent straight link is no veto: the net straight count decides.
    const settledHolds = after !== undefined && baseline !== undefined && gains(after, baseline, ranked ? judges.rankSettled : judges.chordSettled)
      && after.drift <= Math.max(baseline.drift, REST) + PLACEMENT_EPS
      && widthWithin(after, baseline, edge(model).base + (ranked ? rankShare(edge(model)) : CANVAS_GROWTH_SHARE * edge(model).base))
      && nothingNew(baseline.crowded, after.crowded) && nothingNew(baseline.disordered, after.disordered) && nothingNew(baseline.residuals, after.residuals);
    tapVerdict('holdsSettled', () => `${settledHolds} ${after?.overlay.straight}/${baseline?.overlay.straight} ${after?.growth.width}/${baseline?.growth.width}`);
    return settledHolds
      ? { bent: lostStraight(after!, baseline!, 'overlay'), count: after!.overlay.straight, crossings: ranked ? after!.crossings() : 0, base: { crossings: ranked ? baseline!.crossings() : 0, straight: baseline!.overlay.straight }, verdict: after } : undefined;
  };
  const groupOfNodes = (nodes: readonly string[]): LayoutGroup[] => [...new Set(nodes.map(id => model.groups[model.document.nodes[id]!.group]!))];
  const saveGroupsOf = (nodes: readonly string[]): (() => void) => saveGroups(model, groupOfNodes(nodes));

  /**
   * Try the candidates nearest first, and keep the one that leaves the most straight overlays on the settled copy (the nearest of
   * equals): the nearest move can clear one chord and leave a wider one, and a mover that has moved is not moved again. At most
   * SETTLED_TRIALS candidates are judged on a settled copy. `place(dx)` moves the mover by dx, `undo` takes it back. Returns whether one stayed.
   * A frozen chord a candidate would put a body on is a wall (`holds` for a group, the check below for a node).
   */
  const attempt = (key: string, candidates: readonly number[], at: number, place: (dx: number) => void, undo: () => void, nodes: readonly string[],
    holds: (x: number) => boolean, extra: () => boolean = () => true, rank?: string): boolean => {
    const before = readOverlays(model, overlays), blocked = new Set(blockedChords(model));
    let best: { target: number; count: number; verdict?: Verdict | undefined } | undefined, settledTrials = 0, driftBefore: number | undefined;
    // A lower rank (ticket 146) keeps every candidate that passes, and `pickRankMove` chooses: the most straight links, then the fewest crossings.
    const passed: (RankMove & { target: number; base: { crossings: number; straight: number }; verdict?: Verdict | undefined })[] = [];
    for (const target of candidates.slice(0, CHORD_TRIALS)) {
      if (!holds(target)) continue;
      tried = true;
      place(target - at);
      rebuildNodeGeometry(model, nodes, 'current');
      const after = readOverlays(model, overlays);
      let ok = extra() && gains(after, before, judges.chordCheap) && blockedChords(model).every(id => blocked.has(id));
      attemptCounters.cheapTrials++;
      tapVerdict('attemptCheap', () => `${ok} ${after.overlay.straight}/${before.overlay.straight}`);
      // Cheap refusals of a lower rank, before a settled copy is paid for (ticket 146): a crossing added, a drift the column rules would undo.
      if (ok && rank !== undefined) {
        ok = readingHolds(after, before, judges.rankCheap);
        tapVerdict('attemptCrossings', () => `${ok}`);
        if (ok && follow !== undefined) {
          if (driftBefore === undefined) {
            const redo = saveGroupsOf(nodes);
            undo();
            rebuildNodeGeometry(model, nodes, 'current');
            driftBefore = drift(model);
            redo();
            rebuildNodeGeometry(model, nodes, 'current');
          }
          ok = drift(model) <= Math.max(driftBefore, REST) + PLACEMENT_EPS;
        }
      }
      if (ok && (rank === undefined ? settledTrials++ < SETTLED_TRIALS : spend(rank))) {
        const judged = holdsSettled(saveGroupsOf(nodes), undo, nodes, { bent: 0, count: after.overlay.straight, crossings: rank !== undefined ? after.crossings() : 0,
          base: { crossings: rank !== undefined ? before.crossings() : 0, straight: before.overlay.straight } }, rank !== undefined);
        if (judged !== undefined && rank !== undefined) passed.push({ target, dx: target - at, crossings: judged.crossings, straight: judged.count, bent: judged.bent, base: judged.base, verdict: judged.verdict });
        else if (judged !== undefined && (best === undefined || judged.count > best.count)) best = { target, count: judged.count, verdict: judged.verdict };
      }
      undo();
      rebuildNodeGeometry(model, nodes, 'current');
    }
    if (rank !== undefined && passed.length) {
      const pick = pickRankMove(passed, passed[0]!.base);
      if (pick !== undefined) { best = { target: pick.target, count: pick.straight, verdict: pick.verdict }; picked = { dx: pick.dx, ...pick.base, gain: pick.straight - pick.base.straight, after: pick.crossings }; }
    }
    if (best === undefined) return false;
    place(best.target - at);
    rebuildNodeGeometry(model, nodes, 'current');
    // The settled copy that judged the move is the state that stands now: it is the baseline of the next one.
    baseline = best.verdict;
    lastKept = best.verdict;
    history.add(key);
    return true;
  };
  return {
    choose: attempt,
    tried: () => tried,
    takePicked: () => { const found = picked; picked = undefined; return found; },
    adopted: () => (lastKept === undefined ? undefined : copies.get(lastKept)),
  };
}

/** The tier gaps whose plan asks for more height than they have. 7f has already reserved the room every gap asks for. */
export function shortGaps(model: LayoutModel): string[] {
  // A gap is short where the plan asks for more height than the gap has. A residual part is the router's and is planned no seat.
  return tierGapPlans(model).filter(({ plan }) => plan.growth > PLACEMENT_EPS).map(({ gap }) => `gap:${gap.above}:${gap.below}`);
}

/**
 * The linkless candidate: the group with no link steps by `dx`, and the step stays when the straight overlay links it began with still stand
 * (`judges.linkless`). The move is made in place; the replay of the round follows it. Returns whether the step stayed; the caller names a refusal.
 */
export function chooseStep(model: LayoutModel, overlays: readonly LayoutLink[], group: LayoutGroup, dx: number): boolean {
  const straight = (): Reading => read(model, { overlays });
  const before = straight(), undo = saveGroups(model, [group]);
  moveGroup(model, group, dx, 0);
  rebuildNodeGeometry(model, group.nodes, 'current');
  const after = straight();
  const bent = !readingHolds(after, before, judges.linkless);
  tapVerdict('stepOutOfChords', () => `${bent} ${before.overlay.straight}/${after.overlay.straight}`);
  if (bent) {
    undo();
    rebuildNodeGeometry(model, group.nodes, 'current');
  }
  return !bent;
}

/**
 * The lane-reseat candidate: the corridors that follow their child (`reseatLanes` has moved them on `draft`, and `heldLanes` is where they stood). The
 * candidate is derived once, on a copy that has the grid and the labels replayed (`settle`), and is judged there against the incumbent with its lanes
 * held. The settled copy is the state that stands when it is adopted: nothing is derived twice. Returns whether the draft took it.
 *
 * The four things the move can spoil: an alignment 7c could not reach (centring), a gap that cannot seat the new row (short gaps), a link label that
 * loses the room a run had reserved (room), and a corridor that no longer stands at the child it follows; and a body on a frozen chord. All are
 * measured on the settled model, as sets where a trade of one item for another is not "no worse".
 */
export function chooseReseat(draft: LayoutModel, heldLanes: LayoutModel['lanes'], followed: LaneFollow[], settle: (copy: LayoutModel) => void): boolean {
  const settled = candidateCopy(draft);
  settle(settled);
  const afterRoom: LinkLabelShortfall[] = [], heldRoom: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(candidateCopy(settled), afterRoom);
  const after = reading({ sets: { centring: new Set(centreViolations(settled)), gaps: new Set(shortGaps(settled)), room: new Set(afterRoom.map(item => item.link)) },
    facts: { lanesHold: lanesHoldTheirChild(settled, followed), chordsClear: blockedChords(settled).length === 0 } });
  draft.lanes = heldLanes; rebuildLaneExtents(draft);
  reserveLinkLabelRoom(candidateCopy(draft), heldRoom);
  const held = reading({ sets: { centring: new Set(centreViolations(draft)), gaps: new Set(shortGaps(draft)), room: new Set(heldRoom.map(item => item.link)) } });
  if (!readingHolds(after, held, judges.laneReseat)) return false;
  // Adopt the trial whole: `draft` is the object this transaction validates and returns, so it takes the settled state rather than repeating the two producers on itself.
  Object.assign(draft, settled);
  return true;
}
