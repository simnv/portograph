import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, planRoute, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';

// A gap the plan does not fit is left to the router (`fittingPlans`): nothing is planned into it, and libavoid routes its links among
// the reserved parts of the other gaps. Ticket 52 deleted the allocation that used to seat such links (`allocateGap`, the holds and the
// tip bands): the corpus never reached it, 7f sizes every gap it can, and the corridor move is refused where it would leave a gap short
// (`shortGaps`). Since ticket 57 the one solve sizes every gap, so the state arises only where a change after the solve leaves a gap
// short. These tests publish the model with the solve's growth switched off, which is exactly that state. What they hold: the gap is named `TIER_GAP_PART_UNFIT` with the ask, the pipeline publishes, and
// every link the router cannot route is removed with a warning of its own, never dropped silently. They do not hold that nothing is
// removed: libavoid alone removes links here (the old seating removed none on these two fixtures).
const growth = vi.hoisted(() => ({ tiers: new Map<number, number>() }));
vi.mock('../../src/layout/gap-room.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/gap-room.js')>();
  const { rebuildRegionGeometry } = await import('../../src/layout/region-rebuild.js');
  // The gap above each tier grows by the amount a test sets, and by nothing else (the plan asks for more); the rebuild is the solve's.
  return { ...original, solveTierGaps: (model: Parameters<typeof original.moveBands>[0], rebuild: (model: Parameters<typeof original.moveBands>[0]) => void): boolean => {
    if (!growth.tiers.size) return false;
    original.moveBands(model, growth.tiers);
    rebuildRegionGeometry(model, undefined, undefined, true, false);
    rebuild(model);
    return true;
  } };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const place = async (text: string) => bands(bundles(bars(centre(flanks(lanes(rows(await placed(text))))))));
const publish = (name: string): Promise<LayoutModel> =>
  layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** Every removed link carries a routing warning naming it. */
const removalsAreNamed = (model: LayoutModel): boolean => (model.removedLinks ?? []).every(id => model.diagnostics.some(item =>
  (item.code === 'ROUTE_GAP_REJECTED' || item.code === 'ROUTE_CHECKPOINT_SKIPPED') && (item.owners ?? []).some(owner => owner.kind === 'link' && owner.id === id)));

describe('a gap the plan does not fit is left to the router with a diagnostic (ticket 51, ticket 52)', () => {
  it('names the gap and the ask, plans nothing in it, and reports every link the router removes', async () => {
    // Stress ticket 09 (`a-claim-lies-on-a-cover-edge`): the gap above tier 4 is 73 px, the plan asks for 87.5. Since ticket 62 the gap above tier 3
    // is planned too (its title is nudged off link-8's leg), so it is given the growth its plan asks for and stays fit.
    growth.tiers = new Map([[3, 32.5], [4, 34.5]]);
    const model = await place(fixture('a-claim-lies-on-a-cover-edge'));
    const unfit = tierGapPlans(model).filter(({ plan }) => plan.growth > 1e-6).map(({ gap }) => [gap.above, gap.below]);
    expect(unfit).toEqual([[3, 4], [4, 5]]);
    expect(tierGapPlans(model).find(item => item.gap.above === 3)!.plan.growth).toBeCloseTo(14.5, 6);
    // Nothing is planned into an unfit gap: its links stay with the router.
    expect(planRoute(model).batches.length).toBeGreaterThan(0);

    const published = await publish('a-claim-lies-on-a-cover-edge');
    expect(published.diagnostics.filter(item => item.code === 'TIER_GAP_PART_UNFIT').map(item => item.message)).toEqual([
      'the tier gap above tier 4 asks 14.50 px more than it has; its parts are left to the router.',
      'the tier gap above tier 5 asks 22.50 px more than it has; its parts are left to the router.',
    ]);
    expect(removalsAreNamed(published)).toBe(true);
    expect(published.links.filter(item => item.removed !== true).every(item => item.path !== undefined)).toBe(true);
  }, 120000);

  it('publishes a gap that asks 164 px more than it has, with the same guarantees', async () => {
    // Ticket 25 (`a-band-holds-the-group-that-set-its-edge`). Planned, link-22 is claimed tip to tip and never routed; in a gap left to
    // the router it is routed among the completed covers of its neighbours. The gap above tier 3 grows the 23 px the old measure gave
    // it (the plan asks for 198.5 more).
    growth.tiers = new Map([[3, 23]]);
    const published = await layout(parse(orthogonalLinks(fixture('a-band-holds-the-group-that-set-its-edge'))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(published.diagnostics.filter(item => item.code === 'TIER_GAP_PART_UNFIT').map(item => item.message))
      .toEqual(['the tier gap above tier 3 asks 164.00 px more than it has; its parts are left to the router.']);
    expect(removalsAreNamed(published)).toBe(true);
    expect(published.links.filter(item => item.removed !== true).every(item => item.path !== undefined)).toBe(true);
  }, 120000);
});
