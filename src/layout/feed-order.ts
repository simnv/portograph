import type { LayoutGroup, LayoutModel, RowOrderDecision } from '../model/layout.js';
import { frameSubtreeCells } from '../model/model.js';
import { groupShape } from './grid.js';
import { besideRows, tierRange } from './columns.js';
import { withdrawPullsAcrossFlips } from './corridor-order.js';
import { orderTools, reseatRow } from './overlay-order.js';
import { siblingSeatOrder } from './sibling-frames.js';
import { placementWarning } from './regions.js';
import { cellTier } from './read/tier.js';
import { groupOrderFailure, ofKind, reservation, rowOrderFailure, type Reservation, type ReservationOf, type RowFeed } from './reservations.js';
import { compareId } from './skeleton-graph.js';
import { openMemberFault, openScopeFault, openSlotHeld } from './read/open-member.js';
import { choosePairOrder, PAIR_ORDER_BOUND, PAIR_SEARCH_VISITS, type PairChoice } from './row-pairs.js';
import { rebuildBands } from './skeleton-geometry.js';

/** One unit of a fed row: a node of a rank cell, or the own cells or a child frame of a frame. `top` is its first sub-tier, `nodes` its nodes there. */
interface Unit { id: string; top: number; nodes: readonly string[] }
/** A decided row: its order, and the feeding rows with the order they were read in (the premise the entry stores). */
interface Decision { order: string[]; feeds: RowFeed[] }

/** A pair of rows ordered together (dense-16x9 ticket 32): the upper row's and the lower row's orders. */
interface PairOrders { upper: readonly string[]; lower: readonly string[] }

/** Two feed keys closer than this are one key: a mean of row positions differs by 1/n or more where it differs at all. */
const SAME_KEY = 1e-9;

/**
 * Order follows the feeds (architecture-2 ticket 25). The one writer of the ledger kind `rowOrder`.
 *
 * - **What is ordered.** The nodes of a rank cell (a `row` cell of two or more nodes that no flank stands beside), and the units of a frame
 *   that stand beside each other on its sub-tiers: the frame's own cells and its child frames (`besideRows`, the rows the column pack lays).
 *   A canton is author-fixed (decision D1): its members are not ordered, and the free rows keep the corridor order (ticket 17).
 * - **The feed key** of a unit is the mean position, in the feeding row, of the far ends of its routed links into the sub-tier directly
 *   above its first sub-tier: the rule reads downward feeds only. The feeding row is one group: when the feeds of a row come from two
 *   groups, their positions are not comparable before the frames are packed, and the feeds decide nothing there. A position is the index
 *   in the feeding row's order as it stands: the cells are judged top-down, so a cell reads the order this step gave the cell above it.
 * - **The order.** A row is decided when two of its units have different keys. A cell: its keyed nodes take the keyed slots in key order;
 *   a node without a feed keeps its slot, and two nodes with one key keep the order ELK gave them (its input is the declaration order, so a
 *   tie is broken by declaration order unless ELK's crossing reduction swapped the pair for the rows below). Two neighbours that a peer
 *   link (a routed link inside the cell) joins stay next to each other: the run moves as one block, keyed by the mean of its members'
 *   feeds, and ordered inside by their own keys. A frame row: every unit must have a key, and a tie keeps declaration order (the frame's
 *   own cells first, then its children in declaration order).
 * - **A top row** (dense-16x9 ticket 20): a row that no row above feeds (no routed link of a member ends in a sub-tier above it), a rank
 *   cell or a free row that the corridor step could not judge (`frame-columns`, or no record; no far-end pull, no group order of the joint
 *   order reading it), reads its feeds into the sub-tier directly below by the same rule, a tie keeping declaration order: a member
 *   linked to two hubs stands between their runs. A row fed from above, also from both sides, is not read from below. A turned free row
 *   records `feed-order`; its entry names the row (`row`). `layout.feedOrder: false` and `layout.corridorRowOrder: false` keep the
 *   authored order of every top row, a rank cell or a free row (`readsBelow`, the one test).
 * - **The reservation.** Each decided row is one `rowOrder` entry (`rowOrderOf` is the one reader), with its premise: the feeding rows and
 *   the order they were read in (`feeds`). A cell is re-seated in its order here (the replay of ELK's output); the column pack (`standOf`)
 *   stands a child frame on the side its entry names; the overlay order of the frames chains neither a reserved cell nor a feeding row
 *   (`feedingRowsOf`). A free row that a withdrawn pull turns after the frames are packed is read again (`refreshFeedOrders`).
 *   `validateFeedOrders`, and `validateReservations` on every later snapshot, check the order and its premise.
 *
 * - **A pair** (dense-16x9 ticket 32): a rank cell and the row below it that only it feeds are ordered together, to the fewest crossings of
 *   the links between them (`choosePairOrder`, an exact search bounded by `PAIR_ORDER_BOUND`, R4; past it `FEED_ORDER_PAIR_BOUND` names the
 *   pair and today's order stays). The cell's fed members keep their feed keys, the rest are free; an order that is a minimum stays (an
 *   earlier joint choice first, then today's) and is recorded as the joint choice. Each row gets one entry naming the other with its order
 *   (the joint premise). Stacked pairs (owner ruling, 32 review 1): pairs are judged top-down and a row a pair has judged is settled; as the
 *   upper row of the next pair its order is fixed (one key rank per member) and only the lower row moves. The top row above the cell
 *   decides first (top-down); the second round finds the joint choice still a minimum, so it stays.
 *
 * `layout.feedOrder: false` switches the step off (a test input whose subject needs the declared order pins it so).
 * One sort per row, and the bounded search of a pair. The row below a top row may read the top row in its turn, so the rows are judged again while a premise
 * breaks, at most one round per judged row and one more (R4); an entry still broken is withdrawn by name (`FEED_ORDER_WITHDRAWN`). Runs after the free-row orders of stage 4 and before the frames are
 * packed. The entries of an earlier run are replaced, so a placement re-run decides again on its own skeleton.
 */
