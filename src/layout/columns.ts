import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { cellReach, deriveFrames } from './frames.js';
import { GROUP_PADDING } from './regions.js';
import { laneSidesHold, selectAnchorTier } from './lanes.js';
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
  if (model.document.frames === undefined) return columns;
  const tiers = columnTiers(model);
  for (const { index, authority } of sweepSteps(model, tiers)) packStep(model, tiers, index, authority, columns);
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

/** The two ends of the routed feed links of one unit against the tier packed before it. */
interface UnitFeeds {
  /** The x of each distinct port of the tier before, by port id. */
  parents: Map<string, number>;
  /** The x of each distinct port of the unit, by port id, with the cell that holds it. */
  children: Map<string, { x: number; cell: string }>;
}

/**
 * Reads, for a unit of `tiers[index]`, the routed, attached, non-stub links that leave it towards the tier
 * `authority` on the facing sides, with the current x of both ports (ranked-groups tickets 11 and 16).
 * Overlay links are the overlay order's (tickets 05 and 06), stubs draw no path.
 */
function feedReader(model: LayoutModel, tiers: Unit[][], index: number, authority: number | undefined): (unit: Unit) => UnitFeeds {
  const tierOf = new Map<Unit, number>(), unitOf = new Map<string, Unit>();
  for (const [at, members] of tiers.entries()) for (const unit of members) {
    tierOf.set(unit, at);
    for (const group of unit.groups) unitOf.set(group.id, unit);
  }
  return unit => {
    const parents = new Map<string, number>(), children = new Map<string, { x: number; cell: string }>();
    if (authority === undefined) return { parents, children };
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
      for (const [own, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
        const ownGroup = model.document.nodes[own!.node]?.group, otherGroup = model.document.nodes[other!.node]?.group;
        if (ownGroup === undefined || otherGroup === undefined || unitOf.get(ownGroup) !== unit || tierOf.get(unitOf.get(otherGroup)!) !== authority) continue;
        const child = findPort(model, own!), parent = findPort(model, other!);
        if (!child?.anchor || !parent?.anchor) continue;
        if (child.side !== (index > authority ? 'top' : 'bottom') || parent.side !== (index > authority ? 'bottom' : 'top')) continue;
        children.set(portId(child.ref), { x: child.anchor.x, cell: ownGroup });
        parents.set(portId(parent.ref), parent.anchor.x);
      }
    }
    return { parents, children };
  };
}

