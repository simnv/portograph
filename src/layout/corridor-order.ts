import type { Diagnostic, LayoutGroup, LayoutModel, RowOrderDecision } from '../model/layout.js';
import { ownsTransitLanes, selectAnchorTier } from './lanes.js';
import { orderTools, readDraft, reseatRow, saveGroups } from './overlay-order.js';
import { compareId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { straightLengthLimit } from './row-paths.js';
import { rebuildBands } from './skeleton-geometry.js';
import { jointRecord, orderJointFreeRows, type JointBudget } from './joint-order.js';
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
    // A placement re-run decides the joint order again on its own skeleton (ticket 72): the entries of an earlier run are dropped.
    model.reservations = model.reservations.filter(entry => entry.kind !== 'corridorSide' && entry.kind !== 'groupOrder');
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

  const caps = new Set<string>(), budget: JointBudget = { spent: 0, limit: ROW_ORDER_BUDGET, caps };
  let moved = false;
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
    if (budget.spent + candidates.length > ROW_ORDER_BUDGET) {
      caps.add(`the sheet spent its budget of ${ROW_ORDER_BUDGET} candidates`);
      candidates = candidates.slice(0, Math.max(0, ROW_ORDER_BUDGET - budget.spent));
    }
    if (!candidates.length) return;
    budget.spent += candidates.length;
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

  // The joint order (ticket 72): a free row with the group order of the outward sub-tier and the corridor sides, on the budget the sweeps left.
  const joint = model.document.layout?.feedOrder === false ? undefined
    : orderJointFreeRows(model, draft, turnable, movable, frameBound, before, spanned, ROW_ORDER_PERMUTED_NODES, budget);
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

  // The record is written after the pull, so the premise of a group order is the order its free rows stand in now.
  const entries = joint === undefined ? [] : jointRecord(joint);
  if (entries.length) model.reservations = [...(model.reservations ?? []), ...entries];

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