export function orderByFeeds(model: LayoutModel): void {
  const kept = (model.reservations ?? []).filter(entry => entry.kind !== 'rowOrder');
  // `layout.feedOrder: false` keeps ELK's order of every cell, the overlay side of every child frame and the order of every top row: no entry is written.
  if (model.document.layout?.feedOrder === false) { if (model.reservations !== undefined) model.reservations = kept; return; }
  const read = reader(model), rows = read.rows(read.tops());
  const rules = new Map(rows.map(row => [row, row.rowOrderDecision?.rule]));
  let entries: Reservation[], moved = false;
  const chosen = new Map<string, PairOrders>();
  // A top row reads the row below, and that row may read the top row in its turn (a rank cell under it): the rows are judged again while
  // an entry's premise does not hold. R4: at most one round per judged row and one more; an entry still broken then is withdrawn by name.
  for (let round = 0; ; round++) {
    entries = [];
    const settled = new Map<string, number>();
    for (const row of rows) {
      const pair = judgePair(model, read, row, chosen.get(row.id), 'column', entries, settled, rules);
      if (pair !== undefined) { chosen.set(row.id, pair.orders); moved ||= pair.moved; continue; }
      // A row a pair above settled is not judged again (dense-16x9 ticket 32, ruling on stacked pairs).
      if (settled.has(row.id)) continue;
      const decision = read.row(row);
      if (decision === undefined) continue;
      if (!sameOrder(decision.order, row.rowOrder ?? row.nodes)) {
        // A cell may grow to the right over its neighbour: every group of a tier that holds a frame is laid by the column pack after this
        // step, and `placeFlanksAndPeers` then pushes any overlap apart (ELK can stack two linked members of a cell, which the rows stage
        // lays side by side). `reseatRow` with `'column'` refuses only at a flank, which the pack does not lay; a free row grows only into
        // the room its tier leaves. The refusal is named (R6).
        if (!reseatRow(model, row, decision.order, row.frame === undefined ? true : 'column')) { refused(model, row, decision.order); continue; }
        moved = true;
        turned(row, rules.get(row));
      }
      entries.push(rowEntry(row, decision));
    }
    const broken = entries.filter(entry => rowOrderFailure(entry, model) !== undefined);
    if (!broken.length) break;
    if (round >= rows.length) { withdraw(model, broken); entries = entries.filter(entry => !broken.includes(entry)); break; }
  }
  for (const id of read.frames()) {
    const decision = read.frame(id);
    if (decision !== undefined) entries.push(frameEntry(id, decision));
  }
  entries = entries.map(entry => withOpen(model, read, entry));
  // A model placed without a ledger (a stage test) gets one only when a feed decides a row.
  if (model.reservations !== undefined || entries.length) model.reservations = [...kept, ...entries];
  if (moved) rebuildBands(model, false);
}

/**
 * Reads the feed order again after a feeding row turned once the frames were packed (ticket 25 review: `withdrawPullsAcrossFlips` re-seats a
 * free row that may feed a cell). Every cell is judged again top-down, so a cell under a re-seated cell reads its new order: a cell whose
 * decision changed is re-seated inside the room its tier leaves (the frames stand packed now; a row that does not fit is refused by name,
 * `FEED_ORDER_REFUSED`, and its entry dropped), and a cell that the feeds no longer decide drops its entry. A frame entry, and the entry of
 * a free top row, whose premise changed and whose order the feeds still give takes the new premise; one the feeds now order otherwise is
 * dropped by name (`FEED_ORDER_WITHDRAWN`): the child stands where the pack laid it, the row as it stands. A top row's entry whose row below
 * the refresh then turned is dropped by name too. Returns whether the ledger or a cell changed.
 */
export function refreshFeedOrders(model: LayoutModel): boolean {
  if (model.document.layout?.feedOrder === false) return false;
  const read = reader(model), ledger = ofKind(model.reservations ?? [], 'rowOrder'), before = JSON.stringify(ledger);
  const kept = (model.reservations ?? []).filter(entry => entry.kind !== 'rowOrder');
  let entries: Reservation[] = [];
  let moved = false;
  // A free top row is not turned again here: it keeps an entry only where its feeds still give the order it stands in.
  const tops = ledger.flatMap(({ payload }) => 'row' in payload ? [model.groups[payload.row]!] : []);
  const settled = new Map<string, number>();
  for (const row of read.rows(tops)) {
    // A pair ordered together stays while its choice is still a minimum on the rows as they read now (dense-16x9 ticket 32).
    const pair = judgePair(model, read, row, read.pairOf(row, ledger), true, entries, settled);
    if (pair !== undefined) { moved ||= pair.moved; continue; }
    if (settled.has(row.id)) continue;
    const decision = read.row(row);
    if (row.frame === undefined) {
      if (decision !== undefined && sameOrder(decision.order, row.rowOrder ?? row.nodes)) entries.push(rowEntry(row, decision));
      else placementWarning(model, 'FEED_ORDER_WITHDRAWN', `The feeds of row ${row.id} no longer give the order it stands in: the row below it turned after the frames were packed. The order stands, with no reservation.`, [row.id], 'group');
      continue;
    }
    if (decision === undefined) continue;
    if (!sameOrder(decision.order, row.rowOrder ?? row.nodes)) {
      if (!reseatRow(model, row, decision.order, true)) { refused(model, row, decision.order); continue; }
      moved = true;
    }
    entries.push(rowEntry(row, decision));
  }
  const broken = entries.filter(entry => rowOrderFailure(entry, model) !== undefined);
  withdraw(model, broken);
  entries = entries.filter(entry => !broken.includes(entry));
  for (const entry of ledger) {
    if (!('frame' in entry.payload)) continue;
    const id = entry.payload.frame, decision = read.frame(id);
    if (decision !== undefined && sameOrder(decision.order, entry.payload.order)) { entries.push(frameEntry(id, decision)); continue; }
    placementWarning(model, 'FEED_ORDER_WITHDRAWN', `The feeds of frame ${id} no longer give the order its units were packed in (${entry.payload.order.join(', ')}): a feeding row turned after the pack. The order stands as packed, with no reservation.`, [id], 'group');
  }
  entries = entries.map(entry => withOpen(model, read, entry));
  model.reservations = [...kept, ...entries];
  const withdrawn = withdrawBrokenGroupOrders(model);
  if (moved) rebuildBands(model, false);
  return moved || JSON.stringify(entries) !== before || withdrawn;
}

