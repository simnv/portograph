import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { chordLaneCrossings, chordsClearAfterMove, heldChordPorts } from '../../src/layout/centre.js';
import { segmentRectDistance } from '../../src/score/geometry.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 100 review 3: 7f centring packs the ports of a face against the one alignment it keeps. A held chord's port that is not a target
 * used to slide along the face, the chord slanted across the lane of another link, and `validateLanes` threw `Fixed path crosses a foreign lane`.
 * The side is declined instead, so the chord keeps the x it was decided at. The same hole stood in the whole-group shift of the centring (`toMean`):
 * a group that moved left of its chord's other end slanted the chord across a lane; the shift is now 0 for such a move.
 */
describe('a face that aligns one port leaves the port of a held chord in place', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-face-aligns-one-port-and-leaves-a-chord-port-in-place.yaml', import.meta.url), 'utf8');
  it('lays out, and the chord stays straight', async () => {
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    // The chord of src1 to acc3 stays a chord, vertical at the x it was decided at.
    const chord = model.links.find(link => link.attachments!.from.node === 'src1' && link.attachments!.to.node === 'acc3')!;
    expect(chord.path?.fixed).toBe(true);
    expect(chord.path!.segments).toHaveLength(1);
  });
});

describe('a group shift leaves a held chord clear of a lane', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-shift-leaves-a-chord-clear-of-a-lane.yaml', import.meta.url), 'utf8');
  it('lays out, and the chord of src0 to acc0 stays straight', async () => {
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const chord = model.links.find(link => link.attachments!.from.node === 'src0' && link.attachments!.to.node === 'acc0')!;
    expect(chord.path?.fixed).toBe(true);
    expect(chord.path!.segments).toHaveLength(1);
  });
});

// The guards themselves, on the laid-out model of the fixture above with an end forged into a lane column.
describe('the chord guards of the centring read the frozen chords and the lane boxes', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-shift-leaves-a-chord-clear-of-a-lane.yaml', import.meta.url), 'utf8');
  const setup = async () => {
    const model = JSON.parse(JSON.stringify(await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }))) as LayoutModel;
    const link = model.links.find(item => item.attachments!.from.node === 'src0' && item.attachments!.to.node === 'acc0')!;
    const lane = model.lanes.find(item => item.owner.kind !== 'link' || item.owner.id !== link.id)!;
    return { model, link, lane, src: model.groups['src']!, access: model.groups['access']! };
  };
  it('names a chord that crosses a foreign lane, and only once the chords are frozen', async () => {
    const { model, link, lane, src } = await setup();
    expect(chordLaneCrossings(model, src).size).toBe(0);
    // The access end is forged into the lane column: the chord then runs from the source port down into the lane box.
    const to = model.nodes['acc0']!.ports.map(port => port.anchor!).find(anchor => Math.abs(anchor.x - link.path!.segments[0]!.to.x) < 1e-6)!;
    to.x = lane.x;
    const named = [...chordLaneCrossings(model, src)];
    expect(named.length).toBeGreaterThan(0);
    expect(named.every(pair => pair.startsWith(`${link.id}|`))).toBe(true);
    delete model.frozenChords;
    expect(chordLaneCrossings(model, src).size).toBe(0);
  });
  it('refuses a group move that lays a chord across a lane between its ends, and only once frozen', async () => {
    const { model, lane, access } = await setup();
    // The access group moves left until the end of the chord of src0 to acc2 stands clear of the lane column, on its far side: the chord crosses the lane box between its ends.
    const dx = lane.bounds.x - 16 - model.nodes['acc2']!.ports[0]!.anchor!.x;
    expect(chordsClearAfterMove(model, access, dx)).toBe(false);
    delete model.frozenChords;
    expect(chordsClearAfterMove(model, access, dx)).toBe(true);
  });
  it('lets through a move that puts a chord end in the lane column, which the passes undo', async () => {
    const { model, link, lane } = await setup();
    const access = { ...model.groups['access']!, nodes: ['acc0'] };
    const to = model.nodes['acc0']!.ports[0]!.anchor!;
    expect(chordsClearAfterMove(model, access, lane.x - to.x)).toBe(true);
    // The same end, measured without the exception, touches the lane.
    const moved = { from: link.path!.segments[0]!.from, to: { x: lane.x, y: to.y }, owner: link.owner };
    expect(segmentRectDistance(moved, lane.bounds)).toBeLessThan(1e-6);
  });
  it('gives the port guard a verdict per held chord port only once frozen', async () => {
    const { model } = await setup();
    expect(heldChordPorts(model, model.nodes['src0']!).size).toBeGreaterThan(0);
    delete model.frozenChords;
    expect(heldChordPorts(model, model.nodes['src0']!).size).toBe(0);
  });
});
