import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

/**
 * Ticket 30. Two core routers link to the same four edge routers, and the stems nest. The pin-to-pin chord of
 * `c2 -> e3` (link-10) cuts the stem of a batchmate, but every leg of the link through its stem tips stays clear.
 * Counting the chord split the link into a later routing part; the zigzags of the earlier parts closed the pocket
 * of its far stem tip, and the router dropped that checkpoint (`ROUTE_CHECKPOINT_SKIPPED`), removing the link.
 * The fixture runs through the real router. Before the rule it removed one link; with it none.
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-chord-under-a-stem-is-no-crossing.yaml', import.meta.url), 'utf8');

describe('a gap with checkpoints crosses a stem only along its legs', () => {
  it('routes every link of two nested-stem cores through the real router, and removes none', async () => {
    const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED' || item.code === 'ROUTE_GAP_REJECTED')).toEqual([]);
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
  }, 120000);
});
