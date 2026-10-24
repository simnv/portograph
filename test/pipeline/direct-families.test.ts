import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { directFamiliesFault, planDirectFamilies, triggers } from '../../src/layout/direct-families.js';
import { chordVerdict, fixedPointRefusal, flatPerpendicularChord, isRoutedChord, PERPENDICULAR_FLAT_ANGLE, SIDE_EDGE_SLACK } from '../../src/layout/frame-paths.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { findPort } from '../../src/layout/row-paths.js';
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

  it('refuses a held chord the decision did not judge when it stands within clearance of a refused member\'s new leg (review B1)', async () => {
    const model = await run(fixture(DIRECT));
    const draft = structuredClone(model);
    delete draft.frozenChords; delete draft.directFamilies;
    // A labelled link is no family member, so the decision does not judge its chord: r2 to s0 crosses the leg r1 to s3 keeps at r1.
    const labelled = draft.links.find(link => link.attachments!.from.node === 'r2' && link.attachments!.to.node === 's0')!;
    draft.document.links[labelled.sourceIndex]!.label = 'a labelled chord';
    expect(isRoutedChord(draft, labelled)).toBe(true);
    planDirectFamilies(draft);
    const refusedLeg = draft.links.find(link => link.attachments!.from.node === 'r1' && link.attachments!.to.node === 's3')!;
    expect(isRoutedChord(draft, refusedLeg)).toBe(false);
    // The labelled chord fails the fixed point beside the new leg, so it is refused and stays orthogonal.
    expect(isRoutedChord(draft, labelled)).toBe(false);
    // No held chord stands within clearance of the leg of an orthogonal member: every one passes the fixed point.
    const crossable = (id: string): Set<string> | undefined => {
      const owner = draft.directFamilies?.find(family => family.members.some(member => member.link === id));
      return owner === undefined ? undefined : new Set(draft.directFamilies!.filter(family => family !== owner && family.gap.above === owner.gap.above)
        .flatMap(family => family.members.map(member => member.link)));
    };
    for (const chord of draft.links.filter(link => isRoutedChord(draft, link))) {
      expect(fixedPointRefusal(draft, chord, chord.path!.segments[0]!, undefined, crossable(chord.id)), chord.id).toBeUndefined();
    }
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
      // A witness its crossings do not count, and a member link between the units left out of the record (review item 7).
      [forge(copy => { copy.directFamilies![one]!.witnesses.push({ links: ['link-1', 'link-2'], at: { x: 0, y: 0 } }); }), /witnesses for/],
      [forge(copy => { copy.directFamilies![one]!.members.splice(refusedAt, 1); }), /leaves out/],
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
  it('draws the long, flat bottom-to-lateral link as an L, and after the freeze the held chords are the decision', async () => {
    const { model, link } = await lateral();
    expect(link.technique).not.toBe('straight');
    expect(link.path!.segments.length).toBeGreaterThan(1);
    const before = structuredClone(model);
    delete before.frozenChords;
    expect(flatPerpendicularChord(before, link)).toBe(true);
    expect(chordVerdict(before, link, SIDE_EDGE_SLACK)).toEqual({ reason: 'faces' });
    const east = model.links.find(item => item.attachments!.from.node === 'east-router' && item.attachments!.to.node === 'provider')!;
    expect(east.technique).toBe('straight');
    // From the freeze on the rule refuses nothing, whatever the geometry says (R1: the frozen chords are the decision).
    expect(flatPerpendicularChord(model, link)).toBe(false);
  }, 120000);

  it('before the freeze, leaves a short or a steep perpendicular chord to the other chord rules', async () => {
    const { model, link } = await lateral();
    const router = model.nodes['west-router']!, provider = model.nodes['provider']!, end = link.attachments!.to;
    const from = router.ports.find(port => port.side === 'bottom')!.anchor!;
    const moved = (dx: number, dy: number): LayoutModel => {
      const copy = structuredClone(model);
      delete copy.frozenChords;
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

});

describe('a crowded sheet after the user review of a-chord-hint (ticket 22, user 2026-10-24)', () => {
  it('pulls lb next to fe4, draws every front link direct with its label clear of the borders, and brings the provider runs to one row', async () => {
    const model = await run(fixture('a-chord-hint-and-a-lane-hint-never-share-a-batch'));
    // Declaration order is a hint: the far-end pull stands lb next to fe4, so its link and the fan to spare are all chords.
    expect(model.groups.front!.rowOrderDecision!.after.slice(0, 5)).toEqual(['fe', 'fe2', 'fe3', 'fe4', 'lb']);
    const front = model.links.filter(link => model.document.nodes[link.attachments!.from.node]!.group === 'front');
    expect(front.map(link => link.technique)).toEqual(['straight', 'straight', 'straight', 'straight', 'straight']);
    // lb's label lies on its chord, turned, and 7f grew the tier gap until one window between the borders holds it.
    const lb = front.find(link => link.attachments!.from.node === 'lb')!;
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED')
      .filter(item => item.message.includes(`${lb.id} `))).toEqual([]);
    // The two dashed runs come to the provider's top face from opposite sides and share one horizontal height.
    const flat = (link: LayoutModel['links'][number]): number => link.path!.segments.find(item => Math.abs(item.from.y - item.to.y) < 1e-6)!.from.y;
    const rows = model.links.filter(link => link.attachments!.to.node === 'provider').map(flat);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeCloseTo(rows[1]!, 6);
  }, 120000);
});

describe('the ticket 22 fixtures (review item 12)', () => {
  const flat = (link: LayoutModel['links'][number]): number => link.path!.segments.find(item => Math.abs(item.from.y - item.to.y) < 1e-6)!.from.y;
  const to = (model: LayoutModel, from: string, end: string) => model.links.find(link => link.attachments!.from.node === from && link.attachments!.to.node === end)!;

  it('a long, flat chord to a lateral face is an L with one bend; the bottom-to-top chord stays', async () => {
    const model = await run(fixture('a-long-flat-chord-to-a-lateral-face-is-an-l'));
    const west = to(model, 'west-router', 'provider'), east = to(model, 'east-router', 'provider');
    expect(west.technique).not.toBe('straight');
    expect(findPort(model, west.attachments!.to)?.side).toBe('right');
    expect(score(model).snapshot.counts.routed.turns).toBe(1);
    expect(east.technique).toBe('straight');
  }, 120000);

  it('two runs from opposite sides of the provider\'s top face share one row', async () => {
    const model = await run(fixture('runs-from-opposite-sides-share-one-row'));
    const rows = ['west-router', 'east-router'].map(from => flat(to(model, from, 'provider')));
    expect(rows[0]).toBeCloseTo(rows[1]!, 6);
  }, 120000);

  it('the label of a held chord lies on its chord, clear of every group border', async () => {
    const model = await run(fixture('a-label-on-a-held-chord-gets-room-in-its-tier-gap'));
    const labelled = to(model, 'r3', 's1');
    expect(labelled.technique).toBe('straight');
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER')).toEqual([]);
    expect(score(model).snapshot.counters.labelBorderCrossings).toBeUndefined();
  }, 120000);

  it('facing rows link direct as four families, every member a chord', async () => {
    const model = await run(fixture('facing-rows-link-direct-as-families'));
    expect(model.directFamilies!.map(item => item.id)).toEqual(['node:r0>node:s1', 'node:r1>row:access', 'node:r2>row:access', 'node:r3>node:s1']);
    expect(verdicts(model).every(item => item.endsWith(' direct'))).toBe(true);
    expect(directFamiliesFault(model)).toBeUndefined();
  }, 120000);
});
