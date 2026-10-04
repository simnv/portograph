import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { EPS } from '../score/geometry.js';
import { parallelClearance, portOrder } from '../score/gates.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import type { Segment } from '../score/model.js';
import { columnShifts, frameColumns, holdColumnAxes, holdMemberWalls, overlayFreeGroups, packBesideRows } from './columns.js';
import { groupShape } from './grid.js';
import { cellReach, deriveFrames } from './frames.js';
import { blockedChords, chordsHold, isRoutedChord } from './frame-paths.js';
import { optionalMoveHolds, occupiedOverhang, selectAnchorTier } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { saveGroups } from './overlay-order.js';
import { overlayBlockers, overlayPath, straightChord } from './overlay-paths.js';
import { GROUP_PADDING, groupInsets } from './regions.js';
import { findPort } from './row-paths.js';
import { rowGap } from './sides-two.js';
import { moveGroup } from './skeleton-geometry.js';
import { bandGap } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { attemptCounters } from './attempt-counters.js';
import { nodeTier } from './read/tier.js';
import { isOneSegment } from './read/overlay-straight.js';
import { overlayCrossingPairs } from './read/crossings.js';
import { standsInRootCanton } from './read/canton.js';

/** How many candidate x a group or a node tries, nearest first, before it stays (ticket 77). */
const CHORD_TRIALS = 24;

/** How many candidates that pass the cheap checks are judged on a settled copy, nearest first: each one costs a round of the pipeline (ticket 110). */
const SETTLED_TRIALS = 6;

/** The most a slide may grow a canton (and the canvas) beyond its wall, and the share of the canvas width all slides together may add (ticket 80). */
const SLIDE_GROWTH = 40, CANVAS_GROWTH_SHARE = 0.05;
/**
 * The share of the canvas that the growth of all moves together may take, for a lower rank (ticket 146): at least one move's worth, SLIDE_GROWTH. A
 * canvas of a few hundred pixels would otherwise allow less than one move (5 % of 277 px is 14 px), and a small sheet could never step a rank.
 */
const rankShare = (budget: { base: number }): number => Math.max(SLIDE_GROWTH, CANVAS_GROWTH_SHARE * budget.base);

/** The growth the slides of a model have spent, against the canvas width when the first slide was asked. */
export const spent = new WeakMap<LayoutModel, { base: number; grown: number }>();

/** What a move must not lose or add, read off the geometry as it stands. */
interface Reading {
  /** The overlay links drawn as one segment. */
  overlay: Set<string>;
  /** The routed links that run on one axis, or hold a straight chord: a drop that stays vertical stays straight. */
  routed: Set<string>;
  /** The pairs of overlay links whose paths cross (ticket 146): counted on the first ask only, and once. */
  crossings: () => number;
}

export { overlayCrossingPairs as overlayCrossings };

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
  return moves.filter(move => move.crossings <= base.crossings && move.straight > base.straight)
    .sort((a, b) => b.straight - a.straight || (a.bent ?? 0) - (b.bent ?? 0) || a.crossings - b.crossings || Math.abs(a.dx) - Math.abs(b.dx) || a.dx - b.dx)[0];
}

/** A reading of a model that has settled: the two above, and the findings the gates and the tier-gap plan would make. */
interface Verdict extends Reading {
  crowded: Set<string>;
  disordered: Set<string>;
  residuals: Set<string>;
  /** The farthest a group moves when the column rules are asked of the settled model: 0 at their fixed point (ticket 67). */
  drift: number;
  /** The canvas width of the settled model. */
  width: number;
}

/** What a candidate leaves, and what the model had without it: the straight overlay count, the overlay crossings. */
interface Judged { bent: number; count: number; crossings: number; base: { crossings: number; straight: number }; verdict?: Verdict | undefined }

const copy = (model: LayoutModel): LayoutModel => { attemptCounters.candidateCopies++; return JSON.parse(JSON.stringify(model)) as LayoutModel; };

const routedLinks = (model: LayoutModel): LayoutLink[] =>
  model.links.filter(link => link.layer === 'routed' && link.attachments && link.removed !== true && link.technique !== 'stub');

function read(model: LayoutModel, overlays: readonly LayoutLink[]): Reading {
  const blockers = overlayBlockers(model);
  const paths = overlays.map(link => ({ id: link.id, segments: overlayPath(model, link, blockers).segments }));
  const overlay = new Set(paths.filter(path => isOneSegment(path.segments)).map(path => path.id));
  let counted: number | undefined;
  const crossings = (): number => (counted ??= overlayCrossingPairs(paths.map(path => path.segments)));
  const routed = new Set(routedLinks(model).filter(link => {
    if (isRoutedChord(model, link)) return true;
    const from = findPort(model, link.attachments!.from)?.anchor, to = findPort(model, link.attachments!.to)?.anchor;
    return from !== undefined && to !== undefined && (Math.abs(from.x - to.x) <= 0.5 || Math.abs(from.y - to.y) <= 0.5);
  }).map(link => link.id));
  return { overlay, routed, crossings };
}

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
    const clone = copy(model), before = new Map(Object.values(clone.groups).map(group => [group.id, { ...group.bounds! }]));
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

