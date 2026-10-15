import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import type { AttemptTraceEvent } from '../../src/layout/placement-attempt.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture ticket 02: the 7f placement attempt is one module the transaction invokes; its trace and counters never reach the layout. */
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string, attemptTrace?: (event: AttemptTraceEvent) => void): Promise<LayoutModel> =>
  layout(parse(golden(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(attemptTrace ? { attemptTrace } : {}) });
const withoutRuntime = (model: LayoutModel): Partial<LayoutModel> => { const copy: Partial<LayoutModel> = { ...model }; delete copy.runtime; return copy; };

describe('the 7f placement attempt', () => {
  beforeEach(() => { resetAttemptCounters(); });

  it('counts its settle calls, centring passes, candidate copies and validation replays', async () => {
    await run('three-canton-groups-close-up-to-a-band-gap');
    expect(attemptCounters.settleCalls).toBeGreaterThan(0);
    expect(attemptCounters.centringPasses).toBeGreaterThan(0);
    expect(attemptCounters.candidateCopies).toBeGreaterThan(0);
    expect(attemptCounters.validationReplays).toBeGreaterThan(0);
  }, 60000);

  it('traces each pass only when asked, and the trace leaves the layout unchanged', async () => {
    const events: AttemptTraceEvent[] = [];
    const traced = await run('three-canton-groups-close-up-to-a-band-gap', event => events.push(event));
    const plain = await run('three-canton-groups-close-up-to-a-band-gap');
    expect(events.map(event => event.pass)).toEqual(expect.arrayContaining(['freeze-chords', 'group-label-bands', 'round-0:settle', 'held-axes', 'reseat-lanes', 'diagnostics']));
    for (const event of events) expect(event.revision).toMatch(/^[0-9a-f]{8}$/);
    expect(withoutRuntime(traced)).toEqual(withoutRuntime(plain));
    expect(JSON.stringify({ ...traced, reservations: undefined })).not.toContain('"revision"');
  }, 60000);
});
