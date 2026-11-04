import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, planRoute, restoreLayoutModel, route, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { unfitGaps } from '../../src/layout/gap-room.js';
import { solveTierGaps } from '../../src/layout/gap-room.js';
import { replayGridAndBands } from '../../src/layout/placement-attempt.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { nudgingDistance, routedStroke } from '../../src/layout/bands.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { score } from '../../src/score/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';
import { withoutJointOrder } from '../layout/joint-off.js';

/**
 * Ranked-groups ticket 51 (`docs/design/tier-gap-rows.md`, Section 1 item 6 and Section 2.2): every reason a part of a tier gap is
 * left to the router has a code or a reason string, and a residual link publishes with its gate findings named, never as a removal.
 * Each fixture runs through the real router. Where the placement stages never build the shape (a span with no lane, a lane end off
 * its boundary, a lane that walls the gap), the placed model is edited and the plan and the diagnostic are read on it.
 */
const read = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const place = async (text: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(text))))))));
const residual = (model: LayoutModel): string[] => tierGapPlans(model).flatMap(({ plan }) => plan.residual.map(item => `${item.link}:${item.reason}`));
const codes = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code.startsWith('TIER_GAP_PART') || item.code === 'TIER_GAP_ROW_CYCLE')
  .map(item => `${item.code}|${item.message}`);
const failing = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates)
  .flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}:${item.elements.join('/')}`));

async function whole(name: string): Promise<{ placed: LayoutModel; routed: LayoutModel }> {
  return { placed: await place(read(name)), routed: await layout(parse(read(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }) };
}

describe('a residual part publishes with its findings named (ticket 51)', () => {
  it('names a lateral port that crosses the gap (lateral-port) and removes nothing', async () => {
    const { placed: model, routed } = await whole('a-lateral-port-link-crosses-a-tier-gap');
    expect(residual(model)).toEqual(['link-7:lateral-port']);
    expect(codes(model)).toEqual(['TIER_GAP_PART_RESIDUAL|link-7 is left to the router in the tier gap above tier 1: a lateral port crosses the gap.']);
    expect(routed.removedLinks ?? []).toEqual([]);
    // Ticket 59: the jog of link-4's drop, which stands on its upper x, keeps the group-edge margin (10) from the top of `access`.
    const jog = tierGapPlans(model).flatMap(({ plan }) => plan.parts).find(part => part.link === 'link-4')!;
    expect(jog.shape === 'drop' && jog.stand === 'upper' && jog.jog !== undefined).toBe(true);
    // jog = bandTop - max(depth + k, e): k the row pitch, e the group-edge margin from the top of `access`.
    const k = nudgingDistance(model), e = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
    const access = model.groups['access']!.bounds!.y;
    expect(jog.jog!).toBeCloseTo(Math.min(jog.lower.y - k, access - e), 6);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('names a same-boundary U-turn (u-turn): both ports face the gap from one band, no gap between them', async () => {
    const { placed: model, routed } = await whole('a-same-boundary-u-turn-beside-a-tier-gap');
    expect(residual(model)).toEqual(['link-7:u-turn']);
    expect(codes(model)).toEqual(['TIER_GAP_PART_RESIDUAL|link-7 is left to the router in the tier gap above tier 1: both ends stand on one boundary.']);
    expect(routed.removedLinks ?? []).toEqual([]);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('names a port that faces away from the gap (faces-away), not a u-turn', async () => {
    const { placed: model, routed } = await whole('a-port-facing-away-from-a-tier-gap-is-left-to-the-router');
    expect(residual(model)).toEqual(['link-7:faces-away']);
    expect(codes(model)).toEqual(['TIER_GAP_PART_RESIDUAL|link-7 is left to the router in the tier gap above tier 1: a port faces away from the gap.']);
    expect(routed.removedLinks ?? []).toEqual([]);
    // Ticket 52: the grant is the cover of the crossed vertical, not of the whole part. link-7 holds the cover of link-3's upper leg and
    // not that of its lower leg (the segments are leg, row, leg); the wide grant of the whole part let link-7 run 3.83 px beside a
    // leg it never crosses (G6 parallel-clearance link-3 / link-7), and the narrow one routes clear.
    expect(allocateGapRuns(model).find(run => run.link === 'link-3')!.grants).toEqual([['link-7'], [], []]);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('names a part in a row cycle with its own code (TIER_GAP_ROW_CYCLE)', async () => {
    const { placed: model, routed } = await whole('a-row-cycle-leaves-a-part-to-the-router');
    expect(residual(model).sort()).toEqual(['link-6:row-cycle', 'link-7:u-turn']);
    expect(codes(model).sort()).toEqual([
      'TIER_GAP_PART_RESIDUAL|link-7 is left to the router in the tier gap above tier 1: both ends stand on one boundary.',
      'TIER_GAP_ROW_CYCLE|link-6 is left to the router in the tier gap above tier 1: its rows form a cycle.',
    ]);
    expect(routed.removedLinks ?? []).toEqual([]);
    expect(failing(routed)).toEqual(['G6:parallel-clearance:link-5/link-6']);
  }, 120000);

  it('leaves no leg under a title to the router, and names a leg over a shared run (crosses-shared-run) on the corpus fixtures', async () => {
    // A title yields to the legs under it (architecture-2 ticket 54): the fixture whose wide titles once left link-8 and link-11 to the router
    // (`leg-blocked`) plans every part now.
    expect(residual(await place(read('a-title-no-position-clears-leaves-the-leg-to-the-router')))).toEqual([]);
    expect(residual(await place(read('a-tier-gap-plan-orders-every-part')))).toEqual([]);
    const shared = await place(orthogonalLinks(read('a-claimed-run-clears-a-shared-run')));
    expect(residual(shared)).toContain('link-3:crosses-shared-run');
    expect(codes(shared).join('\n')).toContain('a leg stands over the shared run of another link');
  }, 120000);
});

/** Three tiers, a transit lane for link-2 through tier 1, and planned parts in both gaps. */
const transit = `portograph: 2
groups:
  top: { tier: 0 }
  mid: { tier: 1 }
  low: { tier: 2 }
