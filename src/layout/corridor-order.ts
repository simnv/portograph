import type { Diagnostic, LayoutGroup, LayoutModel, RowOrderDecision } from '../model/layout.js';
import { ownsTransitLanes, selectAnchorTier } from './lanes.js';
import { orderTools, readDraft, reseatRow, saveGroups } from './overlay-order.js';
import { compareId } from './skeleton-graph.js';
import { rebuildBands } from './skeleton-geometry.js';

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
 * crossings of `readDraft` (each transit link cut at its predicted corridor).
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
 *
 * Every free row of two or more nodes gets `rowOrderDecision`, also when the order stands; `validateRowOrderDecisions` reads it.
 * The document setting `layout.corridorRowOrder: false` keeps every row as the skeleton gave it (rule `author`), for a sheet whose
 * author wants the declared order (R9: a per-sheet setting).
 */
export function orderByCorridors(model: LayoutModel): void {
  const draft = readDraft(model);
  if (draft === undefined) return;
  const { anchor, tiers, index, measureRange, reach } = draft;
  const { freeRow } = orderTools(model);
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

  // A row whose turn can change a region that holds a frame cell is left out: the frame columns are packed after this step
  // (`placeFlanksAndPeers`), so the draft does not hold the x the frames will stand at, and a corridor predicted against it is not
  // the one 7a reserves (ticket 17 review). The row records `frame-columns`.
  const framed = new Set(Object.values(model.groups).filter(group => group.frame !== undefined && group.bounds !== undefined).map(group => index.get(group.tier!)!));
  const frameBound = new Set(free.filter(group => { const [low, high] = reach([group]); return [...framed].some(k => k >= low && k <= high); }));
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

  for (const [group, order] of before) {
    const after = orderOf(group);
    const decision: RowOrderDecision = { rule: frameBound.has(group) ? 'frame-columns' : sameOrder(order, after) ? 'kept' : 'corridor-crossings', before: order, after };
    group.rowOrderDecision = decision;
  }
  for (const reason of caps) {
    const note: Diagnostic = { stage: 'placement', severity: 'info', code: 'ROW_ORDER_SEARCH_CAPPED', message: `The corridor row order judged fewer candidates: ${reason}.` };
    model.diagnostics.push(note);
  }
  if (moved) rebuildBands(model, false);
}

/**
 * The stage-4 validator of `rowOrderDecision` (R1, R5): it reads the record and the row order, and never runs the search again.
 * A recorded row stands in the order the record names; `before` and `after` are orders of the row's own nodes; `kept` and `author`
 * name one order twice and `corridor-crossings` two different orders; `author` stands exactly when the document sets
 * `layout.corridorRowOrder: false`; only a free row carries a record, and every free row of two or more nodes carries one when the
 * sheet has an anchor tier.
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
    if ((decision.rule !== 'corridor-crossings') !== sameOrder(decision.before, decision.after)) errors.push(`The row order decision of ${group.id} is ${decision.rule}, and its before and after orders contradict it`);
    if ((decision.rule === 'author') !== (model.document.layout?.corridorRowOrder === false)) errors.push(`The row order decision of ${group.id} is ${decision.rule}, and the document setting corridorRowOrder contradicts it`);
    if (!sameOrder(group.rowOrder ?? group.nodes, decision.after)) errors.push(`Group ${group.id} stands in an order its row order decision does not name`);
  }
  return errors;
}
