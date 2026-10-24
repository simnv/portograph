import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { directFamiliesFault, planDirectFamilies, triggers } from '../../src/layout/direct-families.js';
import { chordVerdict, flatPerpendicularChord, PERPENDICULAR_FLAT_ANGLE, perpendicularRefusalsFault, SIDE_EDGE_SLACK } from '../../src/layout/frame-paths.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture 2 ticket 22 (docs/design/routed-chords.md, Section 15): facing units link direct, and a long chord never joins perpendicular faces. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// Six links from four sources to a row that cross when drawn orthogonal; the fixed point alone refuses five of their chords for each other's legs.
const DIRECT = 'a-port-facing-away-from-a-tier-gap-is-left-to-the-router';
const LATERAL = 'a-location-router-leaves-a-lateral-side-toward-a-far-provider';
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const ends = (model: LayoutModel, id: string): string => {
  const link = model.links.find(item => item.id === id)!;
  return [link.attachments!.from.node, link.attachments!.to.node].sort().join('~');
};
/** The direct and the refused members, named by their end nodes (link ids and directions differ between the inputs). */
const verdicts = (model: LayoutModel): string[] => (model.directFamilies ?? [])
  .flatMap(family => family.members.map(member => `${ends(model, member.link)} ${member.mode}${member.reason ? ` ${member.reason}` : ''}`)).sort();
const family = (model: LayoutModel, id: string) => model.directFamilies!.find(item => item.id === id)!;

describe('the trigger', () => {
  it('triggers only on more than one crossing or more than one inversion', () => {
    expect(triggers(1, 1)).toBe(false);
    expect(triggers(2, 0)).toBe(true);
    expect(triggers(0, 2)).toBe(true);
    expect(triggers('unresolved', 1)).toBe(false);
  });
});

describe('facing units link direct', () => {
  it('decides the fans together where the fixed point refuses each chord for the legs of the others', async () => {
    const model = await run(fixture(DIRECT));
    expect(model.directFamilies!.map(item => item.id)).toEqual(['node:r0>node:s1', 'node:r1>row:access', 'node:r2>row:access', 'node:r3>node:s1']);
    for (const item of model.directFamilies!) expect(item.triggered).toBe(true);
    // Five of the six members are chords; the last one keeps its leg reason. The fixed point alone held one chord here (bends 14 before, 6 now).
    expect(verdicts(model).filter(item => item.endsWith(' direct'))).toHaveLength(5);
    expect(family(model, 'node:r1>row:access').members.find(member => member.mode === 'orthogonal')?.reason).toBe('leg');
    for (const id of model.directFamilies!.flatMap(item => item.members.filter(member => member.mode === 'direct').map(member => member.link))) {
      expect(model.links.find(link => link.id === id)!.path!.segments).toHaveLength(1);
    }
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
    expect(flipped.directFamilies!.map(item => item.id)).toEqual(plain.directFamilies!.map(item => item.id));
    expect(flipped.directFamilies!.map(item => [item.crossings, item.inversions])).toEqual(plain.directFamilies!.map(item => [item.crossings, item.inversions]));
    expect(verdicts(flipped)).toEqual(verdicts(plain));
  }, 120000);

  it('restores the record with the layout, and refuses a forged record (R5)', async () => {
    const model = await run(fixture(DIRECT));
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.directFamilies).toEqual(model.directFamilies);
    expect(() => validateGroupLabelBands(restored)).not.toThrow();
    const one = model.directFamilies!.findIndex(item => item.id === 'node:r1>row:access'), other = model.directFamilies!.findIndex(item => item.id === 'node:r2>row:access');
    const direct = model.directFamilies![one]!.members.findIndex(member => member.mode === 'direct');
    const refusedAt = model.directFamilies![one]!.members.findIndex(member => member.mode === 'orthogonal');
    const forge = (change: (copy: LayoutModel) => void): LayoutModel => { const copy = structuredClone(model); change(copy); return copy; };
    const forgeries: [LayoutModel, RegExp][] = [
      // A direct member that holds no chord, and a refused member that does.
      [forge(copy => { copy.frozenChords = copy.frozenChords!.filter(id => id !== copy.directFamilies![one]!.members[direct]!.link); }), /holds no frozen chord/],
      [forge(copy => { copy.frozenChords = [...copy.frozenChords!, copy.directFamilies![one]!.members[refusedAt]!.link]; }), /holds a chord its family refused/],
      // A trigger its counts do not give.
      [forge(copy => { copy.directFamilies![one]!.crossings = 1; copy.directFamilies![one]!.inversions = 0; }), /without a trigger/],
      // A link the model does not have, a member of two families, a refused member with no reason, an unplanned member.
      [forge(copy => { copy.directFamilies![one]!.members[direct]!.link = 'link-99'; }), /not a link of the model/],
      [forge(copy => { copy.directFamilies![other]!.members.push({ ...copy.directFamilies![one]!.members[direct]! }); }), /member of two families/],
      [forge(copy => { delete copy.directFamilies![one]!.members[refusedAt]!.reason; }), /refused with no reason/],
      [forge(copy => { copy.directFamilies![one]!.members[refusedAt]!.mode = 'unplanned'; }), /unplanned/],
      // A record before the freeze.
      [forge(copy => { delete copy.frozenChords; }), /before the freeze/],
    ];
    for (const [forged, why] of forgeries) expect(() => validateGroupLabelBands(forged)).toThrow(why);
    // Absent is no family: a model with no record validates.
    const none = forge(copy => { delete copy.directFamilies; copy.frozenChords = copy.frozenChords!.filter(id => !model.directFamilies!.some(item => item.members.some(member => member.link === id))); });
    expect(directFamiliesFault(none)).toBeUndefined();
  }, 120000);
});

