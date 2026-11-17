import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { pairPitchFault } from '../../src/layout/pair-pitch.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { STEEP_PREMISE, steepBlocksFault, steepFamilies, unheldSteepBlocks } from '../../src/layout/placement-inputs.js';
import { courseLegPitchFault, courseLegPitches, reservedBlockAngle } from '../../src/layout/solid-blocks.js';
import { BLOCK_ANGLE } from '../../src/layout/block-checks.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { PlacementRefusal, PostconditionRefusal, SolidBlockRefusal } from '../../src/layout/placement-refusal.js';

// Dense-16x9 ticket 29: a u-turn course port on a face with solid-block member ports keeps the `leg` pair pitch at which a member chord at the
// angle its block reserves passes the tip of the course's stem. On main 906de428 the member beside the course port stood 21 px from it, its
// chord crossed the U's stem, and 8 of the 12 block members fell back.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-u-course-port-keeps-the-pitch-a-block-chord-needs-past-its-stem.yaml', import.meta.url), 'utf8');
const flat = readFileSync(new URL('../../goldens/synthetic/a-u-course-port-beside-a-flat-block-keeps-no-leg-pitch.yaml', import.meta.url), 'utf8');
const near = readFileSync(new URL('../../goldens/synthetic/a-u-course-port-whose-leg-pitch-takes-its-block-past-the-cap-withdraws-the-pitch.yaml', import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const legs = (model: LayoutModel): { node: string; min: number }[] => Object.values(model.nodes)
  .flatMap(node => (['top', 'bottom'] as const).flatMap(side => (node.pairPitch?.[side] ?? []).filter(entry => entry.rule === 'leg').map(entry => ({ node: node.id, min: entry.min }))));
const orthogonalMembers = (model: LayoutModel): string[] => (model.fanAdmissions ?? []).filter(item => item.mode === 'orthogonal').map(item => item.link);

describe('a u-turn course port keeps the pitch a block chord needs past its stem (dense-16x9 ticket 29)', () => {
  it('reserves a leg pitch on each course port and keeps every block member straight', async () => {
    const model = await run(yaml);
    const course = (model.courses ?? []).find(item => item.kind === 'u-turn');
    expect(course?.from.face).toBe('top');
    expect(legs(model)).toEqual([{ node: 'a-hub-1', min: 43 }, { node: 'b-hub-1', min: 43 }]);
    expect((model.fanAdmissions ?? []).length).toBe(12);
    expect(orthogonalMembers(model)).toEqual([]);
    expect(courseLegPitchFault(model)).toBeUndefined();
  }, 180000);

  it('keeps every member straight with the nodes or the links declared the other way round (R3)', async () => {
    for (const part of ['nodes', 'links'] as const) {
      const model = await run(reversed(yaml, part));
      expect(orthogonalMembers(model)).toEqual([]);
      expect(legs(model).map(item => item.min)).toEqual([43, 43]);
    }
  }, 360000);

  it('refuses a forged, a missing or a stray leg pitch at restore (R5: the validator reads the producer)', async () => {
    const model = await run(yaml);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    const forge = (change: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; change(copy); return JSON.stringify(copy); };
    const leg = (copy: LayoutModel, node: string) => copy.nodes[node]!.pairPitch!.top!.find(entry => entry.rule === 'leg')!;
    expect(() => restoreLayoutModel(forge(copy => { leg(copy, 'a-hub-1').min = 30; }))).toThrow(/a-hub-1 has a leg pitch of 30 px on top, not 43 px/);
    expect(() => restoreLayoutModel(forge(copy => { copy.nodes['a-hub-1']!.pairPitch!.top = copy.nodes['a-hub-1']!.pairPitch!.top!.filter(entry => entry.rule !== 'leg'); })))
      .toThrow(/a-hub-1 lacks the leg pitch of its course port on top/);
    expect(() => restoreLayoutModel(forge(copy => {
      const port = copy.nodes['a-hub-2']!.ports.find(item => item.side === 'top')!;
      copy.nodes['a-hub-2']!.pairPitch!.top!.push({ rule: 'leg', ports: [portId(port.ref)], min: 43 });
    }))).toThrow(/a-hub-2 has a leg pitch on top that no course port asks for/);
  }, 180000);

  it('reads a leg entry as one port that binds both neighbours', () => {
    const node = { id: 'n', ports: [{ ref: { node: 'n', name: 'p', ordinal: 1 } }], pairPitch: { top: [{ rule: 'leg', ports: ['port:["n",false,"p",1]'], min: 43 }] } };
    expect(pairPitchFault(node as never)).toBeUndefined();
    expect(pairPitchFault({ ...node, pairPitch: { top: [{ rule: 'leg', ports: [], min: 43 }] } } as never)).toMatch(/unreadable/);
  });

  it('reads the angle from the steep blocks a placement recorded, and reserves nothing without that fact', async () => {
    const model = await run(yaml);
    const families = model.fanFamilies!.filter(item => item.kind === 'solid').map(item => item.id).sort();
    // The first placement recorded both blocks under the cap, and the command placed once more with them as the input.
    expect(model.steepBlocks).toEqual(families);
    expect(steepFamilies(model)).toEqual(families);
    expect(reservedBlockAngle(model, families[0]!)).toBe(BLOCK_ANGLE);
    const unknown = { ...model } as LayoutModel;
    delete unknown.steepBlocks;
    expect(reservedBlockAngle(unknown, families[0]!)).toBeUndefined();
    expect(courseLegPitches(unknown)).toEqual([]);
    expect(courseLegPitches(model).map(([node, , entry]) => [node, entry.min])).toEqual([['a-hub-1', 43], ['b-hub-1', 43]]);
  }, 180000);

  it('reserves no leg pitch beside a floor-only flat block (review 1: no angle is assumed)', async () => {
    const model = await run(flat);
    expect(model.blockReservations?.map(item => item.mode)).toEqual(['flat', 'flat']);
    expect(model.flatBlockGaps).toBeUndefined();
    expect(model.steepBlocks).toBeUndefined();
    expect(legs(model)).toEqual([]);
    expect(courseLegPitchFault(model)).toBeUndefined();
    expect(orthogonalMembers(model).length).toBeGreaterThan(0);
  }, 180000);

  it('refuses a leg pitch on a model before stage 6, where no course stands to check it (review 1, R6)', () => {
    const model = sidesOne(resolve(parse('portograph: 2\ngroups: {a: {tier: 0}, b: {tier: 1}}\nnodes: {n: {group: a, ports: [p]}, m: {group: b, ports: [q]}}\nlinks: [[n.p, m.q]]')));
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    const node = model.nodes['n']!;
    node.pairPitch = { bottom: [{ rule: 'leg', ports: [portId(node.ports[0]!.ref)], min: 43 }] };
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/n has a leg pitch before stage 6/);
  });

  it('refuses a forged steep block input at restore', async () => {
    const model = await run(yaml);
    for (const forged of [['block:nowhere'], [], ['b', 'a']]) {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      copy.steepBlocks = forged;
      // The leg check or the input's own predicate refuses it, whichever restore reads first; the predicate alone names the input.
      expect(steepBlocksFault(copy)).toBeDefined();
      expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/steepBlocks|leg pitch/);
    }
  }, 180000);
});

