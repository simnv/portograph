import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';

const observed = vi.hoisted(() => ({ proved: [] as string[][], retained: [] as string[][] }));

vi.mock('../../src/layout/stagger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/stagger.js')>();
  return {
    ...actual,
    arrangeGroups: (...args: Parameters<typeof actual.arrangeGroups>) => {
      const prove = args[2];
      args[2] = draft => {
        observed.proved.push(...(draft.staggerRows ?? []).map(row => [...row.far]));
        prove(draft);
      };
      actual.arrangeGroups(...args);
      observed.retained.push(...(args[0].staggerRows ?? []).map(row => [...row.far]));
    },
  };
});

import { placed } from '../layout/phase-two-fixture.js';

// Handoff regression (R1): arrangeGroups proves the far-line decision on a draft and must retain that proved record on model.staggerRows before the final seat runs.
it('retains the proved far decision across the arrangeGroups handoff before the final seat', async () => {
  observed.proved.length = 0;
  observed.retained.length = 0;
  const yaml = readFileSync('goldens/synthetic/a-wide-row-staggers-at-the-default-aim.yaml', 'utf8');
  const model: LayoutModel = await placed(yaml);
  expect(model.staggerRows?.length).toBe(1);
  expect(observed.proved).toHaveLength(1);
  expect(observed.proved[0]!.length).toBeGreaterThan(0);
  expect(observed.retained).toEqual(observed.proved);
  expect(model.staggerRows!.map(row => row.far)).toEqual(observed.proved);
});
