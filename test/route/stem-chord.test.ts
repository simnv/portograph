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
 * its own part and its own row. It is dropped for the CONSUMERS (`pendingStemObstacles`): a pending stem is passable
 * to a later part only where its legs or L shapes cross it. With the chord as a consumer the zigzags of the earlier
 * parts closed the pocket of link-10's far stem tip and the router dropped that checkpoint, removing the link.
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
    expect(requests).toEqual([['link-4#0', 'link-11#0'], ['link-5#0'], ['link-6#0'], ['link-9#0'], ['link-10#0']]);
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED' || item.code === 'ROUTE_GAP_REJECTED')).toEqual([]);
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
  }, 120000);
});