/**
 * The guard after the frame order (ticket 25 re-check, R2): withdraws the far-end pulls the frame order put across, reads the feed orders
 * again, and repeats until a round withdraws no pull. A withdrawn pull turns a free row that may feed a cell, and the refresh can then
 * re-seat a cell that holds the far node of another row's pull, so that pull can stand across in its turn. R4: a round goes on only when
 * a pull was withdrawn, and a withdrawn row records no pull, so there are at most as many rounds as rows with a pull, and one more that
 * withdraws nothing; that count is the cap. Returns the number of rounds that withdrew a pull.
 */
export function settlePullsAndFeeds(model: LayoutModel): number {
  const budget = Object.values(model.groups).filter(group => group.rowOrderDecision?.pulledFrom !== undefined).length;
  let rounds = 0;
  while (rounds <= budget && withdrawPullsAcrossFlips(model)) {
    rounds++;
    refreshFeedOrders(model);
  }
  return rounds;
}

/**
 * Drops by name (R6, `FEED_ORDER_WITHDRAWN`) every group order of the joint order (ticket 72) that no longer holds: a turned free row broke
 * its premise, or the frame pack put its groups in another order. The groups stand as they stand. Returns whether an entry was dropped.
 * The refresh calls it, and stage 4 once more before its check, so a later step of stage 4 cannot leave a broken entry to the validator.
 */
export function withdrawBrokenGroupOrders(model: LayoutModel): boolean {
  const ledger = model.reservations ?? [];
  const broken = ofKind(ledger, 'groupOrder').filter(entry => {
    const why = groupOrderFailure(entry, model);
    if (why !== undefined) placementWarning(model, 'FEED_ORDER_WITHDRAWN', `The group order ${entry.payload.order.join(', ')} of sub-tier ${entry.payload.tier} is withdrawn: ${why}. The groups stand as they stand, with no reservation.`, [...entry.payload.order], 'group');
    return why !== undefined;
  });
  if (broken.length) model.reservations = ledger.filter(entry => !broken.includes(entry as never));
  return broken.length > 0;
}

/** The stage-4 check of the feed orders (R2, R5): every `rowOrder` and `groupOrder` entry of the ledger and its premise hold on the model as it stands. Reads the record, decides nothing again. */
export function validateFeedOrders(model: LayoutModel): string[] {
  const ledger = model.reservations ?? [];
  return [...ofKind(ledger, 'rowOrder'), ...ofKind(ledger, 'groupOrder')].flatMap(entry => {
    const why = rowOrderFailure(entry, model) ?? groupOrderFailure(entry, model);
    return why === undefined ? [] : [`Reservation ${entry.id} does not hold: ${why}`];
  });
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i]);
const cellEntry = (cell: string, { order, feeds }: Decision): ReservationOf<'rowOrder'> =>
  reservation('rowOrder', { kind: 'group', id: cell }, 'cell', 'skeleton', 0, { cell, order, feeds });
const frameEntry = (frame: string, { order, feeds }: Decision): ReservationOf<'rowOrder'> =>
  reservation('rowOrder', { kind: 'group', id: frame }, 'frame', 'skeleton', 0, { frame, order, feeds });
/** A rank cell's entry names the cell, a free top row's entry the row (dense-16x9 ticket 20). */
const rowEntry = (group: LayoutGroup, decision: Decision): ReservationOf<'rowOrder'> => group.frame !== undefined ? cellEntry(group.id, decision)
  : reservation('rowOrder', { kind: 'group', id: group.id }, 'row', 'skeleton', 0, { row: group.id, order: decision.order, feeds: decision.feeds });
/** The free row's stage-4 record follows its new order: `feed-order` while it stands off the order the corridor step left, else the rule that step gave. */
function turned(group: LayoutGroup, rule: RowOrderDecision['rule'] | undefined): void {
  const decision = group.rowOrderDecision;
  if (decision === undefined || rule === undefined || group.frame !== undefined) return;
  const after = [...(group.rowOrder ?? group.nodes)];
  group.rowOrderDecision = { ...decision, rule: sameOrder(decision.before, after) ? rule : 'feed-order', after };
}
/** The diagnostic of a member that keeps its slot because another slot would change what stage 4 decides below it (dense-16x9 ticket 36, slice 3). */
export const FEED_ORDER_SLOT_HELD = 'FEED_ORDER_SLOT_HELD';

