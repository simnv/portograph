import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { blockMoveRefusal, blockReservationFaults, blockReservationsFault, memberChord, rowRoomClearance } from '../../src/layout/block-checks.js';
import { segmentRectDistance } from '../../src/geometry/planar.js';
import { BLOCK_TOLERANCE } from '../../src/layout/tolerance.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../../src/theme/geometry.js';
import { blockBoxPadsAsked, blockRowGapsAsked } from '../../src/layout/block-pads.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import type { LayoutModel } from '../../src/model/layout.js';
import type { LayoutOptions } from '../../src/pipeline/options.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 04, slice 3, step 2, review 1: the room rounds run to the fixed point and name what is left (finding 1); a forged room
// record is refused at early and at final restore (finding 2); the room of a hub frame is held by `deriveFrames` (the reviewer's frame probe).
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const lay = (source: string, options: Partial<LayoutOptions> = {}): Promise<LayoutModel> =>
  layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...options });
const straight = (model: LayoutModel): number => (model.fanAdmissions ?? []).filter(item => item.mode === 'straight').length;
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);

describe('the room rounds run to the fixed point (finding 1)', () => {
  it('gives a tall hub its row gap in as many placements as it takes, and every member stands straight', async () => {
    const model = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'));
    expect(straight(model)).toBe(14);
    expect(model.blockRowGaps?.map(item => [item.left, item.right])).toEqual([['core-a', 'core-b']]);
    // The fixed point: the published model asks for no more room than the records hold.
    expect(blockRowGapsAsked(model)).toEqual(model.blockRowGaps);
    expect(blockBoxPadsAsked(model)).toEqual(model.blockBoxPads);
    expect(codes(model)).not.toContain('BLOCK_ROOM_UNSETTLED');
  }, 180000);

  it('names the room still short when the bound runs out', async () => {
    // Three placements leave the row gap short (the reviewer's state: 1724.52 px held, 1735.04 px asked).
    const model = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'), { testBlockRoomBound: 3 });
    const note = model.diagnostics.find(item => item.code === 'BLOCK_ROOM_UNSETTLED');
    expect(note?.severity).toBe('warning');
    expect(note?.message).toMatch(/core-a to core-b gap \d+\.\d\d px/);
    expect(note?.owners).toEqual(expect.arrayContaining([{ kind: 'node', id: 'core-a' }, { kind: 'node', id: 'core-b' }]));
  }, 180000);
});