describe('a long, flat chord never joins perpendicular faces (ticket 22, rule 5)', () => {
  const lateral = async () => {
    const model = await run(fixture(LATERAL));
    const link = model.links.find(item => item.attachments!.from.node === 'west-router' && item.attachments!.to.node === 'provider')!;
    return { model, link };
  };
  it('draws the long, flat bottom-to-lateral link as an L, and after the freeze reads the record, not the geometry', async () => {
    const { model, link } = await lateral();
    expect(link.technique).not.toBe('straight');
    expect(link.path!.segments.length).toBeGreaterThan(1);
    // The side round refused the chord hint before placement; at the freeze the link has a lane, so the freeze records nothing (absent).
    expect(model.perpendicularRefusals).toBeUndefined();
    const before = structuredClone(model);
    delete before.frozenChords;
    expect(flatPerpendicularChord(before, link)).toBe(true);
    expect(chordVerdict(before, link, SIDE_EDGE_SLACK)).toEqual({ reason: 'faces' });
    expect(flatPerpendicularChord({ ...model, perpendicularRefusals: [link.id] }, link)).toBe(true);
    const east = model.links.find(item => item.attachments!.from.node === 'east-router' && item.attachments!.to.node === 'provider')!;
    expect(east.technique).toBe('straight');
    // The record answers after the freeze (R1): an absent record refuses nothing, whatever the geometry says.
    expect(flatPerpendicularChord(model, link)).toBe(false);
  }, 120000);

  it('before the freeze, leaves a short or a steep perpendicular chord to the other chord rules', async () => {
    const { model, link } = await lateral();
    const router = model.nodes['west-router']!, provider = model.nodes['provider']!, end = link.attachments!.to;
    const from = router.ports.find(port => port.side === 'bottom')!.anchor!;
    const moved = (dx: number, dy: number): LayoutModel => {
      const copy = structuredClone(model);
      delete copy.perpendicularRefusals; delete copy.frozenChords;
      copy.nodes['provider']!.ports = provider.ports.map(port => port.ref.ordinal === end.ordinal && (port.ref.name ?? null) === (end.name ?? null)
        ? { ...port, side: 'right' as const, anchor: { x: from.x + dx, y: from.y + dy } } : port);
      return copy;
    };
    const limit = 2 * Math.max(router.bounds!.width, router.bounds!.height);
    // Short: 60 x 100 px, far under the limit. Steep: as long as the limit and more, 60 degrees from the normal. Flat: 85 degrees.
    expect(flatPerpendicularChord(moved(60, 100), link)).toBe(false);
    const at = (degrees: number, length: number): [number, number] => [length * Math.sin(degrees * Math.PI / 180), length * Math.cos(degrees * Math.PI / 180)];
    expect(flatPerpendicularChord(moved(...at(60, limit * 1.5)), link)).toBe(false);
    expect(flatPerpendicularChord(moved(...at(85, limit * 1.5)), link)).toBe(true);
    expect(PERPENDICULAR_FLAT_ANGLE).toBe(80);
  }, 120000);

  it('refuses a forged record (R5)', async () => {
    const { model, link } = await lateral();
    const east = model.links.find(item => item.attachments!.from.node === 'east-router' && item.attachments!.to.node === 'provider')!;
    expect(() => validateGroupLabelBands(model)).not.toThrow();
    for (const [forged, why] of [
      [{ ...model, perpendicularRefusals: ['link-99'] }, /not a link of the model/],
      [{ ...model, perpendicularRefusals: [east.id] }, /holds a chord its perpendicular faces refused/],
      [{ ...model, frozenChords: [], perpendicularRefusals: model.links.filter(item => item.attachments!.from.node === 'west-core').map(item => item.id) }, /does not join perpendicular faces/],
    ] as [LayoutModel, RegExp][]) expect(() => validateGroupLabelBands(forged)).toThrow(why);
    const early = structuredClone(model);
    delete early.frozenChords; early.perpendicularRefusals = [link.id];
    expect(perpendicularRefusalsFault(early)).toMatch(/before the freeze/);
    expect(perpendicularRefusalsFault({ ...model, perpendicularRefusals: [link.id] })).toBeUndefined();
  }, 120000);
});
