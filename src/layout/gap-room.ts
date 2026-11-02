import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { cantonTiers, reserveLinkLabelRoom } from './bands.js';
import { chordGapNotes, tierGapPlans, type GapPlan, type ResidualReason } from './gap-plan.js';
import type { TierGap } from './gap-runs.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { placementWarning, rebuildRegions } from './regions.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { moveGroup } from './skeleton-geometry.js';
import { recordStemDepths } from './sides-two.js';
import { attemptCounters } from './attempt-counters.js';
import { timed } from './attempt-timings.js';

/**
 * ADR-0015 rule 1, the gap's own height: **a tier gap is as high as its reservations need, and placement computes that height once**
 * (architecture-2 ticket 57).
 *
 * Rule 1 allocates every run that crosses a tier gap, but it cannot allocate room a gap does not have. Stage 4 opens each gap to the
 * floor (`tierGapMin`), stage 6 seats the bands that stand in it (`gapBandDemand`), and 7f grows it once to the rows of its parts and
 * the labels of its drops (`solveTierGaps`). A gap short of what it needs grows by exactly the shortfall, and every band below it moves
 * down by the running total. Nothing moves horizontally, nothing moves up, and a gap whose rows already fit grows by nothing. Stage 8
 * (`allocateGapRuns` in `gap-runs.ts`) is the consumer of the grown gap and never its owner: it reserves the plan's parts in the room
 * the gap has.
 *
 * **What the reservation is.** The height `H` of the tier-gap row plan (`gap-plan.ts`, `docs/design/tier-gap-rows.md` Section 3): the
 * rows of every part packed from the low boundary, and every term anchored to the band below measured from its top. The plan depends on
 * the gap's height only through the stems, and the solve decides those first and records them (`stemDepths`): so one read is the answer,
 * and no fixed point is taken.
 *
 * **Why at the end of 7f.** The count separates a column from a row, so it cannot be taken before lane x is fixed: 7c aligns a child
 * under its lane, 7d spans a bar across its ports, 7e orders a bundle's ports, and the 7f rounds, the corridor move and the overlay nest
 * move x again. Each turns a row into a column. Measured on the M1 golden, its one populated tier gap owes four rows after 7a and none
 * after 7d, so a count taken any earlier grows a gap the finished diagram does not need.
 */

/**
 * The tier gaps whose plan asks for more room than they have, on the model as it stands. 7f sizes each gap once (`solveTierGaps`), after its
 * last move in x; a later stage that left a gap short would be a fault, and stage 8 then leaves its parts to the router
 * (`fittingPlans`). This names each such gap with the ask, once, so that no part is left to the router without a diagnostic. It reads
 * the plans stage 8 already computed for `planRoute` (`route()` computes them once), not a second set.
 */
export function unfitGaps(plans: readonly { gap: TierGap; plan: GapPlan }[]): { above: number; below: number; growth: number }[] {
  return plans.filter(({ plan }) => plan.growth > EPS && plan.parts.length)
    .map(({ gap, plan }) => ({ above: gap.above, below: gap.below, growth: plan.growth }));
}

/** The message `TIER_GAP_PART_UNFIT` carries for a gap that does not fit after 7f's one solve. */
export const unfitMessage = (below: number, growth: number): string =>
  `the tier gap above tier ${below} asks ${growth.toFixed(2)} px more than it has; its parts are left to the router.`;

