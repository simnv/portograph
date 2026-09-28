import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { cellReach, deriveFrames } from './frames.js';
import { GROUP_PADDING } from './regions.js';
import { bandGap, compareId } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';

/**
 * How far a cell may stand off the axis of its column, to either side, so a wide cell can meet a port
 * of the narrow cell below it that is not on the axis. A column is packed this far from each neighbour
 * on top of the band gap, so the frame boxes of two neighbours stay a band gap apart at the limit.
 */
export const COLUMN_SLACK = GROUP_PADDING;

/** The x extent one frame or one-rank group owns in its document tier. */
export interface Column { x: number; width: number }

/** Everything that stands in one column: the cells of a frame and of its child frames, or one group. */
export interface Unit { id: string; frame: boolean; groups: LayoutGroup[]; low: number; high: number }

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
  for (const tier of frameTiers(model)) packTier(model, tier, columns);
  return columns;
}

/** The width of a frame's column: its widest cell, or its widest child frame with the margin on each side. */
const frameWidth = (model: LayoutModel, id: string): number => {
  const frames = model.document.frames!;
  const children = Object.keys(frames).filter(child => frames[child]!.parent === id);
  return Math.max(0, ...frames[id]!.cells.map(cell => cellReach(model, cell).width), ...children.map(child => frameWidth(model, child) + 2 * GROUP_PADDING));
};

/**
 * The document tiers that hold at least one frame, top to bottom, as their units (frames and one-rank
 * groups). A document tier is not stored: the sub-tiers of its groups are contiguous and the tiers do
 * not share one, so units whose sub-tier ranges touch belong to one tier.
 */
export function frameTiers(model: LayoutModel): Unit[][] {
  const frames = model.document.frames;
  if (frames === undefined) return [];
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
  return tiers.filter(members => members.some(unit => unit.frame));
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
 * Packs the units of one document tier left to right (see `packFrameColumns`) and stores the column of
 * every frame cell in `columns`. `sequence` gives the units of a tier a different place than their
 * rank-0 cells stand in (a unit id to a number, the smaller to the left); the overlay-weighted order
 * of frames (ticket 06b) uses it to move a frame as a column.
 */
export function packTier(model: LayoutModel, tier: Unit[], columns: Map<string, Column>, sequence?: ReadonlyMap<string, number>): void {
  const frames = model.document.frames!;
  const childrenOf = (id: string): string[] => Object.keys(frames).filter(child => frames[child]!.parent === id);
  /** Centre every cell of a frame, and of its children, on one axis. */
  const centre = (id: string, axis: number): void => {
    for (const cell of frames[id]!.cells) {
      const reach = cellReach(model, cell);
      moveGroup(model, model.groups[cell]!, axis - (reach.x + reach.width / 2), 0);
    }
    for (const child of childrenOf(id)) centre(child, axis);
  };
  const gap = bandGap(model);
  const place = (unit: Unit): number => sequence?.get(unit.id) ?? unitOrder(unit);
  const left = (unit: Unit): number => Math.min(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x : group.bounds!.x));
  const right = (unit: Unit): number => Math.max(...unit.groups.map(group => unit.frame ? cellReach(model, group.id).x + cellReach(model, group.id).width : group.bounds!.x + group.bounds!.width));
  // The packed run keeps the centre ELK gave the tier, so it stays over and under its neighbour tiers.
  const span = tier.reduce((sum, unit) => sum + (unit.frame ? frameWidth(model, unit.id) + 2 * COLUMN_SLACK : unit.groups[0]!.bounds!.width), gap * (tier.length - 1));
  let x = (Math.min(...tier.map(left)) + Math.max(...tier.map(right))) / 2 - span / 2;
  for (const unit of [...tier].sort((a, b) => place(a) - place(b) || compareId(a.id, b.id))) {
    if (unit.frame) {
      const width = frameWidth(model, unit.id);
      x += COLUMN_SLACK;
      centre(unit.id, x + width / 2);
      for (const group of unit.groups) columns.set(group.id, { x, width });
      x += width + COLUMN_SLACK + gap;
    } else {
      const group = unit.groups[0]!;
      moveGroup(model, group, x - group.bounds!.x, 0);
      x += group.bounds!.width + gap;
    }
  }
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
