import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../score/geometry.js';
import { tierGapRoom, type TierGapRoom } from './gap-runs.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { placementWarning, rebuildRegions } from './regions.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { moveGroup } from './skeleton-geometry.js';

/**
 * ADR-0015 rule 1, the gap's own height: **a tier gap grows to the rows it must seat.**
 *
 * Rule 1 allocates every run that crosses a tier gap, but it cannot allocate room a gap does not
 * have. `bandGap` is one number for the whole diagram, chosen in stage 4 from the node clearance
 * and the widest stroke. The room a tier gap needs is a property of that gap, and this rule
 * reserves it — the **first** thing 7f reserves, before any group label is placed, because the
 * growth moves whole bands down and a label placed first would stay behind.
 *
 * A gap short of what its seating needs grows by exactly the shortfall, and every band below it
 * moves down by the running total. Nothing moves horizontally, nothing moves up, and a gap whose
 * rows already fit grows by nothing. The allocation in `gap-runs.ts` is the consumer of the grown
 * gap and never its owner: it reads the room the gap has and seats what fits in it.
 *
 * **What the reservation is.** Not `rows × pitch`. That is the packing of rows half a pitch inside
 * each boundary with nothing in the way, and a gap with a lane never gets it: every lane's reserved
 * run stands on a boundary and reaches the gate's clearance into the gap, so the first row starts
 * deeper than half a pitch and the last lands past where `rows × pitch` puts it. The reservation is
 * what the seating **lands in** — the last row it seats, plus the headroom the high boundary keeps.
 *
 * **Why a probe.** The seating measured in today's room is the seating today's room allows, and the
 * gap's own high boundary is what stops it: measured on `a-tier-gap-grows-to-its-rows`, 70 px of
 * room seats two of the four rows it owes. So the rule opens every short gap on a **probe** — a
 * copy of the model with the band below each gap moved far enough down that the boundary cannot
 * bind — and measures the seating there. The answer therefore does not depend on the room the gap
 * has now, which is what keeps the reservation monotone: a second pass over the reserved geometry
 * measures the same need and grows nothing. One probe, then the reservation: this rule reserves, it
 * does not search.
 *
 * **What it cannot see.** The group labels 7f places after it become obstacles in the tier gaps,
 * and a gap the probe seated can refuse once they are there. Measured on the Enterprise NTP sheet,
 * that costs one gap of twelve the allocation it grew for.
 *
 * **Why 7f and not 7a.** The count separates a column from a row, so it cannot be taken before lane
 * x is fixed. It cannot be taken at 7a either: 7c aligns a child under its lane, 7d spans a bar
 * across its ports, and 7e orders a bundle's ports, and each turns a row into a column. Measured on
 * the M1 golden, its one populated tier gap owes four rows after 7a and none after 7d, so a count
 * taken any earlier grows a gap the finished diagram does not need and the golden moves.
 */
export function growTierGaps(model: LayoutModel): boolean {
  const demand = tierGapRoom(model);
  const short = demand.filter(needsRoom);
  // A stem tip owes the runs beyond it two clearances (ticket 25); that room is asked for whether
  // or not the gap owes a row, and it needs no probe, because no seat is measured.
  const grown = new Map<number, number>(demand.filter(entry => entry.stems > EPS).map(entry => [entry.below, entry.stems]));
  const byStems = new Set(grown.keys());
  const byHeld = heldRoom(model, demand, grown, byStems);
  if (!short.length) return grow(model, grown, byStems, byHeld);
  const seats = new Map(demand.map(room => [room.below, room.seated]));
  const room = new Map(demand.map(entry => [entry.below, entry.high - entry.low]));

  // The first probe opens each short gap past anything its own seating can ask for: the rows at
  // their pitch, the deepest either boundary reaches into the gap, and one pitch over.
  const opened = new Map(short.map(entry => [entry.below,
    Math.max(0, entry.rows * entry.pitch + 2 * entry.headroom + entry.pitch - (entry.high - entry.low))]));
  for (const entry of tierGapRoom(measured(model, opened))) {
    // Room is reserved only where the probe shows it buys a seat. A gap that seats no more with the
    // boundary out of its way is one the allocation refuses for a reason of its own, and moving
    // every band below it would buy no route at all.
    if (!opened.has(entry.below) || entry.refuses || entry.seated <= seats.get(entry.below)!) continue;
    const extra = entry.required - room.get(entry.below)!;
    if (extra <= EPS) continue;
    if (extra > (grown.get(entry.below) ?? 0)) { byStems.delete(entry.below); byHeld.delete(entry.below); }
    grown.set(entry.below, Math.max(extra, grown.get(entry.below) ?? 0));
  }
  return grow(model, grown, byStems, byHeld);
}