/**
 * The cell entry with its open members (dense-16x9 ticket 36, slice 3; owner ruling 2 of 2026-11-17): with `layout.moveBeforeGrow`, a member whose
 * links all end in the sub-tier directly below (`openMemberFault`) and whose slot, at every other place in the row, leaves the decisions below the cell
 * as they are (`openSlotHeld` over `below`: the joint choice of the pair under it, the feed order of each row it feeds, the frame orders) is open. Stage 4 keeps the
 * order it chose; the seat set of the row closes the open slots at stage 6, inside this record. A member that only the decisions below hold is named
 * (`FEED_ORDER_SLOT_HELD`). An authored order opens nothing. Every slot is tried once per member: at most the row length times the members (R4).
 */
function withOpen(model: LayoutModel, read: Reader, entry: Reservation): Reservation {
  if (openScopeFault(model) !== undefined || entry.kind !== 'rowOrder' || !('cell' in entry.payload)) return entry;
  const cell = model.groups[entry.payload.cell], order = [...entry.payload.order];
  if (cell === undefined || order.length < 2) return entry;
  const today = read.below(cell, order), open: string[] = [];
  for (const node of order) {
    if (openMemberFault(model, cell, node) !== undefined) continue;
    const held = openSlotHeld(cell, node, order, read.below, today);
    if (held === undefined) { open.push(node); continue; }
    const message = `${node} keeps its slot in ${cell.id}: at place ${held + 1} of the row the rows below it would be ordered otherwise.`;
    if (!model.diagnostics.some(item => item.code === FEED_ORDER_SLOT_HELD && item.message === message))
      model.diagnostics.push({ stage: 'placement', severity: 'info', code: FEED_ORDER_SLOT_HELD, message, owners: [{ kind: 'group', id: cell.id }] });
  }
  return open.length ? reservation('rowOrder', { kind: 'group', id: cell.id }, 'cell', 'skeleton', 0, { ...entry.payload, open }) : entry;
}

function refused(model: LayoutModel, row: LayoutGroup, order: readonly string[]): void {
  placementWarning(model, 'FEED_ORDER_REFUSED', `Row ${row.id} cannot stand in the order its feeds give (${order.join(', ')}): it does not fit its room. The order it stands in stays, with no reservation.`, [row.id], 'group');
}
/**
 * Judges the pair whose upper row is `row` (dense-16x9 ticket 32). The pairs are judged top-down, and a row that a pair has judged is
 * settled for the pairs below it (ruling on stacked pairs): when `row` is the lower row of a pair above (`settled` holds the index of its
 * entry in `entries`), its order is fixed in its own pair, and only its lower row moves. Whenever the search gives an order (a new choice,
 * an earlier choice that stays, or today's order that is already a minimum), both rows are re-seated in it and the joint premise is
 * recorded: the lower row gets one entry naming the upper row with its order, and the upper row's entry names the lower row with its order
 * besides what it read before (the row above that feeds it, or the upper row of the pair above, whose entry it extends). Undefined when the
 * pair is not one (`read.pair`), when a bound or the keys stop the search (a bound is named, `FEED_ORDER_PAIR_BOUND`, R6), or when a row
 * does not fit its room (named, `FEED_ORDER_REFUSED`). A refused try gives back its whole write set: the order, the box and the node boxes
 * and anchors of both rows (32 review 1).
 */
