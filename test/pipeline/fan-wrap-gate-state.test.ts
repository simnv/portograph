import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import { PostconditionRefusal, TrunkBlocked } from '../../src/layout/placement-refusal.js';
import { declinedStaggersOf, declinedTrunksOf, ofKind } from '../../src/layout/reservations.js';

// The verdict keeps the wrap: this test is about the state the comparison run leaves, not about the verdict.
vi.mock('../../src/layout/stagger.js', async original => ({ ...(await original<typeof import('../../src/layout/stagger.js')>()), wrapGateDecline: vi.fn(() => undefined) }));
// The stub models are no layout models: the copy that carries the gate's declines is read back as plain JSON, frozen as a restore freezes it.
vi.mock('../../src/layout/mutation.js', async original => ({ ...(await original<typeof import('../../src/layout/mutation.js')>()),
  restoreLayoutModel: vi.fn((json: string) => Object.freeze(JSON.parse(json) as LayoutModel)) }));
const { firstState } = await import('../../src/pipeline/initial.js');
const { wrapGateDecline } = await import('../../src/layout/stagger.js');

// Fan wrap acceptance gate (D-Q4, ticket 07, review round 2): the comparison run has its own state. Here its trunk join is blocked on one
// line (the comparison needs a trunk re-run) and the wrap is kept: the kept wrap goes on as if the comparison had not run, and every
// placement of the comparison stands outside the placement cap (`gateRuns`), so the rounds after it keep their placements.
describe('fan wrap: the comparison run leaves no state behind a kept wrap', () => {
  it('restores the ledger and the re-run count, and lifts every comparison placement from the cap', async () => {
    const wrapped = { groupArrangements: { w: { chosen: 'stagger' } }, staggerRows: [{ group: 'w', order: ['a', 'b', 'c'], far: ['b'], side: 'top', pitches: [1, 1], step: 1 }] } as unknown as LayoutModel;
    const plain = { groupArrangements: { w: { chosen: 'row', reason: 'gate' } } } as unknown as LayoutModel;
    const calls: { arranged: boolean | undefined; trunks: boolean }[] = [];
    const env = {
      options: {}, maxReruns: 3, placements: 0, reruns: 0, blockProbes: 0, gateRuns: 0, placeCap: 4,
      timed: async <T>(_label: string, run: () => T | Promise<T>): Promise<T> => run(),
      place: async (kept: Parameters<Env['place']>[0]): Promise<LayoutModel> => {
        // As `place` counts: a placement started inside an exempt trial is credited as it starts (`Env.exemptPlacing`).
        env.placements++; if (env.exemptPlacing) env.gateRuns++;
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
    expect(declinedStaggersOf(state.kept).size).toBe(0);
  });
});

// DR-11 review: a producer refusal at 7f of a gate run is a trial's refusal, as a stagger refusal is. It declines the lines when the wrapped run
// refuses, and keeps the wrapped run with no comparison when the plain run refuses; it never ends the command.
describe('fan wrap: a producer refusal at 7f of a gate run', () => {
  const run = async (refuses: 'wrapped' | 'plain'): Promise<{ state: Awaited<ReturnType<typeof firstState>>; wrapped: LayoutModel; plain: LayoutModel }> => {
    const wrapped = { groupArrangements: { w: { chosen: 'stagger' } }, staggerRows: [{ group: 'w', order: ['a', 'b', 'c'], far: ['b'], side: 'top', pitches: [1, 1], step: 1 }] } as unknown as LayoutModel;
    const plain = { groupArrangements: { w: { chosen: 'row', reason: 'gate' } } } as unknown as LayoutModel;
    const refused = refuses === 'wrapped' ? wrapped : plain;
    let placed = 0;
    const env = {
      options: {}, maxReruns: 3, placements: 0, reruns: 0, blockProbes: 0, gateRuns: 0, placeCap: 4,
      timed: async <T>(_label: string, work: () => T | Promise<T>): Promise<T> => work(),
      place: async (): Promise<LayoutModel> => {
        env.placements++; placed++;
        env.arrangedRows = placed === 1 ? ['w'] : [];
        return placed === 1 ? wrapped : plain;
      },
      bands: async (model: LayoutModel) => {
        if (model === refused) throw new PostconditionRefusal('bands', [{ kind: 'laneSide', subject: 'g', detail: 'g changed side of lane l' }]);
        return { model, moved: false, unmoved: undefined };
      },
    } as unknown as Env;
    return { state: await firstState(env), wrapped, plain };
  };

  // Every decline of the gate is in the ledger with its clause (dense-16x9 ticket 35): the kept ledger declines the row, and publication names
  // the decline from that entry only, so the gate itself leaves no note.
  it('declines the lines by name in the ledger when the wrapped run refuses', async () => {
    const { state, plain } = await run('wrapped');
    expect(state.kept7e).toMatchObject(plain);
    const entries = ofKind(state.kept, 'staggerDeclined');
    // The kept placement carries the same entries: the published ledger holds the decline.
    expect(state.kept7e.reservations).toEqual(entries);
    expect(entries.map(entry => [entry.producer, entry.payload.group, entry.payload.clause, entry.payload.links])).toEqual([['initial', 'w', 'trial', undefined]]);
    expect(declinedStaggersOf(state.kept).get('w')?.reason).toMatch(/^7f refused them: Postcondition of bands failed: laneSide g/);
    expect(state.keptNotes.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
  });

  it('keeps the wrapped run with no comparison when the plain run refuses', async () => {
    vi.mocked(wrapGateDecline).mockClear();
    const { state, wrapped } = await run('plain');
    expect(state.kept7e).toBe(wrapped);
    expect(wrapGateDecline).not.toHaveBeenCalled();
    expect(state.keptNotes.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
    expect(declinedStaggersOf(state.kept).size).toBe(0);
  });
});
