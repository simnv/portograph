import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { chordClearances, closedChordPairs } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 34: CHORD_CLEARANCE_LOST named the members of a flat block that run closer than 10 px in their sheaf zone, which G6
// excuses, and pairs that 7f did not close. On main 3bb2d565 each sheet below published 4 such warnings ("from 6.2 px apart to 6.2 px").
const sheets = ['a-flat-block-of-named-ports-keeps-the-floor-on-the-drawn-chord', 'a-flat-block-hub-frame-takes-side-room'];

describe('CHORD_CLEARANCE_LOST names only a pair 7f closed, read as G6 reads it (dense-16x9 ticket 34)', () => {
  for (const sheet of sheets) it(`publishes ${sheet} with no warning on its sheaf members`, async () => {
    const text = readFileSync(new URL(`../../goldens/synthetic/${sheet}.yaml`, import.meta.url), 'utf8');
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.blockReservations?.some(record => record.mode === 'flat')).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'CHORD_CLEARANCE_LOST')).toEqual([]);
    // The reading is the gate's: G6 passes, and no pair it reads stands under the clearance.
    expect(score(model).snapshot.gates['G6']!.violations).toEqual([]);
    expect([...chordClearances(model).values()].filter(value => value < 10 - 1e-6)).toEqual([]);
  }, 180000);

  it('names a pair under the clearance that 7f closed, and no pair that got wider or stood clear', () => {
    const before = new Map([['a|b', 9.3], ['c|d', 12], ['e|f', 11], ['g|h', 8]]);
    const after = new Map([['a|b', 9.5], ['c|d', 8.1], ['e|f', 10.5], ['g|h', 8], ['i|j', 5]]);
    expect(closedChordPairs(before, after)).toEqual([{ pair: 'c|d', before: 12, now: 8.1 }]);
  });
});