// Review 2 of ticket 29: the premise of `steepBlocks` is one predicate (`unheldSteepBlocks`): `place` refuses a run by it, the leg-pitch rounds of
// `initial.ts` end on it, and restore checks it wherever block records exist.
describe('the steep-block input holds only blocks recorded under the cap (dense-16x9 ticket 29, review 2)', () => {
  it('refuses a flat block named steep at restore, by the premise and not by the list shape', async () => {
    const model = await run(flat);
    const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
    copy.steepBlocks = (copy.blockReservations ?? []).map(record => record.family).sort();
    expect(copy.steepBlocks.length).toBe(2);
    expect(steepBlocksFault(copy)).toMatch(/is not recorded under the cap/);
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/steepBlocks|leg pitch/);
  }, 180000);

  it('shrinks the input against a bound read once, and ends on a placement that holds its input', async () => {
    // A third block beside the two of the synthetic, so that the controlled placements below can drop the blocks one at a time.
    const text = yaml.replace('nodes:\n', '  core-c: {tier: 1}\nnodes:\n  t-c: {group: top, class: router}\n'
      + [1, 2, 3].map(i => `  c-pe-${i}: {group: core-c, class: router}\n`).join('') + [1, 2].map(i => `  c-hub-${i}: {group: core-c, class: switch}\n`).join(''))
      + [1, 2, 3].map(i => `  - [t-c, c-pe-${i}]\n`).join('') + [1, 2].flatMap(i => [1, 2, 3].map(j => `  - [c-hub-${i}, c-pe-${j}]\n`)).join('')
      + [1, 2].flatMap(i => [5, 6, 7, 8].map(j => `  - [c-hub-${i}, s-${j}]\n`)).join('');
    const seed = (await firstState(createEnv(parse(text), { createElkAttempt: createAttempt }))).kept7e;
    expect(seed.blockReservations?.length).toBe(3);
    // Controlled placements: the first records three blocks under the cap; the next keeps two of them (a third declined), the next one, flat.
    const env = createEnv(parse(text), {});
    const inputs: (string[] | undefined)[] = [];
    env.place = async () => {
      const call = inputs.length, model = structuredClone(seed), records = model.blockReservations!;
      inputs.push(env.steepBlocks === undefined ? undefined : [...env.steepBlocks]);
      if (env.steepBlocks === undefined) delete model.steepBlocks; else model.steepBlocks = [...env.steepBlocks];
      if (call === 1) model.blockReservations = records.slice(0, 2);
      else if (call >= 2) model.blockReservations = [{ ...records[0]!, mode: 'flat', target: 700, chosen: 300, floor: 300 }];
      const removed = records.filter(record => !model.blockReservations!.some(kept => kept.family === record.family));
      if (removed.length) {
        model.declinedSolidBlocks = removed.map(record => ({ family: record.family, reason: 'a controlled refusal' }));
        env.declinedSolidBlocks = new Map(model.declinedSolidBlocks.map(item => [item.family, item.reason]));
        model.fanFamilies = model.fanFamilies!.filter(family => !removed.some(record => record.family === family.id));
        for (const link of model.links) if (removed.some(record => record.family === link.fanFamily)) delete link.fanFamily;
      }
      return model;
    };
    env.bands = async () => { throw new PlacementRefusal('postcondition', 'no later stage in this test'); };
    const state = await firstState(env);
    expect(inputs[0]).toBeUndefined();
    expect(inputs.length).toBeGreaterThan(2);
    // No placement held its input: the command keeps the first placement and no input names a block it did not record steep.
    expect(env.steepBlocks).toBeUndefined();
    expect(state.keptNotes.map(note => note.code)).toContain('COURSE_LEG_PITCH_WITHDRAWN');
  }, 240000);

  it('gives back the whole environment a refused leg placement wrote', async () => {
    const env = createEnv(parse(yaml), { createElkAttempt: createAttempt });
    const place = env.place;
    let calls = 0;
    env.place = async (...args) => {
      if (calls++ === 0) return place(...args);
      env.arrangedRows = ['trial-row'];
      env.declinedArrangements = new Map([['trial-row', 'a trial refusal']]);
      throw new PlacementRefusal('postcondition', 'a controlled refusal after stage 5');
    };
    const state = await firstState(env);
    expect(env.declinedArrangements).toBeUndefined();
    expect(env.arrangedRows).toEqual([]);
    expect(env.steepBlocks).toBeUndefined();
    expect(state.keptNotes.map(note => note.code)).toContain('COURSE_LEG_PITCH_REFUSED');
  }, 180000);
});

