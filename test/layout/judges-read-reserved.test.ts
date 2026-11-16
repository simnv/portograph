import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { crowdedDirectMembers } from '../../src/layout/direct-families.js';
import { chordGapNotes, heldChordsIn, tierGapPlans } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { findPort } from '../../src/layout/row-paths.js';
import { preRoute } from '../../src/route/validate.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * The chord crowding retry and the chord notes read every segment reserved for a final path (dense-16x9 ticket 14, slice 2). The state: the published layout of
 * a-refused-close-up-of-card-nodes-keeps-the-node-labels-in-order seen as stage 8 receives it (`preRoute`): link-21 is a held vertical chord, and
 * link-22 a remainder (no path) whose source stem and planned part rise beside it, 12 px off (10.5 px after the strokes). Moved so that the stem
 * stands 9 px off (7.5 px), the pair is a G6 finding on the reserved geometry, which the stored paths alone do not show: link-22 has no path.
 */
describe('the crowding retry and the chord notes read every reserved segment (dense-16x9 ticket 14, slice 2)', () => {
  let view: LayoutModel, near: LayoutModel;
  beforeAll(async () => {
    const source = readFileSync(new URL('../../goldens/synthetic/a-refused-close-up-of-card-nodes-keeps-the-node-labels-in-order.yaml', import.meta.url), 'utf8');
    view = preRoute(await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
    near = structuredClone(view);
    const chord = near.links.find(link => link.id === 'link-21')!, port = findPort(near, near.links.find(link => link.id === 'link-22')!.attachments!.from)!;
    port.anchor = { ...port.anchor!, x: chord.path!.segments[0]!.from.x + 9 };
  }, 60000);

  it('reads the state: a held chord, and a remainder beside it with no path', () => {
    const chord = view.links.find(link => link.id === 'link-21')!, remainder = view.links.find(link => link.id === 'link-22')!;
    expect(chord.path?.segments).toHaveLength(1);
    expect(remainder.path).toBeUndefined();
    expect(findPort(view, remainder.attachments!.from)!.anchor!.x - chord.path!.segments[0]!.from.x).toBeCloseTo(12, 6);
  });

  it('the crowding retry names a direct member beside a remainder\'s reserved stem', () => {
    const family = (model: LayoutModel): LayoutModel => ({ ...model, directFamilies: [{ id: 'f', members: [{ link: 'link-21', mode: 'direct' }] }] }) as unknown as LayoutModel;
    expect(crowdedDirectMembers(family(view))).toEqual([]);
    expect(crowdedDirectMembers(family(near))).toEqual(['link-21']);
  });

  it('the chord notes name the planned link beside a held chord of its gap', () => {
    const named = (model: LayoutModel): boolean => chordGapNotes(model, tierGapPlans(model))
      .some(note => note.code === 'TIER_GAP_CHORD_CROWDED' && JSON.stringify(note.owners) === JSON.stringify([{ kind: 'link', id: 'link-22' }, { kind: 'link', id: 'link-21' }]));
    expect(tierGaps(view).some(gap => heldChordsIn(view, gap).some(item => item.link.id === 'link-21'))).toBe(true);
    expect(named(view)).toBe(false);
    expect(named(near)).toBe(true);
  });
});
