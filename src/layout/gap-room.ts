import type { LayoutModel } from '../model/layout.js';
import { tierGapRoom } from './gap-runs.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { placementWarning, rebuildRegions } from './regions.js';
import { moveGroup } from './skeleton-geometry.js';

/**
 * ADR-0015 rule 1, the gap's own height: **a tier gap grows to the rows it must seat.**
 *
 * Rule 1 allocates every run that crosses a tier gap, but it cannot allocate room a gap does not
 * have. `bandGap` is one number for the whole diagram, chosen in stage 4 from the node clearance
 * and the widest stroke. The room a tier gap needs is a property of that gap: the rows the
 * allocation must seat in it, one pitch apart. That is a reservation placement makes, not something
 * stage 8 may discover, so this rule makes it — the last thing 7f reserves, and the first thing
 * stage 8 consumes.
 *
 * A gap short of `required − room` grows by exactly that, and every band below it moves down by the
 * running total. Nothing moves horizontally, nothing moves up, and a gap whose rows already fit
 * grows by nothing. The allocation in `gap-runs.ts` is the consumer of the grown gap and never its
 * owner: it reads the room the gap has and seats what fits in it.
 *
 * **Why 7f and not 7a.** The count separates a **column** (both ends on one x, no row needed) from
 * a **row**, so it cannot be taken before lane x is fixed. It cannot be taken at 7a either: 7c
 * aligns a child under its lane and 7d spans a bar across its ports, and both turn a row into a
 * column. Measured on the M1 golden, its one populated tier gap owes four rows after 7a and none
 * after 7d; measured on the Enterprise NTP sheet, 7c changes the count on three of twelve gaps.
 * A count taken any earlier would grow a gap the finished diagram does not need, and the golden
 * would move. 7f is the last placement rule, so its count is the one stage 8 receives.
 */
export function growTierGaps(model: LayoutModel): boolean {
  const growth = new Map<number, number>();
  for (const room of tierGapRoom(model)) {
    const deficit = room.required - (room.high - room.low);
    if (deficit > 1e-9) growth.set(room.below, deficit);
  }
  if (!growth.size) return false;
  let shift = 0;
  for (const band of [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y)) {
    shift += growth.get(band.tier) ?? 0;
    if (!shift) continue;
    for (const id of band.groups) moveGroup(model, model.groups[id]!, 0, shift);
    placementWarning(model, 'TIER_GAP_GROWN',
      `Tier ${band.tier} moved down ${shift.toFixed(2)} px: the tier gaps above it grew to the rows they must seat.`,
      band.groups, 'group');
  }
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
  return true;
}
