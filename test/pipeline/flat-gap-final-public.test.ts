import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import type { LayoutModel } from '../../src/model/layout.js';
import type { FitLimits } from '../../src/pipeline/publication-fit.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42, review 1, through the public `layout` call: the final flat-gap choice runs once per command, and it judges the sheet
// the command publishes. The driver is wrapped to count its calls and their placements, and to skip it for an A/B run.
const trace = vi.hoisted(() => ({ skip: false, wider: false, decorated: 0, calls: [] as { placements: number; ran: boolean; rows: string[] }[] }));
vi.mock('../../src/pipeline/driver.js', async original => {
  const real = await original<typeof import('../../src/pipeline/driver.js')>();
  return { ...real, chooseFlatGapsAgain: async (env: Env, s: State, ...rest: Parameters<typeof real.chooseFlatGapsAgain> extends [unknown, unknown, ...infer R] ? R : never) => {
    if (trace.skip) return false;
    // Review 2, P2b: the candidate of the final choice takes a valid 52 px row gap in the last pair, so its sheet is wider.
    if (trace.wider) {
      const place = env.place;
      env.place = (ledger, abort) => {
        env.blockRowGaps = [...(env.blockRowGaps ?? []).filter(item => item.left !== 'node7a' || item.right !== 'node7b'), { left: 'node7a', right: 'node7b', gap: 52 }]
          .sort((a, b) => a.left.localeCompare(b.left));
        return place(ledger, abort);
      };
    }
    const placements = env.placements, ran = await real.chooseFlatGapsAgain(env, s, ...rest);
    trace.calls.push({ placements: env.placements - placements, ran, rows: (s.base.staggerRows ?? []).map(row => row.group) });
    return ran;
  } };
});
// Review 2, P3b: a fit that returns its run's model itself is not decorated again.
vi.mock('../../src/pipeline/publication-fit.js', async original => {
  const real = await original<typeof import('../../src/pipeline/publication-fit.js')>();
  return { ...real, carryFit: (from: LayoutModel, to: LayoutModel, decorate: (model: LayoutModel) => LayoutModel, limits?: FitLimits) =>
    real.carryFit(from, to, model => { if (model === from) trace.decorated++; return decorate(model); }, limits) };
});

const text = readFileSync(new URL('../../goldens/synthetic/a-flat-gap-is-chosen-again-after-the-fan-round.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const synthetic = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

describe('the final flat-gap choice in one command (review 1)', () => {
  it('runs once per command, on the run it publishes, not in the lift trials (P2)', async () => {
    trace.calls = [];
    const model = await layout(parse(text), options);
    expect(model.diagnostics.some(item => item.code.startsWith('GROUP_LIFT_'))).toBe(true);
    expect(trace.calls.map(({ placements, ran }) => ({ placements, ran }))).toEqual([{ placements: 1, ran: true }]);
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

describe('the final flat-gap choice and the published sheet of the run (review 2)', () => {
  it('is triggered by the published sheet: a route below the placed boxes moves the gap (P2a)', async () => {
    trace.calls = [];
    const model = await layout(parse(readFileSync(new URL('../fixtures/flat-gap/a-perimeter-route-below-a-flat-block-moves-its-gap.yaml', import.meta.url), 'utf8')), options);
    expect(model.canvas!.width).toBeCloseTo(5015.5, 3);
    expect(model.canvas!.height).toBeCloseTo(1671.833, 3);
    expect(trace.calls.map(({ placements, ran }) => ({ placements, ran }))).toEqual([{ placements: 1, ran: true }]);
    expect(model.diagnostics.map(item => item.code)).toContain('FLAT_BLOCK_GAP_FINAL');
  }, 120000);

  it('keeps a picked run that met layout.maxWidth when the candidate passes it, and names why (P2b)', async () => {
    const input = readYaml(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    input.layout.maxWidth = 5017;
    trace.calls = []; trace.wider = true;
    let model: LayoutModel;
    try { model = await layout(parse(writeYaml(input)), options); } finally { trace.wider = false; }
    expect(model.canvas!.width).toBeLessThanOrEqual(5017);
    const note = model.diagnostics.find(item => item.code === 'FLAT_BLOCK_GAP_FINAL_DECLINED');
    expect(note?.message).toMatch(/passes the width budget of 5017 px/);
    expect(model.diagnostics.some(item => item.code === 'WIDTH_BUDGET_UNMET')).toBe(false);
  }, 120000);

  it('fits the winning width trial once, and the width finding reads the model returned', async () => {
    const input = readYaml(synthetic('a-wide-card-row-staggers-under-a-budget')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    input.layout.maxWidth = 1;
    trace.calls = [];
    const model = await layout(parse(writeYaml(input)), options);
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0]!.rows).toEqual((model.staggerRows ?? []).map(row => row.group));
    expect(trace.calls[0]!.rows.length).toBeGreaterThan(0);
    const unmet = model.diagnostics.filter(item => item.code === 'WIDTH_BUDGET_UNMET');
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.message).toContain(`${model.canvas!.width.toFixed(2)} px wide`);
  }, 120000);

  it('does not decorate again a picked run whose fit changed nothing (P3b)', async () => {
    trace.calls = []; trace.decorated = 0;
    await layout(parse(synthetic('a-float-component-rises-beside-a-tall-block')), options);
    expect(trace.calls.map(({ placements }) => placements)).toEqual([0]);
    expect(trace.decorated).toBe(0);
  }, 120000);
});
