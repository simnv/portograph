import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 83 review, as architecture-2 ticket 54 changed it: a title never widens its frame or moves to its other edge for a bus stub. A stub
 * is one more span the title slides off; with none free the title takes the halo. The budget of 7f is spent from the start here, and the run
 * still finishes and restores.
 */
const state = vi.hoisted(() => ({ spent: false }));
vi.mock('../../src/layout/centre.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/centre.js')>();
  return { ...original, createCentreBudget: () => state.spent ? { remaining: 0, passes: 0 } : original.createCentreBudget() };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a title on a bus stub with the budget spent (ticket 83 review, ticket 54)', () => {
  it('finishes with the budget spent, the wide titles placed without a widening or an edge move, and the published layout restores', async () => {
    state.spent = true;
    let model: LayoutModel;
    try { model = await run(fixture('a-mesh-across-frames-draws-one-bus').replace('label: West', `label: ${'West '.repeat(9).trim()}`).replace('label: East', `label: ${'East '.repeat(9).trim()}`)); } finally { state.spent = false; }
    // Every title is placed and carries its crossing record; no title moved to its other edge.
    const titles = model.labels.filter(item => item.role === 'group');
    expect(titles.length).toBe(model.labelBands.length);
    for (const title of titles) expect(Array.isArray(title.crossedBy), title.id).toBe(true);
    expect(model.diagnostics.some(item => item.code.startsWith('MESH_BUS_TITLE'))).toBe(false);
    expect(JSON.stringify(restoreLayoutModel(JSON.stringify(model)))).toBe(JSON.stringify(model));
  }, 120000);
});
