import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import { TrunkBlocked } from '../../src/layout/placement-refusal.js';
import { declinedTrunksOf } from '../../src/layout/reservations.js';

// The verdict keeps the wrap: this test is about the state the comparison run leaves, not about the verdict.
vi.mock('../../src/layout/stagger.js', async original => ({ ...(await original<typeof import('../../src/layout/stagger.js')>()), wrapGateVerdict: () => undefined }));
const { firstState } = await import('../../src/pipeline/initial.js');

// Fan wrap acceptance gate (D-Q4, ticket 07, review round 2): the comparison run has its own state. Here its trunk join is blocked on one
// line (the comparison needs a trunk re-run) and the wrap is kept: the kept wrap goes on as if the comparison had not run, and every
// placement of the comparison stands outside the placement cap (`gateRuns`), so the rounds after it keep their placements.
describe('fan wrap: the comparison run leaves no state behind a kept wrap', () => {
  it('restores the ledger and the re-run count, and lifts every comparison placement from the cap', async () => {
    const wrapped = { groupArrangements: { w: { chosen: 'stagger' } }, staggerRows: [{ group: 'w', order: ['a', 'b', 'c'], side: 'top', pitches: [1, 1], step: 1 }] } as unknown as LayoutModel;
    const plain = { groupArrangements: { w: { chosen: 'row', reason: 'gate' } } } as unknown as LayoutModel;
    const calls: { arranged: boolean | undefined; trunks: boolean }[] = [];
    const env = {
      options: {}, maxReruns: 3, placements: 0, reruns: 0, blockProbes: 0, gateRuns: 0, placeCap: 4,
      timed: async <T>(_label: string, run: () => T | Promise<T>): Promise<T> => run(),
      place: async (kept: Parameters<Env['place']>[0]): Promise<LayoutModel> => {
        env.placements++;
        calls.push({ arranged: env.arranged, trunks: declinedTrunksOf(kept).has('t') });
        if (calls.length === 1) { env.arrangedRows = ['w']; return wrapped; }
        env.arrangedRows = [];
        // The comparison run (one line): the trunk join is blocked until the ledger declines it.
        if (!declinedTrunksOf(kept).has('t')) throw new TrunkBlocked('t', 'a group stands beside the row on one line');
        return plain;
      },
      bands: async (model: LayoutModel) => ({ model, moved: false, unmoved: undefined }),
    } as unknown as Env;
    const state = await firstState(env);
    expect(calls).toEqual([{ arranged: undefined, trunks: false }, { arranged: true, trunks: false }, { arranged: true, trunks: true }]);
    expect(state.kept7e).toBe(wrapped);
    expect(env.staggerRows).toEqual(wrapped.staggerRows);
    // As if the comparison had not run: no trunk decline in the kept ledger, no re-run spent, one placement against the cap.
    expect(declinedTrunksOf(state.kept).has('t')).toBe(false);
    expect(env.reruns).toBe(0);
    expect(env.placements).toBe(3);
    expect(env.gateRuns).toBe(2);
    expect(env.placements - env.blockProbes - env.gateRuns).toBe(1);
    expect(state.keptNotes.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
  });
});