function judgePair(model: LayoutModel, read: Reader, row: LayoutGroup, previous: PairOrders | undefined, mode: true | 'column',
  entries: Reservation[], settled: Map<string, number>, rules?: Map<LayoutGroup, RowOrderDecision['rule'] | undefined>): { orders: PairOrders; moved: boolean } | undefined {
  const at = settled.get(row.id), held = at === undefined ? undefined : entries[at] as ReservationOf<'rowOrder'>;
  const pair = read.pair(row, previous, held?.payload.order);
  if (pair === undefined) return undefined;
  const { choice, lower, above } = pair;
  if (choice.kind === 'bound') bounded(model, row, lower, choice);
  if (choice.kind !== 'chosen' && choice.kind !== 'stays' && choice.kind !== 'kept') return undefined;
  const orders = { upper: choice.upper, lower: choice.lower };
  if (rules !== undefined && !rules.has(lower)) rules.set(lower, lower.rowOrderDecision?.rule);
  const restore = rowsSnapshot(model, [row, lower]);
  const turning: LayoutGroup[] = [];
  for (const [group, order] of [[row, orders.upper], [lower, orders.lower]] as const) {
    if (sameOrder(order, group.rowOrder ?? group.nodes)) continue;
    if (!reseatRow(model, group, [...order], group.frame === undefined ? true : mode)) {
      restore();
      refused(model, group, order);
      return undefined;
    }
    turning.push(group);
  }
  if (rules !== undefined) for (const group of turning) turned(group, rules.get(group));
  const moved = turning.length > 0;
  const down = { row: lower.id, order: [...orders.lower] };
  const upperEntry = rowEntry(row, { order: [...orders.upper], feeds: held !== undefined ? [...held.payload.feeds, down] : [...(above === undefined ? [] : [above]), down] });
  if (at !== undefined) entries[at] = upperEntry; else entries.push(upperEntry);
  settled.set(lower.id, entries.push(rowEntry(lower, { order: [...orders.lower], feeds: [{ row: row.id, order: [...orders.upper] }] })) - 1);
  return { orders, moved };
}
/** Everything a re-seat of the rows writes (`reseatRow`): each row's order and box, and its nodes' boxes and port anchors; the restore puts them back exactly. */
function rowsSnapshot(model: LayoutModel, rows: readonly LayoutGroup[]): () => void {
  const saved = rows.map(group => ({ group, order: group.rowOrder === undefined ? undefined : [...group.rowOrder], bounds: { ...group.bounds! },
    nodes: group.nodes.map(id => ({ node: model.nodes[id]!, bounds: { ...model.nodes[id]!.bounds! }, anchors: model.nodes[id]!.ports.map(port => port.anchor && { ...port.anchor }) })) }));
  return () => {
    for (const item of saved) {
      if (item.order === undefined) delete item.group.rowOrder; else item.group.rowOrder = item.order;
      item.group.bounds = { ...item.bounds };
      for (const entry of item.nodes) {
        entry.node.bounds = { ...entry.bounds };
        entry.node.ports.forEach((port, i) => { const anchor = entry.anchors[i]; if (anchor) port.anchor = { ...anchor }; });
      }
    }
  };
}
function bounded(model: LayoutModel, row: LayoutGroup, lower: LayoutGroup, choice: Extract<PairChoice, { kind: 'bound' }>): void {
  const message = choice.reason === 'orders'
    ? `The rows ${row.id} and ${lower.id} have more than ${PAIR_ORDER_BOUND} joint orders (at least ${choice.count}): they are not ordered together, and today's order stays.`
    : `The search for the joint order of the rows ${row.id} and ${lower.id} visits more than ${PAIR_SEARCH_VISITS} prefixes: they are not ordered together, and today's order stays.`;
  if (!model.diagnostics.some(item => item.code === 'FEED_ORDER_PAIR_BOUND' && item.message === message)) placementWarning(model, 'FEED_ORDER_PAIR_BOUND', message, [row.id, lower.id], 'group');
}
function withdraw(model: LayoutModel, entries: readonly Reservation[]): void {
  for (const entry of entries) {
    if (entry.kind !== 'rowOrder') continue;
    const id = 'cell' in entry.payload ? entry.payload.cell : 'row' in entry.payload ? entry.payload.row : entry.payload.frame;
    placementWarning(model, 'FEED_ORDER_WITHDRAWN', `The feed order of ${id} is withdrawn: ${rowOrderFailure(entry, model)}. The row stands as it stands, with no reservation.`, [id], 'group');
  }
}

type Reader = ReturnType<typeof reader>;
/**
 * What an order of a rank cell decides below it, read by stage 4's own reader (`below`: the pair under it, the feed order of each row it feeds, the
 * frame orders). The seat set reads it for each order its slot choice tries at stage 6 (dense-16x9 ticket 36, slice 3): an order whose signature
 * differs from the cell's own is no candidate. Topology only; one reader per model.
 */
