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
  if (!short.length) return false;
  const seats = new Map(demand.map(room => [room.below, room.seated]));
  const room = new Map(demand.map(entry => [entry.below, entry.high - entry.low]));

  // The first probe opens each short gap past anything its own seating can ask for: the rows at
  // their pitch, the deepest either boundary reaches into the gap, and one pitch over.
  const opened = new Map(short.map(entry => [entry.below,
    Math.max(0, entry.rows * entry.pitch + 2 * entry.headroom + entry.pitch - (entry.high - entry.low))]));
  const grown = new Map<number, number>();
  for (const entry of tierGapRoom(measured(model, opened))) {
    // Room is reserved only where the probe shows it buys a seat. A gap that seats no more with the
    // boundary out of its way is one the allocation refuses for a reason of its own, and moving
    // every band below it would buy no route at all.
    if (!opened.has(entry.below) || entry.seated <= seats.get(entry.below)!) continue;
    const extra = entry.required - room.get(entry.below)!;
    if (extra > EPS) grown.set(entry.below, extra);
  }
  if (!grown.size) return false;

  moveBands(model, grown);
  for (const band of model.tierBands) {
    const extra = grown.get(band.tier);
    if (extra === undefined) continue;
    placementWarning(model, 'TIER_GAP_GROWN',
      `The tier gap above tier ${band.tier} grew ${extra.toFixed(2)} px to the rows it must seat.`,
      band.groups, 'group');
  }
  return true;
}

/**
 * Whether a gap asks for more room than it has: it owes a row the seating did not reach.
 */
function needsRoom(room: TierGapRoom): boolean {
  return room.rows > 0 && room.seated < room.rows;
}

/** A copy of the model with the given room added to each gap, ready to be measured. */
function measured(model: LayoutModel, extra: ReadonlyMap<number, number>): LayoutModel {
  const probe = JSON.parse(JSON.stringify(model)) as LayoutModel;
  moveBands(probe, extra);
  rebuildRegionGeometry(probe, undefined, undefined, true);
  return probe;
}

/** Move every band down by the running total of the room the gaps above it gained. */
function moveBands(model: LayoutModel, extra: ReadonlyMap<number, number>): void {
  let shift = 0;
  for (const band of [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y)) {
    shift += extra.get(band.tier) ?? 0;
    if (shift <= EPS) continue;
    for (const id of band.groups) moveGroup(model, model.groups[id]!, 0, shift);
  }
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
}
