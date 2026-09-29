import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../score/geometry.js';
import { alignLinkedGroupGrid, replanGroupLabels } from './bands.js';
import { tierGapPlans } from './gap-plan.js';
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
  // One pass, no probe. The plan measures every term anchored to the band below from `bandTop`, so its `H` does not
  // move with the growth, and a second pass over the grown gaps asks for nothing (tier-gap-rows.md, Section 3).
  const grown = new Map<number, GapGrowth>();
  for (const { gap, plan } of tierGapPlans(settled(model))) {
    if (plan.growth > EPS) grown.set(gap.below, { extra: plan.growth, setBy: plan.setBy });
  }
  return grow(model, grown);
}

/**
 * The model as 7f publishes it once a gap has grown: the replay that follows a growth refits the group boxes and re-centres
 * their nodes, so the x of a tip or a lane differs from the one this rule sees before it. The plan is read on that replay,
 * not on the model as it stands, or it plans the rows of an x nothing publishes. It is a trial: the model itself is not touched,
 * and the growth is applied to it whole, so the same replay follows.
 */
function settled(model: LayoutModel): LayoutModel {
  const trial = JSON.parse(JSON.stringify(model)) as LayoutModel;
  rebuildRegionGeometry(trial, undefined, undefined, true);
  alignLinkedGroupGrid(trial);
  replanGroupLabels(trial);
  return trial;
}

/** The room one gap gained, and the part or term of the plan that set it. */
interface GapGrowth { extra: number; setBy: string }

/** Moves the bands by the room each gap gained and reports it; false where nothing grew. */
function grow(model: LayoutModel, grown: ReadonlyMap<number, GapGrowth>): boolean {
  if (!grown.size) return false;

  moveBands(model, new Map([...grown].map(([tier, item]) => [tier, item.extra])));
  for (const band of model.tierBands) {
    const item = grown.get(band.tier);
    if (item === undefined) continue;
    placementWarning(model, 'TIER_GAP_GROWN',
      `The tier gap above tier ${band.tier} grew ${item.extra.toFixed(2)} px to hold the rows of its parts (set by ${item.setBy}).`,
      band.groups, 'group');
  }
  return true;
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