export function belowReader(model: LayoutModel): (cell: LayoutGroup, order: readonly string[]) => string {
  return reader(model).below;
}
/** What the writer and the refresh read: the eligible cells and frames in their judging order, and the decision of each. */
function reader(model: LayoutModel) {
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const placed = Object.values(model.groups).filter(group => !group.flank && group.nodes.length > 0 && group.tier !== undefined);
  const tiers = [...new Set(placed.map(group => group.tier!))].sort((a, b) => a - b);
  const above = (tier: number): number | undefined => tiers[tiers.indexOf(tier) - 1];
  const below = (tier: number): number | undefined => tiers[tiers.indexOf(tier) + 1];
  const ends = routedEnds(model);
  // The orders a pair judgement assumes for a row it has not re-seated yet (dense-16x9 ticket 32): today's order of the lower row is read
  // under today's order of the upper row.
  const assumed = new Map<string, readonly string[]>();
  const orderOf = (group: LayoutGroup): string[] => [...(assumed.get(group.id) ?? group.rowOrder ?? group.nodes)];
  const declared = new Map(Object.keys(model.document.nodes).map((node, at) => [node, at]));
  const isRow = (group: LayoutGroup): boolean => groupShape(model, group.id) === 'row' && model.document.groups[group.id]?.shape !== 'bar';
  // A row a flank stands beside is re-packed after this step (its primary peer goes to the outer end): it is no feeding row, and no cell to order.
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  /**
   * The key of each unit (`undefined`: no feed) and the feeding row, read in the sub-tier `toward` names (the one above, or the one below
   * for a top row); the whole answer `undefined` when the feeds come from more than one row, or no row.
   */
  const keysOf = (units: readonly Unit[], toward: (tier: number) => number | undefined = above): { keys: Map<string, number | undefined>; feed: RowFeed } | undefined => {
    let row: LayoutGroup | undefined;
    const feeds = new Map<string, string[]>();
    for (const unit of units) {
      const tier = toward(unit.top);
      const far = tier === undefined ? [] : unit.nodes.flatMap(node => (ends.get(node) ?? []).filter(other => groupOf(other).tier === tier));
      for (const other of far) {
        const group = groupOf(other);
        if (group.flank || flanked.has(group.id) || !isRow(group) || (row !== undefined && row !== group)) return undefined;
        row = group;
      }
      feeds.set(unit.id, far);
    }
    if (row === undefined) return undefined;
    const order = orderOf(row);
    return {
      keys: new Map(units.map(unit => { const far = feeds.get(unit.id)!; return [unit.id, far.length ? far.reduce((sum, node) => sum + order.indexOf(node), 0) / far.length : undefined]; })),
      feed: { row: row.id, order },
    };
  };
  const decided = (keys: ReadonlyMap<string, number | undefined>): boolean => {
    const values = [...keys.values()].filter((key): key is number => key !== undefined);
    return values.some(key => Math.abs(key - values[0]!) > SAME_KEY);
  };
  const byKey = (keys: ReadonlyMap<string, number | undefined>, order: readonly string[]) => (a: string, b: string): number => {
    const d = keys.get(a)! - keys.get(b)!;
    // Last key: the place in `order` (R3: ELK's order of a cell, the declaration order of a frame row).
    return Math.abs(d) > SAME_KEY ? d : order.indexOf(a) - order.indexOf(b);
  };
  /** Whether a routed link of the row ends in a row above it: a row fed from above (from both sides too) never reads the row below. */
  const fedFromAbove = (group: LayoutGroup): boolean => group.nodes.some(node => (ends.get(node) ?? []).some(other => (groupOf(other).tier ?? Infinity) < group.tier!));
  /**
   * The one test of whether a row reads its feeds from the row below (dense-16x9 ticket 20), for every kind of row: a rank cell and a free
   * row alike. Only a top row does, and an authored order stands: `layout.feedOrder: false` (no feed order at all) and
   * `layout.corridorRowOrder: false` (the order the skeleton gave a row that no row above orders) each keep it. A cell fed from above is
   * not asked: its downward feed order answers to `feedOrder` only, as before.
   */
  const authored = model.document.layout?.feedOrder === false || model.document.layout?.corridorRowOrder === false;
  const readsBelow = (group: LayoutGroup): boolean => !authored && !fedFromAbove(group);
  /**
   * The order of a row by the keys `toward` reads: the blocks of peer neighbours take the order of their keys, the members of a block the
   * order of their own keys; a member with no key keeps its slot; `tie` breaks an equal key.
   */
  const ordered = (row: LayoutGroup, toward: (tier: number) => number | undefined, tie: (items: readonly string[]) => readonly string[]): Decision | undefined => {
    const order = orderOf(row);
    const read = keysOf(order.map(node => ({ id: node, top: row.tier!, nodes: [node] })), toward);
    if (read === undefined || !decided(read.keys)) return undefined;
    const { keys } = read;
    // A peer pair that stands side by side stays side by side: a run of neighbours that routed links inside the row join is one block.
    const blocks = peerBlocks(order, ends);
    const blockKeys = keysOf(blocks.map(block => ({ id: block[0]!, top: row.tier!, nodes: block })), toward)!.keys;
    if (!decided(blockKeys) && !blocks.some(block => decided(new Map(block.map(node => [node, keys.get(node)]))))) return undefined;
    const inner = new Map(blocks.map(block => [block[0]!, slotSort(block, keys, byKey(keys, tie(block)))]));
    const heads = blocks.map(block => block[0]!);
    // A cell that stage 4 seated for its sibling-frame links keeps its seat: the feeds order the members between the two seated blocks (dense-16x9 ticket 06).
    return { order: siblingSeatOrder(model, row.id, slotSort(heads, blockKeys, byKey(blockKeys, tie(heads))).flatMap(head => inner.get(head)!)), feeds: [read.feed] };
  };
  /**
   * The order the feeds give a row: a row that a row above feeds (a rank cell) reads the feeds from above, a tie keeping the order it stands
   * in (ELK's); a row that no row above feeds reads its feeds into the row below when `readsBelow` lets it (dense-16x9 ticket 20), a tie
   * keeping declaration order.
   */
  const rowDecision = (row: LayoutGroup): Decision | undefined => readsBelow(row) ? ordered(row, below, () => row.nodes)
    : fedFromAbove(row) && row.frame !== undefined ? ordered(row, above, items => items) : undefined;
  const { freeRow } = orderTools(model);
  const joint = new Set(ofKind(model.reservations ?? [], 'groupOrder').flatMap(({ payload }) => payload.feeds.map(feed => feed.row)));
  /**
   * The row a rank cell's links down all reach, when only that cell feeds it from above and a rule here may order it (dense-16x9 ticket 32):
   * a rank cell, or a free row the corridor step could not judge (as for a top row), with no far-end pull and no group order reading it.
   * A free row this pair turned before (`joined`: an earlier joint choice of the pair, from the round before or the ledger) records
   * `feed-order` and stays the pair's lower row; a row another rule judged does not (32 review 1).
   */
  const lowerOf = (row: LayoutGroup, joined: boolean): LayoutGroup | undefined => {
    const tier = below(row.tier!);
    let lower: LayoutGroup | undefined;
    for (const node of row.nodes) for (const other of ends.get(node) ?? []) {
      const group = groupOf(other);
      if (tier === undefined || group.tier !== tier) continue;
      if (lower !== undefined && lower !== group) return undefined;
      lower = group;
    }
    if (lower === undefined || lower.flank || flanked.has(lower.id) || !isRow(lower)) return undefined;
    if (lower.frame === undefined && (!freeRow(lower) || joint.has(lower.id) || lower.rowOrderDecision?.pulledFrom !== undefined
      || lower.rowOrderDecision !== undefined && lower.rowOrderDecision.rule !== 'frame-columns' && !(joined && lower.rowOrderDecision.rule === 'feed-order'))) return undefined;
    const inside = new Set(row.nodes);
    const fedElsewhere = lower.nodes.some(node => (ends.get(node) ?? []).some(other => (groupOf(other).tier ?? Infinity) < lower!.tier! && !inside.has(other)));
    return fedElsewhere ? undefined : lower;
  };
  /**
   * The joint order of a rank cell and the row below it that only it feeds (dense-16x9 ticket 32, `choosePairOrder`), or undefined when the
   * two are no such pair or an authored order stands (`readsBelow`'s test). The members the row above feeds keep their feed keys; the
   * unfed members are free. Today's order is what the one-row rules give: the cell's, and the lower row's read under it. A cell that a pair
   * above settled (`fixed`) keeps that order: it goes in as the keys, one rank per member, so only the lower row moves.
   */
  const pairOf = (row: LayoutGroup, previous?: PairOrders, fixed?: readonly string[]): { choice: PairChoice; lower: LayoutGroup; above: RowFeed | undefined } | undefined => {
    if (authored || row.frame === undefined || !isRow(row) || flanked.has(row.id)) return undefined;
    const lower = lowerOf(row, previous !== undefined);
    // Each row has two members or more: a row of one has no order to record (a `rowOrder` entry holds two or more).
    if (lower === undefined || row.nodes.length < 2 || lower.nodes.length < 2) return undefined;
    const fed = fixed === undefined && fedFromAbove(row) ? keysOf(row.nodes.map(node => ({ id: node, top: row.tier!, nodes: [node] }))) : undefined;
    if (fixed === undefined && fedFromAbove(row) && fed === undefined) return undefined;
    const upper = fixed !== undefined ? [...fixed] : rowDecision(row)?.order ?? orderOf(row);
    assumed.set(row.id, upper);
    const today = (lower.frame === undefined ? undefined : rowDecision(lower)?.order) ?? orderOf(lower);
    assumed.delete(row.id);
    const inUpper = new Set(row.nodes), inLower = new Set(lower.nodes), members = new Set([...row.nodes, ...lower.nodes]);
    const links: [string, string][] = [], peers: [string, string][] = [];
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.meshBus !== undefined || !link.attachments) continue;
      const a = link.attachments.from.node, b = link.attachments.to.node;
      if (a === b) continue;
      if (inUpper.has(a) && inLower.has(b)) links.push([a, b]);
      else if (inUpper.has(b) && inLower.has(a)) links.push([b, a]);
      else if (inUpper.has(a) && inUpper.has(b) || inLower.has(a) && inLower.has(b)) peers.push([a, b]);
    }
    const outside = new Map<string, string[]>();
    for (const node of members) for (const other of ends.get(node) ?? []) if (!members.has(other)) outside.set(other, [...(outside.get(other) ?? []), node]);
    const feeders = [...outside.keys()].sort(compareId).map(node => outside.get(node)!);
    const tierAbove = above(row.tier!);
    const fromAbove = fixed !== undefined ? [] : [...outside.keys()].sort(compareId).filter(node => groupOf(node).tier === tierAbove)
      .map(node => [...new Set(outside.get(node)!.filter(item => inUpper.has(item)))]).filter(items => items.length > 1);
    // The keys go to the search as ranks: two keys within `SAME_KEY` are one rank.
    const values = [...(fed?.keys ?? new Map<string, number | undefined>())].filter((entry): entry is [string, number] => entry[1] !== undefined);
    const distinct = [...new Set(values.map(([, key]) => key))].sort((a, b) => a - b).filter((key, at, all) => at === 0 || key - all[at - 1]! > SAME_KEY);
    const keys = fixed !== undefined ? new Map(fixed.map((node, rank) => [node, rank]))
      : new Map(values.map(([node, key]) => [node, distinct.filter(value => value <= key + SAME_KEY).length - 1]));
    const choice = choosePairOrder({ upper, lower: today, links, peers, keys, above: fromAbove, feeders, declared, ...(previous === undefined ? {} : { previous }) });
    // A cell that stage 4 seated for its sibling-frame links keeps its seat (dense-16x9 ticket 06): a joint order that would move it is not taken.
    if ((choice.kind === 'chosen' || choice.kind === 'stays' || choice.kind === 'kept') && [[row, choice.upper], [lower, choice.lower]].some(([group, order]) =>
      (group as LayoutGroup).frame !== undefined && !sameOrder(siblingSeatOrder(model, (group as LayoutGroup).id, order as string[]), order as string[]))) return undefined;
    return { choice, lower, above: fed?.feed };
  };
  const frames = model.document.frames ?? {};
  const nodesAt = (cells: readonly string[], tier: number): string[] => cells.filter(cell => cellTier(model, cell) === tier).flatMap(cell => model.groups[cell]!.nodes);
  const tools = {
    /** The frames with children, by id; a canton is author-fixed (D1). */
    frames: (): string[] => Object.keys(frames).filter(id => frames[id]!.kind !== 'canton' && Object.values(frames).some(frame => frame.parent === id)).sort(compareId),
    /**
     * The free rows the feeds below may order (dense-16x9 ticket 20): a free row of two or more nodes that no row above feeds and that the
     * corridor step could not judge (`frame-columns`: its turn changes a region with a frame cell; or no record: no anchor tier), with no
     * far-end pull and no group order of the joint order reading it. A row the corridor step judged keeps its measured order: the feed order
     * was among its candidates and crossed no less. An authored order stands (`readsBelow`).
     */
    tops: (): LayoutGroup[] => placed.filter(group => group.nodes.length > 1 && freeRow(group)
      && !joint.has(group.id) && readsBelow(group) && group.rowOrderDecision?.pulledFrom === undefined
      && (group.rowOrderDecision === undefined || group.rowOrderDecision.rule === 'frame-columns')),
    /** The cells a feed may order and the given free top rows, in their judging order: top-down, by id within a sub-tier, so a row reads the order this step gave the row above it. */
    rows: (tops: readonly LayoutGroup[]): LayoutGroup[] => [...placed.filter(group => group.frame !== undefined && group.nodes.length > 1 && isRow(group) && !flanked.has(group.id)), ...tops]
      .sort((a, b) => a.tier! - b.tier! || compareId(a.id, b.id)),
    /**
     * The order the feeds give a row: a row that a row above feeds (a rank cell) reads the feeds from above, a tie keeping the order it stands
     * in (ELK's); a row that no row above feeds reads its feeds into the row below when `readsBelow` lets it (dense-16x9 ticket 20), a tie
     * keeping declaration order.
     */
    row: rowDecision,
    pair: (row: LayoutGroup, previous?: PairOrders, fixed?: readonly string[]) => pairOf(row, previous, fixed),
    /** The earlier joint choice of the pair whose upper row is `row`, read off its ledger entry (it names the lower row as a feed). */
    pairOf: (row: LayoutGroup, ledger: readonly ReservationOf<'rowOrder'>[]): PairOrders | undefined => {
      const entry = ledger.find(({ payload }) => 'cell' in payload && payload.cell === row.id);
      const tier = below(row.tier!), feed = entry?.payload.feeds.find(item => model.groups[item.row]?.tier === tier);
      return entry === undefined || feed === undefined ? undefined : { upper: entry.payload.order, lower: feed.order };
    },
    frame: (id: string): Decision | undefined => {
      const tierOf = (cell: string): number => cellTier(model, cell);
      const blocks = Object.keys(frames).filter(child => frames[child]!.parent === id).map(child => { const [low, high] = tierRange(model, child); return { child, low, high }; });
      const { own, rows } = besideRows(frames[id]!.cells, tierOf, blocks, block => [block.low, block.high]);
      const lines: Unit[][] = rows.map(row => row.map(block => ({ id: block.child, top: block.low, nodes: nodesAt(frameSubtreeCells(frames, block.child), block.low) })));
      if (own.length) {
        const standing = frames[id]!.cells.filter(cell => own.some(block => tierOf(cell) >= block.low && tierOf(cell) <= block.high));
        const top = Math.min(...standing.map(tierOf));
        lines.unshift([{ id, top, nodes: nodesAt(standing, top) }, ...own.map(block => ({ id: block.child, top: block.low, nodes: nodesAt(frameSubtreeCells(frames, block.child), block.low) }))]);
      }
      const order: string[] = [], feeds: RowFeed[] = [];
      for (const line of lines) {
        const read = keysOf(line);
        if (read === undefined || [...read.keys.values()].some(key => key === undefined) || !decided(read.keys)) continue;
        const declared = line.map(unit => unit.id);
        order.push(...[...declared].sort(byKey(read.keys, declared)));
        feeds.push(read.feed);
      }
      return order.length ? { order, feeds } : undefined;
    },
  };
  return {
    ...tools,
    /**
     * What stage 4 decides below the cell `cell` when it stands in `order` (dense-16x9 ticket 36, slice 3), as one signature: the joint choice of the
     * pair whose upper row is `cell`, with `order` fixed (the lower order and its crossings), the order the feeds give each row of the sub-tier below
     * that `cell` feeds, and the order of every frame. Two orders with one signature decide the same below them; it reads topology only.
     */
    below: (cell: LayoutGroup, order: readonly string[]): string => {
      const pair = tools.pair(cell, undefined, order)?.choice;
      const pairSig = pair === undefined ? null : pair.kind === 'bound' || pair.kind === 'infeasible' ? pair.kind : [[...pair.lower], pair.crossings ?? null];
      const tier = below(cell.tier!), inside = new Set(cell.nodes);
      assumed.set(cell.id, [...order]);
      try {
        const rows = placed.filter(group => tier !== undefined && group.tier === tier && group.nodes.some(node => (ends.get(node) ?? []).some(other => inside.has(other))))
          .sort((a, b) => compareId(a.id, b.id)).map(group => [group.id, rowDecision(group)?.order ?? null]);
        return JSON.stringify([pairSig, rows, tools.frames().map(id => [id, tools.frame(id)?.order ?? null])]);
      } finally { assumed.delete(cell.id); }
    },
  };
}