describe('a forged room record is refused at restore (finding 2)', () => {
  const forged = [
    ['blockBoxPads', [{ box: 'core', side: 'left', pad: -100 }]],
    ['blockRowGaps', [{ left: 'core-a', right: 'core-b', gap: -100 }]],
    ['blockBoxPads', [null]],
  ] as const;
  it.each(forged)('refuses %s %j on a model before the freeze', (field, record) => {
    const model = JSON.parse(JSON.stringify(sizeNodes(sidesOne(resolve(parse(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'))))))) as Record<string, unknown>;
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    model[field] = record;
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/placement input/);
  });
  it('refuses a forged record on a published model', async () => {
    const model = await lay(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'));
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    for (const [field, record] of forged) {
      const copy = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
      copy[field] = record;
      expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/placement input/);
    }
  }, 180000);
});

describe('a forged flat block gap is refused at restore (the placement inputs table)', () => {
  it.each([
    [[{ family: 'block:core:1:', gap: -5 }]],
    [[]],
    [[{ family: 'block:core:1:', gap: 900 }, { family: 'block:core:1:', gap: 900 }]],
  ])('refuses %j on a model before the freeze', record => {
    const model = JSON.parse(JSON.stringify(sizeNodes(sidesOne(resolve(parse(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'))))))) as Record<string, unknown>;
    model['flatBlockGaps'] = record;
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/placement input flatBlockGaps/);
  });
  it('refuses a published model whose flat block gaps disagree with the block records', async () => {
    const model = await lay(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'));
    const [entry] = model.flatBlockGaps!, record = model.blockReservations!.find(item => item.family === entry!.family)!;
    expect(record.mode).toBe('flat');
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    const forged = (edit: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; edit(copy); return JSON.stringify(copy); };
    // A gap the record did not take (it stands below the asked gap, and the demand allows more).
    expect(record.chosen + 100).toBeLessThan(record.target);
    expect(() => restoreLayoutModel(forged(copy => { copy.flatBlockGaps![0]!.gap = record.chosen + 100; }))).toThrow(/does not take its chosen gap/);
    // An entry that names no block.
    expect(() => restoreLayoutModel(forged(copy => { copy.flatBlockGaps![0]!.family = 'block:none:'; }))).toThrow(/names no flat block/);
    // Two entries of one tier gap that ask two values.
    expect(() => restoreLayoutModel(forged(copy => {
      copy.blockReservations!.push({ ...record, family: 'block:twin:' });
      copy.flatBlockGaps!.push({ family: 'block:twin:', gap: entry!.gap + 1 });
    }))).toThrow(/flat block gaps of tier gap \d+ differ/);
  }, 180000);
});

describe('the room of a hub frame (the reviewer\'s frame probe)', () => {
  it('widens the frame by its room on each side; a frame without it loses a member\'s box clearance, and restore refuses it', async () => {
    const model = await lay(fixture('a-flat-block-hub-frame-takes-side-room'));
    expect(straight(model)).toBe(14);
    const frame = model.frames!.find(item => item.id === 'core')!;
    const pads = model.blockBoxPads!.filter(item => item.box === 'core');
    expect(pads.map(item => item.side)).toEqual(['left', 'right']);
    const withoutRoom = { ...model };
    delete withoutRoom.blockBoxPads;
    const bare = deriveFrames(withoutRoom)!, unpadded = bare.find(item => item.id === 'core')!;
    expect(unpadded.box.x - frame.box.x).toBeCloseTo(pads[0]!.pad, 6);
    expect(frame.box.width - unpadded.box.width).toBeCloseTo(pads[0]!.pad + pads[1]!.pad, 6);
    const broken = { ...model, frames: bare };
    expect(blockReservationsFault(broken)).toMatch(/box clearance/);
    expect(() => restoreLayoutModel(JSON.stringify(broken))).toThrow();
  }, 180000);
});

describe('the one judge of a move after the freeze reads the row room (ticket 31)', () => {
  it('refuses a move that takes a row neighbour into the clearance its row gap reserved', async () => {
    const model = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'));
    const before = blockReservationFaults(model);
    expect(blockReservationsFault(model)).toBeUndefined();
    // A mover shifts `core-b` beside `core-a`, its row gap given back: its body now stands in the chords of `core-a`.
    const moved = JSON.parse(JSON.stringify(model)) as LayoutModel, a = moved.nodes['core-a']!.bounds!, b = moved.nodes['core-b']!.bounds!;
    b.x = a.x + a.width + 1;
    expect(blockReservationsFault(moved)).toMatch(/lost its reserved row room beside core-b/);
    expect(blockMoveRefusal(before, moved)?.fault).toMatch(/row room beside core-b/);
  }, 180000);
});

describe('a constraint that backs a gate is held to the gate threshold (review 2, finding 1)', () => {
  /** Moves one node, its ports and their pills by dx, as a mover after the freeze would. */
  const shift = (model: LayoutModel, id: string, dx: number): void => {
    const node = model.nodes[id]!;
    node.bounds = { ...node.bounds!, x: node.bounds!.x + dx };
    for (const port of node.ports) {
      if (port.anchor) port.anchor = { x: port.anchor.x + dx, y: port.anchor.y };
      if (port.pill) port.pill = { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx } };
    }
  };
  const g6 = (model: LayoutModel, code: string): string[][] => score(model).snapshot.gates.G6.violations.filter(item => item.code === code).map(item => item.elements);

  it('names a row neighbour that stands inside the node clearance by less than the tolerance, as G6 does', async () => {
    const built = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'));
    const members = built.links.filter(link => link.solidBlock && built.frozenChords?.includes(link.id) && link.attachments!.from.node === 'core-a');
    // The largest shortfall of the node clearance beside `core-b`, over the straight members of `core-a`, with `core-b` moved left by dx.
    const short = (dx: number): { model: LayoutModel; link: string; short: number } => {
      const model = JSON.parse(JSON.stringify(built)) as LayoutModel;
      shift(model, 'core-b', -dx);
      return members.map(link => ({ model, link: link.id, short: rowRoomClearance(model, link, 'core-b') - segmentRectDistance({ ...memberChord(model, link)!, owner: link.owner }, model.nodes['core-b']!.bounds!) }))
        .reduce((a, b) => b.short > a.short ? b : a);
    };
    expect(short(0).short).toBeLessThan(0);
    // The reviewer's state, found by bisection: one member 0.005 px inside the clearance, within the tolerance.
    let low = 0, high = 1;
    while (short(high).short <= 0) high *= 2;
    for (let step = 0; step < 80; step++) { const mid = (low + high) / 2; if (short(mid).short < BLOCK_TOLERANCE / 2) low = mid; else high = mid; }
    const state = short(low);
    expect(state.short).toBeGreaterThan(0);
    expect(state.short).toBeLessThan(BLOCK_TOLERANCE);
    expect(g6(state.model, 'segment-node-clearance')).toContainEqual([state.link, 'core-b']);
    expect(blockReservationFaults(state.model).get(state.link)?.map(fault => fault.constraint)).toContain('room:core-b');
    expect(blockMoveRefusal(built, state.model)?.fault).toMatch(new RegExp(`${state.link} lost its reserved row room beside core-b`));
  }, 180000);

  it('names a foreign box that a member runs along inside the edge margin by less than the tolerance, as G6 does (ticket 31\'s box check)', async () => {
    const built = await lay(fixture('a-two-by-seven-block-past-the-cap-stays-straight'));
    const model = JSON.parse(JSON.stringify(built)) as LayoutModel, link = model.links.find(item => item.id === 'link-1')!;
    // The far end stood under the core end: the member runs vertical. A foreign box (`pair2`) stands beside it, 0.005 px inside the margin.
    const near = link.attachments!.from, far = link.attachments!.to;
    const at = (ref: typeof near) => model.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name || port.ref.ordinal === ref.ordinal)!.anchor!;
    shift(model, far.node, at(near).x - at(far).x);
    const chord = memberChord(model, link)!;
    expect(Math.abs(chord.to.x - chord.from.x)).toBeLessThan(1e-9);
    link.path = { ...link.path!, segments: [{ ...link.path!.segments[0]!, from: chord.from, to: chord.to }] };
    const reach = GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2 - BLOCK_TOLERANCE / 2, top = Math.min(chord.from.y, chord.to.y);
    model.groups['pair2']!.bounds = { x: chord.from.x + reach, y: top + 100, width: 200, height: 100 };
    expect(g6(model, 'segment-group-edge')).toContainEqual(['link-1', 'pair2']);
    expect(blockReservationFaults(model).get('link-1')?.map(fault => fault.constraint)).toContain('box:pair2:frame');
  }, 180000);
});
