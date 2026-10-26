import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { frameSubtreeCells } from '../model/model.js';
import { CELL_TO_CHILD_FRAME_GAP, cellReach, deriveFrames, frameNodes } from './frames.js';
import { GROUP_PADDING } from './regions.js';
import { selectAnchorTier } from './lanes.js';
import { holdsMove } from './move-reservations.js';
import { findPort } from './row-paths.js';
import { cellTier } from './read/tier.js';
import { isCantonUnit, memberRoom } from './read/canton.js';
import { columnPullFeeds, type UnitFeeds } from './read/feeds.js';
import { rowOrderOf } from './reservations.js';
import { straightOverlaysAsDrawn as straightOverlays } from './read/overlay-straight.js';
import { straightFell, tapVerdict } from './objective.js';
import { bandGap, compareId } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { groupShape } from './grid.js';
import { crosses } from './overlay-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';

/**
 * How far a cell may stand off the axis of its column, to either side, so a wide cell can meet a port
 * of the narrow cell below it that is not on the axis. A column is packed this far from each neighbour
 * on top of the band gap, so the frame boxes of two neighbours stay a band gap apart at the limit.
 */
export const COLUMN_SLACK = GROUP_PADDING;

/** The warning a column gets when its siblings keep it off its feed (ticket 16). */
export const COLUMN_AXIS_HELD = 'COLUMN_AXIS_HELD';

/** The x extent one frame or one-rank group owns in its document tier. */
export interface Column { x: number; width: number }

/** Everything that stands in one column: the cells of a frame and of its child frames, or one group. */
export interface Unit { id: string; frame: boolean; groups: LayoutGroup[]; low: number; high: number }

/**
 * The frames and one-rank groups of a model, grouped by document tier. A document tier is not stored:
 * the sub-tiers of its groups are contiguous and the tiers do not share one, so units whose sub-tier
 * ranges touch belong to one tier.
 */
function columnTiers(model: LayoutModel, only?: string): Unit[][] {
  const frames = model.document.frames ?? {};
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...childrenOf(id).flatMap(cellsOf)];
  const units: Unit[] = [];
  const unit = (id: string): void => {
    const groups = cellsOf(id).map(cell => model.groups[cell]!);
    units.push({ id, frame: true, groups, low: Math.min(...groups.map(group => group.tier!)), high: Math.max(...groups.map(group => group.tier!)) });
  };
  // `only` names a canton: the tiers of its members alone, the units of the inner pass of ticket 56.
  if (only !== undefined) childrenOf(only).forEach(unit);
  else for (const id of Object.keys(frames).filter(item => frames[item]!.parent === undefined)) unit(id);
  for (const group of only !== undefined ? [] : Object.values(model.groups)) {
    if (!group.flank && group.frame === undefined) units.push({ id: group.id, frame: false, groups: [group], low: group.tier!, high: group.tier! });
  }
  units.sort((a, b) => a.low - b.low || a.high - b.high || compareId(a.id, b.id));
  const tiers: Unit[][] = [];
  let reachTo = -Infinity;
  for (const unit of units) {
    if (tiers.length && unit.low <= reachTo) tiers[tiers.length - 1]!.push(unit); else tiers.push([unit]);
    reachTo = Math.max(reachTo, unit.high);
  }
  return tiers;
}

/**
 * A frame is a column (ranked-groups ticket 09). In stage 4, after ELK and the grid repacks, the
 * frames and one-rank groups of one document tier are packed left to right in the ELK order of their rank-0 cells, each
 * as wide as its widest cell (bodies, pill reach and the 20 px margin on each side, `cellReach`; a
 * parent is also as wide as its widest child frame plus the margin on each side), one band gap
 * apart. Every cell of a frame is centred on its column's axis, and a child frame stands on the
 * axis of its parent. Sub-tier packing then never has two sibling cells at one x: each frame's cells
 * stay in its column, whatever the ranks of its neighbours are.
 *
 * A document tier is not stored: the sub-tiers of its groups are contiguous and the tiers do not
 * share one, so units whose sub-tier ranges touch belong to one tier. A tier with no frame is left
 * as it is, so an input with no multi-rank group is not read at all.
 *
 * Returns the column of every cell, for the flank placement that follows.
 */
export function packFrameColumns(model: LayoutModel): Map<string, Column> {
  const columns = new Map<string, Column>();
  if (model.document.frames === undefined) return columns;
  const tiers = columnTiers(model);
  // The side a child stands on reads where its overlay partners stand, and a partner in a tier that is packed later
  // (or a tier mate that a step moves) has not reached its place when the child's own tier is read. The sweep is
  // repeated, at most twice, while a side read off the packed sheet differs from the side the sweep used.
  for (let pass = 0; pass < BESIDE_PASSES; pass++) {
    const used = besideSides(model);
    for (const { index, authority } of sweepSteps(model, tiers)) packStep(model, tiers, index, authority, columns);
    if (besideSides(model) === used) break;
  }
  return columns;
}

/**
 * How the cells of one frame and its child frames stand across its column (ranked-groups ticket 28). Every cell
 * of the frame is centred on one axis, and a child frame stands on that axis too, unless it shares a sub-tier
 * with a cell of the frame or with a sibling child: a leaf child stands beside the parent members of its ranks,
 * so the child frame and the parent's cells of those ranks are two disjoint columns, side by side, and the frame
 * is as wide as that row of blocks. `left` and `right` are the extents of the column from the own axis, `at` the
 * offset of the axis of each child from it. Frame boxes are read only from cell reaches, so the row keeps
 * `COLUMN_SLACK` between a child frame and a parent cell: the child block is the child's column plus the margin on
 * each side, and the parent cell's reach begins where that block ends.
 */
interface Stand { left: number; right: number; at: Map<string, number>; sides: Map<string, 'left' | 'right'> }

/** The sub-tiers a frame occupies, its own cells and its child frames' cells, from the first to the last. */
export function tierRange(model: LayoutModel, id: string): [number, number] {
  const frames = model.document.frames!;
  const cells = frameSubtreeCells(frames, id);
  const tiers = cells.map(cell => model.groups[cell]!.tier!);
  return [Math.min(...tiers), Math.max(...tiers)];
}

/** The x of the node centres at the far ends of the overlay links of `nodes` that leave `frame`, or `undefined` without one. */
function partnerKey(model: LayoutModel, nodes: ReadonlySet<string>, inside: ReadonlySet<string>): number | undefined {
  const xs: number[] = [];
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    for (const [mine, other] of [[link.attachments.from.node, link.attachments.to.node], [link.attachments.to.node, link.attachments.from.node]] as [string, string][]) {
      const box = model.nodes[other]?.bounds;
      if (nodes.has(mine) && !inside.has(other) && box !== undefined) xs.push(box.x + box.width / 2);
    }
  }
  return xs.length ? mean(xs) : undefined;
}

/**
 * The children of a frame that stand beside each other, grouped into rows (canton-groups ticket 63). A child is beside when its
 * sub-tier range touches a cell of the frame or another child. The children in a component that touches a cell of the frame are
 * `own`: they stand in one row with those cells. The other components are rows of their own, the connected components of the
 * range overlap, so members of two tiers never fold into one row: a child stands beside only the children of the sub-tiers it
 * shares, and apart from the others. A component of one child, with no cell of the frame beside it, stands apart.
 */
export function besideRows<T>(cells: readonly string[], tierOf: (cell: string) => number, items: readonly T[], range: (item: T) => [number, number]): { own: T[]; rows: T[][] } {
  const touches = (a: T, b: T): boolean => range(a)[0] <= range(b)[1] && range(b)[0] <= range(a)[1];
  const onCells = (item: T): boolean => cells.some(cell => tierOf(cell) >= range(item)[0] && tierOf(cell) <= range(item)[1]);
  const seen = new Set<T>(), own = new Set<T>(), rows: T[][] = [];
  for (const start of items) {
    if (seen.has(start)) continue;
    const row = new Set<T>([start]);
    for (let grown = true; grown;) { grown = false; for (const item of items) if (!row.has(item) && [...row].some(other => touches(item, other))) { row.add(item); grown = true; } }
    for (const item of row) seen.add(item);
    // Declaration order is kept inside a row.
    const ordered = items.filter(item => row.has(item));
    if (ordered.some(onCells)) for (const item of ordered) own.add(item);
    else if (ordered.length > 1) rows.push(ordered);
  }
  return { own: items.filter(item => own.has(item)), rows };
}

function standOf(model: LayoutModel, id: string, memo: Map<string, Stand>): Stand {
  const known = memo.get(id);
  if (known) return known;
  const frames = model.document.frames!;
  const childIds = Object.keys(frames).filter(child => frames[child]!.parent === id);
  const width = (cells: readonly string[]): number => Math.max(0, ...cells.map(cell => cellReach(model, cell).width));
  const blocks = childIds.map(child => {
    const stand = standOf(model, child, memo), [low, high] = tierRange(model, child);
    return { child, low, high, left: stand.left + GROUP_PADDING, right: stand.right + GROUP_PADDING };
  });
  const tierOf = (cell: string): number => cellTier(model, cell);
  const { own: beside, rows: pure } = besideRows(frames[id]!.cells, tierOf, blocks, block => [block.low, block.high]);
  const apart = blocks.filter(block => !beside.includes(block) && !pure.some(row => row.includes(block)));
  const standing = frames[id]!.cells.filter(cell => beside.some(block => tierOf(cell) >= block.low && tierOf(cell) <= block.high));
  const at = new Map<string, number>(), sides = new Map<string, 'left' | 'right'>();
  // What is not in the row is centred on the axis: the frame's other cells and the children that share no sub-tier.
  const rest = width(frames[id]!.cells.filter(cell => !standing.includes(cell)));
  let left = Math.max(rest / 2, ...apart.map(block => block.left)), right = Math.max(rest / 2, ...apart.map(block => block.right));
  for (const block of apart) at.set(block.child, 0);
  // A row of children with no cell of the frame beside it stands in the order its feeds give (architecture-2 ticket 25, the ledger's
  // `rowOrder` of the frame), else in declaration order, centred on the axis; each row on its own.
  const reserved = rowOrderOf(model.reservations, 'frame', id), slot = (unit: string): number => reserved?.indexOf(unit) ?? -1;
  for (const unsorted of pure) {
    const row = unsorted.every(block => slot(block.child) >= 0) ? [...unsorted].sort((a, b) => slot(a.child) - slot(b.child)) : unsorted;
    const total = row.reduce((sum, block) => sum + block.left + block.right, 0);
    let start = 0;
    for (const block of row) { at.set(block.child, start + block.left - total / 2); sides.set(block.child, 'right'); start += block.left + block.right; }
    left = Math.max(left, total / 2); right = Math.max(right, total / 2);
  }
  if (beside.length) {
    // The child on the side its feeds give (architecture-2 ticket 25): the ledger's `rowOrder` of the frame names the frame (its own
    // cells) and each child left to right. Where the feeds decide nothing, the side its overlay partners favour: the mean x of the
    // partners outside the frame against the mean x of the frame's cells in the row. Declaration order (the frame first, its children
    // in order) on a tie.
    const inside = new Set(frameNodes(model, id)), own = standing.map(cell => cellReach(model, cell)), ownX = own.length ? mean(own.map(reach => reach.x + reach.width / 2)) : undefined;
    const fed = slot(id) >= 0 && beside.every(block => slot(block.child) >= 0);
    const order = Object.keys(frames), place = (block: typeof beside[number]): 'left' | 'right' => {
      if (fed) return slot(block.child) < slot(id) ? 'left' : 'right';
      const key = ownX === undefined ? undefined : partnerKey(model, new Set(frameNodes(model, block.child)), inside);
      return key !== undefined && key < ownX! - PLACEMENT_EPS ? 'left' : 'right';
    };
    const sorted = [...beside].sort((a, b) => (fed ? slot(a.child) - slot(b.child) : 0) || order.indexOf(a.child) - order.indexOf(b.child));
    const placed = new Map(sorted.map(block => [block, place(block)]));
    for (const block of sorted) sides.set(block.child, placed.get(block)!);
    const row: { child?: string; width: number; axis: number }[] = [
      ...sorted.filter(block => placed.get(block) === 'left').map(block => ({ child: block.child, width: block.left + block.right, axis: block.left })),
      ...(standing.length ? [{ width: width(standing), axis: width(standing) / 2 }] : []),
      ...sorted.filter(block => placed.get(block) === 'right').map(block => ({ child: block.child, width: block.left + block.right, axis: block.left })),
    ];
    const total = row.reduce((sum, item) => sum + item.width, 0);
    // The own axis stands at the centre of the parent cells' block, or at the middle of the row without one.
    let start = 0, ownAxis = total / 2;
    for (const item of row) { if (item.child === undefined) ownAxis = start + item.axis; start += item.width; }
    start = 0;
    for (const item of row) { if (item.child !== undefined) at.set(item.child, start + item.axis - ownAxis); start += item.width; }
    left = Math.max(left, ownAxis); right = Math.max(right, total - ownAxis);
  }
  const stand = { left, right, at, sides };
  memo.set(id, stand);
  return stand;
}

