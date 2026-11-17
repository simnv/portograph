import { describe, expect, it } from 'vitest';
import { close, type Round } from '../../src/pipeline/round.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import type { LayoutModel } from '../../src/model/layout.js';

/**
 * Dense-16x9 ticket 36, review 1: the boundaries of the seat-set retry. A controlled state reproduction (stub placements and band runs), as the
 * review built it: it isolates the state transition, not a sheet.
 */
describe('a seat-set retry in a routed round trial (review 1, finding 3)', () => {
  it('passes the placement that replaces the trial through the same admission, and a refusal there refuses the trial and gives back its declines', async () => {
    const original = { tag: 'original', reservations: [] } as unknown as LayoutModel;
    const replacement = { tag: 'replacement', fallbackUsed: true, reservations: [] } as unknown as LayoutModel;
    const withdrawn = { reservations: [{ kind: 'seatSetDeclined', owner: { kind: 'group', id: 'r' }, payload: { row: 'r', at: 'centre', why: 'boundary' } }] } as unknown as LayoutModel;
    let bands = 0, committed: LayoutModel | undefined;
    const checks: string[] = [];
    const env = {
      options: {}, exemptPlacing: 0, timed: async (_label: string, run: () => unknown) => run(), trialAbort: () => undefined,
      place: async () => replacement,
      bands: async () => ({ model: ++bands === 1 ? withdrawn : replacement, moved: false, unmoved: undefined }),
      route: async (model: LayoutModel) => model,
    } as unknown as Env;
    const round = {
      id: 'side', routed: true,
      holdsAt7e: (_e: Env, _s: State, _o: unknown, _l: unknown, model: LayoutModel) => { checks.push((model as unknown as { tag: string }).tag); return undefined; },
      judge: () => undefined, commit: (_e: Env, _s: State, _o: unknown, t: { trial7e: LayoutModel }) => { committed = t.trial7e; }, refuse: () => undefined,
    } as unknown as Round<object>;
    const s = { sideNotes: [], kept7e: { fallbackUsed: false } } as unknown as State;
    const refusal = await close(env, s, round, {}, { ledger: [], trial7e: original });
    // The replacement is read by the same admission: it brings a new ELK fallback, so the trial is refused, and its decline of r is given back.
    expect(checks).toEqual(['original']);
    expect(refusal).toMatchObject({ at: 'fallback' });
    expect(committed).toBeUndefined();
    expect(env.seatSetDeclined).toBeUndefined();
    // The same with no fallback: the round's own 7e check reads the replacement and refuses it.
    (replacement as unknown as { fallbackUsed: boolean }).fallbackUsed = false;
    bands = 0; checks.length = 0;
    (round as unknown as { holdsAt7e: unknown }).holdsAt7e = (_e: Env, _s: State, _o: unknown, _l: unknown, model: LayoutModel) => {
      checks.push((model as unknown as { tag: string }).tag);
      return model === replacement ? { at: 'ledger', why: 'the replacement lacks the held input' } : undefined;
    };
    expect(await close(env, s, round, {}, { ledger: [], trial7e: original })).toMatchObject({ at: 'ledger' });
    expect(checks).toEqual(['original', 'replacement']);
    expect(committed).toBeUndefined();
    expect(env.seatSetDeclined).toBeUndefined();
  });
});
