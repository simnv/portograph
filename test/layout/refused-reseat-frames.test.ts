import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { parse } from '../../src/parse/index.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { createAttempt } from './phase-two-fixture.js';

/**
 * A refused lane reseat restores the lanes and everything derived from them. `reseatLanes` derives the frames again after it moves a corridor; the refusal
 * in `chooseReseat` put the lanes back and left the frames at the refused corridor, and stage 8 threw `Frames contradict the cell geometry they derive from`.
 */
it('after a refused reseat the published frames equal the frames derived from the cells', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-refused-reseat-restores-its-frames.yaml', import.meta.url), 'utf8');
  resetAttemptCounters();
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  // The premise: 7f moved a corridor onto its child and the reseat was refused.
  expect(attemptCounters.reseat.refused).toBeGreaterThan(0);
  expect(model.frames?.length).toBeGreaterThan(0);
  expect(model.frames).toEqual(deriveFrames(model));
});
