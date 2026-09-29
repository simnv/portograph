import { describe, expect, it } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, planRoute, rows } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { findPort } from '../../src/layout/row-paths.js';
import { placed } from '../layout/phase-two-fixture.js';

const text = `portograph: 2
groups:
  upstream: { tier: 0 }
  site: { tier: 1 }
nodes:
  a0: { group: upstream, class: router }
  b0: { group: site, class: switch }
  b1: { group: site, class: switch }
links:
  - [a0, b0, { class: physical, route: orthogonal }]
  - [a0, b1, { class: physical, route: orthogonal }]
`;

/**
 * Ticket 50 re-check. Two links of two nodes whose facing ports stand 9 px apart across a tier gap have legs within a run clearance
 * (spec 2.2): both are planned, the clash is named in `crowded`, and the pair consumes each other's leg covers, so neither is routed,
 * neither is removed. Stage 8 is not run here: a model that holds two ports closer than the pitch cannot be restored for it (the
 * validator refuses it), and the two nodes' lane mouths that stand this close are not built by the placement stages. The G6 finding
 * (`parallel-clearance`) is the gate's, on the routes.
 */
describe('a crowded pair of planned parts', () => {
  it('is planned whole, shares the covers of its pair and joins no batch', async () => {
    const model = structuredClone(bands(bundles(bars(centre(flanks(lanes(rows(await placed(text)))))))) ) as LayoutModel;
    const port = (link: number, end: 'from' | 'to') => findPort(model, model.links[link]!.attachments![end])!;
    const move = (link: number, end: 'from' | 'to', x: number): void => {
      const item = port(link, end);
      item.anchor = { ...item.anchor!, x };
      // A pill 9 px from its neighbour would overlap it; the pills are dropped so that the pair tests the legs alone (two nodes' lane mouths stand this close).
      delete item.pill;
    };
    // The two upper legs of one node stand 9 px apart (ports of one node stand 12 px apart; two nodes' lane mouths may stand closer).
    delete port(0, 'from').pill;
    move(1, 'from', port(0, 'from').anchor!.x + 9);
    const plans = tierGapPlans(model);
    const crowded = plans.flatMap(item => item.plan.crowded);
    expect(crowded.length).toBeGreaterThan(0);
    expect(plans.flatMap(item => item.plan.residual)).toEqual([]);
    const plan = planRoute(model);
    expect(plan.batches).toEqual([]);
    // Both stems are claimed and each link's run consumes the other's leg covers: nothing is asked of the router, so nothing can be removed.
    expect(plan.links.flatMap(item => item.pieces.map(piece => piece.kind)).filter(kind => kind === 'gap')).toEqual([]);
    expect(plan.links.map(item => [item.link, item.pieces[0]!.kind, item.pieces.at(-1)!.kind])).toEqual([['link-1', 'straight', 'straight'], ['link-2', 'straight', 'straight']]);
    const runs = allocateGapRuns(model);
    expect(runs.map(run => [run.link, run.shares])).toEqual([['link-1', ['link-2']], ['link-2', ['link-1']]]);
    expect(crowded).toEqual([{ id: 'link-2#0', link: 'link-2', with: 'link-1' }]);
  }, 60000);
});
