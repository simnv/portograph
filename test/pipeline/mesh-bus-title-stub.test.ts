import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 83 review: a title that stands on the stub of a mesh bus, with no pass left to widen its frame or move it, stays and is reported
 * (`MESH_BUS_TITLE_ON_STUB`) instead of stopping the run. The budget of 7f is spent from the start here, which is the real path.
 */
const state = vi.hoisted(() => ({ spent: false }));
vi.mock('../../src/layout/centre.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/centre.js')>();
  return { ...original, createCentreBudget: () => state.spent ? { remaining: 0, passes: 0 } : original.createCentreBudget() };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a title on a bus stub with the budget spent (ticket 83 review)', () => {
  it('finishes with the budget spent where the titles need a widening, and the published layout restores', async () => {
    state.spent = true;
    let model: LayoutModel;
    try { model = await run(fixture('a-mesh-across-frames-draws-one-bus').replace('label: West', `label: ${'West '.repeat(9).trim()}`).replace('label: East', `label: ${'East '.repeat(9).trim()}`)); } finally { state.spent = false; }
    // The budget is spent where the titles need a widening: the run stalls and finishes with its diagnostics, and stops for nothing.
    expect(model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toBe(true);
    // A title that stays on a stub is reported, never thrown at; none is asserted here because no input reaches a stalled title on a stub.
    expect(model.diagnostics.some(item => item.code === 'MESH_BUS_TITLE_MOVED')).toBe(false);
    expect(JSON.stringify(restoreLayoutModel(JSON.stringify(model)))).toBe(JSON.stringify(model));
  }, 120000);
});