nodes:
  a: { group: top, class: router, ports: [] }
  b: { group: top, class: router, ports: [] }
  c: { group: top, class: router, ports: [] }
  m0: { group: mid, class: switch, ports: [] }
  m1: { group: mid, class: switch, ports: [] }
  m2: { group: mid, class: switch, ports: [] }
  e: { group: low, class: server, ports: [] }
links:
  - [a, m0]
  - [b, e]
  - [c, m2]
  - [a, m2]
  - [b, m1]
  - [m0, e]
`;

describe('shapes the placement stages do not build, on an edited placed model (ticket 51)', () => {
  const edited = async (change: (model: LayoutModel) => void): Promise<LayoutModel> => {
    const model = structuredClone(await place(transit)) as LayoutModel;
    change(model);
    return model;
  };

  it('names a span across two gaps without a lane (spans-two-gaps) in both gaps, and the router is left the link', async () => {
    const model = await edited(item => {
      const link = item.links.find(entry => entry.id === 'link-2')!;
      delete link.fixedSegments;
      item.lanes = item.lanes.filter(lane => !(lane.owner.kind === 'link' && lane.owner.id === 'link-2'));
    });
    expect(residual(model).sort()).toEqual(['link-2:spans-two-gaps', 'link-2:spans-two-gaps']);
    solveTierGaps(model, replayGridAndBands);
    const named = codes(model).filter(item => item.startsWith('TIER_GAP_PART_RESIDUAL')).map(item => item.replace(/tier \d/g, 'tier N'));
    expect(named).toEqual(Array(2).fill('TIER_GAP_PART_RESIDUAL|link-2 is left to the router in the tier gap above tier N: its part spans two tier gaps without a lane.'));
    // Stage 8 plans the edited model without throwing: the residual link has no planned part to reserve.
    expect(() => planRoute(model)).not.toThrow();
  }, 120000);

  it('names a lane end that stands on no boundary of the gap (off-boundary)', async () => {
    const model = await edited(item => {
      for (const segment of item.links.find(entry => entry.id === 'link-2')!.fixedSegments ?? []) { segment.from.y += 4; segment.to.y -= 4; }
    });
    expect(residual(model)).toContain('link-2:off-boundary');
  }, 120000);

  it('names a span that crosses the reserved run of a through lane (crosses-lane)', async () => {
    const model = await edited(item => {
      const above = item.tierBands.find(entry => entry.tier === 0)!.bounds!, below = item.tierBands.find(entry => entry.tier === 1)!.bounds!;
      const lane = item.lanes.find(entry => entry.owner.kind === 'link' && entry.owner.id === 'link-2')!;
      // The lane's box stands over the whole gap, from the band above to the band below: a wall.
      lane.bounds = { ...lane.bounds, y: above.y + above.height - 1, height: below.y - above.y - above.height + 2 };
    });
    expect(residual(model).some(item => item.endsWith(':crosses-lane'))).toBe(true);
  }, 120000);
});

describe('a gap that stops fitting after 7f is named (TIER_GAP_PART_UNFIT)', () => {
  it('reads the gap that asks for more room than it has, once, and none where the plan fits', async () => {
    const model = structuredClone(await place(read('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row'))) as LayoutModel;
    expect(unfitGaps(tierGapPlans(model))).toEqual([]);
    // A corridor move or a later stage that takes 20 px from the gap: the lower band stands 20 px higher than 7f left it.
    const band = model.tierBands.find(item => item.tier === 1)!.bounds!;
    band.y -= 20;
    band.height += 20;
    const unfit = unfitGaps(tierGapPlans(model));
    expect(unfit.map(item => [item.above, item.below])).toEqual([[0, 1]]);
    expect(unfit[0]!.growth).toBeGreaterThan(19);
  }, 120000);

  it('is reported by stage 8 with the ask, once per gap, and 7f names none when the plan fits', async () => {
    const model = structuredClone(await place(read('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row'))) as LayoutModel;
    expect(codes(model)).toEqual([]);
    // The frozen placement carries the bands too: the edit is made on both, then the model is restored as a snapshot.
    for (const bandList of [model.tierBands, model.freeze!.placement!.tierBands]) {
      const band = bandList?.find(item => item.tier === 1)?.bounds;
      if (!band) throw new Error('no band');
      band.y -= 20;
      band.height += 20;
    }
    const routed = await route(restoreLayoutModel(JSON.stringify(model)), { createAttempt: createAvoidAttempt });
    const unfit = routed.diagnostics.filter(item => item.code === 'TIER_GAP_PART_UNFIT');
    expect(unfit.map(item => item.stage)).toEqual(['final-geometry']);
    expect(unfit[0]!.message).toMatch(/^the tier gap above tier 1 asks 2\d\.\d\d px more than it has; its parts are left to the router\.$/);
  }, 120000);
});