/** Packs `tiers[index]`, reading the feeds of the tier `authority` (see `packFrameColumns`). */
function packStep(model: LayoutModel, tiers: Unit[][], index: number, authority: number | undefined, columns: Map<string, Column>,
  sequence?: ReadonlyMap<string, number>): void {
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
  /** The width a unit takes in its tier: a frame with its slack on each side, a group by its box. */
  const extent = (unit: Unit): number => unit.frame ? frameWidth(model, unit.id) + 2 * COLUMN_SLACK : unit.groups[0]!.bounds!.width;

  const feeds = feedReader(model, tiers, index, authority);

  /** The centre a unit wants: over the mean of its routed feeds in the packed tier, `undefined` without one. */
  const wanted = (unit: Unit): number | undefined => {
    const { parents, children } = feeds(unit);
    if (!parents.size || !children.size) return undefined;
    const mean = (values: Iterable<number>): number => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
    return mean(parents.values()) - mean([...children.values()].map(({ x, cell }) => {
      const at = unit.frame ? cellReach(model, cell) : model.groups[cell]!.bounds!;
      return x - (at.x + at.width / 2);
    }));
  };

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
    return;
  }
  const run = [...tier].sort((a, b) => place(a) - place(b) || compareId(a.id, b.id));
  const centres = run.map(wanted);
  // Left edge of each unit once packed a band gap apart, and where its column would stand if it had its way.
  let lefts: number[];
  if (centres.every(wish => wish === undefined)) {
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
      const wish = centres[i] ?? (left(unit) + right(unit)) / 2;
      blocks.push({ sum: wish - extent(unit) / 2 - offsets[i]!, count: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
        const last = blocks.pop()!, before = blocks[blocks.length - 1]!;
        before.sum += last.sum; before.count += last.count;
      }
    }
    lefts = blocks.flatMap(block => Array.from({ length: block.count }, () => block.sum / block.count)).map((base, i) => base + offsets[i]!);
  }
  for (const [i, unit] of run.entries()) {
    if (unit.frame) {
      const width = frameWidth(model, unit.id), x = lefts[i]! + COLUMN_SLACK;
      centre(unit.id, x + width / 2);
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
 * group it holds (lane x is immutable), so the rule can also run after lanes. A frame that holds an end of an overlay link
 * stays where the overlay order put it, and bounds its siblings. A column that still jogs by
 * more than its cells can slide to absorb warns once, `COLUMN_AXIS_HELD`, with that residual in px. The pass
 * is idempotent: the feeds are the fixed end, so a second run wants exactly the plan the first one kept.
 *
 * Returns whether anything moved.
 */
export function holdColumnAxes(model: LayoutModel): boolean {
  if (model.document.frames === undefined) return false;
  const tiers = columnTiers(model);
  let moved = false;
  for (const { index, authority } of sweepSteps(model, tiers)) {
    if (authority !== undefined && tiers[index]!.some(unit => unit.frame)) moved = pullTier(model, tiers, index, authority) || moved;
  }
  return moved;
}

const mean = (values: readonly number[]): number => values.reduce((sum, x) => sum + x, 0) / values.length;

/**
 * How far a frame may move, as `dx` in `[low, high]`, and still have its feed ports reachable: the jog `need`
 * that moves the mean of its ports under the mean of its feeds, less what the cells that hold those ports can
 * slide inside the column (its box with the slack on each side). `undefined` for a frame with no feed.
 */
function feedRange(model: LayoutModel, unit: Unit, feeds: (unit: Unit) => UnitFeeds, box: Rect): { low: number; high: number; need: number } | undefined {
  const { parents, children } = feeds(unit);
  if (!parents.size || !children.size) return undefined;
  const need = mean([...parents.values()]) - mean([...children.values()].map(child => child.x));
  const cells = [...new Set([...children.values()].map(child => child.cell))].map(cell => cellReach(model, cell));
  const slideLow = Math.max(...cells.map(reach => box.x - COLUMN_SLACK - reach.x));
  const slideHigh = Math.min(...cells.map(reach => box.x + box.width + COLUMN_SLACK - reach.x - reach.width));
  return { low: need - slideHigh, high: need - slideLow, need };
}

/** The units of a tier that hold a node at either end of an attached overlay link. */
function overlayUnits(model: LayoutModel, tier: Unit[]): Set<Unit> {
  const unitOf = new Map<string, Unit>();
  for (const unit of tier) for (const group of unit.groups) unitOf.set(group.id, unit);
  const held = new Set<Unit>();
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    for (const end of [link.attachments.from, link.attachments.to]) {
      const unit = unitOf.get(model.document.nodes[end.node]?.group ?? '');
      if (unit !== undefined) held.add(unit);
    }
  }
  return held;
}

/** One tier of `holdColumnAxes`: plans the pulled positions, applies them unless a lane forbids them, and reports the residuals. */
function pullTier(model: LayoutModel, tiers: Unit[][], index: number, authority: number): boolean {
  const tier = tiers[index]!, derived = deriveFrames(model);
  if (derived === undefined || tier.some(unit => !unit.frame && groupShape(model, unit.id) !== 'row')) return false;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const feeds = feedReader(model, tiers, index, authority), gap = bandGap(model);
  const standing = tier.map(unit => {
    const at = unit.frame ? box.get(unit.id)! : unit.groups[0]!.bounds!;
    const range = unit.frame ? feedRange(model, unit, feeds, at) : undefined;
    return { unit, x: at.x, width: at.width, slack: unit.frame ? COLUMN_SLACK : 0, from: at.x + (range?.low ?? 0), to: at.x + (range?.high ?? 0) };
  }).sort((a, b) => a.x - b.x || compareId(a.unit.id, b.unit.id));
  // Lefts of a run kept a band gap apart, less the offset of that run, must not fall: pool adjacent violators on
  // the wanted lefts, the nearest point of each range to where the unit stands in the plan so far.
  const offsets: number[] = [];
  let sum = 0;
  for (const [i, item] of standing.entries()) { offsets.push(sum); sum += item.width + gap + item.slack + (standing[i + 1]?.slack ?? 0); }
  // A unit that holds an end of an overlay link stays where the overlay order put it (face to face, one straight
  // segment); it bounds the units on either side, whose plan is clamped to it, which is exact for a fixed point.
  const pinned = overlayUnits(model, tier);
  const fixed = standing.map((item, i) => pinned.has(item.unit) ? item.x - offsets[i]! : undefined);
  const below = fixed.map((_, i) => Math.max(-Infinity, ...fixed.slice(0, i + 1).filter((z): z is number => z !== undefined)));
  const above = fixed.map((_, i) => Math.min(Infinity, ...fixed.slice(i).filter((z): z is number => z !== undefined)));
  const fit = (wanted: number[]): number[] => {
    const blocks: { sum: number; count: number }[] = [];
    for (const [i, wish] of wanted.entries()) {
      blocks.push({ sum: wish - offsets[i]!, count: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
        const last = blocks.pop()!, before = blocks[blocks.length - 1]!;
        before.sum += last.sum; before.count += last.count;
      }
    }
    return blocks.flatMap(block => Array.from({ length: block.count }, () => block.sum / block.count)).map((base, i) => Math.min(Math.max(base, below[i]!), above[i]!) + offsets[i]!);
  };
  let lefts = standing.map(item => item.x);
  for (let round = 0; round < 200; round++) {
    const next = fit(lefts.map((left, i) => Math.min(Math.max(left, standing[i]!.from), standing[i]!.to)));
    const change = Math.max(...next.map((left, i) => Math.abs(left - lefts[i]!)));
    lefts = next;
    if (change < 1e-9) break;
  }
  const shifts = new Map<LayoutGroup, number>();
  for (const [i, item] of standing.entries()) {
    const dx = lefts[i]! - item.x;
    if (Math.abs(dx) > PLACEMENT_EPS) for (const group of item.unit.groups) shifts.set(group, dx);
  }
  const allowed = shifts.size > 0 && laneSidesHold(model, [...shifts].map(([group, dx]) => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } })));
  if (allowed) for (const [group, dx] of shifts) moveGroup(model, group, dx, 0);
  reportHeld(model, tier, feeds);
  return allowed;
}

/**
 * Says once per column, and again only with a new number, how far its feed links still jog beyond what the
 * cells inside the column can absorb by sliding to the wall: the least jog its siblings leave it.
 */
function reportHeld(model: LayoutModel, tier: Unit[], feeds: (unit: Unit) => UnitFeeds): void {
  const derived = deriveFrames(model);
  if (derived === undefined) return;
  for (const unit of tier.filter(item => item.frame)) {
    model.diagnostics = model.diagnostics.filter(item => !(item.code === COLUMN_AXIS_HELD && item.owners?.some(owner => 'id' in owner && owner.id === unit.id)));
    const range = feedRange(model, unit, feeds, derived.find(item => item.id === unit.id)!.box);
    // Standing where it stands, the column reaches its feed when 0 lies in the range of moves.
    const residual = range === undefined ? 0 : Math.max(0, range.low, -range.high);
    if (residual > 0.5) model.diagnostics.push({ stage: 'placement', severity: 'warning', code: COLUMN_AXIS_HELD, owners: [{ kind: 'group', id: unit.id }],
      message: `Column ${unit.id} cannot reach its feed: its siblings hold it a band gap away, so its feed links keep a jog of ${residual.toFixed(1)} px.` });
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
