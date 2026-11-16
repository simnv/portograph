import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { crowdedDirectMembers, planDirectFamilies } from '../../src/layout/direct-families.js';
import { chordGapNotes, heldChordsIn, tierGapPlans } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { preRoute } from '../../src/route/validate.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/**
 * The chord crowding retry and the chord notes read every segment reserved for a final path (dense-16x9 ticket 14, slice 2). Both cases fail on
 * main 90414fcc: its crowding reader read the planned parts of the member's gap, their stems matched by x and the other chords, and its notes read
 * only a chord across the whole gap and only the verticals of a planned part.
 */
describe('the crowding retry and the chord notes read every reserved segment (dense-16x9 ticket 14, slice 2)', () => {
  it('refuses a direct member beside a lane run of a remainder, which the old reader did not read (a behaviour change of the retry)', async () => {
    // The published layout of a-port-facing-away-from-a-tier-gap-is-left-to-the-router with `corridorRowOrder: false`, seen as stage 8 receives it,
    // with its own direct-family records (complete: the members, their modes, the family's gap). A plan-level state: the remainder link-2 is given
    // a lane run in the open tier gap, 5 px right of the middle of a direct member's chord (the producer, the lanes rule, did not seat one there).
    const yaml = sheet('a-port-facing-away-from-a-tier-gap-is-left-to-the-router').replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n');
    const view = preRoute(await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
    const direct = (view.directFamilies ?? []).flatMap(family => family.members.filter(member => member.mode === 'direct').map(member => member.link));
    expect(direct.length).toBeGreaterThan(0);
    expect(view.directFamilies!.every(family => family.gap !== undefined)).toBe(true);
    expect(crowdedDirectMembers(view)).toEqual([]);
    const near = structuredClone(view), chord = near.links.find(link => link.id === direct[0])!.path!.segments[0]!;
    const remainder = near.links.find(link => link.id === 'link-2')!;
    expect(remainder.path).toBeUndefined();
    const x = (chord.from.x + chord.to.x) / 2 + 5, y = (chord.from.y + chord.to.y) / 2;
    remainder.fixedSegments = [{ from: { x, y }, to: { x, y: y + 3 }, owner: { kind: 'link', id: 'link-2' }, lane: 'test-lane' }];
    const refused = crowdedDirectMembers(near);
    expect(refused).toContain(direct[0]);
    // The retry refuses them: the family records each `orthogonal`, reason `crowds`, where it held the chord before.
    const replay = structuredClone(view);
    planDirectFamilies(replay, new Map(refused.map(id => [id, 'crowds' as const])));
    expect(replay.directFamilies!.flatMap(family => family.members).filter(member => refused.includes(member.link)).map(member => `${member.mode}/${member.reason}`))
      .toEqual(refused.map(() => 'orthogonal/crowds'));
  }, 60000);

  it('names a planned part beside a held chord that ends in its gap, which the old notes did not read', () => {
    // test/fixtures/staged/a-z-middle-drop-beside-a-chord-tip.json: the held chord link-11 ends on a pill face inside the gap, beside the middle drop of
    // link-15. The plans are read without link-11 held, so the middle drop stays where the dodge would move it from: 7.5 px from the chord.
    const model = JSON.parse(readFileSync(new URL('../fixtures/staged/a-z-middle-drop-beside-a-chord-tip.json', import.meta.url), 'utf8')) as LayoutModel;
    const gap = tierGaps(model).find(item => heldChordsIn(model, item).some(chord => chord.link.id === 'link-11'))!;
    expect(heldChordsIn(model, gap).find(chord => chord.link.id === 'link-11')!.across).toBe(false);
    const unheld = { ...model, frozenChords: model.frozenChords!.filter(id => id !== 'link-11') };
    const notes = chordGapNotes(model, tierGapPlans(unheld)).filter(note => note.code === 'TIER_GAP_CHORD_CROWDED');
    expect(notes.map(note => note.owners)).toContainEqual([{ kind: 'link', id: 'link-15' }, { kind: 'link', id: 'link-11' }]);
  });
});
