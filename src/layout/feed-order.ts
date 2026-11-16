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
import { rebuildBands } from './skeleton-geometry.js';

/** One unit of a fed row: a node of a rank cell, or the own cells or a child frame of a frame. `top` is its first sub-tier, `nodes` its nodes there. */
interface Unit { id: string; top: number; nodes: readonly string[] }
/** A decided row: its order, and the feeding rows with the order they were read in (the premise the entry stores). */
interface Decision { order: string[]; feeds: RowFeed[] }

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
 *   records `feed-order`; its entry names the row (`row`). `layout.corridorRowOrder: false` keeps a free top row's authored order.
 * - **The reservation.** Each decided row is one `rowOrder` entry (`rowOrderOf` is the one reader), with its premise: the feeding rows and
 *   the order they were read in (`feeds`). A cell is re-seated in its order here (the replay of ELK's output); the column pack (`standOf`)
 *   stands a child frame on the side its entry names; the overlay order of the frames chains neither a reserved cell nor a feeding row
 *   (`feedingRowsOf`). A free row that a withdrawn pull turns after the frames are packed is read again (`refreshFeedOrders`).
 *   `validateFeedOrders`, and `validateReservations` on every later snapshot, check the order and its premise.
 *
 * `layout.feedOrder: false` switches the step off (a test input whose subject needs the declared order pins it so).
 * No search: one sort per row. The row below a top row may read the top row in its turn, so the rows are judged again while a premise
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
  // A top row reads the row below, and that row may read the top row in its turn (a rank cell under it): the rows are judged again while
  // an entry's premise does not hold. R4: at most one round per judged row and one more; an entry still broken then is withdrawn by name.
  for (let round = 0; ; round++) {
    entries = [];
    for (const row of rows) {
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
  for (const row of read.rows(tops)) {
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
function refused(model: LayoutModel, row: LayoutGroup, order: readonly string[]): void {
  placementWarning(model, 'FEED_ORDER_REFUSED', `Row ${row.id} cannot stand in the order its feeds give (${order.join(', ')}): it does not fit its room. The order it stands in stays, with no reservation.`, [row.id], 'group');
}
function withdraw(model: LayoutModel, entries: readonly Reservation[]): void {
  for (const entry of entries) {
    if (entry.kind !== 'rowOrder') continue;
    const id = 'cell' in entry.payload ? entry.payload.cell : 'row' in entry.payload ? entry.payload.row : entry.payload.frame;
    placementWarning(model, 'FEED_ORDER_WITHDRAWN', `The feed order of ${id} is withdrawn: ${rowOrderFailure(entry, model)}. The row stands as it stands, with no reservation.`, [id], 'group');
  }
}

/** What the writer and the refresh read: the eligible cells and frames in their judging order, and the decision of each. */
function reader(model: LayoutModel) {
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const placed = Object.values(model.groups).filter(group => !group.flank && group.nodes.length > 0 && group.tier !== undefined);
  const tiers = [...new Set(placed.map(group => group.tier!))].sort((a, b) => a - b);
  const above = (tier: number): number | undefined => tiers[tiers.indexOf(tier) - 1];
  const below = (tier: number): number | undefined => tiers[tiers.indexOf(tier) + 1];
  const ends = routedEnds(model);
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
    const order = [...(row.rowOrder ?? row.nodes)];
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
   * The order of a row by the keys `toward` reads: the blocks of peer neighbours take the order of their keys, the members of a block the
   * order of their own keys; a member with no key keeps its slot; `tie` breaks an equal key.
   */
  const ordered = (row: LayoutGroup, toward: (tier: number) => number | undefined, tie: (items: readonly string[]) => readonly string[]): Decision | undefined => {
    const order = [...(row.rowOrder ?? row.nodes)];
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
  const { freeRow } = orderTools(model);
  const joint = new Set(ofKind(model.reservations ?? [], 'groupOrder').flatMap(({ payload }) => payload.feeds.map(feed => feed.row)));
  const frames = model.document.frames ?? {};
  const nodesAt = (cells: readonly string[], tier: number): string[] => cells.filter(cell => cellTier(model, cell) === tier).flatMap(cell => model.groups[cell]!.nodes);
  return {
    /** The frames with children, by id; a canton is author-fixed (D1). */
    frames: (): string[] => Object.keys(frames).filter(id => frames[id]!.kind !== 'canton' && Object.values(frames).some(frame => frame.parent === id)).sort(compareId),
    /**
     * The free rows the feeds below may order (dense-16x9 ticket 20): a free row of two or more nodes that no row above feeds and that the
     * corridor step could not judge (`frame-columns`: its turn changes a region with a frame cell; or no record: no anchor tier), with no
     * far-end pull and no group order of the joint order reading it. A row the corridor step judged keeps its measured order: the feed order
     * was among its candidates and crossed no less. An authored order (`layout.corridorRowOrder: false`) stands.
     */
    tops: (): LayoutGroup[] => model.document.layout?.corridorRowOrder === false ? [] : placed.filter(group => group.nodes.length > 1 && freeRow(group)
      && !joint.has(group.id) && !fedFromAbove(group) && group.rowOrderDecision?.pulledFrom === undefined
      && (group.rowOrderDecision === undefined || group.rowOrderDecision.rule === 'frame-columns')),
    /** The cells a feed may order and the given free top rows, in their judging order: top-down, by id within a sub-tier, so a row reads the order this step gave the row above it. */
    rows: (tops: readonly LayoutGroup[]): LayoutGroup[] => [...placed.filter(group => group.frame !== undefined && group.nodes.length > 1 && isRow(group) && !flanked.has(group.id)), ...tops]
      .sort((a, b) => a.tier! - b.tier! || compareId(a.id, b.id)),
    /**
     * The order the feeds give a row: a row that a row above feeds (a rank cell) reads the feeds from above, a tie keeping the order it stands
     * in (ELK's); a row that no row above feeds reads its feeds into the row below (dense-16x9 ticket 20), a tie keeping declaration order.
     */
    row: (row: LayoutGroup): Decision | undefined => fedFromAbove(row) ? (row.frame === undefined ? undefined : ordered(row, above, items => items))
      : ordered(row, below, () => row.nodes),
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