/** How many times the pack sweep runs when the sides of the children that stand beside their parent's cells change under it. */
const BESIDE_PASSES = 3;

/** The side of every beside child as the sheet stands, one string: two reads are equal when no child would change side. */
function besideSides(model: LayoutModel): string {
  const stands = standsOf(model), sides: string[] = [];
  for (const [id, stand] of stands) for (const [child, side] of stand.sides) sides.push(`${id}/${child}:${side}`);
  return sides.join(',');
}

/** The stands of every frame, read once off the cells as they stand: a rule that moves cells reads them before it moves any. */
function standsOf(model: LayoutModel): Map<string, Stand> {
  const memo = new Map<string, Stand>();
  for (const id of Object.keys(model.document.frames ?? {})) standOf(model, id, memo);
  return memo;
}

/** The offset of the axis of every cell of a frame, and of its child frames, from the frame's own axis. */
function cellOffsets(model: LayoutModel, stands: ReadonlyMap<string, Stand>, id: string, base = 0, into = new Map<string, number>()): Map<string, number> {
  const stand = stands.get(id)!, frames = model.document.frames!;
  for (const cell of frames[id]!.cells) into.set(cell, base);
  for (const child of Object.keys(frames).filter(item => frames[item]!.parent === id)) cellOffsets(model, stands, child, base + (stand.at.get(child) ?? 0), into);
  return into;
}

/**
 * The document tiers that hold at least one frame, top to bottom, as their units (frames and one-rank
 * groups). A document tier is not stored: the sub-tiers of its groups are contiguous and the tiers do
 * not share one, so units whose sub-tier ranges touch belong to one tier.
 */
export function frameTiers(model: LayoutModel): Unit[][] {
  return columnTiers(model).filter(members => members.some(unit => unit.frame));
}

/**
 * The place of a unit in the left to right order of its tier: the x centre of its rank-0 cell (its first
 * sub-tier, which is the cell ELK placed against the tier above), or of the group itself.
 */
export function unitOrder(unit: Unit): number {
  const first = unit.groups.reduce((best, group) => group.tier! < best.tier! ? group : best);
  return first.bounds!.x + first.bounds!.width / 2;
}

/**
 * The order the tiers are packed in (ticket 11): the tier of the anchor first, then the tiers outward one
 * at a time in the order centring steps. `authority` is the tier packed just before, whose ports a tier reads.
 */
function sweepSteps(model: LayoutModel, tiers: Unit[][]): { index: number; authority: number | undefined }[] {
  const anchor = selectAnchorTier(model);
  const first = Math.max(0, tiers.findIndex(tier => tier.some(unit => anchor !== undefined && unit.low <= anchor && anchor <= unit.high)));
  return [{ index: first, authority: undefined },
    ...tiers.slice(first + 1).map((_, i) => ({ index: first + 1 + i, authority: first + i })),
    ...tiers.slice(0, first).map((_, i) => ({ index: first - 1 - i, authority: first - i }))];
}

/**
 * Packs again the one document tier that holds `tier` (see `packFrameColumns`), by the same feed-axis rule
 * and against the tier packed just before it, and stores the column of every frame cell in `columns`.
 * `sequence` gives the units of the tier a different place than their rank-0 cells stand in (a unit id to
 * a number, the smaller to the left); the overlay-weighted order of frames (ticket 06b) uses it to move a
 * frame as a column.
 */
export function packTier(model: LayoutModel, tier: Unit[], columns: Map<string, Column>, sequence?: ReadonlyMap<string, number>): void {
  const tiers = columnTiers(model);
  const step = sweepSteps(model, tiers).find(item => tiers[item.index]!.some(unit => unit.id === tier[0]!.id));
  if (step !== undefined) packStep(model, tiers, step.index, step.authority, columns, sequence);
}

/**
 * Reads, for a unit of `tiers[index]`, the routed, attached, non-stub links that leave it towards the tier
 * `authority` on the facing sides, with the current x of both ports (ranked-groups tickets 11 and 16).
 * Overlay links are the overlay order's (tickets 05 and 06), stubs draw no path.
 */
function feedReader(model: LayoutModel, tiers: Unit[][], index: number, authority: number | undefined): (unit: Unit) => UnitFeeds {
  if (authority === undefined) return () => ({ parents: new Map(), children: new Map() });
  return columnPullFeeds(model, new Set(tiers[authority]!.flatMap(unit => unit.groups.map(group => group.id))), index > authority);
}

/** Packs `tiers[index]`, reading the feeds of the tier `authority` (see `packFrameColumns`). */
function packStep(model: LayoutModel, tiers: Unit[][], index: number, authority: number | undefined, columns: Map<string, Column>,
  sequence?: ReadonlyMap<string, number>): void {
  const frames = model.document.frames!;
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  // Read before any cell moves: which side a child stands on reads the cells and their partners as they are now.
  const stands = standsOf(model);
  /** Centre every cell of a frame on one axis and its children on their own (ticket 28: a child that stands beside is off the axis). */
  const centre = (id: string, axis: number): void => {
    for (const cell of frames[id]!.cells) {
      const reach = cellReach(model, cell);
      moveGroup(model, model.groups[cell]!, axis - (reach.x + reach.width / 2), 0);
    }
    for (const child of childrenOf(id)) centre(child, axis + (stands.get(id)!.at.get(child) ?? 0));
  };
  const gap = bandGap(model);
  const place = (unit: Unit): number => sequence?.get(unit.id) ?? unitOrder(unit);
  const left = (unit: Unit): number => Math.min(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x : group.bounds!.x));
  const right = (unit: Unit): number => Math.max(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x + cellReach(model, group.id).width : group.bounds!.x + group.bounds!.width));
  /** The width a unit takes in its tier: a frame with its slack on each side, a group by its box. */
  const extent = (unit: Unit): number => unit.frame ? stands.get(unit.id)!.left + stands.get(unit.id)!.right + 2 * COLUMN_SLACK : unit.groups[0]!.bounds!.width;
  /** From the left edge of a unit's column to its axis: the cells of a frame are centred on the axis, a group is one box. */
  const pivot = (unit: Unit): number => unit.frame ? COLUMN_SLACK + stands.get(unit.id)!.left : extent(unit) / 2;

  const feeds = feedReader(model, tiers, index, authority);

  /** Centring shapes a bar itself (its slots and spans): a bar keeps the place it has. */
  const isBar = (unit: Unit): boolean => !unit.frame && model.document.groups[unit.id]?.shape === 'bar';

  /** The centre a unit wants: over the mean of its routed feeds in the packed tier, `undefined` without one. */
  const wanted = (unit: Unit): number | undefined => {
    const { parents, children } = feeds(unit);
    if (!parents.size || !children.size) return undefined;
    const mean = (values: Iterable<number>): number => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
    const offsets = unit.frame ? cellOffsets(model, stands, unit.id) : new Map<string, number>();
    return mean(parents.values()) - mean([...children.values()].map(({ x, cell }) => {
      const at = unit.frame ? cellReach(model, cell) : model.groups[cell]!.bounds!;
      return x - (at.x + at.width / 2) + (offsets.get(cell) ?? 0);
    }));
  };

  const tier = tiers[index]!;
  // A tier of one-rank groups reads its feeds only when frames stand beyond it (in the next tier outward or a farther one; the
  // chain reads this tier's ports) and would otherwise stand over the x ELK left it at, and centring puts it elsewhere (ticket 33).
  // A bar is shaped by its own stage and never follows a feed.
  const framed = tier.some(unit => unit.frame);
  // Any tier farther outward counts, not only the next one: a chain of one-rank tiers is packed from the anchor tier
  // outward, and each reads the tier packed before it, so the frames at the end of the chain read a settled x.
  const outward = (): boolean => {
    const step = index > authority! ? 1 : -1;
    for (let at = index + step; at >= 0 && at < tiers.length; at += step) if (tiers[at]!.some(unit => unit.frame)) return true;
    return false;
  };
  const read = framed || (authority !== undefined && outward());
  const centres = new Map<Unit, number | undefined>(tier.map(unit => [unit, read && (framed || !isBar(unit)) ? wanted(unit) : undefined]));
  if (!framed && [...centres.values()].every(wish => wish === undefined)) {
    // A tier of one-rank groups with no feed toward the tier packed before it is left where ELK put it, except that
    // the sweep of `placeFlanksAndPeers` will push apart the groups ELK left closer than a band gap. It is done here
    // so the feed x that the tier next to it reads is the x the tier keeps.
    let end = -Infinity;
    for (const group of tier.flatMap(unit => unit.groups).sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id))) {
      if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
      end = group.bounds!.x + group.bounds!.width + gap;
    }
    return;
  }
  const run = [...tier].sort((a, b) => place(a) - place(b) || compareId(a.id, b.id));
  const wishes = run.map(unit => centres.get(unit));
  // Left edge of each unit once packed a band gap apart, and where its column would stand if it had its way.
  let lefts: number[];
  if (wishes.every(wish => wish === undefined)) {
    // The packed run keeps the centre ELK gave the tier, so it stays over and under its neighbour tiers.
    const span = run.reduce((sum, unit) => sum + extent(unit), gap * (tier.length - 1));
    let x = (Math.min(...tier.map(left)) + Math.max(...tier.map(right))) / 2 - span / 2;
    lefts = run.map(unit => { const at = x; x += extent(unit) + gap; return at; });
  } else {
    // A sibling that would overlap the one before it is pushed outward and the order is kept: the
    // least squares fit of the lefts to a run at least a band gap apart (pool adjacent violators), so
    // a run that moved as a whole is centred back.
    const offsets: number[] = [];
    let sum = 0;
    for (const unit of run) { offsets.push(sum); sum += extent(unit) + gap; }
    const blocks: { sum: number; count: number }[] = [];
    for (const [i, unit] of run.entries()) {
      const wish = wishes[i] === undefined ? (left(unit) + right(unit)) / 2 - extent(unit) / 2 : wishes[i]! - pivot(unit);
      blocks.push({ sum: wish - offsets[i]!, count: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
        const last = blocks.pop()!, before = blocks[blocks.length - 1]!;
        before.sum += last.sum; before.count += last.count;
      }
    }
    lefts = blocks.flatMap(block => Array.from({ length: block.count }, () => block.sum / block.count)).map((base, i) => base + offsets[i]!);
  }
  for (const [i, unit] of run.entries()) {
    if (unit.frame) {
      const stand = stands.get(unit.id)!, width = stand.left + stand.right, x = lefts[i]! + COLUMN_SLACK;
      centre(unit.id, x + stand.left);
      for (const group of unit.groups) columns.set(group.id, { x, width });
    } else {
      const group = unit.groups[0]!;
      moveGroup(model, group, lefts[i]! - group.bounds!.x, 0);
    }
  }
}

