import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { crowdedHeldChords } from '../../src/layout/direct-families.js';
import { refusedChordsOf } from '../../src/layout/reservations.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 28. Measured case (outside sheet, ticket 27 branch): in two flat solid blocks each refused member's fallback crowds the
 * next member, so the 7f crowding retry needs 3 or more runs; with its old bound of 2 it gave up (`FAN_MEMBER_CROWDED`), and the member was
 * published with a G6 finding, because the publication step (`refuseCrowdedChords`) skipped every member. Now the retry runs until no new
 * member is crowded (`crowdRetryBound`, the member count), and the publication step refuses every held chord under the G6 clearance, the
 * members included, as the last resort behind it. No corpus sheet on main needs more than one retry, so the tests stage it: the retry gives up
 * at once (bound 0), a crowding that comes in three waves, or a forged state to publish.
 */
const staged = vi.hoisted(() => ({ bound: undefined as number | undefined, waves: [] as string[] }));
vi.mock('../../src/layout/direct-families.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/direct-families.js')>();
  return {
    ...actual,
    crowdRetryBound: (model: LayoutModel) => staged.bound ?? actual.crowdRetryBound(model),
    // The staged crowding: the first member of `waves` that is still straight is named `crowds` too, one per run of the attempt, as if each
    // refusal's fallback crowded the next member. The publication step reads the real reader (a call inside the module), not this one.
    crowdedFanMembers: (model: LayoutModel) => {
      const found = actual.crowdedFanMembers(model);
      const straight = new Set((model.fanAdmissions ?? []).filter(item => item.mode === 'straight').map(item => item.link));
      const next = staged.waves.find(id => straight.has(id));
      if (next !== undefined) found.set(next, 'crowds');
      return found;
    },
  };
});

const run = (path: string): Promise<LayoutModel> =>
  layout(parse(readFileSync(new URL(path, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const BLOCK = '../../goldens/synthetic/a-solid-block-keeps-the-box-corner-margin.yaml';
const g6 = (model: LayoutModel): string[] => (score(model).snapshot.gates['G6']?.violations ?? []).map(item => [...(item.elements ?? [])].join('/'));

describe('the 7f crowding retry and the publication step behind it (dense-16x9 ticket 28)', () => {
  // Sweep variant v7-1-1: a 7f retry refuses the direct member link-2 as `crowds`. With a bound of 0, 7f gives up at once and names it
  // (`DIRECT_FAMILY_CROWDED`); the publication step then refuses it through the ledger, and the replay falls back as the retry would have.
  it('a direct member that the retry gave up on is refused once, through the ledger', async () => {
    staged.bound = 0;
    try {
      const model = await run('../fixtures/sweep/v7-1-1.yaml');
      expect(refusedChordsOf(model.reservations ?? [])).toEqual(['link-2']);
      expect(model.frozenChords ?? []).not.toContain('link-2');
      const member = (model.directFamilies ?? []).flatMap(family => family.members).find(item => item.link === 'link-2');
      expect(member).toMatchObject({ mode: 'orthogonal', reason: 'crowds' });
      expect(model.diagnostics.some(item => item.code === 'HELD_CHORD_CROWDED')).toBe(false);
      expect(g6(model)).toEqual([]);
      expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    } finally { staged.bound = undefined; }
  }, 120000);

  // Three waves of crowding in one solid block: the retry needs three runs and refuses each member alone; the sheet settles with no G6. With the
  // old bound of 2 (60078aba) the third member stayed straight and FAN_MEMBER_CROWDED named it.
  it('the 7f retry runs until no new member is crowded (three retries)', async () => {
    const plain = await run(BLOCK);
    const straight = (plain.fanAdmissions ?? []).filter(item => item.mode === 'straight' && plain.frozenChords?.includes(item.link)).map(item => item.link);
    expect(straight.length).toBeGreaterThanOrEqual(3);
    staged.waves = straight.slice(0, 3);
    resetAttemptCounters();
    try {
      const model = await run(BLOCK);
      expect(model.diagnostics.filter(item => item.code === 'FAN_MEMBER_CROWDED' || item.code === 'HELD_CHORD_CROWDED').map(item => item.code)).toEqual([]);
      expect(attemptCounters.crowdRetries).toBeGreaterThanOrEqual(3);
      for (const id of staged.waves) expect(model.frozenChords ?? []).not.toContain(id);
      for (const id of straight.slice(3)) expect(model.frozenChords ?? []).toContain(id);
      expect(g6(model)).toEqual([]);
      expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    } finally { staged.waves = []; }
  }, 120000);

  // A forged state to publish: a straight solid-block member gets a foreign path 3 px beside it, under the G6 clearance. The reader of the
  // publication step names it, as the 7f retry's reader does (`crowdedFanMembers`, R1); before ticket 28 it skipped every member.
  it('names a straight solid-block member that a reserved segment crowds', async () => {
    const model = await run(BLOCK);
    const member = (model.fanAdmissions ?? []).find(item => item.mode === 'straight' && model.frozenChords?.includes(item.link))!;
    expect(member).toBeDefined();
    expect(crowdedHeldChords(model)).toEqual([]);
    const chord = model.links.find(link => link.id === member.link)!.path!.segments[0]!;
    const other = model.links.find(link => link.id !== member.link && link.path !== undefined)!;
    const shift = { x: 3, y: 0 };
    const forged: LayoutModel = { ...model, links: model.links.map(link => link.id !== other.id ? link : { ...link, path: { ...link.path!, segments: [
      { ...link.path!.segments[0]!, from: { x: chord.from.x + shift.x, y: chord.from.y + shift.y }, to: { x: chord.to.x + shift.x, y: chord.to.y + shift.y } },
    ] } }) };
    expect(crowdedHeldChords(forged)).toContain(member.link);
  }, 120000);
});