const REASONS: Record<ResidualReason, string> = {
  'spans-two-gaps': 'its part spans two tier gaps without a lane',
  'lateral-port': 'a lateral port crosses the gap',
  'u-turn': 'both ends stand on one boundary',
  'faces-away': 'a port faces away from the gap',
  'off-boundary': 'a lane end stands on no boundary of the gap',
  'crosses-lane': 'its span crosses the reserved run of a through lane',
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
 * band sits in the group's own padding, so it travels with it. No title stands yet: titles are placed
 * at the end of 7f (architecture-2 ticket 54).
 */
export function moveBands(model: LayoutModel, extra: ReadonlyMap<number, number>): void {
  let shift = 0;
  const shifts = new Map<number, number>();
  for (const band of [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y)) {
    shift += extra.get(band.tier) ?? 0;
    if (shift <= EPS) continue;
    shifts.set(band.tier, shift);
    for (const id of band.groups) {
      moveGroup(model, model.groups[id]!, 0, shift);
      for (const entry of model.labelBands) if ((entry.host ?? entry.group) === id) entry.bounds.y += shift;
    }
  }
  // A canton band is held by its sub-tier: it moves with the tier at the edge it stands on.
  for (const band of model.labelBands) {
    if (model.document.frames?.[band.group]?.kind !== 'canton') continue;
    const tiers = cantonTiers(model, band.group), by = shifts.get(band.side === 'top' ? tiers.first : tiers.last) ?? 0;
    if (by <= EPS) continue;
    band.bounds.y += by;
  }
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
}

/** Reads of the label term in the solve (R4: a count). A label that raises its gap is read again with the others at the new height. */
export const LABEL_SOLVE_READS = 4;

/**
 * The one solve of the tier gaps (architecture-2 ticket 57): **a tier gap is as high as its reservations need, and placement computes
 * that height once.** It runs once per 7f attempt, after the last move in x (`nestOverlayPorts`) and before the titles are placed.
 *
 * 1. The stem depths are decided and recorded (`recordStemDepths`); a nested side reads no tier across its gap, so the growth below
 *    cannot change them.
 * 2. Every plan is read once (`tierGapPlans`): its height `H` covers the floor (`tierGapMin`, the bands in the gap: `gapBandDemand`),
 *    the rows and drops of its parts with the stored stem depths, and the residual pockets.
 * 3. The room of the link labels that ride across a gap is read at the growth the gap takes anyway (`reserveLinkLabelRoom` with
 *    `gapRoom`): a label whose window holds unopened can break once the gap opens. A label that raises a gap is read again with the others
 *    at the new height, at most `LABEL_SOLVE_READS` times; a room still rising then is given up to the label placement
 *    (`labelRoomUnsettled`, `LINK_LABEL_ROOM_UNSETTLED`), as a settle gives one up.
 * 4. Each gap grows by `max(0, H − room, label deficit)`; the bands below move down by the running total (`moveBands`), and the claims a
 *    move in y changes are rebuilt with no centring. Nothing moves in x: a rebuild that would move an x is a fault, and it throws.
 *
 * No later step grows a gap. Stage 8 reads the plan again and names a gap that does not fit (`unfitGaps`), a safety net that must not
 * fire. Returns whether a gap grew.
 */
export function solveTierGaps(model: LayoutModel, rebuild: (model: LayoutModel) => void): boolean {
  attemptCounters.gapSolves++;
  recordStemDepths(model);
  const plans = timed('solve-plans', () => tierGapPlans(model));
  const floors = new Map(plans.map(({ gap, plan }) => [gap.above, plan.growth]));
  let deficits = new Map<number, { deficit: number; link: string }>(), rising: number[] = [];
  for (let read = 0; read < LABEL_SOLVE_READS; read++) {
    deficits = new Map();
    timed('solve-labels', () => reserveLinkLabelRoom(JSON.parse(JSON.stringify(model)) as LayoutModel, [], { floors, deficits }));
    rising = [...deficits].filter(([tier, item]) => item.deficit > (floors.get(tier) ?? 0) + EPS).map(([tier]) => tier);
    for (const tier of rising) floors.set(tier, deficits.get(tier)!.deficit);
    if (!rising.length) break;
  }
  // A room still rising after the last read is given up (R4, R6): the gap keeps the height the reads reached, and the label placement
  // decides the label, as for a room a settle gave up.
  if (rising.length) giveUpGapRooms(model, rising.map(tier => deficits.get(tier)!.link));
  const grown = new Map<number, GapGrowth>();
  for (const { gap, plan } of plans) {
    const label = deficits.get(gap.above), extra = Math.max(0, floors.get(gap.above) ?? 0);
    if (extra <= EPS) continue;
    const byLabel = label !== undefined && label.deficit > plan.growth + EPS;
    grown.set(gap.below, { extra, setBy: byLabel ? `the label of ${label.link}` : plan.setBy });
  }
  // A part the plan declines is named, with the reason: the router lays it among the reserved parts.
  for (const { gap, plan } of plans) {
    for (const item of plan.residual) {
      placementWarning(model, item.reason === 'row-cycle' ? 'TIER_GAP_ROW_CYCLE' : 'TIER_GAP_PART_RESIDUAL',
        `${item.link} is left to the router in the tier gap above tier ${gap.below}: ${REASONS[item.reason]}.`, [item.link]);
    }
  }
  if (grown.size) {
    grow(model, grown);
    const before = xCoordinates(model);
    timed('solve-rebuild', () => {
      rebuildRegionGeometry(model, undefined, undefined, true, false);
      rebuild(model);
    });
    const after = xCoordinates(model);
    const moved = [...before].filter(([id, x]) => after.get(id) === undefined || Math.abs(after.get(id)! - x) > EPS).map(([id]) => id);
    if (moved.length) throw new Error(`The tier-gap solve moved ${moved.slice(0, 5).join(', ')} in x; a move in y may move no x`);
  }
  // The notes on a held chord (ticket 101), once each, on the plans of the gaps as they stand now.
  const now = grown.size ? tierGapPlans(model) : plans;
  for (const note of chordGapNotes(model, now)) {
    if (!model.diagnostics.some(item => item.code === note.code && item.message === note.message)) model.diagnostics.push(note);
  }
  return grown.size > 0;
}

/** The x of every node box, group box (left and right edge) and lane: what a move in y keeps. */
function xCoordinates(model: LayoutModel): Map<string, number> {
  const result = new Map<string, number>();
  for (const [id, node] of Object.entries(model.nodes)) if (node.bounds) result.set(`node ${id}`, node.bounds.x);
  for (const [id, group] of Object.entries(model.groups)) if (group.bounds) { result.set(`group ${id}`, group.bounds.x); result.set(`group ${id} right`, group.bounds.x + group.bounds.width); }
  for (const lane of model.lanes) result.set(`lane ${lane.id}`, lane.x);
  return result;
}

/** The label rooms across a tier gap that still rose at the last read of the solve: given up, in link order, with one warning. */
function giveUpGapRooms(model: LayoutModel, links: readonly string[]): void {
  const order = new Map(model.links.map((link, at) => [link.id, at]));
  const byOrder = (a: string, b: string): number => order.get(a)! - order.get(b)!;
  const fresh = [...new Set(links)].sort(byOrder);
  model.labelRoomUnsettled = [...new Set([...(model.labelRoomUnsettled ?? []), ...fresh])].sort(byOrder);
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'LINK_LABEL_ROOM_UNSETTLED', owners: fresh.map(id => ({ kind: 'link' as const, id })),
    message: `The label room of ${fresh.join(', ')} across its tier gap still rose after ${LABEL_SOLVE_READS} reads of the tier-gap solve; it is given up, and the label placement decides; with no window the label may lie across a border.` });
}