/**
 * Keep the columns disjoint after a rule has widened cells (ranked-groups ticket 12). `packFrameColumns`
 * measures a cell as stage 4 leaves it, but the rows rule flattens a cell onto one baseline and spaces its
 * nodes by `rowGap`, and a cell can grow by hundreds of px. A widened cell pushed its row neighbours in
 * one sub-tier alone, so a frame ended up spanning the columns of its neighbours, and a node of one
 * location stood inside the frame of another. A frame is one column: the top-level frames and one-rank
 * groups of a document tier are swept left to right in the order they stand, and each is moved as a whole
 * (every cell and every child frame by one dx) until it is a band gap from the one before, and a
 * `COLUMN_SLACK` more on each side that is a frame's. Nothing moves left, and nothing moves when the columns are already apart, so an input with
 * no frame is not read.
 *
 * Returns whether anything moved.
 */
export function separateFrameColumns(model: LayoutModel): boolean {
  const shifts = columnShifts(model, COLUMN_SLACK);
  for (const [group, dx] of shifts) moveGroup(model, group, dx, 0);
  return shifts.size > 0;
}

/**
 * Pull the columns back toward their feeds (ranked-groups ticket 16). `packFrameColumns` puts the axis of
 * each column on the mean x of its feeds, but the rules after it widen cells and `separateFrameColumns`
 * moves a frame to the right and never back, so a frame the widening pushed stays pushed, and a feed that
 * was straight at pack jogs by the whole push. This is ticket 11's pass again on the geometry as it stands:
 * the frames of a tier want to stand where centring can still put their feed ports under the feeds, and are
 * kept a band gap apart, plus the column slack beside a frame, by pool adjacent violators with the order kept.
 * A run that moved as a whole is centred back, so a frame pushed right by its sibling is met halfway, and a
 * frame nothing pushes does not move.
 *
 * What a frame wants is a range, not a point: centring slides the cells of a frame inside their column, so a
 * feed that a cell can reach by sliding costs nothing, and a feed beyond the wall costs its distance from
 * the wall (`feedRange`). Standing at the point that puts a feed under the port as the cells now stand
 * would pull a frame off a feed that centring reaches anyway, and off the balance between two frames that
 * both have to give. The plan minimises the squared distance outside those ranges, so the current x is the
 * wanted x and the feed mean is the target, in one step by projection and a few more until it settles.
 *
 * The tiers are read in the order centring steps, the anchor tier first, so a tier reads feeds that a later
 * step does not move. A tier that holds a grid, a bar or another group the rows rule cannot move is left
 * alone. The plan of a tier is refused as a whole when a reserved lane would end on the other side of a
 * group it holds (lane x is immutable), so the rule can also run after lanes. The overlay partner of a frame end is a second
 * target, met with the feed (`overlayRange`); a frame stays put, and bounds its siblings, only when no move meets both and the
 * partner is one that stays. A column that still jogs by
 * more than its cells can slide to absorb warns once, `COLUMN_AXIS_HELD`, with that residual in px. The pass
 * is idempotent: the feeds are the fixed end, so a second run wants exactly the plan the first one kept.
 *
 * `slack` is the room a frame leaves its cells beyond its box and keeps beside a sibling: `COLUMN_SLACK` while the
 * rows rule runs, and 0 after centring has spent it (stage 7f, ticket 17: the frames stand a band gap apart and
 * `frameColumns` gives a cell no room beyond its box). A guard that reads a straight overlay link as bent by the
 * move refuses the plan too, and not only one whose box enters the segment: a link that a moved node body or pill
 * now blocks is not in the list of straight links the second reading makes.
 *
 * Returns whether anything moved.
 */
export function holdColumnAxes(model: LayoutModel, slack = COLUMN_SLACK): boolean {
  if (model.document.frames === undefined) return false;
  const tiers = columnTiers(model);
  let moved = false;
  // The close-up of a canton step with an authority is part of the plan of `pullTier`. The anchor step has no feed, so `closeUp`
  // packs it alone; it comes first in the sweep, before the tiers that read it.
  for (const { index, authority } of sweepSteps(model, tiers)) {
    if (authority === undefined) moved = closeUp(model, tiers, index, slack) || moved;
    else if (tiers[index]!.some(unit => unit.frame)) moved = pullTier(model, tiers, index, feedReader(model, tiers, index, authority), slack) || moved;
  }
  return holdMemberWalls(model) || moved;
}

/**
 * The held-axis warnings, read again on the geometry that stands (ticket 75). A warning says how far a column's feed links jog when it is
 * raised; the replays after it move columns. A warning whose column reaches its feed now is withdrawn, and the jog of one that does not
 * is the jog of the final geometry. It raises no new warning and moves nothing.
 */
export function refreshHeldWarnings(model: LayoutModel): void {
  if (model.document.frames === undefined || !model.diagnostics.some(item => item.code === COLUMN_AXIS_HELD)) return;
  const derived = deriveFrames(model);
  if (derived === undefined) return;
  const tiers = columnTiers(model), residual = new Map<string, number>();
  for (const { index, authority } of sweepSteps(model, tiers)) {
    if (authority === undefined) continue;
    const feeds = feedReader(model, tiers, index, authority);
    for (const unit of tiers[index]!.filter(item => item.frame)) {
      const range = feedRange(model, unit, feeds, derived.find(item => item.id === unit.id)!.box, 0);
      residual.set(unit.id, range === undefined ? 0 : Math.max(0, range.low, -range.high));
    }
  }
  model.diagnostics = model.diagnostics.flatMap(item => {
    const owner = item.owners?.[0];
    // A member of a canton is read by the inner pass, with the canton wall; its warning is left as it is.
    if (item.code !== COLUMN_AXIS_HELD || item.owners?.length !== 1 || owner === undefined || !('id' in owner) || !residual.has(owner.id)) return [item];
    const jog = residual.get(owner.id)!;
    // Only a message that states a jog is ours to withdraw; a canton's "cannot close up" states none, and its residual is not the jog (ticket 77).
    if (!/jog of [\d.]+ px/.test(item.message)) return [item];
    return jog > 0.5 ? [{ ...item, message: item.message.replace(/jog of [\d.]+ px/, `jog of ${jog.toFixed(1)} px`) }] : [];
  });
}

/**
 * The close-up alone, in 7f (slack 0), for every merged step that holds a canton: the anchor step by `closeUp`, a step with an
 * authority by the plan of `pullTier` (which closes its run and pulls it to its feeds). The centring replays after a push may widen a
 * canton in place, so stage 7f calls this again before it plans the labels and after the tier gaps grow. It moves groups in x and
 * nothing else: the caller replays the region producers, `syncBands` and `replanGroupLabels` after a move. Returns whether a canton moved.
 */
export function closeCantons(model: LayoutModel): boolean {
  if (model.document.frames === undefined) return false;
  const tiers = columnTiers(model), frames = model.document.frames;
  let moved = false;
  for (const { index, authority } of sweepSteps(model, tiers)) {
    if (!tiers[index]!.some(unit => unit.frame && frames[unit.id]?.kind === 'canton')) continue;
    if (authority === undefined) moved = closeUp(model, tiers, index, 0) || moved;
    // A run that stands packed (or is one unit) is not pulled by the close-up: the pull toward the feeds is `holdColumnAxes`' own, at its own points.
    // (Ticket 67 tried a pull here after the replays: the range is a function of the box, the replay widens the box by the move, and the
    // layout reached its fixed point by growing the canvas. Measured on `a-canton-band-holds-the-rows-off`: Q 0.7862 to 0.7679, width 370 to 377.8.)
    else if (runApart(model, tiers[index]!, 0)) moved = pullTier(model, tiers, index, feedReader(model, tiers, index, authority), 0) || moved;
  }
  return moved;
}

/**
 * The cantons of the anchor step close up to a band gap (ranked-groups ticket 65). The units of a step that holds a canton (the
 * cantons and the foreign units on their tiers) are one run, kept in the order they stand and packed again a band gap apart. The
 * pack of `packStep` sets the spacing once, at skeleton widths; every later pass narrows a canton in place or pushes one right, and
 * nothing moved a canton toward its sibling. The run is packed again when any gap of it differs from the spacing (`runSpacing`).
 *
 * The anchor step has no feed, so the block keeps the centre it stands at. (Ticket 65 proposed the mean x of the overlay partners of
 * the units, the key of `orderFramesByOverlay`. Measured, it does not settle: the tiers above the anchor step stand over the routed
 * feeds of the cantons, so every move of the block moves them by as much, and the block chases a partner mean that runs from it by
 * the same 340 px at every replay. Ticket review: a one-time step to the partner mean translated the whole diagram, offset 348 to
 * 340.) A step with an authority is closed by `pullTier`, inside its plan, so that its pins and its feed ranges are kept.
 * The plan is refused as a whole, and the run stays, when a reserved lane would end on the other side of a unit it holds, a
 * straight overlay link would be bent, or a held lane or a foreign unit stands between two cantons of the run; a refusal warns
 * `COLUMN_AXIS_HELD` once for the step, naming the canton.
 *
 * Idempotent: a run whose gaps equal the spacing is not read again. Returns whether the run moved.
 */
