import type { Diagnostic, LayoutGroup, LayoutLink, LayoutModel, RowOrderDecision } from '../model/layout.js';
import { corridorSide, laneSource, laneWidth, ownsTransitLanes, selectAnchorTier, transitedCore, transitTiers } from './lanes.js';
import { foreignRoot } from './frames.js';
import { orderTools, readDraft, reseatRow, saveGroups } from './overlay-order.js';
import { bandGap, compareId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { findPort, straightLengthLimit } from './row-paths.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { reservation, type Reservation } from './reservations.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** A row of at most this many nodes is judged in every order; a longer row in its adjacent swaps only. */
export const ROW_ORDER_PERMUTED_NODES = 5;
/** The most candidates one step judges (the product over the rows of its two tiers). Above it, one tier at a time; per step. */
export const ROW_ORDER_STEP_CANDIDATES = 720;
/** The most candidates the whole sheet judges, over every step of both sweeps (R4: a count, never a time). */
export const ROW_ORDER_BUDGET = 5000;

/** A candidate: the new order of each row it changes. A row it does not name keeps its order. */
type Candidate = ReadonlyMap<LayoutGroup, readonly string[]>;
const IDENTITY: Candidate = new Map();

/** Every order of `items`, the given order first, then in the lexicographic order of the positions. */
function permutations(items: readonly string[]): string[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((first, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [first, ...rest]));
}
/** `items` and each order one adjacent swap away from it. */
function adjacentSwaps(items: readonly string[]): string[][] {
  return [[...items], ...items.slice(1).map((_, i) => [...items.slice(0, i), items[i + 1]!, items[i]!, ...items.slice(i + 2)])];
}
const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((node, i) => node === b[i]);

/**
 * The order of a free row counts the corridors through it (architecture-2 ticket 17).
 *
 * ELK keeps the declaration order of every row (`semiInteractive`), and `orderByOverlay` re-orders only the tiers an overlay link
 * touches. Neither sees the corridors 7a reserves for a routed link that crosses a tier it does not end in: a corridor passes the
 * transited group on the side `corridorSide` gives, so the run between the corridor and the far end can cross the links of a row
 * whose order would let it pass clear. This step runs after `orderByOverlay`, on the same draft, and reads the corridor-aware
 * crossings of `readDraft` (each transit link cut at its predicted corridor, each end read at its predicted port).
 *
 * - **What moves.** The nodes of a free row (`orderTools().freeRow`) with two or more nodes whose turn changes no region that holds
 *   a frame cell. Such a row records `frame-columns`: the frame columns are packed after this step, so the draft has not their x. A flank, a frame cell (a canton member
 *   among them: its author order stands, R3), a grid, a bar and a nested group keep their order. The anchor tier is the reference
 *   of both sweeps and keeps its order.
 * - **The sweep.** From the anchor tier downwards, then from the anchor tier upwards, one step per sub-tier that a transit link spans
 *   (its two end tiers included). A step judges the rows of its tier together with the rows of the next tier away from the anchor:
 *   a corridor that crosses a feed link is often cleared only when the feed's two ends move together.
 * - **Candidates.** Every order of a row of at most `ROW_ORDER_PERMUTED_NODES` nodes, else its adjacent swaps; the product over the
 *   rows of the two tiers while it is at most `ROW_ORDER_STEP_CANDIDATES`, else each tier alone; `ROW_ORDER_BUDGET` over the sheet.
 *   A truncation is one `ROW_ORDER_SEARCH_CAPPED` info diagnostic.
 * - **Acceptance.** Measured on the draft over the regions that touch the two tiers: the straight overlay links do not fall, the
 *   routed links blocked on their row do not rise, and the routed crossings drop strictly. Among the accepted candidates the most
 *   straight links win, then the fewest blocked, then the fewest crossings; a tie keeps the first enumerated (the current order of
 *   each row comes first, then the orders in the lexicographic order of their positions). No candidate accepted: the order stands.
 * - **The far-end pull (ticket 22).** After both sweeps, every free row, a row next to a frame cell included, pulls its members
 *   toward their links' far ends (`pullTowardFarEnds`): declaration order is a hint. A pulled member passes unlinked members, and a
 *   linked member once when that member's links stay straight or chords. A pull stands only where the draft measure over the regions
 *   the row reaches is no worse. The record keeps the order the search left (`pulledFrom`) and the members served (`pulled`).
 *   `layout.farEndPull: false` switches the pull off.
 *
 * Every free row of two or more nodes gets `rowOrderDecision`, also when the order stands; `validateRowOrderDecisions` reads it.
 * The document setting `layout.corridorRowOrder: false` keeps every row as the skeleton gave it (rule `author`), for a sheet whose
 * author wants the declared order (R9: a per-sheet setting).
 */
export function orderByCorridors(model: LayoutModel): void {
  const draft = readDraft(model);
  if (draft === undefined) return;
  if (model.reservations !== undefined) {
    model.reservations = model.reservations.filter(entry => entry.kind !== 'corridorSide' && !(entry.kind === 'rowOrder' && 'tier' in entry.payload));
  }
  const { anchor, tiers, index, measureRange, reach } = draft;
  const { movable, freeRow } = orderTools(model);
  const orderOf = (group: LayoutGroup): string[] => [...(group.rowOrder ?? group.nodes)];
  const rows = (k: number): LayoutGroup[] => Object.values(model.groups).filter(group => group.tier === tiers[k] && group.nodes.length > 1 && freeRow(group))
    .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
  const free = tiers.flatMap((_, k) => rows(k));
  const before = new Map(free.map(group => [group, orderOf(group)]));
  if (model.document.layout?.corridorRowOrder === false) {
    // The author keeps the order of every row: the decision is recorded, and no candidate is judged.
    for (const [group, order] of before) group.rowOrderDecision = { rule: 'author', before: order, after: [...order] };
    return;
  }

  // The sub-tiers a transit link spans, by index: its two end tiers and every tier it crosses.
  const spanned = new Set<number>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments || !ownsTransitLanes(model, link)) continue;
    const ends = [link.attachments.from.node, link.attachments.to.node].map(node => model.groups[model.document.nodes[node]!.group]!);
    if (ends.some(group => group.flank || group.bounds === undefined)) continue;
    const [p, q] = ends.map(group => index.get(group.tier!)!).sort((a, b) => a - b) as [number, number];
    for (let k = p; k <= q; k++) spanned.add(k);
  }

  // A row whose turn can change a region that touches a frame cell (the measured regions run from tier low - 1 to high + 1) is left
  // out: the frame columns are packed after this step
  // (`placeFlanksAndPeers`), so the draft does not hold the x the frames will stand at, and a corridor predicted against it is not
  // the one 7a reserves (ticket 17 review). The row records `frame-columns`.
  const framed = new Set(Object.values(model.groups).filter(group => group.frame !== undefined && group.bounds !== undefined).map(group => index.get(group.tier!)!));
  const frameBound = new Set(free.filter(group => { const [low, high] = reach([group]); return [...framed].some(k => k >= low - 1 && k <= high + 1); }));
  const turnable = (k: number): LayoutGroup[] => rows(k).filter(group => !frameBound.has(group));

  const caps = new Set<string>();
  let spent = 0, moved = false;
  /** The candidates of the free rows of tier `k`: their product, or one row at a time when the product passes the step cap. */
  const tierCandidates = (k: number): Candidate[] => {
    const lists = turnable(k).map(group => {
      const order = orderOf(group);
      if (order.length > ROW_ORDER_PERMUTED_NODES) caps.add(`row ${group.id} has ${order.length} nodes, so only its adjacent swaps were judged`);
      return { group, orders: order.length <= ROW_ORDER_PERMUTED_NODES ? permutations(order) : adjacentSwaps(order) };
    });
    const product = lists.reduce((size, list) => size * list.orders.length, 1);
    if (product <= ROW_ORDER_STEP_CANDIDATES) {
      return lists.reduce<Candidate[]>((all, { group, orders }) => all.flatMap(partial => orders.map(order => new Map([...partial, [group, order]]))), [IDENTITY]);
    }
    caps.add(`sub-tier ${tiers[k]} has ${product} orders, so each row was judged alone`);
    return [IDENTITY, ...lists.flatMap(({ group, orders }) => orders.slice(1).map(order => new Map([[group, order]])))];
  };
  const apply = (candidate: Candidate): boolean => [...candidate].every(([group, order]) => sameOrder(order, orderOf(group)) || reseatRow(model, group, [...order], true));
  const better = (one: ReturnType<typeof measureRange>, two: ReturnType<typeof measureRange>): boolean =>
    one.straight !== two.straight ? one.straight > two.straight : one.blocked !== two.blocked ? one.blocked < two.blocked : one.crossings < two.crossings;

  /** One step: the free rows of tier `k` (index) with those of tier `next`, the next one away from the anchor. */
  const step = (k: number, next: number | undefined): void => {
    if (!spanned.has(k)) return;
    const own = tierCandidates(k), far = next !== undefined && spanned.has(next) ? tierCandidates(next) : [IDENTITY];
    if (own.length * far.length <= 1) return;
    let candidates = own.length * far.length <= ROW_ORDER_STEP_CANDIDATES
      ? own.flatMap(one => far.map(two => new Map([...one, ...two]) as Candidate))
      : (caps.add(`sub-tiers ${tiers[k]} and ${tiers[next!]} have ${own.length * far.length} orders together, so each was judged alone`), [...own, ...far.slice(1)]);
    candidates = candidates.slice(1); // the first is the current order of every row
    if (spent + candidates.length > ROW_ORDER_BUDGET) {
      caps.add(`the sheet spent its budget of ${ROW_ORDER_BUDGET} candidates`);
      candidates = candidates.slice(0, Math.max(0, ROW_ORDER_BUDGET - spent));
    }
    if (!candidates.length) return;
    spent += candidates.length;
    const groups = [...turnable(k), ...(next === undefined ? [] : turnable(next))];
    // Every region a turned row can change: the whole span of each routed link with an end in a candidate row or crossing its sub-tier.
    const [low, high] = reach(groups);
    const now = measureRange(low, high, true);
    let best: { candidate: Candidate; measure: ReturnType<typeof measureRange> } | undefined;
    for (const candidate of candidates) {
      const undo = saveGroups(model, groups);
      const seated = apply(candidate), measure = seated ? measureRange(low, high, true) : undefined;
      undo();
      if (measure === undefined || measure.straight < now.straight || measure.blocked > now.blocked || measure.crossings >= now.crossings) continue;
      if (best === undefined || better(measure, best.measure)) best = { candidate, measure };
    }
    if (best === undefined) return;
    if (!apply(best.candidate)) throw new Error('A row order the corridor step measured could not be seated again');
    moved = true;
  };

  const at = tiers.indexOf(anchor);
  for (let k = at + 1; k < tiers.length; k++) step(k, k + 1 < tiers.length ? k + 1 : undefined);
  for (let k = at - 1; k >= 0; k--) step(k, k > 0 ? k - 1 : undefined);

  const joint = model.document.layout?.feedOrder === false ? undefined : orderJointFreeRows(model, draft, turnable, movable, frameBound, before, spanned);
  if (joint?.moved) moved = true;

  // The pull toward the far ends (ticket 22): after the search, a member whose link would bend passes the members beside it toward its link's far end.
  const searched = new Map(free.map(group => [group, orderOf(group)])), pulled = new Map<LayoutGroup, string[]>();
  // A row next to a frame cell takes it too: the frame column is later centred on its feeds, this member's link among them. A pull stands only
  // where the draft measure over the regions the row reaches is no worse: no straight overlay link lost, no routed link more blocked, no crossing more.
  // `layout.farEndPull: false` keeps the order the search left (a sheet whose subject needs a node where it is declared).
  for (const group of model.document.layout?.farEndPull === false ? [] : free) {
    const [low, high] = reach([group]), now = measureRange(low, high, true), undo = saveGroups(model, [group]);
    const served = pullTowardFarEnds(model, group);
    if (!served.length) continue;
    const after = measureRange(low, high, true);
    if (after.straight < now.straight || after.blocked > now.blocked || after.crossings > now.crossings) { undo(); continue; }
    pulled.set(group, served);
    moved = true;
  }

  if (joint !== undefined) {
    const entries: Reservation[] = [
      ...joint.tierOrders.map(({ tier, order, rows: feedRows }) =>
        reservation('rowOrder', { kind: 'command', id: 'feed-order' }, `tier:${tier}:${order[0]!}`, 'skeleton', 0, {
          tier, order, feeds: feedRows.map(row => ({ row: row.id, order: orderOf(row) })),
        })),
      ...joint.corridorSides,
    ];
    if (entries.length) model.reservations = [...(model.reservations ?? []), ...entries];
  }

  for (const [group, order] of before) {
    const found = searched.get(group)!, after = orderOf(group);
    const rule: RowOrderDecision['rule'] = frameBound.has(group) ? 'frame-columns'
      : sameOrder(order, found) ? 'kept'
      : joint?.jointMoved.has(group) ? 'feed-order' : 'corridor-crossings';
    const decision: RowOrderDecision = { rule, before: order, after };
    if (!sameOrder(found, after)) { decision.pulledFrom = found; decision.pulled = pulled.get(group)!; }
    group.rowOrderDecision = decision;
  }
  for (const reason of caps) {
    const note: Diagnostic = { stage: 'placement', severity: 'info', code: 'ROW_ORDER_SEARCH_CAPPED', message: `The corridor row order judged fewer candidates: ${reason}.` };
    model.diagnostics.push(note);
  }
  if (moved) rebuildBands(model, false);
}