const verdict = (model: LayoutModel, overlays: readonly LayoutLink[]): Verdict =>
  ({ ...read(model, overlays), crowded: crowded(model), disordered: disordered(model), residuals: residuals(model), drift: drift(model), width: model.canvas?.width ?? 0 });

/** Whether every finding `after` states was stated by `before`. */
const nothingNew = (before: ReadonlySet<string>, after: ReadonlySet<string>): boolean => [...after].every(item => before.has(item));

/**
 * A straight overlay chord between two tiers is a reservation for the tiers between them (ticket 77, Q64). Run in 7f, after the
 * growth and the close-up have settled the columns. A group or a node on a tier strictly between the two ends of a chord that stands
 * on it moves along its tier to the nearest x that clears the chord; the chords that count are the ones straight without the mover.
 *
 * A group moves whole, inside its tier: it keeps the band gap to the groups, columns and lanes, stays inside its canton (less the group
 * margin) when it is a member of one, and stays inside the box of the whole layout, so the canvas does not widen. A group with a routed
 * link keeps its place in the order of its tier, so the move creates no crossing among the links it holds. A node moves inside the
 * box of its group, in the row it stands in, keeping the row gap to its neighbours.
 *
 * A candidate is kept only when both of these hold:
 * - on the geometry after the move, `laneSidesHold` (a lane keeps its side, a frozen chord stays clear of every body), and the
 *   straight overlay count rises (a move that bends one link and straightens two is a trade that counts);
 * - on a copy of the model that `follow` has run, which is what the pipeline does next (the replays of the regions, the grid and
 *   the labels, then a round of the growth and the close-up), against the copy of the model without the move: the straight overlay
 *   count still rises, no routed link that ran on one axis or held a chord stops doing so, and no pair of routed links (G6), no
 *   port out of the order of its far ends (G5) and no tier-gap part the plan declines appears that was not there before.
 * A frame of several cells (ticket 80) is the column pass's unit: it slides whole, every cell by the same dx, inside the slack its column
 * states (`frameColumns`), inside the box of the layout, between the plain groups and the lanes of its sub-tiers, and a node of one of its
 * cells moves alone inside the cell box when the frame edge (`cellReach`) stays as it is. The same acceptance judges both, on the settled
 * copy, so a slide the column pass would undo is never kept. A frame of a canton stays.
 * Otherwise the mover goes back and the next candidate is tried. A mover that has moved in an earlier round (`history`) is left
 * where it stands, so the rounds converge. Returns whether anything stayed moved.
 * The step never reads the clock (ticket 141): its work is bounded by counts (CHORD_TRIALS, SETTLED_TRIALS, one move per mover, CANTON_ROUNDS rounds).
 */
