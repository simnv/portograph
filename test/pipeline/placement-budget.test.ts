import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { SkeletonError } from '../../src/layout/skeleton.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { MAX_RERUNS } from '../../src/pipeline/index.js';
import { LIFT_TRIALS } from '../../src/layout/lift.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { readSheet } from '../hand-solves.js';

/**
 * The placement budget (architecture ticket 22, Q111): a command places at most `MAX_RERUNS` + 1 times, whatever rounds fire. The cap is asserted in one place, at the entry of
 * the pipeline's `place`; a round that asks for more has its trial refused. The group lift (ticket 08) judges a lift on whole command runs: the
 * no-lift run and at most `LIFT_TRIALS` trial runs, each under its own cap. So a command with a float component places at most
 * (`MAX_RERUNS` + 1) x (1 + `LIFT_TRIALS`) times, and one pipeline run (the lift off) at most `MAX_RERUNS` + 1 times.
 */
const SHEETS = [
  'hand-solves/09-flank-link-around-a-neighbour.yaml',
  'goldens/synthetic/two-skirts-from-one-face-nest.yaml',
  'hand-solves/04-mesh-across-a-tier.yaml',
  'goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml',
  'goldens/synthetic/a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame.yaml',
  'goldens/synthetic/a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line.yaml',
];

describe('placements per command', () => {
  it.each(SHEETS)('%s never places past the cap', async sheet => {
    resetAttemptCounters();
    await layout(parse(readSheet(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
    expect(attemptCounters.placeRuns).toBeLessThanOrEqual(MAX_RERUNS + 1);
    expect(attemptCounters.placeRuns).toBeGreaterThanOrEqual(1);
    // With the lift: each run of the command keeps its cap, and the runs are bounded by count (R4).
    resetAttemptCounters();
    let trials = 0;
    await layout(parse(readSheet(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftTrace: () => { trials++; } });
    expect(trials).toBeLessThanOrEqual(LIFT_TRIALS);
    expect(attemptCounters.placeRuns).toBeLessThanOrEqual((MAX_RERUNS + 1) * (1 + trials));
  }, 120000);
});

describe('a started placement is never given back (architecture 2, ticket 03)', () => {
  // A trial that is refused after it began (here: its ELK attempt cannot be made) has spent its slot. The count of starts is the count of attempts the sheet asked for.
  it.each(SHEETS)('%s: refused re-runs still count as starts', async sheet => {
    resetAttemptCounters();
    let attempts = 0;
    const refusing = (): ReturnType<typeof createAttempt> => {
      attempts++;
      if (attempts > 1) throw new SkeletonError('injected refusal after the run began');
      return createAttempt();
    };
    // A fan re-run does not catch a refusal (it ends the command), so the command may end in an error; either way the starts are bounded.
    await layout(parse(readSheet(sheet)), { createElkAttempt: refusing, createRouteAttempt: createAvoidAttempt }).catch(() => undefined);
    expect(attempts).toBeGreaterThan(1);
    expect(attemptCounters.placeStarts).toBeLessThanOrEqual(MAX_RERUNS + 1);
    expect(attemptCounters.placeStarts).toBeGreaterThanOrEqual(1);
  }, 120000);
});