// Review 3 of ticket 29: the premise is judged at its producer boundary (the 7e postconditions, before publication), and from 7e on an absent
// record list holds none of the input. One state table over every outcome of a leg call, one invariant after each.
describe('every outcome of a leg call keeps an input its placement holds, and names what it drops (dense-16x9 ticket 29, review 3)', () => {
  const blockA = 'block:core-a#1:core-a#0:', blockB = 'block:core-b#1:core-b#0:';
  const steepFinding = (family: string): { kind: string; subject: string; detail: string } => ({ kind: STEEP_PREMISE, subject: family, detail: 'a controlled finding' });
  type Leg = (place: () => Promise<LayoutModel>, input: readonly string[]) => Promise<LayoutModel>;
  // `leg` replaces the first call of the leg round (the second `place` call); every other call is the real `place`.
  const rows: { name: string; sheet: string; leg?: Leg; input: string[] | undefined; notes: string[] }[] = [
    { name: 'holds every block of its input', sheet: yaml, input: [blockA, blockB], notes: [] },
    { name: 'stands holding a part of its input', sheet: yaml, input: [blockB], notes: ['COURSE_LEG_PITCH_WITHDRAWN'],
      leg: async place => { const model = structuredClone(await place()); model.blockReservations = model.blockReservations!.filter(item => item.family !== blockA); return model; } },
    { name: 'stands with no block records', sheet: yaml, input: undefined, notes: ['COURSE_LEG_PITCH_WITHDRAWN'],
      leg: async place => { const model = structuredClone(await place()); delete model.blockReservations; return model; } },
    { name: 'declines every block of its input and places again with no record (the real retry)', sheet: yaml, input: undefined, notes: ['COURSE_LEG_PITCH_WITHDRAWN'],
      leg: (_place, input) => { throw new SolidBlockRefusal(new Map(input.map(family => [family, 'a controlled refusal']))); } },
    { name: 'is refused by name for a block of its input (real: the leg pitch takes block A past the cap)', sheet: near, input: [blockB], notes: ['COURSE_LEG_PITCH_WITHDRAWN'] },
    { name: 'is refused by name for a block of its input (controlled)', sheet: yaml, input: [blockB], notes: ['COURSE_LEG_PITCH_WITHDRAWN'],
      leg: () => { throw new PostconditionRefusal('bundles', [steepFinding(blockA)]); } },
    { name: 'is refused by name for a block outside its input', sheet: yaml, input: undefined, notes: ['COURSE_LEG_PITCH_REFUSED'],
      leg: () => { throw new PostconditionRefusal('bundles', [steepFinding('block:elsewhere')]); } },
    { name: 'is refused with no finding', sheet: yaml, input: undefined, notes: ['COURSE_LEG_PITCH_REFUSED'],
      leg: () => { throw new PostconditionRefusal('bundles', []); } },
  ];
  for (const row of rows) it(row.name, async () => {
    const env = createEnv(parse(row.sheet), { createElkAttempt: createAttempt });
    const place = env.place;
    let calls = 0, firstModel: LayoutModel | undefined;
    env.place = async (...args) => {
      const call = calls++;
      if (call === 1 && row.leg) return row.leg(() => place(...args), env.steepBlocks ?? []);
      const model = await place(...args);
      if (call === 0) firstModel = model;
      return model;
    };
    // No plain validator error reaches the command: a refusal of the premise is typed, or the row fails here.
    const state = await firstState(env);
    const kept = state.kept7e, input = kept.steepBlocks;
    expect(input).toEqual(row.input);
    expect(env.steepBlocks).toEqual(input);
    // The invariant: the kept placement's input is a subset of the blocks it records steep.
    expect(unheldSteepBlocks(kept)).toEqual([]);
    for (const family of input ?? []) expect(steepFamilies(kept)).toContain(family);
    // A diagnostic names every withdrawal or stop, and every candidate block the input lost.
    const notes = state.keptNotes.filter(note => note.code.startsWith('COURSE_LEG_PITCH'));
    expect(notes.map(note => note.code)).toEqual(row.notes);
    for (const family of steepFamilies(firstModel!).filter(item => !(input ?? []).includes(item))) expect(notes.some(note => note.message.includes(family))).toBe(true);
    expect(() => restoreLayoutModel(JSON.stringify(kept))).not.toThrow();
  }, 240000);

  it('lets a plain error of a leg call through: the round catches no validator error', async () => {
    const env = createEnv(parse(yaml), { createElkAttempt: createAttempt });
    const place = env.place;
    let calls = 0;
    env.place = async (...args) => { if (calls++ === 1) throw new Error('a controlled validator error'); return place(...args); };
    await expect(firstState(env)).rejects.toThrow('a controlled validator error');
  }, 240000);

  it('publishes the near-cap sheet with the withdrawal named, as before the premise check', async () => {
    const model = await run(near);
    expect(model.steepBlocks).toEqual([blockB]);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_LEG_PITCH_WITHDRAWN').map(item => item.message).join()).toContain(blockA);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 240000);

  it('refuses at restore an input on a placement that ran 7e and recorded no block', async () => {
    const env = createEnv(parse(yaml), { createElkAttempt: createAttempt });
    env.declinedSolidBlocks = new Map([[blockA, 'a controlled refusal'], [blockB, 'a controlled refusal']]);
    const kept = (await firstState(env)).kept7e;
    expect(kept.blockReservations).toBeUndefined();
    expect(() => restoreLayoutModel(JSON.stringify(kept))).not.toThrow();
    const copy = JSON.parse(JSON.stringify(kept)) as LayoutModel;
    copy.steepBlocks = [blockA, blockB];
    expect(unheldSteepBlocks(copy)).toEqual([blockA, blockB]);
    expect(steepBlocksFault(copy)).toMatch(/is not recorded under the cap/);
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/steepBlocks/);
  }, 240000);
});