export function stepOverChords(model: LayoutModel, follow: ((probe: LayoutModel) => unknown) | undefined, history: Set<string> = new Set()): boolean {
  const anchor = selectAnchorTier(model);
  // A member of a mesh bus is not a chord: it is neither straight nor bent, and the step does not read it (mesh-bus.md, section 4).
  const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);
  if (anchor === undefined || !overlays.length) return false;
  const columns = frameColumns(model), movable = overlayFreeGroups(model, anchor, true), free = overlayFreeGroups(model, anchor);
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
  const tierOf = (node: string): number => nodeTier(model, node);
  const linked = new Set<string>();
  for (const link of model.links) if (link.attachments) for (const end of [link.attachments.from.node, link.attachments.to.node]) linked.add(model.document.nodes[end]!.group);
  const gap = bandGap(model);
  const all = Object.values(model.groups).filter(group => group.bounds);
  const world = { low: Math.min(...all.map(group => group.bounds!.x)), high: Math.max(...all.map(group => group.bounds!.x + group.bounds!.width)) };
  const tiers = [...new Set(all.map(group => group.tier!))].sort((a, b) => a - b);
  /** Whether any trial ran: each one rebuilds labels a group at a time and so moves them to the end of the list. */
  let tried = false, moved = false;
  /** The verdict on the settled copy of the model as it stands, without a move. It holds until a move stays. */
  let baseline: Verdict | undefined;

  /** The verdict on a settled copy of the model as it stands now, or `undefined` when the copy cannot be settled. */
  const settled = (): Verdict | undefined => {
    try {
      const probe = copy(model);
      follow!(probe);
      return verdict(probe, overlays);
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
    return after !== undefined && baseline !== undefined && after.overlay.size > baseline.overlay.size
      // A lower rank adds no crossing (ticket 146, user decision). A bent straight link is no veto: the net straight count above decides.
      && (!ranked || after.crossings() <= baseline.crossings())
      && [...baseline.routed].every(id => after.routed.has(id))
      && after.drift <= Math.max(baseline.drift, REST) + PLACEMENT_EPS
      && after.width <= Math.max(baseline.width, edge().base + (ranked ? rankShare(edge()) : CANVAS_GROWTH_SHARE * edge().base)) + PLACEMENT_EPS
      && nothingNew(baseline.crowded, after.crowded) && nothingNew(baseline.disordered, after.disordered) && nothingNew(baseline.residuals, after.residuals)
      ? { bent: [...baseline.overlay].filter(id => !after.overlay.has(id)).length, count: after.overlay.size, crossings: ranked ? after.crossings() : 0, base: { crossings: ranked ? baseline.crossings() : 0, straight: baseline.overlay.size }, verdict: after } : undefined;
  };

  /** The moves `dx` of a set of shapes that put one of them on a chord: open intervals. */
  const bannedFor = (chords: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[], shapes: readonly Rect[]): { low: number; high: number }[] =>
    chords.flatMap(({ from, to }) => shapes.flatMap(shape => {
      const top = shape.y + EPS, floor = shape.y + shape.height - EPS, dy = to.y - from.y;
      let t0 = 0, t1 = 1;
      if (Math.abs(dy) <= EPS) { if (from.y <= top || from.y >= floor) return []; }
      else {
        const a = (top - from.y) / dy, b = (floor - from.y) / dy;
        t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(1, Math.max(a, b));
        if (t1 - t0 <= 0) return [];
      }
      const xs = [from.x + (to.x - from.x) * t0, from.x + (to.x - from.x) * t1];
      return [{ low: Math.min(...xs) - shape.x - shape.width, high: Math.max(...xs) - shape.x }];
    }));
  const shapesOf = (ids: readonly string[]): Rect[] => ids.flatMap(id => {
    const node = model.nodes[id]!;
    return [node.bounds!, ...node.ports.flatMap(port => port.pill && port.ref.anonymous !== true ? [port.pill.bounds] : [])];
  });
  /** The chords that pass over `tier` and are straight without `skip`: the reservations a mover must not stand on. */
  const chordsOver = (tier: number, skip: ReadonlySet<string>): { from: { x: number; y: number }; to: { x: number; y: number } }[] => {
    const bare = overlayBlockers(model, skip);
    return overlays.flatMap(link => {
      const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
      if (!(Math.min(...ends) < tier && tier < Math.max(...ends))) return [];
      const chord = straightChord(model, link, bare);
      return chord ? [chord] : [];
    });
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
    const before = read(model, overlays), blocked = new Set(blockedChords(model));
    let best: { target: number; count: number; verdict?: Verdict | undefined } | undefined, settledTrials = 0, driftBefore: number | undefined;
    // A lower rank (ticket 146) keeps every candidate that passes, and `pickRankMove` chooses: the most straight links, then the fewest crossings.
    const passed: (RankMove & { target: number; base: { crossings: number; straight: number }; verdict?: Verdict | undefined })[] = [];
    for (const target of candidates.slice(0, CHORD_TRIALS)) {
      if (!holds(target)) continue;
      tried = true;
      place(target - at);
      rebuildNodeGeometry(model, nodes, 'current');
      const after = read(model, overlays);
      let ok = extra() && after.overlay.size > before.overlay.size && [...before.routed].every(id => after.routed.has(id)) && blockedChords(model).every(id => blocked.has(id));
      // Cheap refusals of a lower rank, before a settled copy is paid for (ticket 146): a crossing added, a drift the column rules would undo.
      if (ok && rank !== undefined) {
        ok = after.crossings() <= before.crossings();
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
        const judged = holdsSettled(saveGroupsOf(nodes), undo, nodes, { bent: 0, count: after.overlay.size, crossings: rank !== undefined ? after.crossings() : 0,
          base: { crossings: rank !== undefined ? before.crossings() : 0, straight: before.overlay.size } }, rank !== undefined);
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
    history.add(key);
    return true;
  };
  const nearest = (edges: readonly number[], at: number, ok: (x: number) => boolean): number[] => edges
    .filter((x, index, list) => ok(x) && Math.abs(x - at) > PLACEMENT_EPS && list.findIndex(other => Math.abs(other - x) <= PLACEMENT_EPS) === index)
    .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b);

  /**
   * The growth a cell's frame edge may take when its bodies move (ticket 80): the frame stands off the outermost body, so the frame, the
   * canton derived from it and the canvas widen by what the edge moves out. Capped for one move and for all of them together.
   */
  const edge = (): { base: number; grown: number } => {
    const found = spent.get(model) ?? { base: model.canvas?.width ?? 0, grown: 0 };
    spent.set(model, found);
    return found;
  };
  const outward = (before: Rect, now: Rect): number => Math.max(0, before.x - now.x) + Math.max(0, now.x + now.width - (before.x + before.width));
  /** Whether a cell stands in a frame of a canton: only there may its frame edge move out (the decision covers member frames and cantons). */
  const mayGrow = (group: LayoutGroup, before: Rect, now: Rect): boolean => {
    const budget = edge(), by = outward(before, now);
    if (!standsInRootCanton(model, group)) return Math.abs(now.x - before.x) <= PLACEMENT_EPS && Math.abs(now.width - before.width) <= PLACEMENT_EPS;
    return by <= Math.min(SLIDE_GROWTH, CANVAS_GROWTH_SHARE * budget.base - budget.grown) + PLACEMENT_EPS;
  };
  // A frame of several cells slides whole inside its column slack (ticket 80): every cell takes the same dx, so the frame box, the
  // cell boxes and the rows stay as they are, and the column pass has nothing of its own to redo. The frame keeps its place among
  // the groups of its sub-tiers (the run between its neighbours' walls), inside the slack its column states, inside the box of the
  // whole layout. A member frame of a canton slides inside the canton wall. A flank or a bar does not slide.
  const frames = model.document.frames ?? {};
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
  // The units: a top-level frame in its column, or a member frame of a canton inside the canton's wall (the member's cells only).
  const units = columns.flatMap(column => frames[column.id]?.kind === 'canton'
    ? Object.keys(frames).filter(id => frames[id]!.parent === column.id).map(id => ({ id, column, member: true }))
    : frames[column.id]?.parent === undefined ? [{ id: column.id, column, member: false }] : []);
  for (const { id, column, member } of units) {
    const key = `frame:${id}`;
    if (history.has(key)) continue;
    const ids = member ? cellsOf(id) : [...column.cells];
    const cells = ids.map(cell => model.groups[cell]!).filter(group => group.bounds && group.nodes.length > 0);
    if (cells.length < 2 || cells.length !== ids.length || cells.some(cell => movable.has(cell.id) || cell.flank || model.document.groups[cell.id]?.shape === 'bar')) continue;
    const span = { from: Math.min(...cells.map(cell => cell.tier!)), to: Math.max(...cells.map(cell => cell.tier!)) };
    const nodes = cells.flatMap(cell => cell.nodes), skip = new Set(nodes);
    const banned = cells.flatMap(cell => bannedFor(chordsOver(cell.tier!, skip), shapesOf(cell.nodes)));
    if (!banned.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) continue;
    const derived = deriveFrames(model), box = derived?.find(item => item.id === id)?.box;
    if (derived === undefined || box === undefined) continue;
    // The run of dx the frame may take: its column, the box of the layout, then the walls of the plain groups and the lanes of its sub-tiers.
    const reaches = cells.map(cell => ({ cell, reach: occupiedOverhang(model, cell) }));
    // A member of a canton stays inside the canton's wall, less the group margin, and 2 * GROUP_PADDING from the members that share a sub-tier.
    const wall = member ? column.wall : undefined;
    if (member && wall === undefined) continue;
    const roomLow = wall === undefined ? column.x : wall.x + GROUP_PADDING, roomHigh = wall === undefined ? column.x + column.width : wall.x + wall.width - GROUP_PADDING;
    // A slide of a canton member may pass the wall: the canton is derived from its members and grows with it, and the close-up packs its
    // neighbours again. The growth is capped for one slide and for all of them together.
    const budget = edge();
    const grow = member ? Math.max(0, Math.min(SLIDE_GROWTH, CANVAS_GROWTH_SHARE * budget.base - budget.grown)) : 0;
    let low = Math.max(roomLow - grow - box.x, world.low - grow - Math.min(...reaches.map(({ cell, reach }) => cell.bounds!.x - reach.left)));
    let high = Math.min(roomHigh + grow - box.x - box.width, world.high + grow - Math.max(...reaches.map(({ cell, reach }) => cell.bounds!.x + cell.bounds!.width + reach.right)));
    const walls: { low: number; high: number }[] = [];
    for (const item of all) {
      if (item.frame !== undefined || item.tier! < span.from || item.tier! > span.to) continue;
      const one = occupiedOverhang(model, item);
      walls.push({ low: item.bounds!.x - one.left - gap - (box.x + box.width), high: item.bounds!.x + item.bounds!.width + one.right + gap - box.x });
    }
    for (const lane of model.lanes) {
      if (lane.tier < span.from || lane.tier > span.to || (lane.bounds.x < box.x + box.width && lane.bounds.x + lane.bounds.width > box.x)) continue;
      walls.push({ low: lane.bounds.x - (box.x + box.width), high: lane.bounds.x + lane.bounds.width - box.x });
    }
    if (member) {
      const mine = new Set(cells.map(cell => cell.tier));
      for (const other of derived) {
        if (other.id === id || frames[other.id]!.parent !== column.id || !cellsOf(other.id).some(cell => mine.has(model.groups[cell]!.tier))) continue;
        walls.push({ low: other.box.x - 2 * GROUP_PADDING - (box.x + box.width), high: other.box.x + other.box.width + 2 * GROUP_PADDING - box.x });
      }
    }
    // A wall that already holds the frame's place pins it; a frame keeps its place in the order of the tiers it spans.
    if (walls.some(wall => wall.low < -PLACEMENT_EPS && wall.high > PLACEMENT_EPS)) continue;
    low = Math.max(low, ...walls.filter(wall => wall.high <= PLACEMENT_EPS).map(wall => wall.high));
    high = Math.min(high, ...walls.filter(wall => wall.low >= -PLACEMENT_EPS).map(wall => wall.low));
    const candidates = nearest(banned.flatMap(({ low: from, high: to }) => [from, to]), 0, dx => dx >= low - PLACEMENT_EPS && dx <= high + PLACEMENT_EPS);
    if (!candidates.length) continue;
    const undo = saveGroups(model, cells);
    let refusal: { group: LayoutGroup; bounds: Rect }[] | undefined;
    const at = cells[0]!.bounds!.x;
    const placed = attempt(key, candidates, 0, dx => { for (const cell of cells) moveGroup(model, cell, dx, 0); }, undo, nodes, dx => {
      const proposed = cells.map(group => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }));
      if (optionalMoveHolds(model, proposed, false)) return true;
      if (refusal === undefined && !chordsHold(model, proposed, false)) refusal = proposed;
      return false;
    });
    if (placed) {
      moved = true;
      const dx = cells[0]!.bounds!.x - at;
      budget.grown += Math.max(0, roomLow - (box.x + dx), box.x + dx + box.width - roomHigh);
    } else if (refusal !== undefined) chordsHold(model, refusal, true);
  }

  /** A cell of a frame that the whole-group step leaves to the column pass: its nodes move alone, inside the cell's slack (ticket 80). */
  const cellOfFrame = (group: LayoutGroup): boolean => group.frame !== undefined && !movable.has(group.id) && !group.flank
    && model.document.groups[group.id]?.shape !== 'bar' && !frames[group.frame]?.kind?.startsWith('canton');
  /** A lower rank cell (ticket 146): a rank cell that is not the first of its frame, in rank order. */
  const lowerRank = (group: LayoutGroup): boolean => group.frame !== undefined && cellOfFrame(group) && frames[group.frame]!.cells.indexOf(group.id) > 0;
  const same = (a: Rect | undefined, b: Rect | undefined): boolean => a !== undefined && b !== undefined && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k as keyof Rect] - b[k as keyof Rect]) <= PLACEMENT_EPS);
  /**
   * What a move of a lower rank cell may do to its frames (ticket 146), read on the frames as they stand before the move. Outside a canton every
   * frame box stays. In a canton the top frame (the canton) may grow by the budget of ticket 80, and the member frame that holds the cell keeps its
   * wall: 2 * GROUP_PADDING from the member frames of its sub-tiers, the band gap from the plain groups, and the lanes.
   */
  const rankFrames = (group: LayoutGroup) => {
    const chain: string[] = [];
    for (let at: string | undefined = group.frame; at !== undefined; at = frames[at]!.parent) chain.push(at);
    const root = chain[chain.length - 1]!, canton = frames[root]!.kind === 'canton', unit = canton && chain.length > 1 ? chain[chain.length - 2]! : undefined;
    const boxes = (): Map<string, Rect> => new Map((deriveFrames(model) ?? []).map(item => [item.id, item.box]));
    const before = boxes();
    const tiersOf = new Set(unit === undefined ? [] : cellsOf(unit).map(id => model.groups[id]!.tier!));
    const walls: { low: number; high: number }[] = [];
    if (unit !== undefined) {
      for (const [id, box] of before) if (id !== unit && frames[id]!.parent === root && cellsOf(id).some(cell => tiersOf.has(model.groups[cell]!.tier!))) walls.push({ low: box.x - 2 * GROUP_PADDING, high: box.x + box.width + 2 * GROUP_PADDING });
      for (const item of all) {
        if (item.frame !== undefined || !tiersOf.has(item.tier!)) continue;
        const one = occupiedOverhang(model, item);
        walls.push({ low: item.bounds!.x - one.left - gap, high: item.bounds!.x + item.bounds!.width + one.right + gap });
      }
      for (const lane of model.lanes) if (tiersOf.has(lane.tier)) walls.push({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width });
    }
    const grown = (now: Map<string, Rect>): number => outward(before.get(root)!, now.get(root)!);
    const hits = (box: Rect, wall: { low: number; high: number }): boolean => box.x < wall.high - PLACEMENT_EPS && box.x + box.width > wall.low + PLACEMENT_EPS;
    return {
      /** Whether the frames, as they stand now, are within what the move may do. */
      holds: (): boolean => {
        const now = boxes();
        if (!canton) return [...before].every(([id, box]) => same(box, now.get(id)));
        if (!before.has(root) || !now.has(root)) return false;
        const budget = edge();
        if (grown(now) > Math.min(SLIDE_GROWTH, rankShare(budget) - budget.grown) + PLACEMENT_EPS) return false;
        return unit === undefined || walls.every(wall => hits(before.get(unit)!, wall) || !hits(now.get(unit)!, wall));
      },
      /** What the canton grew by, for the budget. */
      grown: (): number => (canton ? grown(boxes()) : 0),
      /** The room a body may take: the x-extent of the bodies of the frame's other cells, child frames included, and what the budget allows past it. */
      room: (current: { low: number; high: number }): { low: number; high: number } => {
        const others = cellsOf(group.frame!).filter(id => id !== group.id).flatMap(id => model.groups[id]!.nodes.map(node => model.nodes[node]!.bounds!));
        const budget = edge(), more = canton ? Math.max(0, Math.min(SLIDE_GROWTH, rankShare(budget) - budget.grown)) : 0;
        // A cell of a child frame can stand on the same tier, beside this one: its bodies are walls, with the band gap.
        const beside = cellsOf(group.frame!).filter(id => id !== group.id && model.groups[id]!.tier === group.tier).flatMap(id => model.groups[id]!.nodes.map(node => model.nodes[node]!.bounds!));
        const middle = (current.low + current.high) / 2;
        const leftWall = Math.max(-Infinity, ...beside.filter(body => body.x + body.width / 2 < middle).map(body => body.x + body.width + gap));
        const rightWall = Math.min(Infinity, ...beside.filter(body => body.x + body.width / 2 >= middle).map(body => body.x - gap));
        return { low: Math.max(leftWall, Math.min(current.low, ...others.map(body => body.x)) - more), high: Math.min(rightWall, Math.max(current.high, ...others.map(body => body.x + body.width)) + more) };
      },
    };
  };
  /** Says that a lower rank moved. */
  const noteRank = (id: string): void => {
    if (picked === undefined) return;
    model.diagnostics.push({
      stage: 'placement', severity: 'info', code: 'RANK_STEPPED_OFF_CHORD', owners: [{ kind: 'group', id }],
      message: `The lower rank ${id} moved ${Math.round(picked.dx * 10) / 10} px off the overlay chords of the ranks above: ${picked.gain} more straight overlay links, overlay crossings ${picked.crossings} to ${picked.after}.`,
    });
    picked = undefined;
  };
  for (const tier of tiers) {
    const groups = all.filter(group => group.tier === tier);
    const over = overlays.some(link => {
      const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
      return Math.min(...ends) < tier && tier < Math.max(...ends);
    });
    if (!over) continue;
    for (const group of groups.filter(item => (movable.has(item.id) || cellOfFrame(item)) && linked.has(item.id))) {
      // Whole group.
      const box = { ...group.bounds! };
      const banned = bannedFor(chordsOver(tier, new Set(group.nodes)), shapesOf(group.nodes));
      const reach = occupiedOverhang(model, group);
      const routedGroup = !free.has(group.id);
      let placed = false;
      const lower = lowerRank(group), keep = lower ? `rank:${group.id}` : group.id;
      const stands = !history.has(keep) && banned.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS);
      const rankGuard = lower && stands ? rankFrames(group) : undefined;
      if (stands) {
        // The walls, as moves of the group: the run of x a move may not put the group's occupied extent into.
        const walls: { low: number; high: number }[] = [];
        // A cell of a frame is bound by its frames' boxes (`sameFrames`), which the canvas holds, not by the box of the groups.
        let inside = cellOfFrame(group) ? { low: -Infinity, high: Infinity } : { low: world.low + reach.left, high: world.high - box.width - reach.right };
        const cell = group.frame === undefined ? undefined : columns.find(column => column.cells.has(group.id));
        let skip = false;
        if (group.frame !== undefined && !cellOfFrame(group)) {
          const frames = model.document.frames!, derived = deriveFrames(model);
          const frame = derived?.find(item => item.id === group.frame);
          if (cell?.wall === undefined || frame === undefined) skip = true;
          else {
            // A member of a canton stands inside the canton, less the group margin, and 2 * GROUP_PADDING from the other frames of its sub-tier.
            const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
            const lead = box.x - frame.box.x, span = frame.box.width;
            inside = { low: Math.max(world.low, cell.wall.x + GROUP_PADDING + lead), high: Math.min(world.high - box.width, cell.wall.x + cell.wall.width - GROUP_PADDING - span + lead) };
            for (const other of derived!) {
              if (other.id === group.frame || frames[other.id]!.parent !== cell.id || !cellsOf(other.id).some(id => model.groups[id]!.tier === tier)) continue;
              walls.push({ low: other.box.x - 2 * GROUP_PADDING - span + lead, high: other.box.x + other.box.width + 2 * GROUP_PADDING + lead });
            }
            for (const lane of model.lanes.filter(item => item.tier === tier)) walls.push({ low: lane.bounds.x - span + lead, high: lane.bounds.x + lane.bounds.width + lead });
          }
        } else {
          const width = box.width + reach.left + reach.right;
          const wall = (low: number, high: number, space: number): void => { walls.push({ low: low - space - width + reach.left, high: high + space + reach.left }); };
          for (const item of groups) {
            if (item === group) continue;
            const one = occupiedOverhang(model, item);
            wall(item.bounds!.x - one.left, item.bounds!.x + item.bounds!.width + one.right, gap);
          }
          for (const column of columns.filter(item => item.from <= tier && tier <= item.to && !(cellOfFrame(group) && item.cells.has(group.id)))) wall(column.x, column.x + column.width, gap);
          for (const lane of model.lanes.filter(item => item.tier === tier)) wall(lane.bounds.x, lane.bounds.x + lane.bounds.width, 0);
        }
        if (!skip) {
          // A group that holds a routed link keeps its place in the order of its tier: the run between its neighbours' walls. A wall
          // that already holds the group's place is a wall on both sides, and the group stays.
          if (routedGroup) {
            if (walls.some(wall => wall.low < box.x - PLACEMENT_EPS && wall.high > box.x + PLACEMENT_EPS)) inside = { low: box.x, high: box.x };
            const below = walls.filter(wall => wall.high <= box.x + PLACEMENT_EPS).map(wall => wall.high);
            const above = walls.filter(wall => wall.low >= box.x - PLACEMENT_EPS).map(wall => wall.low);
            inside = { low: Math.max(inside.low, ...below), high: Math.min(inside.high, ...above) };
          }
          const feasible = (x: number): boolean => x >= inside.low - PLACEMENT_EPS && x <= inside.high + PLACEMENT_EPS
            && !walls.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS);
          // A lower rank asks the ends of the banned runs only, pushed out (ticket 146); the wall edges are no chord clearances.
          const candidates = lower ? nearest(banned.flatMap(({ low, high }) => [box.x + low - PLACEMENT_EPS, box.x + high + PLACEMENT_EPS]), box.x, feasible)
            : nearest([...banned.flatMap(({ low, high }) => [box.x + low, box.x + high]), ...walls.flatMap(({ low, high }) => [low, high])], box.x, feasible);
          const undo = saveGroups(model, [group]);
          // A cell of a frame slides alone (ticket 80) only where every frame box stays as it is: the cell goes to the room its frame has beside it.
          const boxesBefore = cellOfFrame(group) ? deriveFrames(model)?.map(item => item.box) : undefined;
          const sameFrames = (): boolean => {
            if (boxesBefore === undefined) return true;
            const now = deriveFrames(model)?.map(item => item.box);
            return now !== undefined && now.length === boxesBefore.length && now.every((one, i) => ['x', 'y', 'width', 'height'].every(k => Math.abs(one[k as keyof Rect] - boxesBefore[i]![k as keyof Rect]) <= PLACEMENT_EPS));
          };
          // The candidates ask without a report; a frozen chord is named once, for the nearest candidate it refused, when no candidate stays.
          let refusal: { group: LayoutGroup; bounds: Rect }[] | undefined;
          placed = attempt(keep, candidates, box.x, dx => moveGroup(model, group, dx, 0), undo, group.nodes, x => {
            const proposed = [{ group, bounds: { ...box, x } }];
            if (optionalMoveHolds(model, proposed, false)) return true;
            if (refusal === undefined && !chordsHold(model, proposed, false)) refusal = proposed;
            return false;
          }, () => rankGuard === undefined ? sameFrames() : rankGuard.holds(), lower ? group.id : undefined);
          if (placed && rankGuard !== undefined) { edge().grown += rankGuard.grown(); noteRank(group.id); }
          if (placed) moved = true;
          else if (refusal !== undefined) chordsHold(model, refusal, true);
        }
      }
      if (placed) continue;
      // A node inside its group: the row stays in its order, and the node stays inside the box the group has (its slack).
      if (groupShape(model, group.id) !== 'row') continue;
      const order = [...(group.rowOrder ?? group.nodes)].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x);
      const inset = groupInsets(model, group);
      // A cell of a frame: the whole row slides inside the cell box when its nodes cannot pass one another (ticket 80). The cell box and the frame stay.
      if (cellOfFrame(group) && order.length > 1 && !history.has(`row:${group.id}`)) {
        const ids = order, own = bannedFor(chordsOver(tier, new Set(ids)), shapesOf(ids));
        if (own.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) {
          const bodies = ids.map(id => model.nodes[id]!.bounds!);
          const room = { low: group.bounds!.x + inset.left - Math.min(...bodies.map(body => body.x)), high: group.bounds!.x + group.bounds!.width - inset.right - Math.max(...bodies.map(body => body.x + body.width)) };
          const candidates = nearest(own.flatMap(({ low, high }) => [low, high]), 0, dx => dx >= room.low - PLACEMENT_EPS && dx <= room.high + PLACEMENT_EPS);
          const before = cellReach(model, group.id);
          const undo = saveGroups(model, [group]);
          const slide = (dx: number): void => {
            for (const id of ids) {
              const node = model.nodes[id]!;
              node.bounds!.x += dx;
              for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
            }
          };
          const framed = (): boolean => mayGrow(group, before, cellReach(model, group.id));
          // The ticket-80 slide stays as it was for a lower rank too: it is not under the rank rule, since the rule would refuse moves main makes.
          if (candidates.length && attempt(`row:${group.id}`, candidates, 0, slide, undo, ids, () => true, framed)) {
            moved = true;
            edge().grown += outward(before, cellReach(model, group.id));
            continue;
          }
        }
      }
      const lowerCell = lowerRank(group);
      for (const [index, id] of order.entries()) {
        if (history.has(`node:${id}`)) continue;
        const node = model.nodes[id]!, body = { ...node.bounds! };
        const own = bannedFor(chordsOver(tier, new Set([id])), shapesOf([id]));
        if (!own.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) continue;
        // The room of a lower rank is the frame span, and what the budget allows past it (ticket 146): the row ends are not the cell box.
        const rankGuard = lowerCell ? rankFrames(group) : undefined;
        const room = rankGuard?.room({ low: group.bounds!.x + inset.left, high: group.bounds!.x + group.bounds!.width - inset.right });
        const lowest = index === 0 ? (room?.low ?? group.bounds!.x + inset.left) : model.nodes[order[index - 1]!]!.bounds!.x + model.nodes[order[index - 1]!]!.bounds!.width + rowGap(model, order[index - 1]!, id);
        const highest = index === order.length - 1 ? (room?.high ?? group.bounds!.x + group.bounds!.width - inset.right) - body.width
          : model.nodes[order[index + 1]!]!.bounds!.x - rowGap(model, id, order[index + 1]!) - body.width;
        if (highest - lowest < PLACEMENT_EPS) continue;
        const pad = lowerCell ? PLACEMENT_EPS : 0;
        const candidates = nearest(own.flatMap(({ low, high }) => [body.x + low - pad, body.x + high + pad]), body.x, x => x >= lowest - PLACEMENT_EPS && x <= highest + PLACEMENT_EPS);
        const undo = saveGroups(model, [group]);
        // The box of a lower rank cell hugs its bodies as it did before the move: it follows a node that leaves it.
        const bodies = group.nodes.map(node => model.nodes[node]!.bounds!);
        const left = Math.min(...bodies.map(item => item.x)) - group.bounds!.x, right = group.bounds!.x + group.bounds!.width - Math.max(...bodies.map(item => item.x + item.width));
        const shift = (dx: number): void => {
          node.bounds!.x += dx;
          for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
          if (!lowerCell) return;
          const now = group.nodes.map(other => model.nodes[other]!.bounds!), start = Math.min(...now.map(item => item.x)) - left;
          group.bounds = { ...group.bounds!, x: start, width: Math.max(...now.map(item => item.x + item.width)) + right - start };
        };
        // A frozen chord is a wall for a node as for a group: `attempt` refuses a candidate that puts a body on one.
        // A node of a cell moves only where the frame stays as it is: the frame edge stands off the outermost body (`cellReach`).
        const reach = cellOfFrame(group) ? cellReach(model, group.id) : undefined;
        const framed = (): boolean => rankGuard !== undefined ? rankGuard.holds() : reach === undefined || mayGrow(group, reach, cellReach(model, group.id));
        if (attempt(`node:${id}`, candidates, body.x, shift, undo, [id], () => true, framed, lowerCell ? group.id : undefined)) {
          moved = true;
          if (rankGuard !== undefined) { edge().grown += rankGuard.grown(); noteRank(id); }
          else if (reach !== undefined) edge().grown += outward(reach, cellReach(model, group.id));
        }
      }
    }
  }
  if (tried) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  return moved;
}
