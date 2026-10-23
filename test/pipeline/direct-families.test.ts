import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { DIRECT_GAP_CAP, DIRECT_MIN_SLOPE, directFamiliesFault, planDirectFamilies, steepEnough, triggers } from '../../src/layout/direct-families.js';
import { chordVerdict, SIDE_EDGE_SLACK } from '../../src/layout/frame-paths.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture 2 ticket 22, slice 1 (docs/design/routed-chords.md, Section 15): facing units link direct. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const DIRECT = 'a-node-facing-a-row-links-direct';
const LATERAL = 'a-location-router-leaves-a-lateral-side-toward-a-far-provider';
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const ends = (model: LayoutModel, id: string): string => {
  const link = model.links.find(item => item.id === id)!;
  return [link.attachments!.from.node, link.attachments!.to.node].sort().join('~');
};
/** The direct and the refused members, named by their end nodes (link ids and directions differ between the inputs). */
const verdicts = (model: LayoutModel): string[] => (model.directFamilies ?? [])
  .flatMap(family => family.members.map(member => `${ends(model, member.link)} ${member.mode}${member.reason ? ` ${member.reason}` : ''}`)).sort();
const point = (x: number, y: number) => ({ x, y });

describe('the 30 degree floor', () => {
  it('holds a chord at exactly 30 degrees and refuses one a hair flatter; the reserved growth counts', () => {
    expect(DIRECT_MIN_SLOPE).toBeCloseTo(Math.tan(Math.PI / 6), 12);
    const dy = 40, dx = dy * Math.sqrt(3);
    expect(steepEnough({ from: point(0, 0), to: point(dx, dy) })).toBe(true);
    expect(steepEnough({ from: point(dx, 0), to: point(0, dy) })).toBe(true);
    expect(steepEnough({ from: point(0, 0), to: point(dx + 0.01, dy) })).toBe(false);
    expect(steepEnough({ from: point(0, 0), to: point(dx + 0.01, dy) }, 0.01)).toBe(true);
  });

  it('triggers only on more than one crossing or more than one inversion', () => {
    expect(triggers(1, 1)).toBe(false);
    expect(triggers(2, 0)).toBe(true);
    expect(triggers(0, 2)).toBe(true);
    expect(triggers('unresolved', 1)).toBe(false);
  });
});

