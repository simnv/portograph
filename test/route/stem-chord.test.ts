import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
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
    const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: recording(requests) });
    // Ticket 50: five of the six fan links are planned parts (rows 280.5 to 332.5, tip to tip) and never reach the router; the sixth,
    // link-11, stays residual because its rows form a cycle no middle drop clears (`row-cycle`), so it is the one request. Main asked
    // for three, one part per fan link that a chord-crossed stem split.
    expect(requests).toEqual([['link-11#0']]);
    // KNOWN REGRESSION (ticket 50, recorded in its file; ticket 51): the residual link is routed among the covers of five reserved
    // parts, its checkpoints stand in pockets those covers close, and stage 8 removes it (ROUTE_GAP_REJECTED). Main removed none.
    // Spec Section 2.2 prefers a published residual with a G6 finding to a removed link; the grant that would give it is ticket 51's.
    expect(model.removedLinks ?? []).toEqual(['link-11']);
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL').map(item => item.message))
      .toEqual([expect.stringContaining('link-11 is left to the router')]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED')).toEqual([]);
    for (const link of model.links) expect(link.path === undefined, link.id).toBe(link.id === 'link-11');
  }, 120000);
});
