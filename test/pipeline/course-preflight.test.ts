import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, serializeLayoutModel } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import type { Env } from '../../src/pipeline/env.js';
import { close, type Refusal, type Round } from '../../src/pipeline/round.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const ntpYaml = readFileSync(new URL('../../goldens/real/ntp.yaml', import.meta.url), 'utf8');
const spineLeafYaml = readFileSync(new URL('../../goldens/real/private-datacenter-spine-leaf.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

const layoutHash = (model: LayoutModel): string => {
  const json = `${serializeLayoutModel({ ...model, runtime: { stages: [] } })}\n`;
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
};

describe('course 7e preflight', () => {
  it('resets coursePreflight counters in resetAttemptCounters', () => {
    attemptCounters.coursePreflight.checked = 3;
    attemptCounters.coursePreflight.refusedAt7e = 2;
    resetAttemptCounters();
    expect(attemptCounters.coursePreflight).toEqual({ checked: 0, refusedAt7e: 0 });
  });

  it('refuses at preflight before calling bands and handles tolerated preflight errors', async () => {
    const events: string[] = [];
    const model = { fallbackUsed: false } as LayoutModel;
    const makeRound = (preflight: NonNullable<Round<Record<string, never>>['preflight']>, tolerates = false): Round<Record<string, never>> => ({
      id: 'course',
      label: 'rerun-course',
      routed: true,
      children: [],
      budget: { protects: [], tie: 0, visits: 1, again: false, retries: [], reopens: false, floor: 0 },
      enabled: () => true,
      gain: () => [0, 0, 0],
      skip: () => undefined,
      tolerates: (_error, phase) => tolerates && phase === 'bands',
      measure: async () => ({}),
      reserve: () => [],
      holdsAt7e: () => undefined,
      preflight,
      judge: () => { events.push('judge'); return undefined; },
      commit: () => { events.push('commit'); },
      refuse: (_env, _s, _o, r) => { events.push(`refuse:${r.at}:${r.why}`); },
    });
    const env = {
      options: {},
      bands: async (m: LayoutModel) => { events.push('bands'); return { model: m, moved: false, unmoved: undefined }; },
      route: async (m: LayoutModel) => { events.push('route'); return m; },
    } as unknown as Env;
    const state = { kept7e: model, base: model, kept: [] } as unknown as State;

    const refused: Refusal = { at: 'verdict', why: 'demoted chord removed at 7e' };
    const r1 = await close(env, state, makeRound(async () => refused), {}, { ledger: [], trial7e: model });
    expect(r1).toEqual(refused);
    expect(events).toEqual(['refuse:verdict:demoted chord removed at 7e']);

    events.length = 0;
    const r2 = await close(env, state, makeRound(async () => { throw new PlacementRefusal('course', 'route timed out'); }, true), {}, { ledger: [], trial7e: model });
    expect(r2?.at).toBe('bands');
    expect(r2?.why).toBe('route timed out');
    expect(events).toEqual(['refuse:bands:route timed out']);
  });

  it('refuses the doomed course trial at 7e on goldens/real/private-datacenter-spine-leaf.yaml with an identical layout hash', async () => {
    resetAttemptCounters();
    const model = await layout(parse(spineLeafYaml), options);
    expect(attemptCounters.coursePreflight.checked).toBeGreaterThanOrEqual(1);
    expect(attemptCounters.coursePreflight.refusedAt7e).toBeGreaterThanOrEqual(1);
    expect(attemptCounters.attempts).toBe(1);
    expect(layoutHash(model)).toBe('56f38cf75727');
  }, 60000);

  it('refuses the doomed course trial at 7e on goldens/real/ntp.yaml with an identical layout hash', async () => {
    resetAttemptCounters();
    const model = await layout(parse(ntpYaml), options);
    expect(attemptCounters.coursePreflight.checked).toBeGreaterThanOrEqual(1);
    expect(attemptCounters.coursePreflight.refusedAt7e).toBe(1);
    expect(attemptCounters.attempts).toBe(1);
    expect(layoutHash(model)).toBe('5b36a217c50b');
  }, 120000);
});