function closeUp(model: LayoutModel, tiers: Unit[][], index: number, slack: number): boolean {
  const tier = tiers[index]!;
  const isCanton = (unit: Unit): boolean => isCantonUnit(model, unit);
  if (!tier.some(isCanton) || tier.some(unit => !unit.frame && groupShape(model, unit.id) !== 'row')) return false;
  const derived = deriveFrames(model);
  if (derived === undefined) return false;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const at = (unit: Unit): Rect => unit.frame ? box.get(unit.id)! : unit.groups[0]!.bounds!;
  const run = [...tier].sort((a, b) => at(a).x - at(b).x || compareId(a.id, b.id));
  const offsets = runSpacing(model, run, at, slack);
  if (!run.some((unit, i) => i > 0 && Math.abs(at(unit).x - at(run[i - 1]!).x - (offsets[i]! - offsets[i - 1]!)) > PLACEMENT_EPS)) return false;
  const last = at(run[run.length - 1]!), extent = offsets[run.length - 1]! + last.width;
  const base = (at(run[0]!).x + last.x + last.width) / 2 - extent / 2;
  const shifts = new Map<LayoutGroup, number>();
  const packed = run.map((_, i) => base + offsets[i]!);
  for (const [i, unit] of run.entries()) {
    const dx = packed[i]! - at(unit).x;
    if (Math.abs(dx) > PLACEMENT_EPS) for (const group of unit.groups) shifts.set(group, dx);
  }
  if (!shifts.size) return false;
  const named = run.find(unit => isCanton(unit) && unit.groups.some(group => shifts.has(group))) ?? run.find(isCanton)!;
  let cause = stepBlock(model, tier, run, at, isCanton);
  const proposed = [...shifts].map(([group, dx]) => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }));
  if (cause === undefined && !holdsMove(model, proposed)) cause = 'a reserved lane it would cross holds it';
  if (cause === undefined) {
    const straight = straightOverlays(model), undo = exactUndo(model, shifts.keys());
    for (const [group, dx] of shifts) moveGroup(model, group, dx, 0);
    const settle = (): void => rebuildNodeGeometry(model, [...shifts.keys()].flatMap(group => group.nodes), 'current');
    settle();
    // A link that stood as one segment and is not one after the move has been bent by it. In 7f (slack 0) the node bodies, read
    // exactly, decide; a frame box counts only while the rows rule can still slide cells inside it.
    // The count reading (ADR-0019: the straight overlay links do not fall): a block move swaps chords, and one that bends while another
    // straightens is no loss. `pullTier` reads each link, as its moves are small (decisions-log Q102).
    const segments = straightOverlays(model);
    const after = new Map(deriveFrames(model)?.map(frame => [frame.id, frame.box]));
    const bent = straightFell(segments, straight, true) || (slack > 0 && segments.some(({ ends, from, to }) => tier.some(unit => {
      const was = unit.frame ? box.get(unit.id) : undefined, now = unit.frame ? after.get(unit.id) : undefined;
      return was !== undefined && now !== undefined && shifts.has(unit.groups[0]!) && !unit.groups.some(group => ends.has(group.id))
        && crosses(from, to, now) && !crosses(from, to, was);
    })));
    tapVerdict('closeUp', () => `${bent} ${segments.length}/${straight.length}`);
    if (bent) { undo(); settle(); cause = 'a straight overlay link would be bent'; }
  }
  warnCloseUp(model, run.filter(isCanton).map(unit => unit.id), named.id, cause);
  return cause === undefined;
}

/**
 * The offset of each unit of a sorted run from the first when the run stands packed, and the one rule of the spacing that `pullTier`,
 * `closeUp` and `columnShifts` agree on: a band gap, plus the slack of each frame that faces the gap; a frame beside a plain group
 * always keeps `COLUMN_SLACK` on its side, as the rows rule reserves it, because the rows rule replays after 7f moves and would take
 * back what a close-up removed.
 */
function runSpacing(model: LayoutModel, run: readonly Unit[], at: (unit: Unit) => Rect, slack: number): number[] {
  const gap = bandGap(model), offsets: number[] = [];
  let sum = 0;
  for (const [i, unit] of run.entries()) {
    offsets.push(sum);
    const next = run[i + 1];
    if (next !== undefined) sum += at(unit).width + gap + (unit.frame && next.frame ? 2 * slack : unit.frame || next.frame ? COLUMN_SLACK : 0);
  }
  return offsets;
}

/** Whether the units of a step stand off the spacing of `runSpacing` now: some gap of the run, in the order it stands, is not the packed one. */
function runApart(model: LayoutModel, tier: readonly Unit[], slack: number): boolean {
  const derived = deriveFrames(model);
  if (derived === undefined) return false;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const at = (unit: Unit): Rect => unit.frame ? box.get(unit.id)! : unit.groups[0]!.bounds!;
  const run = [...tier].sort((a, b) => at(a).x - at(b).x || compareId(a.id, b.id)), offsets = runSpacing(model, run, at, slack);
  return run.some((unit, i) => i > 0 && Math.abs(at(unit).x - at(run[i - 1]!).x - (offsets[i]! - offsets[i - 1]!)) > PLACEMENT_EPS);
}

/** Why a run of cantons may not be closed at all: a foreign unit, or a held lane, stands between two cantons of it. */
function stepBlock(model: LayoutModel, tier: readonly Unit[], run: readonly Unit[], at: (unit: Unit) => Rect, isCanton: (unit: Unit) => boolean): string | undefined {
  const first = run.findIndex(isCanton), last = run.length - 1 - [...run].reverse().findIndex(isCanton);
  const low = Math.min(...tier.map(unit => unit.low)), high = Math.max(...tier.map(unit => unit.high));
  if (run.slice(first + 1, last).some(unit => !isCanton(unit))) return 'a foreign unit stands between two cantons of the run';
  const lane = model.lanes.some(item => item.tier >= low && item.tier <= high
    && run.slice(first, last).some((unit, i) => item.x > at(unit).x + at(unit).width - PLACEMENT_EPS && item.x < at(run[first + i + 1]!).x + PLACEMENT_EPS));
  return lane ? 'a reserved lane stands between two cantons of the run' : undefined;
}

/**
 * The way back for a move that may be refused: the boxes of the groups, their nodes and the anchors of their ports as they stand, put
 * back exactly. A move by `dx` and back by `-dx` leaves float noise, and publication re-derives regions and label bands from the geometry.
 */
function exactUndo(model: LayoutModel, groups: Iterable<LayoutGroup>): () => void {
  const saved = [...groups].map(group => ({ group, bounds: { ...group.bounds! }, nodes: group.nodes.map(id => ({ node: model.nodes[id]!, bounds: { ...model.nodes[id]!.bounds! },
    anchors: model.nodes[id]!.ports.map(port => port.anchor && { ...port.anchor }) })) }));
  return () => {
    for (const item of saved) {
      Object.assign(item.group.bounds!, item.bounds);
      for (const entry of item.nodes) {
        Object.assign(entry.node.bounds!, entry.bounds);
        entry.node.ports.forEach((port, i) => { if (port.anchor && entry.anchors[i]) Object.assign(port.anchor, entry.anchors[i]); });
      }
    }
  };
}

/** Says once for a step, naming a canton, why its run stays; an earlier warning of the step is dropped first. */
function warnCloseUp(model: LayoutModel, cantons: readonly string[], named: string, cause: string | undefined): void {
  model.diagnostics = model.diagnostics.filter(item => !(item.code === COLUMN_AXIS_HELD && cantons.some(id => item.message.startsWith(`Canton ${id} cannot close up`))));
  if (cause === undefined) return;
  // A straight link outranks the close-up (user, 2026-10-04): that outcome is accepted, so it is information; any other cause stays a warning.
  model.diagnostics.push({ stage: 'placement', severity: cause === 'a straight overlay link would be bent' ? 'info' : 'warning', code: COLUMN_AXIS_HELD, owners: [{ kind: 'group', id: named }],
    message: `Canton ${named} cannot close up to a band gap from its siblings: ${cause}, so the run of cantons stays where it stands.` });
}

/**
 * The base `c` of a run kept packed that costs the least squared distance outside the spans `[low, high]` (a unit is content
 * when `c` lies in its span): the point of the content set nearest to `keep` when the spans meet, the one minimum otherwise.
 */
function leastJog(spans: readonly { low: number; high: number }[], keep: number): number {
  const lows = Math.max(...spans.map(span => span.low)), highs = Math.min(...spans.map(span => span.high));
  if (lows <= highs + PLACEMENT_EPS) return Math.min(Math.max(keep, lows), Math.max(lows, highs));
  let low = Math.min(...spans.map(span => span.low)), high = Math.max(...spans.map(span => span.high));
  const slope = (c: number): number => spans.reduce((sum, span) => sum + (c < span.low ? c - span.low : c > span.high ? c - span.high : 0), 0);
  for (let round = 0; round < 100; round++) { const mid = (low + high) / 2; if (slope(mid) < 0) low = mid; else high = mid; }
  return (low + high) / 2;
}

/**
 * The inner pass alone, for every canton (see `pullMembers`). `holdColumnAxes` runs it after the pass over the top-level units.
 * Exported so that a test can hold the pass to idempotence on a finished layout apart from the pass over the columns.
 */
export function holdMemberWalls(model: LayoutModel): boolean {
  if (model.document.frames === undefined) return false;
  const tiers = columnTiers(model);
  let moved = false;
  for (const id of Object.keys(model.document.frames)) {
    if (model.document.frames[id]!.kind === 'canton' && model.document.frames[id]!.parent === undefined) moved = pullMembers(model, id, tiers) || moved;
  }
  return moved;
}

/**
 * The inner pass of a canton (canton-groups ticket 56, Section 2b rule 2). `pullTier` moves a canton as a whole: its
 * units are the top-level units and a member is never one. Here the members are the units, per tier, and the
 * derived canton box is the wall of the plan: a member is pulled to its feed, and to a partner that stays, only inside
 * the canton, and warns `COLUMN_AXIS_HELD` naming the canton when the wall keeps it off. The same ranges (`feedRange`,
 * `overlayRange`), the same refusals (a lane, a straight overlay link) and the same plan as `pullTier`. Members that
 * share a sub-tier stand beside each other and are one row that `packBesideRows` packs: they are not moved here, so
 * the two rules never fight over the gap. The canton box does not change under the pass, so it is idempotent.
 */
