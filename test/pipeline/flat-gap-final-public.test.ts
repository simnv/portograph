import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42, review 1, through the public `layout` call: the final flat-gap choice runs once per command, and it judges the sheet
// the command publishes. The driver is wrapped to count its calls and their placements, and to skip it for an A/B run.
const trace = vi.hoisted(() => ({ skip: false, calls: [] as { placements: number; ran: boolean }[] }));
vi.mock('../../src/pipeline/driver.js', async original => {
  const real = await original<typeof import('../../src/pipeline/driver.js')>();
  return { ...real, chooseFlatGapsAgain: async (env: Env, s: State) => {
    if (trace.skip) return false;
    const placements = env.placements, ran = await real.chooseFlatGapsAgain(env, s);
    trace.calls.push({ placements: env.placements - placements, ran });
    return ran;
  } };
});

const text = readFileSync(new URL('../../goldens/synthetic/a-flat-gap-is-chosen-again-after-the-fan-round.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

describe('the final flat-gap choice in one command (review 1)', () => {
  it('runs once per command, on the run it publishes, not in the lift trials (P2)', async () => {
    trace.calls = [];
    const model = await layout(parse(text), options);
    expect(model.diagnostics.some(item => item.code.startsWith('GROUP_LIFT_'))).toBe(true);
    expect(trace.calls).toEqual([{ placements: 1, ran: true }]);
    expect(model.canvas!.height).toBeCloseTo(model.canvas!.width / 3, 1);
  }, 120000);

  it('judges the published sheet: a route outside the placed boxes does not take it off the aim (P1)', async () => {
    // A link label on a link between the two outer pairs: stage 8 draws its route below the placed boxes, 5 px past them.
    const input = readYaml(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    input.layout.aspect = '5016:1290';
    for (const id of ['node1a', 'node7b']) input.nodes[id].ports = [{ name: 'port', side: 'bottom' }];
    input.links.push({ from: 'node1a.port', to: 'node7b.port', label: 'perimeter link label' });
    const run = () => layout(parse(writeYaml(input)), options), off = (height: number, width: number) => Math.abs(height - width * 1290 / 5016);
    trace.skip = true; const without = await run();
    trace.skip = false; trace.calls = []; const kept = await run();
    expect(off(kept.canvas!.height, kept.canvas!.width)).toBeLessThanOrEqual(off(without.canvas!.height, without.canvas!.width));
    // The note reports the published size.
    const note = kept.diagnostics.find(item => item.code === 'FLAT_BLOCK_GAP_FINAL');
    if (note !== undefined) expect(note.message).toContain(`the published sheet is ${kept.canvas!.width.toFixed(0)} x ${kept.canvas!.height.toFixed(0)} px`);
  }, 120000);
});