/** The nodes of `group` that some drawn link ends on: the members whose place in the row changes a link. */
function linkedMembers(model: LayoutModel, group: LayoutGroup): Set<string> {
  const own = new Set(group.nodes);
  const linked = new Set<string>();
  for (const link of model.links) {
    if (link.removed === true || !link.attachments) continue;
    for (const end of [link.attachments.from.node, link.attachments.to.node]) if (own.has(end)) linked.add(end);
  }
  return linked;
}

const centreOf = (model: LayoutModel, node: string): number => { const box = model.nodes[node]!.bounds!; return box.x + box.width / 2; };
/** The sub-tiers that face a row across one tier gap: the occupied sub-tiers next to its own (the tiers `readDraft` reads). */
function facingTiers(model: LayoutModel, group: LayoutGroup): Set<number> {
  const tiers = [...new Set(Object.values(model.groups).filter(item => !item.flank && item.nodes.length).map(item => item.tier!))].sort((a, b) => a - b);
  const at = tiers.indexOf(group.tier!);
  return new Set([tiers[at - 1], tiers[at + 1]].filter((tier): tier is number => tier !== undefined));
}
/**
 * The one far node of a member whose links are all routed and all end on that node, in a band that faces the row (`facing`); else
 * `undefined`. An overlay link keeps the place the overlay order gave, and a link to a band farther off is not this gap's.
 */