describe('a node facing a row links direct', () => {
  it('draws the fan of the source node direct and in peer order on a reserved gap, and records why the other fan stays orthogonal', async () => {
    const model = await run(fixture(DIRECT));
    const families = model.directFamilies!;
    expect(families.map(family => family.id)).toEqual(['node:hub>row:edge', 'node:peer>row:edge']);
    for (const family of families) expect(family.triggered && family.crossings !== 'unresolved' && family.crossings > 1).toBe(true);
    const [hub, peer] = families as [NonNullable<LayoutModel['directFamilies']>[number], NonNullable<LayoutModel['directFamilies']>[number]];
    expect(hub.members.map(member => member.mode)).toEqual(['direct', 'direct', 'direct', 'direct']);
    expect(peer.members.every(member => member.mode === 'orthogonal' && member.reason !== undefined)).toBe(true);
    // The growth is reserved in placement, under the cap, and the gap holds it (R2).
    expect(hub.growth).toBeGreaterThan(0);
    expect(hub.height).toBeLessThanOrEqual(DIRECT_GAP_CAP * 60);
    expect(model.diagnostics.map(item => item.code)).toContain('DIRECT_FAMILY_GAP_RESERVED');
    // Every direct member is one straight segment at 30 degrees or steeper, and the fan keeps the order of its peers.
    const chords = hub.members.map(member => model.links.find(link => link.id === member.link)!);
    for (const link of chords) {
      expect(link.path!.segments).toHaveLength(1);
      expect(steepEnough(link.path!.segments[0]!)).toBe(true);
    }
    const lower = chords.map(link => link.path!.segments[0]!.to.x);
    expect([...lower].sort((a, b) => a - b)).toEqual(lower);
    expect(directFamiliesFault(model)).toBeUndefined();
    expect(() => validateGroupLabelBands(model)).not.toThrow();
  }, 120000);

  // The input order of a whole sheet moves ELK's placement, so R3 is read on the decision itself: one placed model, its links listed in reverse
  // and each drawn the other way round, gives the same families and the same verdicts.
  it('links listed in reverse and drawn the other way round give the same families and the same verdicts (R3)', async () => {
    const model = await run(fixture(DIRECT));
    const draft = (flip: boolean): LayoutModel => {
      const copy = structuredClone(model);
      delete copy.frozenChords; delete copy.directFamilies;
      if (flip) {
        copy.links.reverse();
        for (const link of copy.links) link.attachments = { from: link.attachments!.to, to: link.attachments!.from };
      }
      planDirectFamilies(copy);
      return copy;
    };
    const plain = draft(false), flipped = draft(true);
    expect(plain.directFamilies!.length).toBeGreaterThan(0);
    expect(flipped.directFamilies!.map(family => family.id)).toEqual(plain.directFamilies!.map(family => family.id));
    expect(flipped.directFamilies!.map(family => [family.crossings, family.inversions, family.growth])).toEqual(plain.directFamilies!.map(family => [family.crossings, family.inversions, family.growth]));
    expect(verdicts(plain).filter(item => item.endsWith(' direct'))).toHaveLength(4);
    expect(verdicts(flipped)).toEqual(verdicts(plain));
  }, 120000);

  it('restores the record with the layout, and refuses a forged record (R5)', async () => {
    const model = await run(fixture(DIRECT));
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.directFamilies).toEqual(model.directFamilies);
    expect(() => validateGroupLabelBands(restored)).not.toThrow();
    const hub = 0, peer = 1;
    const forge = (change: (copy: LayoutModel) => void): LayoutModel => { const copy = structuredClone(model); change(copy); return copy; };
    const forgeries: [LayoutModel, RegExp][] = [
      // A direct member that holds no chord, and a refused member that does.
      [forge(copy => { copy.frozenChords = copy.frozenChords!.filter(id => id !== copy.directFamilies![hub]!.members[0]!.link); }), /holds no frozen chord/],
      [forge(copy => { copy.frozenChords = [...copy.frozenChords!, copy.directFamilies![peer]!.members[0]!.link]; }), /holds a chord its family refused/],
      // A trigger its counts do not give, and a growth over the cap.
      [forge(copy => { copy.directFamilies![hub]!.crossings = 1; copy.directFamilies![hub]!.inversions = 0; }), /without a trigger/],
      [forge(copy => { copy.directFamilies![hub]!.height = 10_000; }), /reserves a gap/],
      // A link the model does not have, a member of two families, a refused member with no reason, an unplanned member.
      [forge(copy => { copy.directFamilies![hub]!.members[0]!.link = 'link-99'; }), /not a link of the model/],
      [forge(copy => { copy.directFamilies![peer]!.members.push({ ...copy.directFamilies![hub]!.members[0]! }); }), /member of two families/],
      [forge(copy => { delete copy.directFamilies![peer]!.members[0]!.reason; }), /refused with no reason/],
      [forge(copy => { copy.directFamilies![peer]!.members[0]!.mode = 'unplanned'; }), /unplanned/],
      // A record before the freeze.
      [forge(copy => { delete copy.frozenChords; }), /before the freeze/],
    ];
    for (const [forged, why] of forgeries) expect(() => validateGroupLabelBands(forged)).toThrow(why);
    // Absent is no family: a model with no record validates.
    const none = forge(copy => { delete copy.directFamilies; copy.frozenChords = copy.frozenChords!.filter(id => !model.directFamilies!.some(family => family.members.some(member => member.link === id))); });
    expect(directFamiliesFault(none)).toBeUndefined();
  }, 120000);
});

describe('a chord joins opposite faces only (ticket 22, rule 5)', () => {
  it('draws the bottom-to-lateral link as an L, and chordVerdict names the faces', async () => {
    const model = await run(fixture(LATERAL));
    const link = model.links.find(item => item.attachments!.from.node === 'west-router' && item.attachments!.to.node === 'provider')!;
    expect(link.technique).not.toBe('straight');
    expect(link.path!.segments.length).toBeGreaterThan(1);
    expect(chordVerdict(model, link, SIDE_EDGE_SLACK)).toEqual({ reason: 'faces' });
    const east = model.links.find(item => item.attachments!.from.node === 'east-router' && item.attachments!.to.node === 'provider')!;
    expect(east.technique).toBe('straight');
  }, 120000);
});
