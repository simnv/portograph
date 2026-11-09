import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import type { Env } from '../../src/pipeline/env.js';
import { open, type AnyRound, type Refusal } from '../../src/pipeline/round.js';
import { fan } from '../../src/pipeline/rounds.js';
import type { State } from '../../src/pipeline/state.js';
import { PostconditionRefusal, PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { BundleFeasibilityError } from '../../src/layout/bundle-paths.js';

/**
 * DR-11 review F1: a producer refusal raised inside a trial's placement run (a postcondition of 7e, or a bundle path with no room after the W09 guard
 * refused the room) withdraws the trial in every round; it is never the command's error. The rule is the round runner's, so a round that tolerates
 * nothing of its own withdraws too.
 */
const env = (error: unknown): Env => ({
  reruns: 0,
  timed: async <T>(_label: string, run: () => T | Promise<T>): Promise<T> => await run(),
  trialAbort: () => undefined,
  place: async (): Promise<LayoutModel> => { throw error; },
}) as unknown as Env;
const state = (): State => ({ kept: [], cuts: [], kept7e: { fallbackUsed: false } as LayoutModel }) as unknown as State;
const postcondition = (): PostconditionRefusal => new PostconditionRefusal('bundles', [{ kind: 'stored', subject: 'pitchFloor:fan-a', detail: 'the floor is broken' }]);
const bundle = (): BundleFeasibilityError => new BundleFeasibilityError('BUNDLE_CROSSOVER_CAPACITY', 'b1', 'Need 40 px crossover length, have 12.');

describe('a producer refusal in a trial (DR-11)', () => {
  it.each([['a postcondition', postcondition], ['a bundle path with no room', bundle]])('withdraws the fan trial on %s, and the cut names a broken reservation', async (_name, make) => {
    const s = state();
    const result = await open(env(make()), s, fan, { grown: [] });
    expect((result as Refusal).at).toBe('place');
    expect(s.cuts).toHaveLength(1);
    expect(s.cuts[0]!.code).toBe('FAN_SPREAD_CUT');
    expect(s.cuts[0]!.message).toContain('it broke a reservation');
    expect(s.cuts[0]!.message).not.toContain('trunk join');
  });

  it('withdraws the trial of a round that tolerates nothing of its own (one rule in the runner)', async () => {
    const refused: Refusal[] = [];
    const strict = { ...fan, tolerates: () => false, refuse: (_e: Env, _s: State, _o: unknown, r: Refusal) => { refused.push(r); } } as AnyRound;
    await open(env(postcondition()), state(), strict, { grown: [] });
    await open(env(bundle()), state(), strict, { grown: [] });
    expect(refused.map(item => item.at)).toEqual(['place', 'place']);
  });

  it('still lets every other error of a fan trial propagate', async () => {
    await expect(open(env(new Error('a defect')), state(), fan, { grown: [] })).rejects.toThrow('a defect');
    await expect(open(env(new PlacementRefusal('centring', 'the centring invariant')), state(), fan, { grown: [] })).rejects.toThrow('centring');
  });
});
