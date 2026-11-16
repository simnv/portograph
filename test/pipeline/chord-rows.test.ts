import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { fixedPointRefusal, isRoutedChord, legSiblings } from '../../src/layout/frame-paths.js';
import { lineOf } from '../../src/layout/read/stagger.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { withLayoutEntry } from '../aspect-fixture.js';

// Dense-16x9 ticket 03, slice C: a leaf row whose members have several links stands on two lines with compact hubs and routed chords.
const CONTIGUOUS = 'a-member-with-several-links-stands-on-the-near-line';
const INTERLEAVED = 'a-row-whose-hub-runs-interleave-takes-compact-hubs';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const leafLinks = (model: LayoutModel) => model.links.filter(link => link.attachments!.from.node.startsWith('leaf-'));
const failedGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const withMove = (yaml: string): string => /^layout: \{ (.*) \}$/m.test(yaml)
  ? yaml.replace(/^layout: \{ (.*) \}$/m, 'layout: { $1, moveBeforeGrow: true }') : withLayoutEntry(yaml, 'moveBeforeGrow: true');

describe.each([[CONTIGUOUS, ['leaf-6', 'leaf-7']], [INTERLEAVED, ['leaf-4', 'leaf-5']]] as const)('%s', (name, shared) => {
  it.each([['default alignment', false], ['moveBeforeGrow', true]] as const)('staggers with compact hubs and every leaf chord held (%s)', async (_, move) => {
    const model = await run(move ? withMove(fixture(name)) : fixture(name));
    expect(model.groupArrangements?.leaves).toEqual({ chosen: 'stagger' });
    const row = model.staggerRows!.find(plan => plan.group === 'leaves')!;
    expect(row.chordHubs).toEqual(['hub-1', 'hub-2']);
    // A member with several links stands on the near line; the far line holds one-link members only.
    for (const id of shared) expect(lineOf(row, id)).toBe('near');
    expect(row.far.length).toBeGreaterThan(0);
    expect(new Set(row.order.map(id => model.nodes[id]!.bounds!.y)).size).toBe(2);
    for (const link of leafLinks(model)) {
      expect(isRoutedChord(model, link), link.id).toBe(true);
      expect(pathBends(link), link.id).toBe(0);
    }
    expect(model.removedLinks ?? []).toEqual([]);
    expect(failedGates(model)).toEqual([]);
  });
});

describe('the chord row record', () => {
  it('restores the published model and refuses a forged or missing compact-hub record', async () => {
    const model = await run(fixture(CONTIGUOUS));
    expect(restoreLayoutModel(JSON.stringify(model)).staggerRows).toEqual(model.staggerRows);
    const forge = (change: (row: NonNullable<LayoutModel['staggerRows']>[number]) => void): string => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      change(copy.staggerRows!.find(plan => plan.group === 'leaves')!);
      return JSON.stringify(copy);
    };
    for (const change of [
      (row: { chordHubs?: string[] }) => { delete row.chordHubs; },
      (row: { chordHubs?: string[] }) => { row.chordHubs = []; },
      (row: { chordHubs?: string[] }) => { row.chordHubs = ['hub-1']; },
      (row: { chordHubs?: string[] }) => { row.chordHubs = ['hub-2', 'hub-1']; },
    ]) expect(() => restoreLayoutModel(forge(change))).toThrow(/Invalid stagger reservation/);
    // A member with several links on the far line is refused, whatever the geometry.
    expect(() => restoreLayoutModel(forge(row => { row.far = [...row.far, 'leaf-6']; }))).toThrow(/stagger/i);
  });

  it('lets a chord cross the fallback leg of its own row only, read from the record', async () => {
    const model = await run(fixture(CONTIGUOUS));
    const link = (from: string) => model.links.find(item => item.attachments!.from.node === from)!;
    // leaf-1's chord runs to the right, over the vertical leg leaf-2 would take as an orthogonal link.
    const chord = link('leaf-1'), sibling = link('leaf-2'), outside = model.links.find(item => item.attachments!.from.node === 'hub-1' && item.attachments!.to.node === 'store-1')!;
    expect(legSiblings(model, chord, sibling)).toBe(true);
    expect(legSiblings(model, chord, outside)).toBe(false);
    const fallback = (copy: LayoutModel): LayoutModel => {
      const other = copy.links.find(item => item.id === sibling.id)!;
      other.technique = 'orthogonal';
      delete other.path;
      return copy;
    };
    const segment = chord.path!.segments[0]!;
    // With the record, the sibling's fallback leg does not refuse the chord.
    expect(fixedPointRefusal(fallback(JSON.parse(JSON.stringify(model)) as LayoutModel), chord, segment)).toBeUndefined();
    // The same leg of a link outside every chord row refuses it: the row is gone from the record.
    const outsideRow = fallback(JSON.parse(JSON.stringify(model)) as LayoutModel);
    outsideRow.staggerRows = outsideRow.staggerRows!.filter(plan => plan.group !== 'leaves');
    expect(fixedPointRefusal(outsideRow, chord, segment)).toBe('leg');
  });

  it('does not follow the order of the links; reversed nodes reverse the row and keep the choice (R3)', async () => {
    for (const name of [CONTIGUOUS, INTERLEAVED]) {
      const base = await run(fixture(name));
      const links = await run(reversed(fixture(name), 'links'));
      expect(links.staggerRows, name).toEqual(base.staggerRows);
      for (const id of Object.keys(base.nodes)) expect(links.nodes[id]!.bounds, `${name} ${id}`).toEqual(base.nodes[id]!.bounds);
      // Node declaration order is the row order here (a meaningful order, R3): the row runs the other way and the line rule starts from its
      // other end, so the decision, the hubs and the held chords stay.
      const nodes = await run(reversed(fixture(name), 'nodes'));
      expect(nodes.groupArrangements, name).toEqual(base.groupArrangements);
      expect(nodes.staggerRows![0]!.chordHubs, name).toEqual(base.staggerRows![0]!.chordHubs);
      for (const link of leafLinks(nodes)) expect(isRoutedChord(nodes, link), `${name} ${link.id}`).toBe(true);
    }
  });

  it('keeps a row whose every member has several links on one line: no member stands on the far line', async () => {
    const leaves = [1, 2, 3, 4, 5, 6, 7, 8];
    const yaml = `portograph: 2
groups: { leaves: { tier: 0 }, core: { tier: 1 } }
nodes:
${leaves.map(i => `  leaf-${i}: { group: leaves }`).join('\n')}
  hub-1: { group: core }
  hub-2: { group: core }
links:
${leaves.flatMap(i => [`  - [leaf-${i}, hub-1]`, `  - [leaf-${i}, hub-2]`]).join('\n')}
`;
    const model = await run(yaml);
    // The rule keeps the row before any draft, and no other group is tried: nothing to choose, so no record (ticket 51).
    expect(model.staggerRows).toBeUndefined();
    expect(model.groupArrangements).toBeUndefined();
    expect(new Set(leaves.map(i => model.nodes[`leaf-${i}`]!.bounds!.y)).size).toBe(1);
  });
});
