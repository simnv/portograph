import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { cellReach, deriveFrames } from './frames.js';
import { GROUP_PADDING } from './regions.js';
import { selectAnchorTier } from './lanes.js';
import { findPort } from './row-paths.js';
import { bandGap, compareId, portId } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { groupShape } from './grid.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * How far a cell may stand off the axis of its column, to either side, so a wide cell can meet a port
 * of the narrow cell below it that is not on the axis. A column is packed this far from each neighbour
 * on top of the band gap, so the frame boxes of two neighbours stay a band gap apart at the limit.
 */
export const COLUMN_SLACK = GROUP_PADDING;

/** The x extent one frame or one-rank group owns in its document tier. */
export interface Column { x: number; width: number }

/** Everything that stands in one column: the cells of a frame and of its child frames, or one group. */
interface Unit { id: string; frame: boolean; groups: LayoutGroup[]; low: number; high: number }

/**
 * The frames and one-rank groups of a model, grouped by document tier. A document tier is not stored:
 * the sub-tiers of its groups are contiguous and the tiers do not share one, so units whose sub-tier
 * ranges touch belong to one tier.
 */
function columnTiers(model: LayoutModel): Unit[][] {
  const frames = model.document.frames ?? {};
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...childrenOf(id).flatMap(cellsOf)];
  const units: Unit[] = [];
  for (const id of Object.keys(frames).filter(item => frames[item]!.parent === undefined)) {
    const groups = cellsOf(id).map(cell => model.groups[cell]!);
    units.push({ id, frame: true, groups, low: Math.min(...groups.map(group => group.tier!)), high: Math.max(...groups.map(group => group.tier!)) });
  }
  for (const group of Object.values(model.groups)) {
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
  const frames = model.document.frames;
  if (frames === undefined) return columns;
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  const widthOf = (id: string): number => Math.max(0, ...frames[id]!.cells.map(cell => cellReach(model, cell).width),
    ...childrenOf(id).map(child => widthOf(child) + 2 * GROUP_PADDING));
  /** Centre every cell of a frame, and of its children, on one axis. */
  const centre = (id: string, axis: number): void => {
    for (const cell of frames[id]!.cells) {
      const reach = cellReach(model, cell);
      moveGroup(model, model.groups[cell]!, axis - (reach.x + reach.width / 2), 0);
    }
    for (const child of childrenOf(id)) centre(child, axis);
  };

  const tiers = columnTiers(model);

  const gap = bandGap(model);
  // The order is the ELK order of the rank-0 cell of a frame (its first sub-tier, which is the cell ELK
  // placed against the tier above), or of the group itself when it is not in a frame.
  const order = (unit: Unit): number => {
    const first = unit.groups.reduce((best, group) => group.tier! < best.tier! ? group : best);
    return first.bounds!.x + first.bounds!.width / 2;
  };
  const left = (unit: Unit): number => Math.min(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x : group.bounds!.x));
  const right = (unit: Unit): number => Math.max(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x + cellReach(model, group.id).width : group.bounds!.x + group.bounds!.width));
  /** The width a unit takes in its tier: a frame with its slack on each side, a group by its box. */
  const extent = (unit: Unit): number => unit.frame ? widthOf(unit.id) + 2 * COLUMN_SLACK : unit.groups[0]!.bounds!.width;

  // A column's axis lands on its feed before the width of any sibling is fixed (ticket 11): the tier
  // of the anchor packs first, then the tiers outward one at a time in the order centring steps, and a
  // tier reads the ports of the tier packed just before it. A tier that no routed link joins to it
  // takes the centre ELK gave it.
  const tierOf = new Map<Unit, number>(), unitOf = new Map<string, Unit>();
  for (const [index, tier] of tiers.entries()) for (const unit of tier) {
    tierOf.set(unit, index);
    for (const group of unit.groups) unitOf.set(group.id, unit);
  }
  const anchor = selectAnchorTier(model);
  const first = Math.max(0, tiers.findIndex(tier => tier.some(unit => anchor !== undefined && unit.low <= anchor && anchor <= unit.high)));
  const steps: { index: number; authority: number | undefined }[] = [{ index: first, authority: undefined },
    ...tiers.slice(first + 1).map((_, i) => ({ index: first + 1 + i, authority: first + i })),
    ...tiers.slice(0, first).map((_, i) => ({ index: first - 1 - i, authority: first - i }))];

  /** The centre a unit wants: over the mean of its routed feeds in the packed tier, `undefined` without one. */
  const wanted = (unit: Unit, index: number, authority: number | undefined): number | undefined => {
    if (authority === undefined) return undefined;
    const parents = new Map<string, number>(), children = new Map<string, number>();
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
      for (const [own, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
        const ownGroup = model.document.nodes[own!.node]?.group, otherGroup = model.document.nodes[other!.node]?.group;
        if (ownGroup === undefined || otherGroup === undefined || unitOf.get(ownGroup) !== unit || tierOf.get(unitOf.get(otherGroup)!) !== authority) continue;
        const child = findPort(model, own!), parent = findPort(model, other!);
        if (!child?.anchor || !parent?.anchor) continue;
        if (child.side !== (index > authority ? 'top' : 'bottom') || parent.side !== (index > authority ? 'bottom' : 'top')) continue;
        const cell = model.groups[ownGroup]!, at = unit.frame ? cellReach(model, cell.id) : cell.bounds!;
        children.set(portId(child.ref), child.anchor.x - (at.x + at.width / 2));
        parents.set(portId(parent.ref), parent.anchor.x);
      }
    }
    if (!parents.size || !children.size) return undefined;
    const mean = (values: Iterable<number>): number => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
    return mean(parents.values()) - mean(children.values());
  };

  for (const { index, authority } of steps) {
    const tier = tiers[index]!;
    if (!tier.some(unit => unit.frame)) {
      // A tier of one-rank groups is left where ELK put it, except that the sweep of `placeFlanksAndPeers`
      // will push apart the groups ELK left closer than a band gap. It is done here so the feed x that
      // the tier below reads is the x the tier keeps.
      let end = -Infinity;
      for (const group of tier.flatMap(unit => unit.groups).sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id))) {
        if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
        end = group.bounds!.x + group.bounds!.width + gap;
      }
      continue;
    }
    const run = [...tier].sort((a, b) => order(a) - order(b) || compareId(a.id, b.id));
    const centres = run.map(unit => wanted(unit, index, authority));
    // Left edge of each unit once packed a band gap apart, and where its column would stand if it had its way.
    let lefts: number[];
    if (centres.every(centre => centre === undefined)) {
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
        const centre = centres[i] ?? (left(unit) + right(unit)) / 2;
        blocks.push({ sum: centre - extent(unit) / 2 - offsets[i]!, count: 1 });
        while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
          const last = blocks.pop()!, before = blocks[blocks.length - 1]!;
          before.sum += last.sum; before.count += last.count;
        }
      }
      lefts = blocks.flatMap(block => Array.from({ length: block.count }, () => block.sum / block.count)).map((base, i) => base + offsets[i]!);
    }
    for (const [i, unit] of run.entries()) {
      if (unit.frame) {
        const width = widthOf(unit.id), x = lefts[i]! + COLUMN_SLACK;
        centre(unit.id, x + width / 2);
        for (const group of unit.groups) columns.set(group.id, { x, width });
      } else {
        const group = unit.groups[0]!;
        moveGroup(model, group, lefts[i]! - group.bounds!.x, 0);
      }
    }
  }
  return columns;
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
  for (const all of columnTiers(model).filter(members => members.some(unit => unit.frame))) {
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

/**
 * The unit each group stands in for `columnShifts`: the id of its top-level frame, or its own id for a
 * one-rank row group beside frames. A group not listed (a grid, a bar, a group in a tier with no frame)
 * is not swept. A rule that plans the widening of a cell and then asks `columnShifts` must not also push
 * the cells of another unit itself: the sweep measures frame boxes, and a cell push it cannot see is
 * counted twice (ranked-groups ticket 15).
 */
export function sweptUnits(model: LayoutModel): Map<string, string> {
  const units = new Map<string, string>();
  for (const all of columnTiers(model).filter(members => members.some(unit => unit.frame))) {
    for (const unit of all.filter(item => item.frame || groupShape(model, item.id) === 'row')) {
      for (const group of unit.groups) units.set(group.id, unit.id);
    }
  }
  return units;
}

/** The column of one top-level frame as it stands: its x extent, the sub-tiers it spans, and its cells. */
export interface FrameColumn extends Column { id: string; from: number; to: number; cells: ReadonlySet<string> }

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
    return { id: frame.id, x: frame.box.x - low, width: frame.box.width + low + high, from, to, cells: new Set(cells) };
  });
}
