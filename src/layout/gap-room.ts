import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../score/geometry.js';
import { alignLinkedGroupGrid, replanGroupLabels } from './bands.js';
import { tierGapPlans, type ResidualReason } from './gap-plan.js';
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
 * **What the reservation is.** The height `H` of the tier-gap row plan (`gap-plan.ts`,
 * `docs/design/tier-gap-rows.md` Section 3): the rows of every part packed from the low boundary,
 * and every term anchored to the band below measured from its top. The gap grows by `H` less the
 * room it has. No probe: the plan does not depend on how far the gap has opened, except through
 * the stems (`sidePlan` nests a stem only where there is room), which is why the growth is taken to
 * a fixed point on trial copies (`settled`) and applied to the model once.
 *
 * **What it cannot see.** The corridor move after it (`reseatLanes`) changes a lane x; the plan is
 * recomputed at consumption, and a gap that no longer fits is left to the router.
 *
 * **Why 7f and not 7a.** The count separates a column from a row, so it cannot be taken before lane
 * x is fixed. It cannot be taken at 7a either: 7c aligns a child under its lane, 7d spans a bar
 * across its ports, and 7e orders a bundle's ports, and each turns a row into a column. Measured on
 * the M1 golden, its one populated tier gap owes four rows after 7a and none after 7d, so a count
 * taken any earlier grows a gap the finished diagram does not need and the golden moves.
 */
export function growTierGaps(model: LayoutModel): boolean {
  // The plan is read on the model as 7f will publish it (`settled`), and a stem nests only where the gap has the room
  // (`sidePlan` declines a nested turn that would stand in frozen geometry), so the tips the plan reads depend on how far the
  // gap has opened. The growth is therefore taken to its fixed point: each round reads the plan on the model grown by the
  // rounds before it and adds what that plan still asks for. `H` does not move with the growth except through the stems,
  // so the rounds are few (a round that asks for nothing ends it), and the model itself is touched once, by the sum.
  const grown = new Map<number, GapGrowth>();
  let plans: ReturnType<typeof tierGapPlans> = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    plans = tierGapPlans(settled(model, new Map([...grown].map(([tier, item]) => [tier, item.extra]))));
    let more = false;
    for (const { gap, plan } of plans) {
      if (plan.growth <= EPS) continue;
      more = true;
      grown.set(gap.below, { extra: (grown.get(gap.below)?.extra ?? 0) + plan.growth, setBy: plan.setBy });
    }
    if (!more) break;
  }
  // A part the plan declines is named, with the reason: the router lays it as it did before the plan.
  for (const { gap, plan } of plans) {
    for (const item of plan.residual) {
      placementWarning(model, 'TIER_GAP_PART_RESIDUAL',
        `${item.link} is left to the router in the tier gap above tier ${gap.below}: ${REASONS[item.reason]}${item.granted ? ` (${item.granted}'s leg cover is granted to it)` : ''}.`, [item.link]);
    }
  }
  return grow(model, grown);
}

const MAX_ROUNDS = 6;

/**
 * The model as 7f publishes it once the gaps have grown by `extra`: the replay that follows a growth refits the group boxes and
 * re-centres their nodes, so the x of a tip or a lane differs from the one this rule sees before it. The plan is read on that
 * replay, not on the model as it stands, or it plans the rows of an x nothing publishes. It is a trial: the model itself is
 * not touched.
 */
function settled(model: LayoutModel, extra: ReadonlyMap<number, number>): LayoutModel {
  const trial = JSON.parse(JSON.stringify(model)) as LayoutModel;
  if (extra.size) moveBands(trial, extra);
  rebuildRegionGeometry(trial, undefined, undefined, true);
  alignLinkedGroupGrid(trial);
  replanGroupLabels(trial);
  return trial;
}

const REASONS: Record<ResidualReason, string> = {
  'spans-two-gaps': 'its part spans two tier gaps without a lane',
  'lateral-port': 'a lateral port crosses the gap',
  'u-turn': 'both ends stand on one boundary',
  'faces-away': 'a port faces away from the gap',
  'off-boundary': 'a lane end stands on no boundary of the gap',
  'crosses-lane': 'its span crosses the reserved run of a through lane',
  'legs-within-k': 'its leg stands within a run clearance of the leg of another node',
  'row-cycle': 'its rows form a cycle',
  'crosses-shared-run': 'a leg stands over the shared run of another link',
  'leg-blocked': 'a leg would pass through a label, a lane box or an obstacle',
};

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
