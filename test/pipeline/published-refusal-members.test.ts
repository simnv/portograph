import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { crowdedHeldChords } from '../../src/layout/direct-families.js';
import { refusedChordsOf } from '../../src/layout/reservations.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 28: the publication step (`refuseCrowdedChords`) refuses every held chord that would be published under the G6 clearance,
 * the direct, fan and solid-block members included, as the last resort after the 7f retry gave up. Measured case (outside sheet, ticket 27
 * branch): a solid-block member stayed straight after `DIRECT_RETRIES` retries (`FAN_MEMBER_CROWDED`) and was published with a G6 finding
 * against a planned part, because the step skipped every member. No corpus sheet on main lets the retry give up, so the tests stage it:
 * the retry gives up at once (`DIRECT_RETRIES` 0), or the state to publish is forged.
 */
const retries = vi.hoisted(() => ({ value: 2 }));
vi.mock('../../src/layout/direct-families.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/direct-families.js')>();
  return { ...actual, get DIRECT_RETRIES() { return retries.value; } };
});

const run = (path: string): Promise<LayoutModel> =>
  layout(parse(readFileSync(new URL(path, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const g6 = (model: LayoutModel): string[] => (score(model).snapshot.gates['G6']?.violations ?? []).map(item => [...(item.elements ?? [])].join('/'));

describe('the publication step refuses a crowded member after the 7f retry gave up (dense-16x9 ticket 28)', () => {
  // Sweep variant v7-1-1: a 7f retry refuses the direct member link-2 as `crowds`. With no retry, 7f gives up at once and names it
  // (`DIRECT_FAMILY_CROWDED`); the publication step then refuses it through the ledger, and the replay falls back as the retry would have.
  it('a direct member that the retry gave up on is refused once, through the ledger', async () => {
    retries.value = 0;
    try {
      const model = await run('../fixtures/sweep/v7-1-1.yaml');
      expect(refusedChordsOf(model.reservations ?? [])).toEqual(['link-2']);
      expect(model.frozenChords ?? []).not.toContain('link-2');
      const member = (model.directFamilies ?? []).flatMap(family => family.members).find(item => item.link === 'link-2');
      expect(member).toMatchObject({ mode: 'orthogonal', reason: 'crowds' });
      expect(model.diagnostics.some(item => item.code === 'HELD_CHORD_CROWDED')).toBe(false);
      expect(g6(model)).toEqual([]);
      expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    } finally { retries.value = 2; }
  }, 120000);

  // A forged state to publish: a straight solid-block member gets a foreign path 3 px beside it, under the G6 clearance. The reader of the
  // publication step names it, as the 7f retry's reader does (`crowdedFanMembers`, R1); before ticket 28 it skipped every member.
  it('names a straight solid-block member that a reserved segment crowds', async () => {
    const model = await run('../../goldens/synthetic/a-solid-block-keeps-the-box-corner-margin.yaml');
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