function pullMembers(model: LayoutModel, canton: string, outer: Unit[][]): boolean {
  const frames = model.document.frames!, box = deriveFrames(model)?.find(frame => frame.id === canton)?.box;
  if (box === undefined) return false;
  const tiers = columnTiers(model, canton), members = tiers.flat();
  const alone = new Set(members.filter(unit => !members.some(other => other !== unit && other.low <= unit.high && unit.low <= other.high)));
  if (!alone.size || frames[canton] === undefined) return false;
  const anchor = selectAnchorTier(model);
  const inside = tiers.findIndex(tier => tier.some(unit => anchor !== undefined && unit.low <= anchor && anchor <= unit.high));
  // The tier outside the canton that the member tier nearest the anchor reads, when the anchor stands outside the canton.
  const at = outer.findIndex(tier => tier.some(unit => unit.id === canton)), step = sweepSteps(model, outer).find(item => item.index === at);
  const beyond = step?.authority === undefined ? undefined : { groups: new Set(outer[step.authority]!.flatMap(unit => unit.groups.map(group => group.id))), below: at > step.authority };
  const order: { index: number; sources: ReadonlySet<string> | undefined; below: boolean }[] = [];
  const groupsOf = (index: number): Set<string> => new Set(tiers[index]!.flatMap(unit => unit.groups.map(group => group.id)));
  if (inside >= 0) {
    order.push({ index: inside, sources: undefined, below: false });
    for (let i = inside + 1; i < tiers.length; i++) order.push({ index: i, sources: groupsOf(i - 1), below: true });
    for (let i = inside - 1; i >= 0; i--) order.push({ index: i, sources: groupsOf(i + 1), below: false });
  } else if (beyond !== undefined && beyond.below) {
    order.push({ index: 0, sources: beyond.groups, below: true });
    for (let i = 1; i < tiers.length; i++) order.push({ index: i, sources: groupsOf(i - 1), below: true });
  } else if (beyond !== undefined) {
    order.push({ index: tiers.length - 1, sources: beyond.groups, below: false });
    for (let i = tiers.length - 2; i >= 0; i--) order.push({ index: i, sources: groupsOf(i + 1), below: false });
  }
  let moved = false;
  for (const { index, sources, below } of order) {
    const units = new Set(tiers[index]!.filter(unit => alone.has(unit)));
    if (sources === undefined || !units.size) continue;
    moved = pullTier(model, tiers, index, columnPullFeeds(model, sources, below), 0, { units, wall: { x: box.x, width: box.width }, canton }) || moved;
  }
  return moved;
}

const mean = (values: readonly number[]): number => values.reduce((sum, x) => sum + x, 0) / values.length;

/** A range of moves `dx` in `[low, high]`; `need` is the jog it takes to straighten the links it is read from. */
interface MoveRange { low: number; high: number; need: number }

/** The moves of a frame that leave the port of a cell at `need` from its target reachable by sliding the cell inside the column. */
function slideRange(model: LayoutModel, box: Rect, cellIds: Iterable<string>, need: number, slack: number): MoveRange {
  const cells = [...new Set(cellIds)].map(cell => cellReach(model, cell));
  const slideLow = Math.max(...cells.map(reach => box.x - slack - reach.x));
  const slideHigh = Math.min(...cells.map(reach => box.x + box.width + slack - reach.x - reach.width));
  return { low: need - slideHigh, high: need - slideLow, need };
}

/**
 * How far a frame may move, as `dx` in `[low, high]`, and still have its feed ports reachable: the jog `need`
 * that moves the mean of its ports under the mean of its feeds, less what the cells that hold those ports can
 * slide inside the column (its box with the slack on each side). `undefined` for a frame with no feed.
 */
function feedRange(model: LayoutModel, unit: Unit, feeds: (unit: Unit) => UnitFeeds, box: Rect, slack: number): MoveRange | undefined {
  const { parents, children } = feeds(unit);
  if (!parents.size || !children.size) return undefined;
  const need = mean([...parents.values()]) - mean([...children.values()].map(child => child.x));
  return slideRange(model, box, [...children.values()].map(child => child.cell), need, slack);
}

/**
 * The groups `placeOverlayFree` (ticket 05) may move: no routed link out, and no other rule that owns the group's
 * place. The column pass reads the rest as partners that stay where they are. `withRouted` keeps the groups that have a routed
 * link out and drops nothing else: the step over a chord moves those under its own acceptance (ticket 77).
 */
export function overlayFreeGroups(model: LayoutModel, anchor: number | undefined, withRouted = false): Set<string> {
  const frames = model.document.frames;
  // A one-node client group that is a member of a canton is a frame of one cell, and keeps ticket 05's barycentre (ticket 56):
  // `placeOverlayFree` moves it as a frame and clamps it to its canton. A frame of other cells stays a frame the column rules own.
  const member = (group: LayoutGroup): boolean => {
    const own = group.frame === undefined ? undefined : frames?.[group.frame];
    return own !== undefined && own.cells.length === 1 && own.parent !== undefined && frames![own.parent]!.kind === 'canton'
      && !Object.values(frames!).some(frame => frame.parent === group.frame);
  };
  const routedOut = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    const groups = [link.attachments.from.node, link.attachments.to.node].map(node => model.document.nodes[node]!.group);
    if (groups[0] !== groups[1]) for (const group of groups) routedOut.add(group);
  }
  const parents = new Set(Object.values(model.document.groups).flatMap(group => group.parent === undefined ? [] : [group.parent]));
  return new Set(Object.values(model.groups).filter(group => group.bounds !== undefined && group.nodes.length > 0
    && !group.flank && (group.frame === undefined || member(group)) && group.tier !== anchor && (withRouted || !routedOut.has(group.id))
    && !parents.has(group.id) && model.document.groups[group.id]?.parent === undefined
    && model.document.groups[group.id]?.shape !== 'bar').map(group => group.id));
}

/**
 * The moves of a frame that keep each of its overlay links to a partner that stays reachable by sliding: the
 * partner's port x is a second target, read like a feed (ranked-groups ticket 16). A partner stays when no
 * later rule moves it: it is not free (`overlayFreeGroups`, so `placeOverlayFree` follows the frame later).
 * A partner in the same document tier never counts: the links between two units of a tier are face to face and
 * one straight segment, and a move in x cannot bend them. `undefined` when no partner stays.
 */
function overlayRange(model: LayoutModel, unit: Unit, tier: Unit[], free: ReadonlySet<string>, box: Rect, slack: number): MoveRange | undefined {
  const own = new Set(unit.groups.map(group => group.id)), sameTier = new Set(tier.flatMap(item => item.groups.map(group => group.id)));
  let range: MoveRange | undefined;
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    for (const [mine, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
      const ownGroup = model.document.nodes[mine!.node]?.group, otherGroup = model.document.nodes[other!.node]?.group;
      if (ownGroup === undefined || otherGroup === undefined || !own.has(ownGroup) || sameTier.has(otherGroup) || free.has(otherGroup) || free.has(ownGroup)) continue;
      const from = findPort(model, mine!), to = findPort(model, other!);
      if (!from?.anchor || !to?.anchor) continue;
      const next = slideRange(model, box, [ownGroup], to.anchor.x - from.anchor.x, slack);
      range = range === undefined ? next : { low: Math.max(range.low, next.low), high: Math.min(range.high, next.high), need: range.need };
    }
  }
  return range;
}

/** What keeps a column from its feed: an overlay link to a group that stays, a lane it may not cross, or its siblings. */
type HeldBy = 'overlay' | 'segment' | 'lane' | 'siblings' | 'canton' | 'keepout';
const HELD_TEXT: Record<HeldBy, string> = {
  overlay: 'an overlay link to a group that stays holds it',
  segment: 'an overlay segment holds it',
  lane: 'a reserved lane it would cross holds it',
  siblings: 'its siblings hold it a band gap away',
  keepout: 'a link that drops beside its edge holds it',
  canton: 'the canton column holds it',
};

/** The flanks that stand in a tier of `unit`: the passes that move columns may not move a column into one (`rows.ts` throws if it stands there). */
function flanksBesideUnit(model: LayoutModel, unit: Unit): LayoutGroup[] {
  return Object.values(model.groups).filter(group => group.flank !== undefined && group.bounds !== undefined && group.tier !== undefined && group.tier >= unit.low && group.tier <= unit.high);
}

/** The members of one canton that the inner pass may move, and the canton frame box that walls them. */
interface MemberScope { units: ReadonlySet<Unit>; wall: Column; canton: string }