function farEndOf(model: LayoutModel, node: string, facing: ReadonlySet<number>): string | undefined {
  const far = new Set<string>();
  for (const link of model.links) {
    if (link.removed === true || !link.attachments) continue;
    const { from, to } = link.attachments, other = from.node === node ? to.node : to.node === node ? from.node : undefined;
    if (other === undefined) continue;
    const tier = model.groups[model.document.nodes[other]?.group ?? '']?.tier;
    if (link.layer !== 'routed' || other === node || tier === undefined || !facing.has(tier) || model.nodes[other]?.bounds === undefined) return undefined;
    far.add(other);
  }
  return far.size === 1 ? [...far][0] : undefined;
}
/**
 * The one test of the pull for "a link that would bend": the member's centre stands off the x-range `[low, high]` of its far node by the
 * straight-link length limit of the two bodies or more (`straightLengthLimit`), so neither a straight drop nor a chord takes the link.
 * The two callers read different ranges, and the difference is the point: a pull target reads the one x its far node is predicted at
 * (`[goal, goal]`), because 7c has not yet seated the far node and its draft box is not where it will stand; a passed linked member reads
 * the draft box of its own far node, because that node already stands under its feeds and a feed that stretches it keeps the link straight
 * anywhere over it.
 */
function wouldBend(model: LayoutModel, node: string, far: string, low: number, high: number): boolean {
  const x = centreOf(model, node), off = Math.max(0, low - x, x - high);
  return off >= straightLengthLimit([model.nodes[node]!, model.nodes[far]!]) - 1e-6;
}

/** The members of `group` that a routed link joins to `far`. */
function feedersIn(model: LayoutModel, group: LayoutGroup, far: string): string[] {
  const own = new Set(group.nodes);
  return [...new Set(model.links.flatMap(link => {
    if (link.removed === true || !link.attachments || link.layer !== 'routed') return [];
    const { from, to } = link.attachments;
    return from.node === far && own.has(to.node) ? [to.node] : to.node === far && own.has(from.node) ? [from.node] : [];
  }))];
}
/**
 * Where the far node `far` of a member of `group` will stand once 7c has seated its siblings under their feeds: a sibling stretches or
 * moves to reach the members of the row that feed it, so the far node stands beyond the farthest feed of every sibling before it in its
 * row, and short of the nearest feed of every sibling after it (half its width and the node clearance off). Its draft x where no sibling
 * pushes it. A sibling is a node of its group on its own row (its body meets the far node's rows): a node of another rank of the group
 * stands on another sub-tier and pushes nothing (ticket 22 review: the feeds of a lower rank once pulled a member away from its far node).
 */
function predictedCentre(model: LayoutModel, group: LayoutGroup, far: string): number {
  const box = model.nodes[far]!.bounds!, row = model.groups[model.document.nodes[far]!.group]!, order = row.rowOrder ?? row.nodes, at = order.indexOf(far);
  const sameRow = (id: string): boolean => { const other = model.nodes[id]!.bounds!; return other.y < box.y + box.height && box.y < other.y + other.height; };
  const reach = box.width / 2 + spacing.nodeClearance;
  let goal = centreOf(model, far);
  for (const [index, sibling] of order.entries()) {
    const xs = index === at || !sameRow(sibling) ? [] : feedersIn(model, group, sibling).map(node => centreOf(model, node));
    if (!xs.length) continue;
    if (index < at) goal = Math.max(goal, Math.max(...xs) + reach);
    else goal = Math.min(goal, Math.min(...xs) - reach);
  }
  return goal;
}

/**
 * A row pulls a member toward its link's far end (architecture-2 ticket 22; user, 2026-10-24: "LB should be moved closer to FE4", and on
 * a-row-stretches "we could switch f1 and f2 places"). A member is pulled when all its links are routed and end on one node of a band that
 * faces its row across one tier gap (`farEndOf`), no other member of the row feeds that node (its x is then a compromise between the
 * feeds), and its link would bend at the x the node is predicted at (`wouldBend`). A member whose link a chord can take keeps its place.
 * Where the node will stand is predicted (`predictedCentre`): 7c seats its siblings under their feeds, so it stands beyond the farthest
 * feed of every sibling before it and short of the nearest feed of every one after it.
 * The member trades places with a neighbour while that brings its centre strictly nearer the far node's centre. The neighbour is an
 * unlinked member, or a linked member that is no pull target, is passed for the first time, and whose links all stay straight or chords
 * after the trade (`staysDirect`; user, 2026-10-24: "move f1 to the right side of container"). A passed linked member moves one slot, so
 * the order of its links' ends changes against the pulled member's only; the draft measure of the caller refuses a pull that adds a crossing.
 * Members are taken in row order, again until none moves (R3: the row order, never the link order). Returns the members the pull moved,
 * in row order (empty: the row stands).
 */
function pullTowardFarEnds(model: LayoutModel, group: LayoutGroup): string[] {
  const linked = linkedMembers(model, group);
  if (!linked.size || group.nodes.length < 2) return [];
  const centre = (node: string): number => centreOf(model, node);
  const facing = facingTiers(model, group);
  const feeders = (far: string): string[] => feedersIn(model, group, far);
  const target = new Map<string, number>();
  for (const node of linked) {
    const other = farEndOf(model, node, facing);
    // No pull toward a far node that another member of this row also feeds: its x is a compromise between the feeds, not one member's goal.
    if (other === undefined || feeders(other).some(peer => peer !== node)) continue;
    const goal = predictedCentre(model, group, other);
    // A member whose link a chord can take keeps its place: the pull serves a link that would bend.
    if (wouldBend(model, node, other, goal, goal)) target.set(node, goal);
  }
  /** Whether every link of a linked member stays straight or a chord where it now stands: each is routed to a node of a facing band, and none would bend over that node's draft box. */
  const staysDirect = (node: string): boolean => model.links.every(link => {
    if (link.removed === true || !link.attachments) return true;
    const { from, to } = link.attachments, other = from.node === node ? to.node : to.node === node ? from.node : undefined;
    if (other === undefined) return true;
    const tier = model.groups[model.document.nodes[other]?.group ?? '']?.tier, box = model.nodes[other]?.bounds;
    if (link.layer !== 'routed' || other === node || tier === undefined || !facing.has(tier) || box === undefined) return false;
    return !wouldBend(model, node, other, box.x, box.x + box.width);
  });
  const served = new Set<string>(), passed = new Set<string>();
  // R4: the bound is a guard the loop never meets. Each trade moves one pull target past one member that is no target, strictly nearer its
  // goal, and the goal stays fixed. Trading back would put it where it was, which is not nearer, so a target passes each other member at most
  // once (a linked one once in all). A round that changes the row makes one trade at least, so there are at most n² rounds.
  for (let moved = true, rounds = 0; moved && rounds < group.nodes.length * group.nodes.length; rounds++) {
    moved = false;
    for (const node of [...(group.rowOrder ?? group.nodes)]) {
      const goal = target.get(node);
      if (goal === undefined) continue;
      const order = [...(group.rowOrder ?? group.nodes)], at = order.indexOf(node);
      const step = goal < centre(node) ? -1 : 1, next = order[at + step];
      if (next === undefined || target.has(next) || passed.has(next)) continue;
      const before = Math.abs(centre(node) - goal);
      const undo = saveGroups(model, [group]);
      order[at] = next; order[at + step] = node;
      if (!reseatRow(model, group, order, true) || Math.abs(centre(node) - goal) >= before - 1e-6 || (linked.has(next) && !staysDirect(next))) { undo(); continue; }
      if (linked.has(next)) passed.add(next);
      served.add(node);
      moved = true;
    }
  }
  return (group.rowOrder ?? group.nodes).filter(node => served.has(node));
}

