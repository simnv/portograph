import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { MAX_RERUNS } from '../../src/pipeline/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * The placement budget (architecture ticket 22, Q111): a command places at most `MAX_RERUNS` + 1 times, whatever rounds fire. The cap is asserted in one place, at the entry of
 * the pipeline's `place`; a round that asks for more has its trial refused.
 */
const SHEETS = [
  'ref/hand-solves/09-flank-link-around-a-neighbour.yaml',
  'goldens/synthetic/two-skirts-from-one-face-nest.yaml',
  'ref/hand-solves/04-mesh-across-a-tier.yaml',
  'goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml',
  'goldens/synthetic/a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame.yaml',
  'goldens/synthetic/a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line.yaml',
];

describe('placements per command', () => {
  it.each(SHEETS)('%s never places past the cap', async sheet => {
    resetAttemptCounters();
    await layout(parse(readFileSync(sheet, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(attemptCounters.placeRuns).toBeLessThanOrEqual(MAX_RERUNS + 1);
    expect(attemptCounters.placeRuns).toBeGreaterThanOrEqual(1);
  }, 120000);
});
