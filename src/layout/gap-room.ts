import type { Diagnostic, LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { alignLinkedGroupGridAndPack, cantonTiers, resyncLabelBands } from './bands.js';
import { chordGapNotes, tierGapPlans, type GapPlan, type ResidualReason } from './gap-plan.js';
import type { TierGap } from './gap-runs.js';
import { rebuildLaneExtents } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { placementWarning, rebuildRegions } from './regions.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { moveGroup } from './skeleton-geometry.js';
import { attemptCounters } from './attempt-counters.js';
import { timed } from './attempt-timings.js';

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
 * rows already fit grows by nothing. Stage 8 (`allocateGapRuns` in `gap-runs.ts`) is the consumer of the
 * grown gap and never its owner: it reserves the plan's parts in the room the gap has.
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
export function growTierGaps(model: LayoutModel, out?: { trial?: LayoutModel; baseDiagnostics?: number; original?: ReadonlySet<Diagnostic> | undefined }): boolean {
  const baseDiagnostics = model.diagnostics.length;
  let stopped = false;
  // The plan is read on the model as 7f will publish it (`settled`), and a stem nests only where the gap has the room
  // (`sidePlan` declines a nested turn that would stand in frozen geometry), so the tips the plan reads depend on how far the
  // gap has opened. The growth is therefore taken to a fixed point of `extra = H(grown by extra) − room`: each round reads the plan
  // on the model grown by the round before and replaces the growth by the height that plan asks. The rounds are few (a round that
  // moves nothing ends them), and the model itself is touched once, by the result.
  const grown = new Map<number, GapGrowth>();
  let plans: ReturnType<typeof tierGapPlans> = [];
  let trial = model;
  let unfit: { above: number; below: number; ask: number }[] = [];
  // The room each gap has on the model as it stands, before any growth: what `extra` is measured against.
  const room = new Map<number, number>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    attemptCounters.gapRounds++;
    trial = timed('grow-clone', () => settled(model, new Map([...grown].map(([tier, item]) => [tier, item.extra]))));
    plans = timed('grow-plans', () => tierGapPlans(trial));
    if (!round) for (const { gap, plan } of plans) room.set(gap.below, plan.bandTop - plan.low);
    // Each round replaces the growth of a gap by the height its plan asks on the model grown as before: `extra = H − room`. The rounds
    // do not accumulate. A round that adds what its trial still asks for counts a stem that nested only in a larger gap twice, and
    // the growth then stands above the height the published plan asks (a-band-holds-the-group-that-set-its-edge: 198.5 against 187).
    const moving: typeof unfit = [];
    for (const { gap, plan } of plans) {
      const before = grown.get(gap.below)?.extra ?? 0, ask = Math.max(0, plan.height - room.get(gap.below)!);
      // H is not monotone in the growth (band-holds: 247.75 unopened, 236.25 opened by 198.5), so the first correction may lower the
      // growth; from the third round on a gap never gives back what an earlier round asked, which makes the rounds converge or hit the cap.
      const after = round >= 2 ? Math.max(before, ask) : ask;
      if (Math.abs(after - before) <= EPS) continue;
      moving.push({ above: gap.above, below: gap.below, ask: after - before });
      if (after <= EPS) grown.delete(gap.below); else grown.set(gap.below, { extra: after, setBy: plan.setBy });
    }
    if (!moving.length) { stopped = true; break; }
    if (round === MAX_ROUNDS - 1) unfit = moving.filter(item => item.ask > EPS);
  }
  // The gap that settled is named by the plan of the round that settled it.
  for (const { gap, plan } of plans) {
    const item = grown.get(gap.below);
    if (item !== undefined) item.setBy = plan.setBy;
  }
  // A gap that still asks for room after the last round does not settle (spec 3): it is named, with the ask, and the router lays its
  // parts as it did before the plan.
  for (const { below, ask } of unfit) {
    placementWarning(model, 'TIER_GAP_PART_UNFIT',
      `the tier gap above tier ${below} still asks ${ask.toFixed(2)} px after ${MAX_ROUNDS} rounds of growth; its parts are left to the router.`, []);
  }
  // A part the plan declines is named, with the reason: the router lays it as it did before the plan.
  for (const { gap, plan } of plans) {
    for (const item of plan.residual) {
      placementWarning(model, item.reason === 'row-cycle' ? 'TIER_GAP_ROW_CYCLE' : 'TIER_GAP_PART_RESIDUAL',
        `${item.link} is left to the router in the tier gap above tier ${gap.below}: ${REASONS[item.reason]}.`, [item.link]);
    }
  }
  // The notes on a held chord (ticket 101), once each: this runs after every move of 7f, and the plans are those of the last round.
  for (const note of chordGapNotes(trial, plans)) {
    if (!model.diagnostics.some(item => item.code === note.code && item.message === note.message)) model.diagnostics.push(note);
  }
  // The loop stopped on "no change", so the last trial is the model grown by `grown` and replayed: the state `grow` and the replay after it
  // make on the model itself (architecture ticket 13, phase 2). A caller that asks takes it in place of the replay. A loop that ran out of rounds
  // read its last trial before the last correction, so it hands nothing back.
  if (stopped && out !== undefined && grown.size) { out.trial = trial; out.baseDiagnostics = baseDiagnostics; out.original = originals.get(trial); }
  return grow(model, grown);
}

const MAX_ROUNDS = 6;

/**
 * The tier gaps whose plan asks for more room than they have, on the model as it stands. 7f sizes a gap on a trial; a change after
 * it (the corridor move of `reseatLanes`, a later stage) can leave a gap short, and stage 8 then leaves its parts to the router
 * (`fittingPlans`). This names each such gap with the ask, once, so that no part is left to the router without a diagnostic. It reads
 * the plans stage 8 already computed for `planRoute` (`route()` computes them once), not a second set.
 */
export function unfitGaps(plans: readonly { gap: TierGap; plan: GapPlan }[]): { above: number; below: number; growth: number }[] {
  return plans.filter(({ plan }) => plan.growth > EPS && plan.parts.length)
    .map(({ gap, plan }) => ({ above: gap.above, below: gap.below, growth: plan.growth }));
}

/** The message `TIER_GAP_PART_UNFIT` carries for a gap that does not fit after a change following 7f's growth. */
export const unfitMessage = (below: number, growth: number): string =>
  `the tier gap above tier ${below} asks ${growth.toFixed(2)} px more than it has; its parts are left to the router.`;

/**
 * The model as 7f publishes it once the gaps have grown by `extra`: the replay that follows a growth refits the group boxes and
 * re-centres their nodes, so the x of a tip or a lane differs from the one this rule sees before it. The plan is read on that
 * replay, not on the model as it stands, or it plans the rows of an x nothing publishes. It is a trial: the model itself is
 * not touched.
 */
/** The diagnostic objects each trial started with: the replay filters its list and appends to it, so what stands afterwards is told by identity. */
const originals = new WeakMap<LayoutModel, ReadonlySet<Diagnostic>>();
function settled(model: LayoutModel, extra: ReadonlyMap<number, number>): LayoutModel {
  const trial = JSON.parse(JSON.stringify(model)) as LayoutModel;
  originals.set(trial, new Set(trial.diagnostics));
  // 7f replays only a model whose gaps grew (`mutation.ts`), so a trial of no growth is the model as it stands: the plan reads what is published.
  if (!extra.size) return trial;
  moveBands(trial, extra);
  rebuildRegionGeometry(trial, undefined, undefined, true);
  alignLinkedGroupGridAndPack(trial);
  resyncLabelBands(trial);
  return trial;
}

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
