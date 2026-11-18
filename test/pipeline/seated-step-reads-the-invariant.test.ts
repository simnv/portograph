import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 38 (R1): the seated centring step and the centring invariant read one set. A port the seat leaves off its feed is
// unresolved by the step, so the check excuses it, and no round of the passes runs again on geometry that does not change.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-seated-row-names-the-ports-its-seat-leaves-off-their-feeds.yaml', import.meta.url), 'utf8');

it('a seated row leaves no stall round, and centring converges', async () => {
  resetAttemptCounters();
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect((model.reservations ?? []).filter(entry => entry.kind === 'seatSet').length).toBeGreaterThan(0);
  expect(attemptCounters.centreStallRounds).toBe(0);
  expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' || item.code === 'CENTRE_ALIGNMENT_OPEN').map(item => item.code)).toEqual([]);
}, 120000);
