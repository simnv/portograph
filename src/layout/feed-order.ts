import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { frameSubtreeCells } from '../model/model.js';
import { groupShape } from './grid.js';
import { besideRows, tierRange } from './columns.js';
import { reseatRow } from './overlay-order.js';
import { placementWarning } from './regions.js';
import { cellTier } from './read/tier.js';
import { ofKind, reservation, rowOrderFailure, type Reservation } from './reservations.js';
import { compareId } from './skeleton-graph.js';
import { rebuildBands } from './skeleton-geometry.js';

/** One unit of a fed row: a node of a rank cell, or the own cells or a child frame of a frame. `top` is its first sub-tier, `nodes` its nodes there. */
interface Unit { id: string; top: number; nodes: readonly string[] }

/** Two feed keys closer than this are one key: a mean of row positions differs by 1/n or more where it differs at all. */
const SAME_KEY = 1e-9;

/**
 * Order follows the feeds (architecture-2 ticket 25). The one writer of the ledger kind `rowOrder`.
 *
 * - **What is ordered.** The nodes of a rank cell (a `row` cell of two or more nodes that no flank stands beside), and the units of a frame
 *   that stand beside each other on its sub-tiers: the frame's own cells and its child frames (`besideRows`, the rows the column pack lays).
 *   A canton is author-fixed (decision D1): its members are not ordered, and the free rows keep the corridor order (ticket 17).
 * - **The feed key** of a unit is the mean position, in the feeding row, of the far ends of its routed links into the sub-tier directly
 *   above its first sub-tier. The feeding row is one group: when the feeds of a row come from two groups, their positions are not
 *   comparable before the frames are packed, and the feeds decide nothing there. A position is the index in the feeding row's order as it
 *   stands: the cells are judged top-down, so a cell reads the order this step gave the cell above it.
 * - **The order.** A row is decided when two of its units have different keys. A cell: its keyed nodes take the keyed slots in key order;
 *   a node without a feed keeps its slot, and two nodes with one key keep the order ELK gave them (its input is the declaration order, so a
 *   tie is broken by declaration order unless ELK's crossing reduction swapped the pair for the rows below). Two neighbours that a peer link (a
 *   routed link inside the cell) joins stay next to each other: the run moves as one block, keyed by the mean of its members' feeds,
 *   and ordered inside by their own keys. A frame row: every unit must
 *   have a key, and a tie keeps declaration order (the frame's own cells first, then its children in declaration order).
 * - **The reservation.** Each decided row is one `rowOrder` entry (`rowOrderOf` is the one reader). A cell is re-seated in its order here
 *   (the replay of ELK's output); the column pack (`standOf`) stands a child frame on the side its entry names; the overlay order of the
 *   frames leaves a reserved cell alone. `validateFeedOrders`, and `validateReservations` on every later snapshot, check the order holds.
 *
 * `layout.feedOrder: false` switches the step off (a test input whose subject needs the declared order pins it so).
 * No search: one sort per row, a finite traversal (R4 needs no cap). Runs after the free-row orders of stage 4 and before the frames are
 * packed. The entries of an earlier run are replaced, so a placement re-run decides again on its own skeleton.
 */
