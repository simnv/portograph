import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import type { LayoutModel } from '../../src/index.js';

// Architecture-2 ticket 51: when a later stage of the first placement run refuses a stagger that stage 5 chose, the run is placed again with
// that row declined. The rows rule (stage 6) is wrapped to refuse the reservation once, as a later move that breaks it would.
let refusals = 0;
vi.mock('../../src/layout/rows.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/rows.js')>();
  return {
    ...actual,
    rows: (model: LayoutModel) => {
      if (refusals === 0 && model.staggerRows?.some(row => row.group === 'servers')) {
        refusals++;
        throw new PlacementRefusal('stagger', 'Stagger placement lost its reserved pitch or lines', { owners: [{ kind: 'group', id: 'servers' }] });
      }
      return actual.rows(model);
    },
  };
});

const { layout, parse } = await import('../../src/index.js');
const { createAttempt } = await import('../layout/phase-two-fixture.js');
const { createAvoidAttempt } = await import('../route/fixture.js');
const yaml = readFileSync(new URL('../../goldens/synthetic/a-wide-leaf-row-of-two-parents-staggers-without-a-budget.yaml', import.meta.url), 'utf8');

it('declines a stagger that a later stage of the first run refuses, and places the run again', async () => {
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(refusals).toBe(1);
  expect(model.staggerRows).toBeUndefined();
  expect(model.groupArrangements!.servers).toEqual({
    chosen: 'row', reason: 'a later stage of the first run refused the two lines: Stagger placement lost its reserved pitch or lines',
  });
  expect(new Set(model.groups.servers!.nodes.map(id => model.nodes[id]!.bounds!.y)).size).toBe(1);
}, 60000);