/** The routed far ends of each node, the one input of the feed keys and of the peer blocks: a link to itself, a mesh bus member and an overlay link feed nothing. */
export function routedEnds(model: LayoutModel): Map<string, string[]> {
  const ends = new Map<string, string[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.meshBus !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    if (from.node === to.node) continue;
    ends.set(from.node, [...(ends.get(from.node) ?? []), to.node]);
    ends.set(to.node, [...(ends.get(to.node) ?? []), from.node]);
  }
  return ends;
}

/**
 * The runs of a cell whose neighbours a routed link inside the cell joins (peer links), as blocks in the order they stand: a peer pair that
 * stands side by side keeps standing side by side. A pair with a member between it is no block (the member stands on its link, which the
 * order then keeps as it is). A member with no such neighbour is a block of one.
 */
export function peerBlocks(order: readonly string[], ends: ReadonlyMap<string, readonly string[]>): string[][] {
  const blocks: string[][] = [];
  for (const [i, node] of order.entries()) {
    if (i > 0 && (ends.get(order[i - 1]!) ?? []).includes(node)) blocks[blocks.length - 1]!.push(node); else blocks.push([node]);
  }
  return blocks;
}

/** `items` with the keyed ones in the keyed slots, in the order `compare` gives (`byKey`); an item with no key keeps its slot. */
function slotSort(items: readonly string[], keys: ReadonlyMap<string, number | undefined>, compare: (a: string, b: string) => number): string[] {
  const queue = items.filter(item => keys.get(item) !== undefined).sort(compare);
  return items.map(item => keys.get(item) === undefined ? item : queue.shift()!);
}
