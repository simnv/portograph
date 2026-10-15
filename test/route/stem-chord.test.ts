import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import type { CreateRouteAttempt } from '../../src/route/worker.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

/**
 * Ticket 30. Two core routers link to the same four edge routers, and the stems nest. The pin-to-pin chord of
 * `c2 -> e3` (link-10) cuts the stem of a batchmate, but every leg of the link through its stem tips stays clear.
 * The chord stays in the PART KEY (`crossedStems`): the batch splits by a chord-crossed stem, so each fan link gets
 * its own part and its own request (the parts still share rows 263, 278 and 293 by overlap). It is dropped for the
 * CONSUMERS (`pendingStemObstacles`): a pending stem is passable to a later part only where its legs or L shapes
 * cross it. With the chord as a consumer, link-9 walked through the granted stem:8:link-10 at x 75.1 and its
 * cover `routed:link-9#0:0` (x 66 to 86.6) closed link-10's near tip (75, 263): the router skipped that
 * checkpoint and link-10 was removed. Without it stem:8 stays an obstacle, link-9 drops at x 63.3 and link-10 routes.
 * Dropping the chord from the key too merged the parts and put every horizontal on one row (crossings 8 to 24).
 * The fixture runs through the real router and records each request's connectors.
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-chord-under-a-stem-is-no-crossing.yaml', import.meta.url), 'utf8');

/** The real router, with the connector ids of every request recorded in order. */
function recording(requests: string[][]): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    return { assets: avoidAssets, worker: {
      postMessage: message => {
        const batch = (message as { batch?: { connectors?: { id: string }[] } }).batch;
        if (batch?.connectors) requests.push(batch.connectors.map(item => item.id));
        worker.postMessage(message);
      },
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    } };
  };
}

describe('the chord splits a batch but does not open a pending stem', () => {
  it('routes every link of two nested-stem cores through the real router, one part per fan link, and removes none', async () => {
    const requests: string[][] = [];
    const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
    const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: recording(requests) });
    // Ticket 50: every fan link is a planned part; the router is asked for nothing (main asked for three requests, one part per fan link
    // a chord-crossed stem split). link-11 (87 to 265.5) crosses the four others, and its whole edges close the cycle 11 > 9 > 4 > 6 > 11:
    // it is a Z part whose middle drop stands at 223.75, the widest clear interval that breaks the cycle (the widest of all, 164.25, leaves
    // 11b > 10 > 9 > 4 > 6 > 11b). The order is 11a, 10, 9, 4, 5, 6, 11b.
    expect(requests).toEqual([]);
    const plan = tierGapPlans(placedModel).find(item => item.plan.parts.length > 2)!.plan;
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(id => id.replace('link-', '').replace('#0', ''))).toEqual(['11a', '10', '9', '4', '5', '6', '11b']);
    expect(plan.parts.find(part => part.link === 'link-11')!.middle).toBeCloseTo(223.75, 6);
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED' || item.code === 'ROUTE_GAP_REJECTED')).toEqual([]);
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
  }, 120000);
});