/** One tier of `holdColumnAxes`: plans the pulled positions, applies them unless a lane forbids them, and reports the residuals. */
function pullTier(model: LayoutModel, tiers: Unit[][], index: number, feeds: (unit: Unit) => UnitFeeds, requestedSlack: number, scope?: MemberScope): boolean {
  const tier = tiers[index]!, derived = deriveFrames(model);
  // The inner pass of ticket 56 moves the members of one canton only and slides no cell beyond its member's box: the canton box is the wall.
  const inScope = (unit: Unit): boolean => scope === undefined || scope.units.has(unit);
  const columnSlack = scope === undefined ? requestedSlack : 0;
  if (derived === undefined || tier.some(unit => inScope(unit) && !unit.frame && groupShape(model, unit.id) !== 'row')) return false;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const gap = bandGap(model), free = overlayFreeGroups(model, selectAnchorTier(model));
  // A frame with a feed wants the moves that reach the feed and every partner that stays (both ranges met). When
  // no move does, an overlay link to a group that stays holds the frame where it stands: it is pinned.
  const held = new Map<Unit, HeldBy>(), pinned = new Set<Unit>(), wanting = new Set<Unit>(), flush = new Set<Unit>();
  const standing = tier.filter(inScope).map(unit => {
    const at = unit.frame ? box.get(unit.id)! : unit.groups[0]!.bounds!;
    let range: MoveRange | undefined;
    if (unit.frame) {
      range = feedRange(model, unit, feeds, at, columnSlack);
      const overlay = overlayRange(model, unit, tier, free, at, columnSlack);
      if (overlay !== undefined) {
        const met = range === undefined ? overlay : { ...range, low: Math.max(range.low, overlay.low), high: Math.min(range.high, overlay.high) };
        if (met.low > met.high + PLACEMENT_EPS) { pinned.add(unit); held.set(unit, 'overlay'); range = undefined; } else range = met;
      }
    }
    let from = at.x + (range?.low ?? 0), to = at.x + (range?.high ?? 0);
    if (range !== undefined && scope !== undefined) {
      // The member frame stays inside the canton frame with the group margin to spare. A range wholly beyond the wall
      // ends at the wall, and the member is held by the canton.
      // A member above the anchor tier may stand past the wall up to the aligned extent its cells reserved in 7c (architecture-2 ticket 31).
      // `memberRoom` is the one reader of the member wall: the member window of centring (`columnWindow`) and the chord step call it too.
      const room = memberRoom(model, scope.wall, at, unit.groups.map(cell => cell.id), GROUP_PADDING), low = room.low, high = room.high - at.width;
      // The widest member fills the wall (`high` = `low`): the wall is its own box, and the canton pass already reports its feed.
      if (high - low >= PLACEMENT_EPS) {
        if (from > high + PLACEMENT_EPS || to < low - PLACEMENT_EPS) { held.set(unit, 'canton'); from = to = from > high ? high : low; }
        else { from = Math.max(from, low); to = Math.min(to, high); }
      } else { from = to = at.x; flush.add(unit); }
    }
    // A flank stands where it stands: its box is a wall the pull may not cross. A frame column keeps a band gap and its slack from a plain group
    // (`runSpacing`), boxes measured, so the flank is that wall too (ticket 19). A unit already past the wall stays where it is, and nothing here moves it back.
    for (const flank of flanksBesideUnit(model, unit)) {
      const wall = gap + (unit.frame ? COLUMN_SLACK : 0);
      if (flank.flank!.align === 'right') to = Math.max(Math.min(to, flank.bounds!.x - wall - at.width), at.x);
      else from = Math.min(Math.max(from, flank.bounds!.x + flank.bounds!.width + wall), at.x);
    }
    from = Math.min(from, to); to = Math.max(from, to);
    if (range !== undefined) wanting.add(unit);
    return { unit, x: at.x, width: at.width, slack: unit.frame ? columnSlack : 0, from, to };
  }).sort((a, b) => a.x - b.x || compareId(a.unit.id, b.unit.id));
  // Lefts of a run kept a band gap apart, less the offset of that run, must not fall: pool adjacent violators on
  // the wanted lefts, the nearest point of each range to where the unit stands in the plan so far.
  const offsets: number[] = [];
  let sum = 0;
  for (const [i, item] of standing.entries()) { offsets.push(sum); sum += item.width + gap + item.slack + (standing[i + 1]?.slack ?? 0); }
  // A pinned unit stays where the overlay order put it; it splits the run. The units on either side are pooled apart, each side
  // between its own pins (ticket 67): pooled across a pin, two wishes of opposite sign would average and move a unit away from its own
  // feed range, and a packed run with a pin would not be a fixed point.
  // The held points, as z = x - offset, must not fall along the tier, or the clamp below is not exact and a held frame
  // would move: the geometry after the later rules can stand closer than the plan keeps frames (they slide into
  // the column slack). So the pins are taken first, in order, and a held point that would fall is dropped from the
  // pins; then the frames that only reach where they stand (`extra`) are added where they fit between the held ones.
  const plan = (pins: ReadonlySet<Unit>, extra: ReadonlySet<Unit> = new Set()): number[] => {
    const at = standing.map((item, i) => item.x - offsets[i]!);
    const fixed: (number | undefined)[] = standing.map(() => undefined);
    let last = -Infinity;
    for (const [i, item] of standing.entries()) if (pins.has(item.unit) && at[i]! >= last - PLACEMENT_EPS) { fixed[i] = at[i]; last = at[i]!; }
    for (const [i, item] of standing.entries()) {
      if (fixed[i] !== undefined || !extra.has(item.unit)) continue;
      const lower = Math.max(-Infinity, ...fixed.slice(0, i).filter((z): z is number => z !== undefined));
      const upper = Math.min(Infinity, ...fixed.slice(i + 1).filter((z): z is number => z !== undefined));
      if (at[i]! >= lower - PLACEMENT_EPS && at[i]! <= upper + PLACEMENT_EPS) fixed[i] = at[i];
    }
    const below = fixed.map((_, i) => Math.max(-Infinity, ...fixed.slice(0, i + 1).filter((z): z is number => z !== undefined)));
    const above = fixed.map((_, i) => Math.min(Infinity, ...fixed.slice(i).filter((z): z is number => z !== undefined)));
    const segment = fixed.map((_, i) => 2 * fixed.slice(0, i).filter(z => z !== undefined).length + (fixed[i] !== undefined ? 1 : 0));
    const fit = (wanted: number[]): number[] => {
      const blocks: { sum: number; count: number; segment: number }[] = [];
      for (const [at, wish] of wanted.entries()) {
        blocks.push({ sum: wish - offsets[at]!, count: 1, segment: segment[at]! });
        while (blocks.length > 1 && blocks[blocks.length - 2]!.segment === blocks[blocks.length - 1]!.segment && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
          const last = blocks.pop()!, before = blocks[blocks.length - 1]!;
          before.sum += last.sum; before.count += last.count;
        }
      }
      return blocks.flatMap(block => Array.from({ length: block.count }, () => block.sum / block.count)).map((base, at) => Math.min(Math.max(base, below[at]!), above[at]!) + offsets[at]!);
    };
    let lefts = standing.map(item => item.x);
    for (let round = 0; round < 200; round++) {
      const next = fit(lefts.map((left, at) => Math.min(Math.max(left, standing[at]!.from), standing[at]!.to)));
      const change = Math.max(...next.map((left, at) => Math.abs(left - lefts[at]!)));
      lefts = next;
      if (change < 1e-9) break;
    }
    return lefts;
  };
  // In a tier where an overlay link pins a frame, the overlay order (ticket 06b) has already traded the order and
  // the places of the frames against the bends of their links, and the score reads bends. A frame that reaches its
  // feed where it stands then gives way to a sibling only when that lets the sibling reach its own: a partial move
  // that ends short gains no straight link, and the cells it moves are tied by links of their own that centring,
  // which slides the feed cell only, would leave jogged. When such a plan leaves a frame short, the frames that
  // reach where they stand are held, and the plan is made again. A tier with no pinned frame keeps the give and take.
  const short = (at: number[]): boolean => standing.some((item, i) => wanting.has(item.unit) && (at[i]! < item.from - PLACEMENT_EPS || at[i]! > item.to + PLACEMENT_EPS));
  let lefts = plan(pinned);
  if (pinned.size > 0 && short(lefts)) {
    const reaching = new Set(standing.filter(item => wanting.has(item.unit) && item.from <= item.x + PLACEMENT_EPS && item.to >= item.x - PLACEMENT_EPS).map(item => item.unit));
    lefts = plan(pinned, reaching);
  }
  const isCanton = (unit: Unit): boolean => isCantonUnit(model, unit);
  /**
   * The close-up of the run (ranked-groups ticket 65), part of this plan: the plan's own lefts with the run packed at the spacing of
   * `runSpacing`. A pinned unit stays where it stands, so it fixes the base of the run; a unit that reaches its feed is not pushed off
   * it, and none is pushed farther off its feed than the plan left it. With no pin the base is the least jog to the feed ranges,
   * nearest the centre the plan gave the run. A run that cannot close says why (`cause`), and the plan stands as it is.
   */
  const closeRun = (planned: number[]): { lefts?: number[]; cause?: string; spread?: boolean } => {
    if (scope !== undefined || !standing.some(item => isCanton(item.unit))) return {};
    const run = standing.map(item => item.unit), rect = (unit: Unit): Rect => unit.frame ? box.get(unit.id)! : unit.groups[0]!.bounds!;
    const offset = runSpacing(model, run, rect, columnSlack);
    const apart = (lefts: readonly number[]): boolean => lefts.some((left, i) => i > 0 && Math.abs(left - lefts[i - 1]! - (offset[i]! - offset[i - 1]!)) > PLACEMENT_EPS);
    if (!apart(standing.map(item => item.x))) return {};
    const blockedBy = stepBlock(model, tier, run, rect, isCanton);
    if (blockedBy !== undefined) return { cause: blockedBy };
    if (!apart(planned)) return { spread: true };
    const pins = standing.flatMap((item, i) => pinned.has(item.unit) ? [item.x - offset[i]!] : []);
    const lastItem = standing[standing.length - 1]!;
    const keep = (planned[0]! + planned[planned.length - 1]! + lastItem.width) / 2 - (offset[offset.length - 1]! + lastItem.width) / 2;
    let base = keep;
    if (pins.length && Math.max(...pins) - Math.min(...pins) <= PLACEMENT_EPS) base = pins[0]!;
    else {
      // Pins that stand apart cannot all stay: they count as points, and the run stands where it costs the least distance from them
      // and from the feed ranges. The lane and the straight-link guards of the attempt still refuse the move.
      const spans = standing.flatMap((item, i) => wanting.has(item.unit) ? [{ low: item.from - offset[i]!, high: item.to - offset[i]! }]
        : pinned.has(item.unit) ? [{ low: item.x - offset[i]!, high: item.x - offset[i]! }] : []);
      if (spans.length) base = leastJog(spans, keep);
    }
    const target = offset.map(value => base + value);
    const off = (item: typeof standing[number], at: number): number => Math.max(0, item.from - at, at - item.to);
    if (standing.some((item, i) => wanting.has(item.unit) && off(item, target[i]!) > off(item, planned[i]!) + 0.5)) return { cause: 'a feed a column reaches holds it' };
    return { lefts: target };
  };
  /** Moves the units to `target` unless a lane or a straight overlay link forbids it; the move is undone when it is refused. */
  const attempt = (target: number[], withBoxes: boolean, byCount = false): { shifts: Map<LayoutGroup, number>; allowed: boolean; blocked: boolean; bent: boolean } => {
    const shifts = new Map<LayoutGroup, number>();
    for (const [i, item] of standing.entries()) {
      const dx = target[i]! - item.x;
      if (Math.abs(dx) > PLACEMENT_EPS) for (const group of item.unit.groups) shifts.set(group, dx);
    }
    const allowed = shifts.size > 0 && holdsMove(model, [...shifts].map(([group, dx]) => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } })));
    // A move must not put a frame into the way of an overlay link that is one straight segment: the cells slide
    // inside the box later, so the box is what the segment must clear, and the link would be routed round the
    // cells. The plan is refused as a whole, as for a lane, and the columns stay where they stand.
    const straight = allowed ? straightOverlays(model) : [];
    const before = new Map(deriveFrames(model)?.map(frame => [frame.id, frame.box]));
    // `moveGroup` carries anchors but not pill bounds, and the straightness below reads pills: the shifted
    // groups' node geometry is rebuilt before the reading, and again on rollback (ticket 17 review).
    const settle = (): void => rebuildNodeGeometry(model, [...shifts.keys()].flatMap(group => group.nodes), 'current');
    const undo = exactUndo(model, shifts.keys());
    if (allowed) { for (const [group, dx] of shifts) moveGroup(model, group, dx, 0); settle(); }
    const after = new Map(deriveFrames(model)?.map(frame => [frame.id, frame.box]));
    // The ends are read after the move: a frame that ends a link takes its own ports with it.
    const segments = straightOverlays(model, byCount ? undefined : new Set(straight.map(({ id }) => id)));
    // A link that stood as one segment and is not one after the move has been bent by it: a node body or a pill
    // now stands in its way. `segments` lists only the links that are still straight, so the test is a count.
    const bent = straightFell(segments, straight, byCount);
    tapVerdict('pullTier', () => `${bent} ${byCount} ${segments.length}/${straight.length}`);
    const blocked = bent || (withBoxes && segments.some(({ ends, from, to }) => standing.some(item => {
      const was = item.unit.frame ? before.get(item.unit.id) : undefined, now = item.unit.frame ? after.get(item.unit.id) : undefined;
      return was !== undefined && now !== undefined && shifts.has(item.unit.groups[0]!) && !item.unit.groups.some(group => ends.has(group.id))
        && crosses(from, to, now) && !crosses(from, to, was);
    })));
    if (blocked) { undo(); settle(); }
    return { shifts, allowed, blocked, bent };
  };
  // A left the plan takes may put a foreign drop along the unit's edge (ticket 75). The unit then stays on its own side of the band, the way
  // it stood; a snap that would close a band gap on a neighbour is not made.
  const drops = standing.map(item => item.unit.frame ? foreignDrops(model, item.unit) : []);
  const snapped = new Set<Unit>();
  const keepOut = (target: number[]): number[] => {
    const out = snapOut(target, standing.map(item => item.x), standing.map(item => item.width), drops, i => standing[i - 1]!.width + gap);
    for (const [i, item] of standing.entries()) if (Math.abs(out[i]! - target[i]!) > PLACEMENT_EPS) snapped.add(item.unit);
    return out;
  };
  lefts = keepOut(lefts);
  const closing = closeRun(lefts);
  if (closing.lefts !== undefined) closing.lefts = keepOut(closing.lefts);
  let result = closing.lefts === undefined ? undefined : attempt(closing.lefts, requestedSlack > 0, true);
  let cause = closing.cause;
  // In 7f (slack 0) the frame boxes do not slide, so the node bodies, read exactly, decide; the close-up is refused as the plan is.
  if (result !== undefined && result.shifts.size > 0 && (!result.allowed || result.blocked)) {
    cause = result.blocked ? 'a straight overlay link would be bent' : 'a reserved lane it would cross holds it';
    result = undefined;
  }
  const { shifts, allowed, blocked } = result ?? attempt(lefts, true);
  // The plan itself was refused while the run stands apart: the run stays, and the warning says why.
  if (cause === undefined && closing.cause === undefined && shifts.size > 0 && (!allowed || blocked) && closing.spread === true) {
    cause = blocked ? 'a straight overlay link would be bent' : 'a reserved lane it would cross holds it';
  }
  const refused = shifts.size > 0 && (!allowed || blocked);
  if (refused) for (const item of standing) if (shifts.has(item.unit.groups[0]!) && !held.has(item.unit)) held.set(item.unit, blocked ? 'segment' : 'lane');
  // A unit the keep-out held back from the plan is held by the drop, not by its siblings.
  for (const unit of snapped) if (!held.has(unit)) held.set(unit, 'keepout');
  // A column its siblings stop short of its feed may be held by a straight overlay link as well: the move that would reach the feed alone
  // bends the link. The reason that names the link is the one that stays true if the sibling moves away (ticket 75: a centring that reaches
  // its fixed point leaves the siblings closer, so the plan no longer tries the move the link refuses).
  for (const item of standing) {
    if (!item.unit.frame || held.has(item.unit) || !wanting.has(item.unit) || shifts.has(item.unit.groups[0]!)) continue;
    const dx = item.x < item.from - PLACEMENT_EPS ? item.from - item.x : item.x > item.to + PLACEMENT_EPS ? item.to - item.x : 0;
    if (dx === 0) continue;
    const straight = straightOverlays(model), moved = new Map(item.unit.groups.map(group => [group, dx] as const));
    const undo = exactUndo(model, moved.keys());
    for (const [group, by] of moved) moveGroup(model, group, by, 0);
    const nodes = [...moved.keys()].flatMap(group => group.nodes);
    rebuildNodeGeometry(model, nodes, 'current');
    const bent = straightFell(straightOverlays(model, new Set(straight.map(({ id }) => id))), straight, false);
    tapVerdict('pullTierHeld', () => `${bent}`);
    undo(); rebuildNodeGeometry(model, nodes, 'current');
    if (bent) held.set(item.unit, 'segment');
  }
  reportHeld(model, tier.filter(item => inScope(item) && !flush.has(item)), feeds, held, columnSlack, scope);
  if (scope === undefined && standing.some(item => isCanton(item.unit))) {
    const cantons = standing.filter(item => isCanton(item.unit)).map(item => item.unit.id);
    const named = standing.find(item => isCanton(item.unit) && item.unit.groups.some(group => shifts.has(group)))?.unit.id ?? cantons[0]!;
    warnCloseUp(model, cantons, named, cause);
  }
  return allowed && !blocked;
}

