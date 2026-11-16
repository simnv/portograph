import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { drive } from '../../src/pipeline/driver.js';
import type { AnyRound } from '../../src/pipeline/round.js';
import { declinedStaggersOf, declineTrunk, reserve } from '../../src/layout/reservations.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

/**
 * Dense-16x9 ticket 22, review 3: a round whose 7f trial refuses a kept stagger by name declines that row and places the baseline again without it
 * (`keptStaggers` in `round.ts`). Four equal leaf rows, each kept by the gate; an unrouted round with the fan's budget whose every trial 7f refuses the
 * first stagger row it holds. Each refused row is declined once, by one more placement each, and every one of those placements stands outside the
 * cap: the third no longer throws `PlacementBudgetExceeded` (on 0e3832d6 it did: placements 11, gateRuns 6, cap 4). The round's starts (`MAX_RERUNS`)
 * end the trials after the third, as for any round: a visit given back does not give back a start, so the fourth row stands as the gate kept it.
 */
const ids = ['a', 'b', 'c', 'd'], members = [1, 2, 3, 4, 5, 6];
const yaml = `portograph: 2
layout: { aspect: "1:1" }
groups:
  g-up: { tier: 0 }
  g-core: { tier: 1 }
${ids.map(id => `  g-h${id}: { tier: 2 }\n  g-${id}: { tier: 3 }`).join('\n')}
nodes:
  up: { group: g-up, class: router }
  core: { group: g-core, class: router }
${ids.map(id => `  h${id}: { group: g-h${id}, class: switch }\n${members.map(n => `  ${id}${n}: { group: g-${id}, class: server }`).join('\n')}`).join('\n')}
links:
  - [up, core]
${ids.map(id => `  - [core, h${id}]\n${members.map(n => `  - [h${id}, ${id}${n}]`).join('\n')}`).join('\n')}
`;

describe('a declined stagger costs one placement outside the cap, once per row (dense-16x9 ticket 22, review 3)', () => {
  it('declines each refused row once, by one placement outside the cap each, and never throws the placement cap', async () => {
    const env = createEnv(parse(yaml), { createElkAttempt: createAttempt });
    const s = await firstState(env);
    expect(s.kept7e.staggerRows?.map(row => row.group)).toEqual(['g-a', 'g-b', 'g-c', 'g-d']);
    // A trial carries this marker in its ledger; the baseline placed again from the kept ledger does not.
    const trial = (model: LayoutModel): boolean => (model.reservations ?? []).some(entry => entry.kind === 'trunkDeclined' && entry.payload.reason === 'trial marker');
    const bands = env.bands, refused: string[] = [];
    env.bands = async (model, mode) => {
      if (trial(model) && model.staggerRows?.length) {
        const group = model.staggerRows[0]!.group;
        refused.push(group);
        throw new PlacementRefusal('stagger', `test corridor refusal of ${group}`, { owners: [{ kind: 'group', id: group }] });
      }
      return bands(model, mode);
    };
    const round = {
      id: 'fan', label: 'test-fan', routed: false, children: [],
      budget: { protects: [], tie: 0, visits: 2, again: true, retries: [], reopens: false, floor: 2 },
      enabled: () => true, gain: () => [0, 0, 0], skip: () => undefined, tolerates: () => false,
      measure: async (_env: unknown, state: typeof s) => state.kept7e.staggerRows?.length ? {} : undefined,
      reserve: (_env: unknown, state: typeof s) => reserve(state.kept, declineTrunk('test-marker', 'trial marker', 1)),
      holdsAt7e: () => undefined, judge: () => undefined,
      commit: (_env: unknown, state: typeof s, _offer: unknown, t: { trial7e: LayoutModel; ledger: typeof s.kept }) => { state.kept7e = t.trial7e; state.kept = t.ledger; },
      refuse: () => undefined,
    } as unknown as AnyRound;
    await drive(env, s, [[round]]);
    expect(refused).toEqual(['g-a', 'g-b', 'g-c']);
    expect(s.rebased).toBe(3);
    expect([...declinedStaggersOf(s.kept).keys()]).toEqual(['g-a', 'g-b', 'g-c']);
    expect(s.kept7e.staggerRows?.map(row => row.group)).toEqual(['g-d']);
    expect(env.rebasedRows).toEqual(new Set(['g-a', 'g-b', 'g-c']));
    expect(env.placements - env.blockProbes - env.gateRuns - env.farEndRuns).toBeLessThanOrEqual(env.placeCap);
  }, 180000);
});
