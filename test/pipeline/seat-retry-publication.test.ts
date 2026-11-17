import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// A controlled state reproduction (review 1, finding 4): the chord selection and the score are injected, so the publication replay runs on the real
// fixture with a band run that withdraws its set; it isolates the state transition, not a sheet.
const finding = { on: false };
vi.mock('../../src/layout/direct-families.js', async actual => ({ ...await actual<Record<string, unknown>>(), crowdedHeldChords: () => ['link-3'] }));
vi.mock('../../src/score/index.js', async actual => ({ ...await actual<Record<string, unknown>>(),
  score: (model: { seatProbe?: boolean }) => ({ snapshot: { gates: finding.on && model.seatProbe ? { G6: { severity: 'error', violations: [{ code: 'probe', elements: ['x'] }] } } : {} } }) }));

const { parse } = await import('../../src/index.js');
const { createEnv } = await import('../../src/pipeline/env.js');
const { firstState } = await import('../../src/pipeline/initial.js');
const { refuseCrowdedChords } = await import('../../src/pipeline/driver.js');
const { ofKind } = await import('../../src/layout/reservations.js');
const { withdrawSeatSet } = await import('../../src/layout/seat-set.js');
const { createAttempt } = await import('../layout/phase-two-fixture.js');
const { createAvoidAttempt } = await import('../route/fixture.js');
type LayoutModel = import('../../src/model/layout.js').LayoutModel;

const text = readFileSync(new URL('../../goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml', import.meta.url), 'utf8');

/** A command at its publication replay whose first band run withdraws site#1; `place` stands in for the retry's placement. */
async function command() {
  const env = createEnv(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const s = await firstState(env);
  expect(ofKind(s.kept7e.reservations ?? [], 'seatSet')).toHaveLength(1);
  let places = 0, bands = 0;
  env.place = async () => { places++; return structuredClone(s.kept7e); };
  env.bands = async model => {
    const copy = structuredClone(model) as LayoutModel & { seatProbe?: boolean };
    if (++bands === 1) { copy.stage = 'centre'; withdrawSeatSet(copy, 'site#1', 'a publication replay moved its boundary'); }
    copy.seatProbe = true;
    return { model: copy, moved: true, unmoved: undefined };
  };
  env.route = async model => model;
  s.routedBase = s.kept7e;
  return { env, s, places: () => places };
}

describe('the publication replay is a kept placement of the seat-set retry (review 1, finding 4)', () => {
  it('declines a set the replay withdraws and places the replay once more, before the gates judge it', async () => {
    finding.on = false;
    const { env, s, places } = await command();
    await refuseCrowdedChords(env, s);
    expect(places()).toBe(1);
    expect([...(env.seatSetDeclined ?? new Map()).keys()]).toEqual(['site#1']);
    expect(ofKind(s.routedFinal!.reservations ?? [], 'seatSetDeclined').filter(item => item.payload.at !== 'input')).toEqual([]);
  }, 120000);

  it('a replay the gates discard gives back its declines and publishes none of its notes', async () => {
    finding.on = true;
    const { env, s, places } = await command();
    const before = s.routedFinal, kept7e = s.kept7e;
    await refuseCrowdedChords(env, s);
    // The replay was placed once more without site#1, and its routed result adds a finding: the state before it stays, and so do the declines.
    expect(places()).toBe(1);
    expect(env.seatSetDeclined).toBeUndefined();
    expect([s.routedFinal, s.kept7e]).toEqual([before, kept7e]);
    expect(s.sideNotes.map(note => note.code)).toContain('HELD_CHORD_CROWDED');
  }, 120000);
});