/**
 * Says once per column, and again only with a new number, how far its feed links still jog beyond what the
 * cells inside the column can absorb by sliding to the wall: the least jog its siblings leave it.
 */
function reportHeld(model: LayoutModel, tier: Unit[], feeds: (unit: Unit) => UnitFeeds, heldBy: ReadonlyMap<Unit, HeldBy>, slack: number, scope?: MemberScope): void {
  const derived = deriveFrames(model);
  if (derived === undefined) return;
  for (const unit of tier.filter(item => item.frame)) {
    // The first owner is the column that is held; a member's warning names its canton as the second.
    model.diagnostics = model.diagnostics.filter(item => !(item.code === COLUMN_AXIS_HELD && item.owners?.[0] !== undefined && 'id' in item.owners[0] && item.owners[0].id === unit.id));
    const range = feedRange(model, unit, feeds, derived.find(item => item.id === unit.id)!.box, slack);
    // Standing where it stands, the column reaches its feed when 0 lies in the range of moves.
    const residual = range === undefined ? 0 : Math.max(0, range.low, -range.high);
    if (residual > 0.5) model.diagnostics.push({ stage: 'placement', severity: 'warning', code: COLUMN_AXIS_HELD,
      owners: [{ kind: 'group', id: unit.id }, ...(scope ? [{ kind: 'group' as const, id: scope.canton }] : [])],
      message: `${scope ? `Member ${unit.id} of canton ${scope.canton}` : `Column ${unit.id}`} cannot reach its feed: ${HELD_TEXT[heldBy.get(unit) ?? 'siblings']}, so its feed links keep a jog of ${residual.toFixed(1)} px.` });
  }
}

/**
 * The sweep of `separateFrameColumns` as a plan: how far each group would move right so that the frames
 * and one-rank row groups of a document tier stand a band gap plus `slack` on each side that is a frame's
 * apart, reading the geometry as it stands and moving nothing. A frame moves as a whole, so every cell of
 * it is listed with the same dx. A rule that widens a cell (a label the box must hold) asks for this with
 * a `slack` of 0 for the widening applied: a frame box is wider than its cells, so the gap between two cells
 * that the rule keeps (`growthPlan`) is not the gap between their frames (ranked-groups ticket 15).
 */
export function columnShifts(model: LayoutModel, slack: number): Map<LayoutGroup, number> {
  const shifts = new Map<LayoutGroup, number>();
  const derived = deriveFrames(model);
  if (derived === undefined) return shifts;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const gap = bandGap(model);
  for (const all of frameTiers(model)) {
    // The rows rule may move frames (their cells are rows) and one-rank row groups. A grid, a bar or a
    // flank stands where it stands, out of the sweep; the collision guard of `repackOverlaps` reports a clash.
    const tier = all.filter(unit => unit.frame || groupShape(model, unit.id) === 'row');
    const extent = (unit: Unit): { x: number; end: number } => unit.frame
      ? { x: box.get(unit.id)!.x, end: box.get(unit.id)!.x + box.get(unit.id)!.width }
      : { x: unit.groups[0]!.bounds!.x, end: unit.groups[0]!.bounds!.x + unit.groups[0]!.bounds!.width };
    const standing = tier.map(unit => ({ unit, ...extent(unit) })).sort((a, b) => a.x - b.x || compareId(a.unit.id, b.unit.id));
    let end = -Infinity;
    for (const { unit, x, end: right } of standing) {
      const dx = Math.max(0, end + (unit.frame ? slack : 0) - x);
      if (dx > PLACEMENT_EPS) for (const group of unit.groups) shifts.set(group, dx);
      end = right + dx + gap + (unit.frame ? slack : 0);
    }
  }
  return shifts;
}

/** The x of every foreign port a routed link of `unit` drops to, with the clearance a frame edge keeps from it (ticket 75). */
function foreignDrops(model: LayoutModel, unit: Unit): { x: number; margin: number }[] {
  // A canton stands a band gap from the next one (ticket 65), which the keep-out does not override.
  if (unit.frame && model.document.frames?.[unit.id]?.kind === 'canton') return [];
  const own = new Set(unit.groups.map(group => group.id)), drops: { x: number; margin: number }[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.removed === true || link.technique === 'stub' || !link.attachments) continue;
    const ends = [link.attachments.from, link.attachments.to], groups = ends.map(end => model.document.nodes[end.node]?.group);
    for (const [mine, other] of [[0, 1], [1, 0]] as const) {
      const inside = groups[mine], outside = groups[other];
      if (inside === undefined || outside === undefined || !own.has(inside) || own.has(outside)) continue;
      const port = findPort(model, ends[other]!), group = model.groups[outside];
      if (!port?.anchor || !group || group.tier === model.groups[inside]?.tier || (port.side !== 'top' && port.side !== 'bottom')) continue;
      drops.push({ x: port.anchor.x, margin: GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2 + PLACEMENT_EPS });
    }
  }
  return drops;
}

/**
 * The lefts a box of `width` may not take because a foreign drop would then run along one of its edges: G6 refuses a segment that runs
 * outside a group box closer than the edge clearance and half its stroke, and routing can only discover that. Sorted, open intervals.
 */
function keepOutLefts(drops: readonly { x: number; margin: number }[], width: number): [number, number][] {
  return drops.flatMap(({ x, margin }): [number, number][] => [[x - PLACEMENT_EPS, x + margin], [x - width - margin, x - width + PLACEMENT_EPS]]).sort((a, b) => a[0] - b[0]);
}

/**
 * The targets with every left that would put a foreign drop along an edge held where the unit stands (ticket 75), unless that closes the
 * step to a neighbour below `step`. `drops` is empty for a unit that has no box to keep the drops from.
 */
function snapOut(target: readonly number[], now: readonly number[], width: readonly number[], drops: readonly (readonly { x: number; margin: number }[])[], step: (index: number) => number): number[] {
  const out = [...target];
  for (let i = 0; i < out.length; i++) {
    for (const [low, high] of keepOutLefts(drops[i]!, width[i]!)) {
      if (out[i]! <= low || out[i]! >= high || (now[i]! > low && now[i]! < high)) continue;
      const snapped = now[i]! <= low ? low : high;
      const before = i > 0 ? out[i - 1]! + step(i) : -Infinity, after = i + 1 < out.length ? out[i + 1]! - step(i + 1) : Infinity;
      if (snapped >= before - PLACEMENT_EPS && snapped <= after + PLACEMENT_EPS) out[i] = snapped;
    }
  }
  return out;
}

/**
 * How far each unit of a frame tier moves right so that no foreign drop runs along one of its edges (ticket 75). A routed link between a
 * cell of the unit and a port of another tier's group drops to the x of that port, from a row in the padding of the unit. When that x falls
 * outside the unit's box, within the edge clearance and half the stroke of an edge, the drop runs along the edge: a spacing routing would
 * discover, and placement can reserve. The unit moves by the smallest amount that leaves the band. Reads the geometry as it stands and
 * moves nothing.
 */
export function keepOutShifts(model: LayoutModel): Map<LayoutGroup, number> {
  const shifts = new Map<LayoutGroup, number>();
  const derived = deriveFrames(model);
  if (derived === undefined) return shifts;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  for (const all of frameTiers(model)) {
    for (const unit of all.filter(item => item.frame || groupShape(model, item.id) === 'row')) {
      const at = unit.frame ? box.get(unit.id) : unit.groups[0]!.bounds;
      if (at === undefined) continue;
      let dx = 0;
      for (const [low, high] of keepOutLefts(foreignDrops(model, unit), at.width)) if (at.x > low && at.x < high) dx = Math.max(dx, high - at.x);
      if (dx > PLACEMENT_EPS) for (const group of unit.groups) shifts.set(group, Math.max(shifts.get(group) ?? 0, dx));
    }
  }
  return shifts;
}