/**
 * The guard after the frames are ordered (`withdrawPullsAcrossFlips`, ticket 22 review): the frame columns are packed and ordered after the
 * pull (`placeFlanksAndPeers`), and a frame order that flips can put a far node on the other side of the member the pull moved toward it.
 * The prediction is read again on that model (`pullsAcross`): a pull that no longer brings a member nearer its far node's predicted place is
 * undone with every pull of its row: the row takes the order the search left again, and the record names every member the pull had moved
 * (`pullWithdrawn`). Rows are judged again until none changes. Returns whether a row changed.
 */
export function withdrawPullsAcrossFlips(model: LayoutModel): boolean {
  let changed = false, grew = false;
  // Rows in id order (R3), again until a round withdraws nothing: a withdrawn row moves the far nodes of the rows that face it, and a pull
  // kept in an earlier round can then stand across. R4: each round that goes on withdraws one pull at least, and a withdrawn row records no
  // pull, so there are at most as many rounds as rows with a pull, and one more.
  const rows = Object.values(model.groups).filter(group => group.rowOrderDecision?.pulledFrom !== undefined).sort((p, q) => compareId(p.id, q.id));
  for (let round = 0, again = true; again && round <= rows.length; round++) {
    again = false;
    for (const group of rows) {
      const decision = group.rowOrderDecision!;
      if (decision.pulledFrom === undefined || decision.pulled === undefined) continue;
      if (!pullsAcross(model, group, decision.pulledFrom, decision.after, decision.pulled).length) continue;
      const width = group.bounds!.width;
      if (!reseatRow(model, group, [...decision.pulledFrom], true)) continue;
      // Every pull of the row is undone with its order, so every pulled member is named.
      group.rowOrderDecision = { rule: decision.rule, before: decision.before, after: [...decision.pulledFrom], pullWithdrawn: [...decision.pulled] };
      grew ||= group.bounds!.width > width + PLACEMENT_EPS;
      changed = again = true;
    }
  }
  // `reseatRow` may widen the box (gaps differ by the strokes of the neighbours): the bands follow it then, as after the pull. A row that
  // keeps its box moves no band, and the bands are left as `placeFlanksAndPeers` built them.
  if (grew) rebuildBands(model, false);
  return changed;
}
/**
 * The pulled members the pull no longer brings nearer the place their far node is predicted at (`predictedCentre`, read on the model as it
 * stands): the ones `withdrawPullsAcrossFlips` undoes, and a record the validator refuses. The member's centre in the order the search left is
 * read by seating the row in that order and putting it back (a probe, nothing is searched).
 */
function pullsAcross(model: LayoutModel, group: LayoutGroup, from: readonly string[], after: readonly string[], pulled: readonly string[]): string[] {
  if (!sameOrder(group.rowOrder ?? group.nodes, after)) return [];
  const facing = facingTiers(model, group), fars = new Map(pulled.flatMap(node => { const far = farEndOf(model, node, facing); return far === undefined ? [] : [[node, far] as const]; }));
  const now = new Map([...fars.keys()].map(node => [node, centreOf(model, node)]));
  // The goals are read as the pull read them, with the row in the order the search left: a passed feeder of a sibling stood there.
  const undo = saveGroups(model, [group]);
  const seated = reseatRow(model, group, [...from], true);
  const before = new Map([...fars].map(([node, far]) => [node, { x: centreOf(model, node), goal: predictedCentre(model, group, far) }]));
  undo();
  if (!seated) return [];
  return [...before].filter(([node, { x, goal }]) => Math.abs(now.get(node)! - goal) >= Math.abs(x - goal) - 1e-6).map(([node]) => node);
}

/**
 * The stage-4 validator of `rowOrderDecision` (R1, R5): it reads the record and the row order, and never runs the search again.
 * A recorded row stands in the order the record names; `before` and `after` are orders of the row's own nodes; `kept` and `author`
 * name one order twice and `corridor-crossings` two different orders; `author` stands exactly when the document sets
 * `layout.corridorRowOrder: false`; only a free row carries a record, and every free row of two or more nodes carries one when the
 * sheet has an anchor tier. A far-end pull is checked by reading the prediction again on the geometry as it stands (`pullsAcross`): the
 * check is valid only on the stage-4 model right after `withdrawPullsAcrossFlips`, on the same geometry; later stages move the far nodes.
 */
export function validateRowOrderDecisions(model: LayoutModel): string[] {
  const errors: string[] = [];
  const { freeRow } = orderTools(model);
  // `readDraft` answers nothing, and the step records nothing, exactly when no tier is the anchor.
  const decided = selectAnchorTier(model) !== undefined;
  const ofRow = (group: LayoutGroup, order: readonly string[]): boolean => sameOrder([...order].sort(compareId), [...group.nodes].sort(compareId));
  for (const group of Object.values(model.groups)) {
    const decision = group.rowOrderDecision;
    // Absent is the decision "not this step's" only where the step does not decide: no main tier, or no free row of two nodes.
    if (decision === undefined) {
      if (decided && freeRow(group) && group.nodes.length > 1) errors.push(`Free row ${group.id} has no row order decision`);
      continue;
    }
    if (!freeRow(group) || group.nodes.length < 2) errors.push(`Group ${group.id} records a row order decision but is no free row`);
    if (!ofRow(group, decision.before) || !ofRow(group, decision.after)) errors.push(`The row order decision of ${group.id} names nodes that are not its own`);
    const searched = decision.pulledFrom ?? decision.after;
    const turnedRule = decision.rule === 'corridor-crossings' || decision.rule === 'feed-order';
    if (turnedRule === sameOrder(decision.before, searched)) errors.push(`The row order decision of ${group.id} is ${decision.rule}, and its before and after orders contradict it`);
    if (decision.rule === 'feed-order' && model.document.layout?.feedOrder === false) errors.push(`The row order decision of ${group.id} is feed-order, and feedOrder is false`);
    if ((decision.pulledFrom === undefined) !== (decision.pulled === undefined)) errors.push(`The far-end pull of ${group.id} records only one of its order and its members`);
    if (decision.pulledFrom !== undefined && decision.pulled !== undefined) {
      // R5, read and not searched again: the pulled members are linked members of the row and keep their relative order, the other linked members
      // keep theirs, and each of those is passed by one pulled member at most (a linked member moves one slot).
      const linked = linkedMembers(model, group), pulled = new Set(decision.pulled);
      const keep = (order: readonly string[], served: boolean): string[] => order.filter(node => linked.has(node) && pulled.has(node) === served);
      const at = (order: readonly string[], node: string): number => order.indexOf(node);
      const passes = (node: string): number => decision.pulled!.filter(item => Math.sign(at(decision.pulledFrom!, item) - at(decision.pulledFrom!, node)) !== Math.sign(at(decision.after, item) - at(decision.after, node))).length;
      if (!ofRow(group, decision.pulledFrom) || sameOrder(decision.pulledFrom, decision.after) || decision.pulled.length === 0 || decision.pulled.some(node => !linked.has(node))
        || !sameOrder(keep(decision.pulledFrom, true), keep(decision.after, true)) || !sameOrder(keep(decision.pulledFrom, false), keep(decision.after, false))
        || keep(decision.after, false).some(node => passes(node) > 1)
        // Every pulled member moved, and the move brings it nearer the place its one far node is predicted at (`pullsAcross`).
        || decision.pulled.some(node => at(decision.pulledFrom!, node) === at(decision.after, node) || farEndOf(model, node, facingTiers(model, group)) === undefined)
        || pullsAcross(model, group, decision.pulledFrom, decision.after, decision.pulled).length > 0) {
        errors.push(`The far-end pull of ${group.id} is recorded on orders it cannot give`);
      }
      if (decision.rule === 'author') errors.push(`The row order decision of ${group.id} is ${decision.rule}, and records a far-end pull`);
      if (model.document.layout?.farEndPull === false) errors.push(`The row order decision of ${group.id} records a far-end pull, and the document setting farEndPull is false`);
    }
    if (decision.pullWithdrawn !== undefined && (decision.pulledFrom !== undefined || decision.pullWithdrawn.length === 0 || decision.pullWithdrawn.some(node => !group.nodes.includes(node)))) {
      errors.push(`The far-end pull of ${group.id} is recorded as withdrawn on a record that cannot hold it`);
    }
    if ((decision.rule === 'author') !== (model.document.layout?.corridorRowOrder === false)) errors.push(`The row order decision of ${group.id} is ${decision.rule}, and the document setting corridorRowOrder contradicts it`);
    if (!sameOrder(group.rowOrder ?? group.nodes, decision.after)) errors.push(`Group ${group.id} stands in an order its row order decision does not name`);
  }
  return errors;
}

