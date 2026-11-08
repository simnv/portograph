import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
// The group lift (ticket 08) is off in these tests: they count the placements, rebuilds or budget of one pipeline run, and each lift trial is one
// more whole run. `placement-budget.test.ts` bounds the runs of a command with the lift.

/**
 * Architecture 2, ticket 04: the unmoved baseline is rebuilt for a side offer at most once in a command, even when the side round is opened again after a course.
 * `testRebuildAlways` forces the rebuild whenever 7f moved the placement and the kept baseline has no offer.
 */
const SHEETS = ['a-tier-gap-plan-orders-every-part', 'three-continents', 'a-corridor-moves-after-the-grid-settles', 'a-chord-and-a-lane-share-a-middle-tier', 'an-overlay-leaves-a-lateral-side-past-a-sibling-body'];

it('rebuilds the unmoved baseline at most once per command', async () => {
  const counts: number[] = [];
  for (const name of SHEETS) {
    let rebuilds = 0;
    await layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true,
      testRebuildAlways: true, testTiming: label => { if (label === 'bands-unmoved') rebuilds++; } });
    counts.push(rebuilds);
  }
  expect(Math.max(...counts)).toBeLessThanOrEqual(1);
  // The test bites: at least one sheet reaches the rebuild.
  expect(Math.max(...counts)).toBe(1);
}, 120000);