/**
 * The unit each group stands in for `columnShifts`: the id of its top-level frame, or its own id for a
 * one-rank row group beside frames. A group not listed (a grid, a bar, a group in a tier with no frame)
 * is not swept. A rule that plans the widening of a cell and then asks `columnShifts` must not also push
 * the cells of another unit itself: the sweep measures frame boxes, and a cell push it cannot see is
 * counted twice (ranked-groups ticket 15).
 */
export function sweptUnits(model: LayoutModel): Map<string, string> {
  const units = new Map<string, string>();
  for (const all of frameTiers(model)) {
    for (const unit of all.filter(item => item.frame || groupShape(model, item.id) === 'row')) {
      for (const group of unit.groups) units.set(group.id, unit.id);
    }
  }
  return units;
}

/**
 * The child frames that stand beside the cells of their parent, as one row (ranked-groups ticket 28): each child
 * that shares a sub-tier with a cell of its parent, or with a sibling child, is packed against those cells again
 * from the geometry as it stands. The pack sweep laid the row out from the boxes ELK sized, and the stages
 * after it (`fitGroupBox`, lane and region widths, centring) change the widths and the places of the cells, so
 * the row is laid again at the start and at the end of centring, and after the rows rule. A child stays on the side
 * it stands on and moves toward the cells of its parent: its frame box ends `GROUP_PADDING` from the widest parent cell
 * on that side, and two children side by side end `2 * GROUP_PADDING` apart, the margin each block keeps. The
 * parent's cells stay where they are, and a child with a cell that `movable` refuses stays where it is. Idempotent:
 * a row that stands packed is not moved. Returns whether a cell moved.
 */
export function packBesideRows(model: LayoutModel, movable: (cell: string) => boolean = () => true): boolean {
  const frames = model.document.frames, derived = deriveFrames(model);
  if (frames === undefined || derived === undefined) return false;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...childrenOf(id).flatMap(cellsOf)];
  const tierOf = (cell: string): number => cellTier(model, cell);
  let moved = false;
  for (const parent of Object.keys(frames)) {
    const children = childrenOf(parent).map(child => ({ child, box: box.get(child)!, range: tierRange(model, child) }));
    const { own: beside, rows: pure } = besideRows(frames[parent]!.cells, tierOf, children, item => item.range);
    if (!beside.length && !pure.length) continue;
    const standing = frames[parent]!.cells.filter(cell => beside.some(item => tierOf(cell) >= item.range[0] && tierOf(cell) <= item.range[1])).map(cell => cellReach(model, cell));
    const centre = (item: typeof children[number]): number => item.box.x + item.box.width / 2;
    const place = (item: typeof children[number], x: number): void => {
      const delta = x - item.box.x;
      // A child with a cell that the caller may not move (the anchor tier or a flank in centring) stays; its edge still bounds the next.
      if (Math.abs(delta) <= PLACEMENT_EPS || !cellsOf(item.child).every(movable)) return;
      for (const cell of cellsOf(item.child)) moveGroup(model, model.groups[cell]!, delta, 0);
      item.box = { ...item.box, x };
      moved = true;
    };
    // `GROUP_PADDING` below is `CELL_TO_CHILD_FRAME_GAP` from the reach of a parent cell (the first child of a side) and the margin of the frame
    // before it (every next child), so two children end `FRAME_TO_FRAME_GAP` apart. The sums stay as they were written: the order of the additions is the output.
    const closeUp = (row: typeof children): void => {
      const sorted = [...row].sort((a, b) => centre(a) - centre(b));
      let edge = sorted[0]!.box.x + sorted[0]!.box.width + GROUP_PADDING;
      for (const item of sorted.slice(1)) { place(item, edge + GROUP_PADDING); edge = item.box.x + item.box.width + GROUP_PADDING; }
    };
    if (standing.length) {
      const low = Math.min(...standing.map(reach => reach.x)), high = Math.max(...standing.map(reach => reach.x + reach.width)), middle = (low + high) / 2;
      let edge = high;
      for (const item of beside.filter(item => centre(item) >= middle).sort((a, b) => centre(a) - centre(b))) { place(item, edge + GROUP_PADDING); edge = item.box.x + item.box.width + GROUP_PADDING; }
      edge = low;
      for (const item of beside.filter(item => centre(item) < middle).sort((a, b) => centre(b) - centre(a))) { place(item, edge - GROUP_PADDING - item.box.width); edge = item.box.x - GROUP_PADDING; }
    } else if (beside.length) {
      // Children with no cell of the parent between them: the first from the left stays, the rest close up to it.
      closeUp(beside);
    }
    for (const row of pure) closeUp(row);
  }
  return moved;
}

/** A window `[low, high]` on the x of a cell box; a cell of a frame that stands beside another column keeps inside it. */
export interface CellWindow { low: number; high: number }

/**
 * The walls between the columns of one parent (ranked-groups ticket 28). A child frame that shares a sub-tier
 * with a cell of its parent, or with a sibling child, stands beside those cells: its frame box and the parent's
 * cells of those ranks are two disjoint columns. The top-level column that centring keeps a cell inside is
 * the whole parent, so the two columns need a wall of their own. A cell of the child stays inside the child's
 * box, a cell of the parent or of a sibling stays on its side of the child's box grown by `GROUP_PADDING`
 * (the room a parent box leaves its child). Read off the geometry as it stands, like `frameColumns`, and keyed
 * by cell id. A cell that stands beside nothing is not listed.
 */
export function besideWalls(model: LayoutModel): Map<string, CellWindow> {
  const walls = new Map<string, CellWindow>();
  const frames = model.document.frames, derived = deriveFrames(model);
  if (frames === undefined || derived === undefined) return walls;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...childrenOf(id).flatMap(cellsOf)];
  const tierOf = (cell: string): number => cellTier(model, cell);
  const narrow = (cell: string, wall: Partial<CellWindow>): void => {
    const known = walls.get(cell) ?? { low: -Infinity, high: Infinity };
    walls.set(cell, { low: Math.max(known.low, wall.low ?? -Infinity), high: Math.min(known.high, wall.high ?? Infinity) });
  };
  for (const parent of Object.keys(frames)) {
    const children = childrenOf(parent);
    for (const child of children) {
      const inside = cellsOf(child), tiers = new Set(inside.map(tierOf));
      const others = [...frames[parent]!.cells, ...children.filter(sibling => sibling !== child).flatMap(cellsOf)].filter(cell => tiers.has(tierOf(cell)));
      if (!others.length) continue;
      const wall = box.get(child)!;
      const left = (cell: string): boolean => { const reach = cellReach(model, cell); return reach.x + reach.width / 2 < wall.x + wall.width / 2; };
      for (const cell of inside) {
        const reach = cellReach(model, cell), at = model.groups[cell]!.bounds!;
        narrow(cell, { low: wall.x + (at.x - reach.x), high: wall.x + wall.width - (reach.x + reach.width - (at.x + at.width)) });
        // The child's edge that faces cells beside it is held by the cell that stands on it: a cell that gave the edge
        // up would shrink the frame and open the row (a frame is derived from its cells).
        if (others.some(left) && reach.x <= wall.x + PLACEMENT_EPS) narrow(cell, { high: wall.x + (at.x - reach.x) });
        if (others.some(cell => !left(cell)) && reach.x + reach.width >= wall.x + wall.width - PLACEMENT_EPS) narrow(cell, { low: wall.x + wall.width - reach.width + (at.x - reach.x) });
      }
      const edge = CELL_TO_CHILD_FRAME_GAP, own = new Set(frames[parent]!.cells);
      // The widest cell of the parent on each side: it stands `edge` from the child, so a narrower cell may stand
      // as much further as it is narrower, which is how far the row centres it on one axis.
      const widest = (side: boolean): number => Math.max(0, ...others.filter(cell => own.has(cell) && left(cell) === side).map(cell => cellReach(model, cell).width));
      for (const cell of others) {
        const reach = cellReach(model, cell), at = model.groups[cell]!.bounds!;
        // Near wall: the cell keeps its margin from the child. Far wall (parent cells only, a sibling child is held by
        // its own box): centring cannot slide it under its feed and open the row beyond the column slack.
        if (left(cell)) narrow(cell, { high: wall.x - edge - (reach.x + reach.width - (at.x + at.width)), ...(own.has(cell) ? { low: wall.x - edge - widest(true) + (at.x - reach.x) } : {}) });
        else narrow(cell, { low: wall.x + wall.width + edge + (at.x - reach.x), ...(own.has(cell) ? { high: wall.x + wall.width + edge + widest(false) - (reach.x + reach.width - (at.x + at.width)) } : {}) });
      }
    }
  }
  return walls;
}

/** The column of one top-level frame as it stands: its x extent, the sub-tiers it spans, and its cells. */
export interface FrameColumn extends Column {
  id: string; from: number; to: number; cells: ReadonlySet<string>;
  /** A canton's frame box, without slack: the wall of its members (ticket 56). A member never spends the slack, or the box would grow by it at every replay. */
  wall?: Column;
}

/**
 * The columns of a model's top-level frames, read off the geometry as it stands. A parent's frame box
 * holds its children, so the box of a top-level frame, with up to `COLUMN_SLACK` on each side that the next frame leaves beyond a band gap, is its column, and every cell of a child frame
 * stands in the column of the top-level frame above it. Centring reads them once, before its first
 * step, and treats them as walls: a cell stays inside its column, and a group that is not in a frame
 * stays out of the column of every frame whose sub-tiers it shares.
 */
export function frameColumns(model: LayoutModel): FrameColumn[] {
  const frames = model.document.frames, derived = deriveFrames(model);
  if (frames === undefined || derived === undefined) return [];
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...childrenOf(id).flatMap(cellsOf)];
  const tops = derived.filter(frame => frame.parent === undefined).map(frame => {
    const cells = cellsOf(frame.id), tiers = cells.map(cell => model.groups[cell]!.tier!);
    return { frame, cells, from: Math.min(...tiers), to: Math.max(...tiers) };
  });
  const gap = bandGap(model);
  return tops.map(({ frame, cells, from, to }) => {
    // The slack is what the boxes of the neighbour frames leave beyond a band gap, shared between the
    // two; read off the boxes as they stand, so a replay of centring cannot spend it a second time.
    const room = (side: 1 | -1): number => {
      let free = Infinity;
      for (const other of tops) {
        if (other.frame === frame || other.from > to || other.to < from) continue;
        const between = side > 0 ? other.frame.box.x - (frame.box.x + frame.box.width) : frame.box.x - (other.frame.box.x + other.frame.box.width);
        if (between >= 0) free = Math.min(free, Math.max(0, between - gap) / 2);
      }
      return Math.min(COLUMN_SLACK, free);
    };
    const low = room(-1), high = room(1);
    return { id: frame.id, x: frame.box.x - low, width: frame.box.width + low + high, from, to, cells: new Set(cells),
      ...(frame.kind === 'canton' ? { wall: { x: frame.box.x, width: frame.box.width } } : {}) };
  });
}