const SAME_FEED_KEY = 1e-6;
const JOINT_RUN_PERMS_CAP = 24;
const JOINT_TRANSIT_ENUM_CAP = 4;

interface JointResult {
  moved: boolean;
  jointMoved: Set<LayoutGroup>;
  tierOrders: { tier: number; order: string[]; rows: LayoutGroup[] }[];
  corridorSides: Reservation[];
}

function slotSortBy(items: readonly string[], keys: ReadonlyMap<string, number | undefined>, cmp: (a: string, b: string) => number): string[] {
  const queue = items.filter(item => keys.get(item) !== undefined).sort(cmp);
  return items.map(item => keys.get(item) === undefined ? item : queue.shift()!);
}

/**
 * Joint stage-4 order of each free row with the movable group order of the sub-tier below and the sides of the transit corridors that
 * cross the row's sub-tier, judged at the predicted stage-7c centres of the sub-tier below.
 */
function orderJointFreeRows(model: LayoutModel, draft: NonNullable<ReturnType<typeof readDraft>>,
  turnable: (k: number) => LayoutGroup[], movable: (group: LayoutGroup) => boolean,
  frameBound: ReadonlySet<LayoutGroup>, before: ReadonlyMap<LayoutGroup, readonly string[]>,
  spanned: ReadonlySet<number>): JointResult {
  const { anchor, tiers, measureRange, reach, portX } = draft;
  const orderOf = (group: LayoutGroup): string[] => [...(group.rowOrder ?? group.nodes)];
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const gap = bandGap(model);
  const jointMoved = new Set<LayoutGroup>();
  const tierOrders: { tier: number; order: string[]; rows: LayoutGroup[] }[] = [];
  const corridorSides: Reservation[] = [];
  let moved = false;

  const residualGroups = new Set<LayoutGroup>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.meshBus !== undefined || !link.attachments || link.technique === 'stub') continue;
    const { from, to } = link.attachments;
    if (from.node === to.node) continue;
    const gf = groupOf(from.node), gt = groupOf(to.node);
    const pf = findPort(model, from), pt = findPort(model, to);
    const sf = pf?.side ?? pf?.sizingSide, st = pt?.side ?? pt?.sizingSide;
    if (gf !== gt) {
      if (sf === 'left' || sf === 'right' || st === 'left' || st === 'right') {
        residualGroups.add(gf);
        residualGroups.add(gt);
      }
    } else if (sf === 'top' || sf === 'bottom' || st === 'top' || st === 'bottom' || model.document.links[link.sourceIndex]?.label !== undefined) {
      residualGroups.add(gf);
    }
  }

  const routedVertical = model.links.filter(link => {
    if (link.layer !== 'routed' || link.meshBus !== undefined || !link.attachments || link.technique === 'stub') return false;
    const { from, to } = link.attachments;
    if (from.node === to.node) return false;
    const pf = findPort(model, from), pt = findPort(model, to);
    const sf = pf?.side ?? pf?.sizingSide, st = pt?.side ?? pt?.sizingSide;
    return sf !== 'left' && sf !== 'right' && st !== 'left' && st !== 'right';
  });
  const routedSameRow = model.links.filter(link => link.layer === 'routed' && link.meshBus === undefined && link.attachments && link.technique !== 'stub'
    && link.attachments.from.node !== link.attachments.to.node
    && groupOf(link.attachments.from.node).id === groupOf(link.attachments.to.node).id);

  const passesFrame = (link: LayoutLink): boolean => {
    const crossed = new Set(transitTiers(model, link));
    return Object.values(model.groups).some(group => group.tier !== undefined && crossed.has(group.tier) && foreignRoot(model, group.id, link) !== undefined);
  };

  /** Normalized [0, 1] left-to-right node rank on a sub-tier as currently seated. */
  const tierRanks = (tier: number | undefined): Map<string, number> => {
    if (tier === undefined) return new Map();
    const groups = Object.values(model.groups)
      .filter(group => !group.flank && group.tier === tier && group.bounds !== undefined && group.nodes.length > 0)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    const slots: string[][] = [];
    for (const group of groups) {
      const ord = group.rowOrder ?? [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x);
      const boxes = ord.map(id => model.nodes[id]!.bounds!);
      const oneRow = boxes.every(b => b.y < boxes[0]!.y + boxes[0]!.height && boxes[0]!.y < b.y + b.height);
      if (oneRow) for (const id of ord) slots.push([id]);
      else slots.push(ord);
    }
    const n = slots.length;
    const out = new Map<string, number>();
    slots.forEach((ids, i) => { const r = n <= 1 ? 0.5 : i / (n - 1); for (const id of ids) out.set(id, r); });
    return out;
  };

  /** Repack `ids` across `run`'s existing outer span `[minX, maxRight]` so no neighbour wall is crossed. */
  const seatRun = (run: readonly LayoutGroup[], ids: readonly string[]): void => {
    const minX = Math.min(...run.map(group => group.bounds!.x));
    const maxRight = Math.max(...run.map(group => group.bounds!.x + group.bounds!.width));
    const sumW = ids.reduce((sum, id) => sum + model.groups[id]!.bounds!.width, 0);
    const stepGap = ids.length > 1 ? Math.max(gap, (maxRight - minX - sumW) / (ids.length - 1)) : 0;
    let x = minX;
    for (const id of ids) {
      const group = model.groups[id]!;
      moveGroup(model, group, x - group.bounds!.x, 0);
      x += group.bounds!.width + stepGap;
    }
  };

  /** Candidate node orders for `row` read from normalized ranks on `upTier` and `downTier`. */
  const rowFeedCandidates = (row: LayoutGroup, rankUp: ReadonlyMap<string, number>, rankDown: ReadonlyMap<string, number>): string[][] => {
    const cur = orderOf(row), own = new Set(cur);
    const up = new Map<string, number | undefined>(), down = new Map<string, number | undefined>(), both = new Map<string, number | undefined>();
    for (const node of cur) {
      const upVals: number[] = [], downVals: number[] = [];
      for (const link of routedVertical) {
        const { from, to } = link.attachments!;
        const farRef = from.node === node ? to : to.node === node ? from : undefined;
        if (farRef === undefined || own.has(farRef.node)) continue;
        const farPort = findPort(model, farRef);
        const shift = farPort?.authorOrder !== undefined ? farPort.authorOrder * 1e-4 : 0;
        if (rankUp.has(farRef.node)) upVals.push(rankUp.get(farRef.node)! + shift);
        else if (rankDown.has(farRef.node)) downVals.push(rankDown.get(farRef.node)! + shift);
      }
      const ku = upVals.length ? upVals.reduce((s, v) => s + v, 0) / upVals.length : undefined;
      const kd = downVals.length ? downVals.reduce((s, v) => s + v, 0) / downVals.length : undefined;
      up.set(node, ku);
      down.set(node, kd);
      both.set(node, ku !== undefined && kd !== undefined ? (ku + kd) / 2 : (ku ?? kd));
    }
    // Keep adjacent same-row routed peers together; keep their internal order when a lateral face is authored.
    const blocks: { nodes: string[]; fixedInner: boolean }[] = [];
    for (const [i, node] of cur.entries()) {
      const prev = i > 0 ? cur[i - 1]! : undefined;
      const join = prev === undefined ? [] : routedSameRow.filter(link => {
        const { from, to } = link.attachments!;
        return (from.node === prev && to.node === node) || (from.node === node && to.node === prev);
      });
      if (join.length > 0) {
        const lateral = join.some(link => {
          const pf = findPort(model, link.attachments!.from), pt = findPort(model, link.attachments!.to);
          return [pf?.side, pt?.side].some(s => s === 'left' || s === 'right');
        });
        blocks[blocks.length - 1]!.nodes.push(node);
        blocks[blocks.length - 1]!.fixedInner ||= lateral;
      } else {
        blocks.push({ nodes: [node], fixedInner: false });
      }
    }
    const buildOrder = (keys: ReadonlyMap<string, number | undefined>, cmpNode: (a: string, b: string) => number): string[] => {
      const vals = [...keys.values()].filter((v): v is number => v !== undefined);
      if (vals.length < 2) return [...cur];
      const bKeys = new Map<string, number | undefined>();
      for (const b of blocks) {
        const bVals = b.nodes.map(n => keys.get(n)).filter((v): v is number => v !== undefined);
        bKeys.set(b.nodes[0]!, bVals.length ? bVals.reduce((s, v) => s + v, 0) / bVals.length : undefined);
      }
      const bHeads = blocks.map(b => b.nodes[0]!);
      const cmpBlock = (ha: string, hb: string): number => {
        const d = bKeys.get(ha)! - bKeys.get(hb)!;
        return Math.abs(d) > SAME_FEED_KEY ? d : cmpNode(ha, hb);
      };
      const sortedHeads = slotSortBy(bHeads, bKeys, cmpBlock);
      const innerMap = new Map(blocks.map(b => [b.nodes[0]!, b.fixedInner || b.nodes.length < 2 ? b.nodes : slotSortBy(b.nodes, keys, cmpNode)]));
      return sortedHeads.flatMap(h => innerMap.get(h)!);
    };
    const tieSecondary = (a: string, b: string): number => {
      const ua = up.get(a), ub = up.get(b);
      if (ua !== undefined && ub !== undefined && Math.abs(ua - ub) > SAME_FEED_KEY) return ua - ub;
      const da = down.get(a), db = down.get(b);
      if (da !== undefined && db !== undefined && Math.abs(da - db) > SAME_FEED_KEY) return da - db;
      return cur.indexOf(a) - cur.indexOf(b);
    };
    const tieSecondaryDown = (a: string, b: string): number => {
      const da = down.get(a), db = down.get(b);
      if (da !== undefined && db !== undefined && Math.abs(da - db) > SAME_FEED_KEY) return da - db;
      const ua = up.get(a), ub = up.get(b);
      if (ua !== undefined && ub !== undefined && Math.abs(ua - ub) > SAME_FEED_KEY) return ua - ub;
      return cur.indexOf(a) - cur.indexOf(b);
    };
    const cmpBoth = (a: string, b: string): number => {
      const d = both.get(a)! - both.get(b)!;
      return Math.abs(d) > SAME_FEED_KEY ? d : tieSecondary(a, b);
    };
    const cmpBothDown = (a: string, b: string): number => {
      const d = both.get(a)! - both.get(b)!;
      return Math.abs(d) > SAME_FEED_KEY ? d : tieSecondaryDown(a, b);
    };
    const cmpBothOuter = (a: string, b: string): number => {
      const ka = both.get(a)!, kb = both.get(b)!, d = ka - kb;
      if (Math.abs(d) > SAME_FEED_KEY) return d;
      const twoA = up.get(a) !== undefined && down.get(a) !== undefined, twoB = up.get(b) !== undefined && down.get(b) !== undefined;
      if (twoA !== twoB && Math.abs(ka - 0.5) > SAME_FEED_KEY) {
        return ka < 0.5 ? (twoA ? 1 : -1) : (twoA ? -1 : 1);
      }
      return tieSecondary(a, b);
    };
    const cmpUp = (a: string, b: string): number => {
      const d = up.get(a)! - up.get(b)!;
      return Math.abs(d) > SAME_FEED_KEY ? d : cur.indexOf(a) - cur.indexOf(b);
    };
    const cmpDown = (a: string, b: string): number => {
      const d = down.get(a)! - down.get(b)!;
      return Math.abs(d) > SAME_FEED_KEY ? d : cur.indexOf(a) - cur.indexOf(b);
    };
    const raw = [cur, buildOrder(both, cmpBoth), buildOrder(both, cmpBothDown), buildOrder(both, cmpBothOuter), buildOrder(up, cmpUp), buildOrder(down, cmpDown)];
    const unique: string[][] = [];
    for (const ord of raw) if (!unique.some(other => sameOrder(other, ord))) unique.push(ord);
    return unique;
  };

  /** Count same-row routed links inside `rowsK` that have another member of the row between their ends. */
  const freeRowBlocked = (rowsK: readonly LayoutGroup[]): number => {
    let blocked = 0;
    for (const row of rowsK) {
      const ord = orderOf(row);
      for (const link of routedSameRow) {
        const { from, to } = link.attachments!;
        if (groupOf(from.node) !== row) continue;
        const pf = findPort(model, from), pt = findPort(model, to);
        const sf = pf?.side ?? pf?.sizingSide, st = pt?.side ?? pt?.sizingSide;
        if (sf === 'top' || sf === 'bottom' || st === 'top' || st === 'bottom') continue;
        if (Math.abs(ord.indexOf(from.node) - ord.indexOf(to.node)) > 1) blocked++;
      }
    }
    return blocked;
  };

  const at = tiers.indexOf(anchor);
  const sweepOrder = [at, ...Array.from({ length: tiers.length - at - 1 }, (_, i) => at + 1 + i), ...Array.from({ length: at }, (_, i) => at - 1 - i)];

  for (const k of sweepOrder) {
    const rowsK = turnable(k).filter(group => !residualGroups.has(group));
    if (!rowsK.length) continue;
    const tierK = tiers[k]!, tierUp = k > 0 ? tiers[k - 1] : undefined, tierDown = k + 1 < tiers.length ? tiers[k + 1] : undefined;
    const tierOut = k >= at ? tierDown : tierUp;
    const mainK = Object.values(model.groups).filter(g => !g.flank && g.tier === tierK && g.bounds !== undefined && g.nodes.length > 0)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    const transitLinks = model.links.filter(link => link.layer === 'routed' && link.attachments && ownsTransitLanes(model, link)
      && transitTiers(model, link).includes(tierK) && !passesFrame(link)).sort((a, b) => a.sourceIndex - b.sourceIndex);

    // Movable group runs on tierOut (away from anchor, matching 7c): length >= 1 runs get predicted-7c centring; length >= 2 runs get permuted.
    const groupsDown = tierOut === undefined ? [] : Object.values(model.groups)
      .filter(g => !g.flank && g.tier === tierOut && g.bounds !== undefined && g.nodes.length > 0)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    interface RunSpec { groups: LayoutGroup[]; wallLeft: number; wallRight: number; permute: boolean }
    const runsDown: RunSpec[] = [];
    for (let i = 0; i < groupsDown.length;) {
      if (!movable(groupsDown[i]!)) { i++; continue; }
      let j = i;
      while (j < groupsDown.length && movable(groupsDown[j]!)) j++;
      const slice = groupsDown.slice(i, j);
      const wallLeft = i > 0 ? groupsDown[i - 1]!.bounds!.x + groupsDown[i - 1]!.bounds!.width + gap : -Infinity;
      const wallRight = j < groupsDown.length ? groupsDown[j]!.bounds!.x - gap : Infinity;
      const nodeSet = new Set(slice.flatMap(g => g.nodes)), rowNodeSet = new Set(rowsK.flatMap(g => g.nodes));
      const touches = routedVertical.some(l => (nodeSet.has(l.attachments!.from.node) && rowNodeSet.has(l.attachments!.to.node))
        || (nodeSet.has(l.attachments!.to.node) && rowNodeSet.has(l.attachments!.from.node)))
        || transitLinks.some(l => nodeSet.has(l.attachments!.from.node) || nodeSet.has(l.attachments!.to.node));
      const hasSameTierPeer = model.links.some(l => l.layer === 'routed' && l.attachments
        && nodeSet.has(l.attachments.from.node) && nodeSet.has(l.attachments.to.node)
        && groupOf(l.attachments.from.node) !== groupOf(l.attachments.to.node));
      const sliceFrameBound = slice.some(g => frameBound.has(g));
      runsDown.push({ groups: slice, wallLeft, wallRight, permute: slice.length > 1 && touches && !hasSameTierPeer && !sliceFrameBound });
      i = j;
    }

    let sigmaCombos: string[][][] = [[]];
    for (const run of runsDown) {
      const baseIds = run.groups.map(g => g.id);
      const opts = !run.permute ? [baseIds] : run.groups.length <= 4 ? permutations(baseIds) : [baseIds, [...baseIds].reverse()];
      const next = sigmaCombos.flatMap(prefix => opts.map(opt => [...prefix, opt]));
      sigmaCombos = next.length <= JOINT_RUN_PERMS_CAP ? next : [...sigmaCombos.map(p => [...p, baseIds]), ...(opts.length > 1 ? [[...sigmaCombos[0]!, opts[1]!]] : [])];
    }

    // Transit side vectors on tierK: baseline sides first, then remaining combinations.
    const defaultSides = (): ('left' | 'right')[] => transitLinks.map(link => {
      const sx = portX(laneSource(model, link));
      const core = transitedCore(mainK, sx) ?? mainK[0]!;
      return corridorSide(core.bounds!, sx);
    });
    const baseSides = defaultSides();
    let sideVectors: (('left' | 'right')[] | undefined)[];
    if (transitLinks.length === 0) {
      sideVectors = [undefined];
    } else if (transitLinks.length <= JOINT_TRANSIT_ENUM_CAP) {
      const all: ('left' | 'right')[][] = [[]];
      for (let m = 0; m < transitLinks.length; m++) {
        const b = baseSides[m]!, other: 'left' | 'right' = b === 'left' ? 'right' : 'left';
        all.splice(0, all.length, ...all.flatMap(prefix => [[...prefix, b], [...prefix, other]]));
      }
      sideVectors = all;
    } else {
      const rUp = tierRanks(tierUp), rDown = tierRanks(tierDown);
      const rankSide = transitLinks.map((link, m) => {
        const { from, to } = link.attachments!;
        const vals = [rUp.get(from.node) ?? rDown.get(from.node), rUp.get(to.node) ?? rDown.get(to.node)].filter((v): v is number => v !== undefined);
        if (!vals.length) return baseSides[m]!;
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        return Math.abs(avg - 0.5) <= SAME_FEED_KEY ? baseSides[m]! : avg < 0.5 ? 'left' : 'right';
      });
      sideVectors = [baseSides, ...(rankSide.some((s, i) => s !== baseSides[i]) ? [rankSide] : [])];
    }

    /** Predict 7c non-overlapping centres for `runsDown` given current `rowsK` seating and corridor `sides`. */
    const seatPredicted7c = (sigma: readonly (readonly string[])[], sides: readonly ('left' | 'right')[] | undefined): void => {
      const corridorAt = new Map<LayoutLink, number>();
      for (const [m, link] of transitLinks.entries()) {
        const sx = centreOf(model, laneSource(model, link).node);
        const core = transitedCore(mainK, sx) ?? mainK[0]!;
        const half = laneWidth(model, link) / 2;
        const s = sides?.[m] ?? corridorSide(core.bounds!, sx);
        corridorAt.set(link, s === 'left' ? Math.min(sx, core.bounds!.x - half) : Math.max(sx, core.bounds!.x + core.bounds!.width + half));
      }
      const tierKSet = new Set(mainK.flatMap(g => g.nodes));
      for (const [rIdx, run] of runsDown.entries()) {
        const ids = sigma[rIdx]!;
        const blocks: { ids: string[]; desired: number; weight: number; span: number }[] = ids.map(id => {
          const group = model.groups[id]!, gNodes = new Set(group.nodes);
          const xs: number[] = [];
          for (const link of routedVertical) {
            const { from, to } = link.attachments!;
            if (gNodes.has(from.node) && tierKSet.has(to.node)) xs.push(centreOf(model, to.node));
            else if (gNodes.has(to.node) && tierKSet.has(from.node)) xs.push(centreOf(model, from.node));
          }
          for (const link of transitLinks) {
            if (link.bundle) continue;
            const { from, to } = link.attachments!;
            if (gNodes.has(from.node) || gNodes.has(to.node)) xs.push(corridorAt.get(link)!);
          }
          const wantLeft = xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length - group.bounds!.width / 2 : group.bounds!.x;
          return { ids: [id], desired: wantLeft, weight: Math.max(1, xs.length), span: group.bounds!.width };
        });
        for (let m = 0; m + 1 < blocks.length;) {
          const a = blocks[m]!, b = blocks[m + 1]!, off = a.span + gap;
          if (a.desired + off <= b.desired + PLACEMENT_EPS) { m++; continue; }
          blocks.splice(m, 2, {
            ids: [...a.ids, ...b.ids],
            desired: (a.desired * a.weight + (b.desired - off) * b.weight) / (a.weight + b.weight),
            weight: a.weight + b.weight,
            span: off + b.span,
          });
          if (m > 0) m--;
        }
        let cursor = run.wallLeft;
        const starts = blocks.map(b => { const x = Math.max(cursor, b.desired); cursor = x + b.span + gap; return x; });
        let high = run.wallRight;
        for (let m = blocks.length - 1; m >= 0; m--) {
          if (starts[m]! + blocks[m]!.span > high) starts[m] = Math.max(run.wallLeft, high - blocks[m]!.span);
          high = starts[m]! - gap;
        }
        for (const [m, b] of blocks.entries()) {
          let x = starts[m]!;
          for (const id of b.ids) {
            const group = model.groups[id]!;
            moveGroup(model, group, x - group.bounds!.x, 0);
            x += group.bounds!.width + gap;
          }
        }
      }
    };

    const feedStretch = (sides: readonly ('left' | 'right')[] | undefined): number => {
      const rowNodeSet = new Set(rowsK.flatMap(g => g.nodes));
      const corridorAt = new Map<LayoutLink, number>();
      for (const [m, link] of transitLinks.entries()) {
        const sx = centreOf(model, laneSource(model, link).node);
        const core = transitedCore(mainK, sx) ?? mainK[0]!;
        const half = laneWidth(model, link) / 2;
        const s = sides?.[m] ?? corridorSide(core.bounds!, sx);
        corridorAt.set(link, s === 'left' ? Math.min(sx, core.bounds!.x - half) : Math.max(sx, core.bounds!.x + core.bounds!.width + half));
      }
      const farNodes = new Set<string>();
      for (const tier of [tierUp, tierDown]) if (tier !== undefined) {
        for (const g of Object.values(model.groups)) if (!g.flank && g.tier === tier) for (const n of g.nodes) farNodes.add(n);
      }
      let total = 0;
      for (const far of farNodes) {
        const xs: number[] = [];
        for (const link of routedVertical) {
          const { from, to } = link.attachments!;
          if (from.node === far && rowNodeSet.has(to.node)) xs.push(centreOf(model, to.node));
          else if (to.node === far && rowNodeSet.has(from.node)) xs.push(centreOf(model, from.node));
        }
        for (const link of transitLinks) {
          if (link.attachments!.from.node === far || link.attachments!.to.node === far) xs.push(corridorAt.get(link)!);
        }
        if (xs.length > 1) total += Math.max(...xs) - Math.min(...xs);
      }
      return total;
    };

    const probeGroups = [...rowsK, ...runsDown.flatMap(r => r.groups)];
    const [low, high] = reach(probeGroups);
    const savedLedger = model.reservations;

    const evaluate = (sigma: readonly (readonly string[])[], rowOrders: readonly (readonly string[])[],
      sides: readonly ('left' | 'right')[] | undefined) => {
      const undo = saveGroups(model, probeGroups);
      let ok = true;
      for (const [i, row] of rowsK.entries()) {
        if (!sameOrder(rowOrders[i]!, orderOf(row)) && !reseatRow(model, row, [...rowOrders[i]!], true)) { ok = false; break; }
      }
      if (ok) {
        for (const [rIdx, run] of runsDown.entries()) seatRun(run.groups, sigma[rIdx]!);
        if (sides !== undefined && transitLinks.length > 0) {
          const tempSides = transitLinks.map((link, m) => {
            const core = transitedCore(mainK, centreOf(model, laneSource(model, link).node)) ?? mainK[0]!;
            return reservation('corridorSide', { kind: 'link', id: link.id }, String(tierK), 'skeleton', 0,
              { link: link.id, tier: tierK, group: core.id, side: sides[m]! });
          });
          model.reservations = [...(savedLedger ?? []), ...tempSides];
        }
        seatPredicted7c(sigma, sides);
      }
      const result = ok ? { ...measureRange(low, high, true), freeBlocked: freeRowBlocked(rowsK), stretch: feedStretch(sides) } : undefined;
      if (savedLedger === undefined) delete model.reservations; else model.reservations = savedLedger;
      undo();
      return result;
    };

    const baseSigma = runsDown.map(r => r.groups.map(g => g.id));
    const baseRowOrders = rowsK.map(r => orderOf(r));
    const baseline = evaluate(baseSigma, baseRowOrders, transitLinks.length > 0 ? baseSides : undefined);
    if (baseline === undefined) continue;

    interface ScoredCandidate {
      sigma: string[][];
      rowOrders: string[][];
      sides: ('left' | 'right')[] | undefined;
      score: NonNullable<ReturnType<typeof evaluate>>;
    }
    let best: ScoredCandidate | undefined;

    for (const sigma of sigmaCombos) {
      // Read ranks under `sigma` so free-row keys match the candidate outward group order.
      const undoDown = saveGroups(model, runsDown.flatMap(r => r.groups));
      for (const [rIdx, run] of runsDown.entries()) seatRun(run.groups, sigma[rIdx]!);
      const rankUp = tierRanks(tierUp), rankDown = tierRanks(tierDown);
      undoDown();

      const perRow = rowsK.map(row => rowFeedCandidates(row, rankUp, rankDown));
      const product = perRow.reduce((acc, list) => acc * list.length, 1);
      const rowCombos: string[][][] = product <= 16
        ? perRow.reduce<string[][][]>((acc, list) => acc.flatMap(prefix => list.map(ord => [...prefix, ord])), [[]])
        : [
          rowsK.map((_, i) => perRow[i]![0]!),
          ...Array.from({ length: Math.max(...perRow.map(l => l.length)) - 1 }, (_, mode) => rowsK.map((_, i) => perRow[i]![Math.min(mode + 1, perRow[i]!.length - 1)]!)),
          ...rowsK.flatMap((_, i) => perRow[i]!.slice(1).map(ord => rowsK.map((__, j) => i === j ? ord : perRow[j]![0]!))),
        ];

      const sigmaUnchanged = sigma.every((ids, rIdx) => sameOrder(ids, baseSigma[rIdx]!));
      const stepCovered = k !== at && spanned.has(k) && rowsK.every(r => r.nodes.length <= ROW_ORDER_PERMUTED_NODES);
      for (const rowOrders of rowCombos) {
        if (rowOrders.every((ord, i) => sameOrder(ord, baseRowOrders[i]!))) continue;
        // Do not undo a 2-tier corridor turn that `step` already committed back to its original order.
        if (rowOrders.some((ord, i) => {
          const orig = before.get(rowsK[i]!);
          return orig !== undefined && !sameOrder(orig, baseRowOrders[i]!) && sameOrder(orig, ord);
        })) continue;
        for (const sides of sideVectors) {
          if (stepCovered && sigmaUnchanged && (sides === undefined || sides.every((s, m) => s === baseSides[m]))) continue;
          const score = evaluate(sigma, rowOrders, sides);
          if (score === undefined) continue;
          if (score.straight < baseline.straight || score.blocked > baseline.blocked || score.freeBlocked > baseline.freeBlocked || score.crossings >= baseline.crossings) continue;
          const wins = best === undefined
            || (score.straight !== best.score.straight ? score.straight > best.score.straight
              : (score.blocked + score.freeBlocked) !== (best.score.blocked + best.score.freeBlocked) ? (score.blocked + score.freeBlocked) < (best.score.blocked + best.score.freeBlocked)
                : score.crossings !== best.score.crossings ? score.crossings < best.score.crossings
                  : score.stretch < best.score.stretch - PLACEMENT_EPS);
          if (wins) best = { sigma, rowOrders, sides, score };
        }
      }
    }

    if (best === undefined) continue;
    for (const [i, row] of rowsK.entries()) {
      if (!sameOrder(best.rowOrders[i]!, orderOf(row))) {
        if (!reseatRow(model, row, [...best.rowOrders[i]!], true)) throw new Error('A joint row order could not be seated again');
        jointMoved.add(row);
        moved = true;
      }
    }
    for (const [rIdx, run] of runsDown.entries()) {
      if (!sameOrder(best.sigma[rIdx]!, baseSigma[rIdx]!)) {
        seatRun(run.groups, best.sigma[rIdx]!);
        tierOrders.push({ tier: tierOut!, order: [...best.sigma[rIdx]!], rows: [...rowsK] });
        moved = true;
      }
    }
    if (best.sides !== undefined && transitLinks.length > 0) {
      for (const [m, link] of transitLinks.entries()) {
        const core = transitedCore(mainK, centreOf(model, laneSource(model, link).node)) ?? mainK[0]!;
        corridorSides.push(reservation('corridorSide', { kind: 'link', id: link.id }, String(tierK), 'skeleton', 0,
          { link: link.id, tier: tierK, group: core.id, side: best.sides[m]! }));
      }
    }
  }

  return { moved, jointMoved, tierOrders, corridorSides };
}
