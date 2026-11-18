import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse, score } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42, review 3: the reviewer's replay (review3-unmet), kept as a test. A width budget the picked run already missed
// (`maxWidth: 5015`, the winner is 5016 px) must not get worse at the final flat-gap fit, and the width finding names the model returned. The
// candidate takes a valid 52 px row gap in the last pair, so its sheet is wider (5046.5 px before the fix).
const replay = vi.hoisted(() => ({ skip: false, wider: false }));
vi.mock('../../src/pipeline/driver.js', async original => {
  const real = await original<typeof import('../../src/pipeline/driver.js')>();
  return { ...real, chooseFlatGapsAgain: async (env: Env, s: State, ...rest: Parameters<typeof real.chooseFlatGapsAgain> extends [unknown, unknown, ...infer R] ? R : never) => {
    if (replay.skip) return false;
    if (replay.wider) {
      const place = env.place;
      env.place = (ledger, abort) => {
        env.blockRowGaps = [...(env.blockRowGaps ?? []).filter(item => item.left !== 'node7a' || item.right !== 'node7b'), { left: 'node7a', right: 'node7b', gap: 52 }]
          .sort((a, b) => a.left.localeCompare(b.left));
        return place(ledger, abort);
      };
    }
    return real.chooseFlatGapsAgain(env, s, ...rest);
  } };
});

const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const input = (): Record<string, any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const sheet = readYaml(readFileSync(new URL('../../goldens/synthetic/a-flat-gap-is-chosen-again-after-the-fan-round.yaml', import.meta.url), 'utf8'));
  sheet.layout.maxWidth = 5015;
  return sheet;
};
const errors = (model: Awaited<ReturnType<typeof layout>>): string[] =>
  Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id);

it('publishes no sheet wider than a picked run that missed layout.maxWidth, and the width finding names the model returned (review 3)', async () => {
  replay.wider = true;
  try {
    replay.skip = true;
    const baseline = await layout(parse(writeYaml(input())), options);
    replay.skip = false;
    const model = await layout(parse(writeYaml(input())), options);
    expect(baseline.canvas!.width).toBe(5016);
    expect(model.canvas!.width).toBeLessThanOrEqual(baseline.canvas!.width);
    expect(errors(model)).toEqual([]);
    const note = model.diagnostics.find(item => item.code === 'FLAT_BLOCK_GAP_FINAL_DECLINED');
    expect(note?.message).toMatch(/passes the width limit of 5016 px/);
    const unmet = model.diagnostics.filter(item => item.code === 'WIDTH_BUDGET_UNMET');
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.message).toContain(`The narrowest valid result tried is ${model.canvas!.width.toFixed(2)} px wide`);
  } finally { replay.wider = false; replay.skip = false; }
}, 240000);
