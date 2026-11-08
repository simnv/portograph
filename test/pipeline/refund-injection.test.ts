import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { CourseRefusal } from '../../src/layout/courses.js';
import { SpanRefusal } from '../../src/layout/span-lanes.js';
import { MAX_RERUNS } from '../../src/pipeline/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';
// The group lift (ticket 08) is off in these tests: they count the placements, rebuilds or budget of one pipeline run, and each lift trial is one
// more whole run. `placement-budget.test.ts` bounds the runs of a command with the lift.

/**
 * Architecture 2, ticket 03: a placement that has started is never given back. Stage 7a is made to refuse the n-th placement of a command with a `CourseRefusal` (the refusal that
 * used to refund its re-run), and the starts are counted at the entry of `place`. The refused start stays spent, so the rounds after it find one re-run fewer.
 */
const injected: { at: number; calls: number; bundlesAt: number; bundlesCalls: number } = { at: 0, calls: 0, bundlesAt: 0, bundlesCalls: 0 };
vi.mock('../../src/layout/bundles.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/layout/bundles.js')>();
  return { ...real, bundles: (...args: Parameters<typeof real.bundles>) => {
    injected.bundlesCalls++;
    if (injected.bundlesCalls === injected.bundlesAt) throw new SpanRefusal('injected refusal at stage 7e');
    return real.bundles(...args);
  } };
});
vi.mock('../../src/layout/lanes.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/layout/lanes.js')>();
  return { ...real, lanes: (...args: Parameters<typeof real.lanes>) => {
    injected.calls++;
    if (injected.calls === injected.at) throw new CourseRefusal('injected refusal at stage 7a');
    return real.lanes(...args);
  } };
});

const SHEET = 'goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml';
const SPAN_SHEET = 'goldens/synthetic/a-chord-over-three-tier-gaps-passes-two-middle-tiers.yaml';
const FAN_SHEET = 'goldens/synthetic/a-fan-spreads-its-ports-so-its-chords-hold-clearance.yaml'; // one fan re-run
const run = async (at: number, sheet = SHEET, bundlesAt = 0): Promise<{ starts: number; runs: number; stage: string | undefined }> => {
  injected.at = at; injected.calls = 0; injected.bundlesAt = bundlesAt; injected.bundlesCalls = 0;
  resetAttemptCounters();
  const model = await layout(parse(withoutJointOrder(readFileSync(sheet, 'utf8'))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true }).catch(() => undefined);
  return { starts: attemptCounters.placeStarts, runs: attemptCounters.placeRuns, stage: model?.stage };
};

describe('a placement that stage 7a refuses is still a start', () => {
  beforeEach(() => { injected.at = 0; injected.calls = 0; });

  it('counts the refused start and stays under the cap', async () => {
    const plain = await run(0);
    expect(plain.stage).toBe('link-labels');
    expect(plain.starts).toBe(plain.runs);
    // Refuse the last placement the plain command makes: the start is counted, no run is finished for it, and no later round gets the slot back.
    expect(plain.starts).toBe(MAX_RERUNS + 1);
    // Refused at 7a: the start is counted, and the rounds after it find one re-run fewer (the command made four starts, now three).
    const early = await run(2);
    expect(early).toEqual({ starts: 3, runs: 3, stage: 'link-labels' });
    // Refused as the last placement: the start stays spent, the command still ends.
    expect(await run(plain.starts)).toEqual({ starts: plain.starts, runs: plain.runs, stage: 'link-labels' });
    // Refused before the command starts anything else: one start, and the command ends in the error.
    expect(await run(1)).toEqual({ starts: 1, runs: 1, stage: undefined });
  }, 240000);

  it('counts a span trial refused at stage 7e', async () => {
    const plain = await run(0, SPAN_SHEET);
    expect(plain.stage).toBe('link-labels');
    // Since architecture-2 ticket 32 the parent `n` spreads its two ports over its children, both drops stand vertical, and the sheet makes no fan re-run:
    // the span trial is the second placement.
    expect(plain.starts).toBe(2);
    // The span trial's 7e refuses. The start is spent, and the command ends with the sheet as the baseline made it.
    expect(await run(0, SPAN_SHEET, 2)).toEqual({ starts: 2, runs: 2, stage: 'link-labels' });
    // Refused at the fan re-run (the second placement of a sheet that makes one): a fan re-run does not catch a refusal, so the command ends with it,
    // after two starts.
    expect(await run(0, FAN_SHEET, 2)).toEqual({ starts: 2, runs: 2, stage: undefined });
  }, 240000);
});
