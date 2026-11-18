import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { chooseFlatGapsAgain, drive, FLAT_BLOCK_GAP_FINAL_DECLINED, refuseCrowdedChords } from '../../src/pipeline/driver.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42, review 1 (P2, large model): the final choice reads the gates through `gateFindings` (it scores with force, so a model
// above 1000 nodes is scored), and a model the gates cannot score is declined by name. The reader is made to fail on the candidate.
const reader = vi.hoisted(() => ({ fail: undefined as LayoutModel | undefined, calls: 0 }));
vi.mock('../../src/layout/trial-findings.js', async original => {
  const real = await original<typeof import('../../src/layout/trial-findings.js')>();
  return { ...real, gateFindings: (model: LayoutModel, severity?: 'error' | 'warning') => {
    reader.calls++;
    return reader.fail !== undefined && model !== reader.fail ? undefined : real.gateFindings(model, severity);
  } };
});

const text = readFileSync(new URL('../../goldens/synthetic/a-flat-gap-is-chosen-again-after-the-fan-round.yaml', import.meta.url), 'utf8');

it('declines by name a candidate the gates cannot score', async () => {
  const env = createEnv(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const s = await firstState(env);
  await drive(env, s); await refuseCrowdedChords(env, s);
  // Every model but the baseline's publication route fails to score.
  reader.fail = s.routedFinal ?? s.routedBase; reader.calls = 0;
  const base = s.base;
  expect(await chooseFlatGapsAgain(env, s)).toBe(true);
  expect(reader.calls).toBeGreaterThan(0);
  expect(s.sideNotes.at(-1)?.code).toBe(FLAT_BLOCK_GAP_FINAL_DECLINED);
  expect(s.sideNotes.at(-1)?.message).toMatch(/the gates cannot score the candidate/);
  expect(s.base).toBe(base);
}, 120000);