/**
 * Ticket 39. A gap that cannot hold the run an earlier link of an interleaved pair asks for between its tip rows
 * grows until it can. The window between two tip rows is one pitch tall, and a band of a foreign nested tip row
 * keeps a run two run clearances off it, so a run refused in the room the gap has may stand in a little more. The
 * gap is measured on a probe, as the rows are, and grows by the smallest step that holds every run it was asked
 * for; a gap that holds none however tall keeps what it has, and its links keep the route they have today.
 * Returns the tiers of the gaps it grew, and records their room in `grown`.
 */
function heldRoom(model: LayoutModel, demand: readonly TierGapRoom[], grown: Map<number, number>, byStems: Set<number>): Set<number> {
  const result = new Set<number>();
  for (const entry of demand) {
    if (entry.heldPlaced >= entry.held) continue;
    const step = entry.pitch / 2, base = grown.get(entry.below) ?? 0;
    for (let count = 1; count <= HELD_STEPS; count++) {
      const probe = tierGapRoom(measured(model, new Map([[entry.below, base + count * step]]))).find(item => item.below === entry.below);
      if (!probe || probe.heldPlaced < probe.held) continue;
      grown.set(entry.below, base + count * step);
      byStems.delete(entry.below);
      result.add(entry.below);
      break;
    }
  }
  return result;
}

/** How many steps of half a pitch a gap may grow to hold the runs of its interleaved pairs. */
const HELD_STEPS = 8;

/** Moves the bands by the room each gap gained and reports it; false where nothing grew. */
function grow(model: LayoutModel, grown: ReadonlyMap<number, number>, byStems: ReadonlySet<number>, byHeld: ReadonlySet<number>): boolean {
  if (!grown.size) return false;

  moveBands(model, grown);
  for (const band of model.tierBands) {
    const extra = grown.get(band.tier);
    if (extra === undefined) continue;
    placementWarning(model, 'TIER_GAP_GROWN',
      `The tier gap above tier ${band.tier} grew ${extra.toFixed(2)} px to ${byHeld.has(band.tier)
        ? 'hold the run between the tip rows of two links that cross' : byStems.has(band.tier)
          ? 'keep the two stem tips of a link clear of each other\'s stem obstacle' : 'the rows it must seat'}.`,
      band.groups, 'group');
  }
  return true;
}

/**
 * Whether a gap asks for more room than it has. A gap that owes no row asks for nothing, and so
 * does one the allocation refuses for a reason of its own — it seats nothing however tall it is,
 * and growing it would move every band below for no route at all.
 */
function needsRoom(room: TierGapRoom): boolean {
  return room.rows > 0 && !room.refuses && room.seated < room.rows;
}

/** A copy of the model with the given room added to each gap, ready to be measured. */
function measured(model: LayoutModel, extra: ReadonlyMap<number, number>): LayoutModel {
  const probe = JSON.parse(JSON.stringify(model)) as LayoutModel;
  moveBands(probe, extra);
  rebuildRegionGeometry(probe, undefined, undefined, true);
  return probe;
}

/**
 * Move every band down by the running total of the room the gaps above it gained. A group's label
 * band and its placed label sit in the group's own padding, so they travel with it: a label left
 * behind would stand in the gap the move just opened, as an obstacle nothing owns.
 */
function moveBands(model: LayoutModel, extra: ReadonlyMap<number, number>): void {
  let shift = 0;
  for (const band of [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y)) {
    shift += extra.get(band.tier) ?? 0;
    if (shift <= EPS) continue;
    for (const id of band.groups) {
      moveGroup(model, model.groups[id]!, 0, shift);
      for (const entry of model.labelBands) if ((entry.host ?? entry.group) === id) entry.bounds.y += shift;
      for (const label of model.labels) if (label.role === 'group' && label.id === `label:group:${id}` && label.bounds) label.bounds.y += shift;
    }
  }
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
}
