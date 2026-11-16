import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';

const observed = vi.hoisted(() => ({ proved: [] as string[][], retained: [] as string[][], provedHubs: [] as unknown[], retainedHubs: [] as unknown[] }));

vi.mock('../../src/layout/stagger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/stagger.js')>();
  return {
    ...actual,
    arrangeGroups: (...args: Parameters<typeof actual.arrangeGroups>) => {
      const prove = args[2];
      args[2] = draft => {
        observed.proved.push(...(draft.staggerRows ?? []).map(row => [...row.far]));
        observed.provedHubs.push(...(draft.staggerRows ?? []).map(row => row.chordHubs));
        prove(draft);
      };
      actual.arrangeGroups(...args);
      observed.retained.push(...(args[0].staggerRows ?? []).map(row => [...row.far]));
      observed.retainedHubs.push(...(args[0].staggerRows ?? []).map(row => row.chordHubs));
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

// The same handoff for the compact hubs (dense-16x9 ticket 03, slice C, review 1): the proved `chordHubs` is retained, `[]` included.
it.each([
  ['goldens/synthetic/a-member-with-several-links-stands-on-the-near-line.yaml', ['hub-1', 'hub-2']],
  ['goldens/synthetic/a-wide-row-staggers-at-the-default-aim.yaml', []],
])('retains the proved compact-hub decision across the arrangeGroups handoff (%s)', async (file, hubs) => {
  observed.provedHubs.length = 0;
  observed.retainedHubs.length = 0;
  await placed(readFileSync(file, 'utf8'));
  expect(observed.provedHubs.at(-1)).toEqual(hubs);
  expect(observed.retainedHubs).toEqual([hubs]);
});
