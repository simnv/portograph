import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

// Ranked-groups ticket 31, round 4: a run the gap seats has a column at each end, and a column that stands
// within one tip band (23 px) of a stem tip column and reaches its row walls the pocket the tip needs. On the
// generated sheets these shapes threw "retraces itself" (a middle port between two seated columns) or
// dropped the link that owns a tip (a column in the only corridor). The gap refuses such a seat, and the
// link routes free as on main.
for (const name of ['a-seated-column-leaves-a-tip-its-pockets', 'a-seated-column-leaves-a-corridor-open']) {
  it(`routes every link through the real router and does not retrace (${name})`, async () => {
    const routed = await layout(parse(read(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(routed.removedLinks ?? []).toEqual([]);
  }, 120000);
}