export function orderByFeeds(model: LayoutModel): void {
  const kept = (model.reservations ?? []).filter(entry => entry.kind !== 'rowOrder');
  const entries: Reservation[] = [];
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const placed = Object.values(model.groups).filter(group => !group.flank && group.nodes.length > 0 && group.tier !== undefined);
  const tiers = [...new Set(placed.map(group => group.tier!))].sort((a, b) => a - b);
  const above = (tier: number): number | undefined => tiers[tiers.indexOf(tier) - 1];
  // The routed far ends of each node; a link to itself, a mesh bus member and an overlay link feed nothing.
  const ends = new Map<string, string[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.meshBus !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    if (from.node === to.node) continue;
    ends.set(from.node, [...(ends.get(from.node) ?? []), to.node]);
    ends.set(to.node, [...(ends.get(to.node) ?? []), from.node]);
  }
  const isRow = (group: LayoutGroup): boolean => groupShape(model, group.id) === 'row' && model.document.groups[group.id]?.shape !== 'bar';
  /** The key of each unit, `undefined` for a unit with no feed; the whole answer `undefined` when the feeds come from more than one row, or no row. */
  const keysOf = (units: readonly Unit[]): Map<string, number | undefined> | undefined => {
    let row: LayoutGroup | undefined;
    const feeds = new Map<string, string[]>();
    for (const unit of units) {
      const tier = above(unit.top);
      const far = tier === undefined ? [] : unit.nodes.flatMap(node => (ends.get(node) ?? []).filter(other => groupOf(other).tier === tier));
      for (const other of far) {
        const group = groupOf(other);
        if (group.flank || !isRow(group) || (row !== undefined && row !== group)) return undefined;
        row = group;
      }
      feeds.set(unit.id, far);
    }
    if (row === undefined) return undefined;
    const order = row.rowOrder ?? row.nodes;
    return new Map(units.map(unit => {
      const far = feeds.get(unit.id)!;
      return [unit.id, far.length ? far.reduce((sum, node) => sum + order.indexOf(node), 0) / far.length : undefined];
    }));
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
  let moved = false;
  // `layout.feedOrder: false` keeps ELK's order of every cell and the overlay side of every child frame: no entry is written.
  const off = model.document.layout?.feedOrder === false;

  // Cells, top-down: a cell reads the order this step gave the cell above it.
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  for (const tier of off ? [] : tiers) {
    const cells = placed.filter(group => group.tier === tier && group.frame !== undefined && group.nodes.length > 1 && isRow(group) && !flanked.has(group.id))
      .sort((a, b) => compareId(a.id, b.id));
    for (const cell of cells) {
      const order = [...(cell.rowOrder ?? cell.nodes)];
      const keys = keysOf(order.map(node => ({ id: node, top: tier, nodes: [node] })));
      if (keys === undefined || !decided(keys)) continue;
      // A peer pair that stands side by side stays side by side: a run of neighbours that routed links inside the cell join is one block.
      // The blocks take the order of their keys, the members of a block the order of their own keys.
      const blocks = peerBlocks(order, ends);
      const blockKeys = keysOf(blocks.map(block => ({ id: block[0]!, top: tier, nodes: block })))!;
      const heads = blocks.map(block => block[0]!), inner = new Map(blocks.map(block => [block[0]!, slotSort(block, keys, byKey)]));
      const next = slotSort(heads, blockKeys, byKey).flatMap(head => inner.get(head)!);
      if (!decided(blockKeys) && !blocks.some(block => decided(new Map(block.map(node => [node, keys.get(node)]))))) continue;
      if (next.some((node, i) => node !== order[i])) {
        // The cell may grow to the right over its neighbour: the frame columns are packed after this step and lay the cells apart (ELK can
        // stack two linked members of a cell, which the rows stage lays side by side). R6: a refusal is named, never skipped.
        if (!reseatRow(model, cell, next, 'column')) {
          placementWarning(model, 'FEED_ORDER_REFUSED', `Cell ${cell.id} cannot stand in the order its feeds give (${next.join(', ')}): it does not fit its box. ELK's order stands.`, [cell.id], 'group');
          continue;
        }
        moved = true;
      }
      entries.push(reservation('rowOrder', { kind: 'group', id: cell.id }, 'cell', 'skeleton', 0, { cell: cell.id, order: next }));
    }
  }

  // Frame rows: the own cells and the child frames that stand beside each other, as the column pack lays them (`besideRows`).
  const frames = model.document.frames ?? {};
  const nodesAt = (cells: readonly string[], tier: number): string[] => cells.filter(cell => cellTier(model, cell) === tier).flatMap(cell => model.groups[cell]!.nodes);
  for (const id of off ? [] : Object.keys(frames).sort(compareId)) {
    if (frames[id]!.kind === 'canton') continue;
    const children = Object.keys(frames).filter(child => frames[child]!.parent === id);
    if (!children.length) continue;
    const tierOf = (cell: string): number => cellTier(model, cell);
    const blocks = children.map(child => { const [low, high] = tierRange(model, child); return { child, low, high }; });
    const { own, rows } = besideRows(frames[id]!.cells, tierOf, blocks, block => [block.low, block.high]);
    const lines: Unit[][] = rows.map(row => row.map(block => ({ id: block.child, top: block.low, nodes: nodesAt(frameSubtreeCells(frames, block.child), block.low) })));
    if (own.length) {
      const standing = frames[id]!.cells.filter(cell => own.some(block => tierOf(cell) >= block.low && tierOf(cell) <= block.high));
      const top = Math.min(...standing.map(tierOf));
      lines.unshift([{ id, top, nodes: nodesAt(standing, top) }, ...own.map(block => ({ id: block.child, top: block.low, nodes: nodesAt(frameSubtreeCells(frames, block.child), block.low) }))]);
    }
    const order: string[] = [];
    for (const line of lines) {
      const keys = keysOf(line);
      if (keys === undefined || [...keys.values()].some(key => key === undefined) || !decided(keys)) continue;
      const declared = line.map(unit => unit.id);
      order.push(...[...declared].sort(byKey(keys, declared)));
    }
    if (order.length) entries.push(reservation('rowOrder', { kind: 'group', id }, 'frame', 'skeleton', 0, { frame: id, order }));
  }
  // A model placed without a ledger (a stage test) gets one only when a feed decides a row.
  if (model.reservations !== undefined || entries.length) model.reservations = [...kept, ...entries];
  if (moved) rebuildBands(model, false);
}

/**
 * The runs of a cell whose neighbours a routed link inside the cell joins (peer links), as blocks in the order they stand: a peer pair that
 * stands side by side keeps standing side by side. A pair with a member between it is no block (the member stands on its link, which the
 * order then keeps as it is). A member with no such neighbour is a block of one.
 */
function peerBlocks(order: readonly string[], ends: ReadonlyMap<string, readonly string[]>): string[][] {
  const blocks: string[][] = [];
  for (const [i, node] of order.entries()) {
    if (i > 0 && (ends.get(order[i - 1]!) ?? []).includes(node)) blocks[blocks.length - 1]!.push(node); else blocks.push([node]);
  }
  return blocks;
}

/** `items` with the keyed ones in the keyed slots, in key order (`byKey`, last key the place in `items`); an item with no key keeps its slot. */
function slotSort(items: readonly string[], keys: ReadonlyMap<string, number | undefined>,
  byKey: (keys: ReadonlyMap<string, number | undefined>, order: readonly string[]) => (a: string, b: string) => number): string[] {
  const queue = items.filter(item => keys.get(item) !== undefined).sort(byKey(keys, items));
  return items.map(item => keys.get(item) === undefined ? item : queue.shift()!);
}

/** The stage-4 check of the feed orders (R2, R5): every `rowOrder` entry of the ledger holds on the model as it stands. Reads the record, decides nothing again. */
export function validateFeedOrders(model: LayoutModel): string[] {
  return ofKind(model.reservations ?? [], 'rowOrder').flatMap(entry => {
    const why = rowOrderFailure(entry, model);
    return why === undefined ? [] : [`Reservation ${entry.id} does not hold: ${why}`];
  });
}
