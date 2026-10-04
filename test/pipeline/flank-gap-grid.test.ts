import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Architecture ticket 07 (ADR-0012 amendment): the linked grid widens a core and moves its flanks outward, so each keeps one band gap.
it('a core the grid widens keeps one band gap to both flanks', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-grid-keeps-the-flank-gap-of-a-widened-core.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const [upper, core, left, right] = ['upper', 'core', 'side-left', 'side-right'].map(id => model.groups[id]!.bounds!);
  expect(core!.x, 'the grid widened the core to the extent above it').toBeCloseTo(upper!.x, 6);
  expect(core!.width).toBeCloseTo(upper!.width, 6);
  expect(core!.x - (left!.x + left!.width), 'left flank gap').toBeCloseTo(bandGap(model), 6);
  expect(right!.x - (core!.x + core!.width), 'right flank gap').toBeCloseTo(bandGap(model), 6);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});
