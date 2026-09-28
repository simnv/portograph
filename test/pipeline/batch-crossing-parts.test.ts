import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

describe('an ownership batch whose links cross different completed runs', () => {
  it('routes every link and keeps G2', async () => {
    const model = await layout(parse(fixture('a-batch-splits-by-the-covers-its-links-cross')),
      { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.links.every(item => item.path !== undefined)).toBe(true);
    expect(model.removedLinks ?? []).toEqual([]);
    const gates = score(model).snapshot.gates;
    expect(gates.G2.violations).toEqual([]);
    // G6 reports `segment-group-edge` on the first drop of four links: a leg that turns on the x of a
    // neighbour group's edge. That is a stem-turn placement fault, present without the split too (ticket 14
    // comment), so this test does not assert it.
  }, 60000);
});
