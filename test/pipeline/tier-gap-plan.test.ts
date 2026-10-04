import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, growTierGaps, lanes, layout, parse, planRoute, rows } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { score } from '../../src/score/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';

/**
 * Ranked-groups ticket 50 (`docs/design/tier-gap-rows.md`, Section 5, ticket 2): 7f grows every tier gap by the plan's `H` and stage 8
 * reserves the planned parts tip to tip. The fixtures are the four shapes of Section 2.4, through the real router.
 */
const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const place = async (name: string, orthogonal = false): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(orthogonal ? orthogonalLinks(read(name)) : read(name)))))))));
const growth = (model: LayoutModel): number[] => model.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN')
  .map(item => Number(/grew ([\d.]+) px/.exec(item.message)![1]));
const failing = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates)
  .flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}`));

async function whole(name: string): Promise<{ placed: LayoutModel; routed: LayoutModel }> {
  return { placed: await place(name), routed: await layout(parse(read(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] }) };
}

describe('7f grows the gaps by the plan and stage 8 reserves what it planned (ranked-groups ticket 50)', () => {
  it('routes the ticket 41 shape whole: the router is asked for nothing', async () => {
    const { placed: model, routed } = await whole('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    expect(planRoute(model).batches).toEqual([]);
    expect(growth(model)).toEqual([]);
    expect(routed.removedLinks ?? []).toEqual([]);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('routes the ticket 43 shape whole: the tips in the padding hold rows of their own', async () => {
    const { placed: model, routed } = await whole('a-plain-tip-in-the-group-padding-holds-its-row');
    expect(planRoute(model).batches).toEqual([]);
    expect(growth(model)).toEqual([]);
    expect(routed.removedLinks ?? []).toEqual([]);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('grows the ticket 36 shape 45 px, the spec\'s H = 105 against the 60 px band gap, and routes it whole', async () => {
    const { placed: model, routed } = await whole('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row');
    expect(growth(model)).toEqual([45]);
    expect(planRoute(model).batches).toEqual([]);
    expect(routed.removedLinks ?? []).toEqual([]);
    expect(failing(routed)).toEqual([]);
  }, 120000);

  it('grows the v5-4-0 shape 9.25 px in its upper gap and 22.5 px in its lower, and removes nothing', async () => {
    // The spec's 9.25 + 10: the upper 9.25 is link-3's row. Its leg to the nested tip stands under the `access` group label; since ticket 62
    // placement nudges that label off the leg, so link-3 is planned (it was residual, `leg-blocked`, before). The lower 10 is measured after
    // the 12.5 px main grew (12.5 + 10 = 22.5).
    const { placed: model, routed } = await whole('a-tier-gap-plan-orders-every-part');
    expect(growth(model)).toEqual([9.25, 22.5]);
    expect(tierGapPlans(model).flatMap(({ plan }) => plan.residual.map(item => `${item.link}:${item.reason}`))).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL').map(item => item.message)).toEqual([]);
    expect(routed.removedLinks ?? []).toEqual([]);
    // Placement's own finding, also on main: the port order of `isp0`. The two G6 findings of the residual link-3 are gone with it.
    expect(failing(routed)).toEqual(['G5:port-order', 'G5:port-order']);
  }, 120000);

  it('asks for nothing on a second measure of any of the four shapes, and a second bands pass grows nothing', async () => {
    for (const name of ['an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips', 'a-plain-tip-in-the-group-padding-holds-its-row',
      'two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', 'a-tier-gap-plan-orders-every-part']) {
      const model = await place(name);
      for (const { plan } of tierGapPlans(model)) expect([name, plan.growth]).toEqual([name, 0]);
      expect([name, growTierGaps(structuredClone(model) as LayoutModel)]).toEqual([name, false]);
    }
  }, 120000);

  it('leaves a part that crosses the shared run of another link to the router (crosses-shared-run)', async () => {
    const model = await place('a-claimed-run-clears-a-shared-run', true);
    const residual = tierGapPlans(model).flatMap(({ plan }) => plan.residual.map(item => `${item.link}:${item.reason}`));
    expect(residual).toContain('link-3:crosses-shared-run');
    expect(planRoute(model).links.find(item => item.link === 'link-3')!.pieces.map(piece => piece.kind)).toEqual(['gap']);
  }, 60000);
});
