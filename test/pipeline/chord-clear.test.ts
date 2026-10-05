import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { overlayCrossings, spent, stepOverChords } from '../../src/layout/chord-clear.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { crosses, overlayBlockers, overlayPath, straightChord } from '../../src/layout/overlay-paths.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/**
 * Ticket 77. A straight overlay chord between two tiers is a reservation for the tiers between them: a node with an overlay link of
 * its own, on a tier between, steps along its tier to the nearest x that clears the chord, and both links stay one straight segment.
 */
describe('a linked node on a middle tier stands off a straight overlay chord (ticket 77)', () => {
  it('the chord from the source to the far target is one straight segment, and the middle node does not cross it', async () => {
    const model = await run(fixture('a-linked-node-steps-out-of-a-straight-chord'));
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const overlays = model.links.filter(link => link.layer === 'overlay');
    expect(overlays).toHaveLength(2);
    const body = model.nodes['mid']!.bounds!;
    for (const link of overlays) {
      // Read on the placed model: the decision placement made is the one the overlay rule re-derives.
      const path = overlayPath(model, link);
      expect(path.segments, link.id).toHaveLength(1);
      expect(link.path!.segments, link.id).toHaveLength(1);
      if (link.attachments!.from.node === 'src') expect(crosses(path.segments[0]!.from, path.segments[0]!.to, body)).toBe(false);
    }
  }, 60000);
});

describe('the step over a chord, where the mover holds routed links or shares a group (ticket 77)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
  const overlay = (model: LayoutModel) => model.links.find(link => link.layer === 'overlay')!;

  it('a group with routed links that run on no axis is moved off the chord, and stays where the order of its tier keeps it', async () => {
    const model = copy(await run(fixture('a-group-with-routed-links-steps-off-a-straight-chord')));
    const link = overlay(model), group = model.groups['middle']!, node = model.nodes['mid']!;
    const chord = straightChord(model, link)!;
    // Stand `mid` on the chord, as an earlier centring could leave it.
    const y = node.bounds!.y + node.bounds!.height / 2;
    const at = chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y);
    const x0 = group.bounds!.x;
    moveGroup(model, group, at - (node.bounds!.x + node.bounds!.width / 2), 0);
    rebuildNodeGeometry(model, group.nodes, 'current');
    const stood = group.bounds!.x;
    expect(overlayPath(model, link).segments.length).toBeGreaterThan(1);
    expect(stepOverChords(model, undefined)).toBe(true);
    expect(overlayPath(model, link).segments).toHaveLength(1);
    expect(crosses(chord.from, chord.to, node.bounds!)).toBe(false);
    expect(group.bounds!.x).not.toBe(stood);
    // The nearest way out: no farther than the way back to where layout had it, and the two parents stay on its either side.
    expect(Math.abs(group.bounds!.x - stood)).toBeLessThanOrEqual(Math.abs(x0 - stood) + 1e-6);
  }, 60000);

  it('a node with slack in its group moves alone, inside the box the group has', async () => {
    const model = await run(fixture('a-node-steps-off-a-straight-chord-inside-its-group'));
    const link = overlay(model);
    expect(link.path!.segments).toHaveLength(1);
    const copyOf = copy(model);
    // Architecture ticket 13, phase 4: in a layout of the test harness the whole group may now step first, bending its link to `p` for a net gain by turns (the
    // order of the user), and the mover that has moved is not moved again. So put the group back under its parent, as the real fonts lay it out, mark it as moved,
    // and let the node step.
    const p = copyOf.nodes['p']!, ma = copyOf.nodes['ma']!, mb = copyOf.nodes['mb']!, box = copyOf.groups['middle']!.bounds!;
    moveGroup(copyOf, copyOf.groups['middle']!, p.bounds!.x + p.bounds!.width / 2 - (ma.bounds!.x + ma.bounds!.width / 2), 0);
    rebuildNodeGeometry(copyOf, copyOf.groups['middle']!.nodes, 'current');
    // Put `mb` where the row packs it and step again.
    const packed = ma.bounds!.x + ma.bounds!.width + 20;
    const shift = packed - mb.bounds!.x;
    mb.bounds!.x += shift;
    for (const port of mb.ports) if (port.anchor) port.anchor.x += shift;
    rebuildNodeGeometry(copyOf, ['mb'], 'current');
    const before = { ma: ma.bounds!.x, box: { ...box }, mb: mb.bounds!.x };
    expect(overlayPath(copyOf, overlay(copyOf)).segments.length).toBeGreaterThan(1);
    expect(stepOverChords(copyOf, undefined, new Set(['middle']))).toBe(true);
    expect(overlayPath(copyOf, overlay(copyOf)).segments).toHaveLength(1);
    expect(copyOf.nodes['mb']!.bounds!.x).not.toBe(before.mb);
    expect(copyOf.nodes['ma']!.bounds!.x).toBe(before.ma);
    expect(copyOf.groups['middle']!.bounds).toEqual(before.box);
  }, 60000);
  it('a move whose settled copy cannot be judged is refused', async () => {
    const model = copy(await run(fixture('a-group-with-routed-links-steps-off-a-straight-chord')));
    const link = overlay(model), group = model.groups['middle']!, node = model.nodes['mid']!;
    const chord = straightChord(model, link)!;
    const y = node.bounds!.y + node.bounds!.height / 2;
    moveGroup(model, group, chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y) - (node.bounds!.x + node.bounds!.width / 2), 0);
    rebuildNodeGeometry(model, group.nodes, 'current');
    const stood = JSON.stringify(group.bounds);
    expect(stepOverChords(model, () => { throw new Error('unsettled'); })).toBe(false);
    expect(JSON.stringify(group.bounds)).toBe(stood);
    expect(overlayPath(model, link).segments.length).toBeGreaterThan(1);
  }, 60000);
  it('a routed group moves in one round only, and the last round runs no step (a-corridor-moves-after-the-grid-settles)', async () => {
    const model = await run(fixture('a-corridor-moves-after-the-grid-settles'));
    // Main 6757da1 moves `row-11` by 0 here. The first try moved it -25, +82, +0.5 and +0.7 px in four rounds and kept nothing after the first.
    expect(Math.abs(model.groups['row-11']!.bounds!.x - 1489.1)).toBeLessThan(30); // 1587.4 before ticket 78 ordered the tier-6 row by its partners (the row stands 98 px to the left)
    expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE' && d.message.startsWith('The cantons'))).toEqual([]);
    // The centring warning on main stands; the step adds none.
    expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(1);
  }, 120000);
});

/**
 * Ticket 80. A frame of several cells is the column pass's unit: it slides whole inside the slack its column states to clear a
 * straight chord, and a node of one of its cells moves inside that cell's slack, the cell box and so the frame unchanged.
 */
describe('a frame of two cells steps off a straight overlay chord inside its column slack (ticket 80)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
  const NAME = 'a-frame-slides-off-a-straight-chord-inside-its-column-slack';
  const overlay = (model: LayoutModel) => model.links.find(link => link.layer === 'overlay')!;
  const cells = ['loc#0', 'loc-zone#1'];
  const box = (model: LayoutModel) => deriveFrames(model)!.find(frame => frame.id === 'loc')!.box;

  it('the whole frame moves by one dx, inside the slack, and the chord is one segment again', async () => {
    const model = copy(await run(fixture(NAME)));
    const link = overlay(model);
    expect(link.path!.segments).toHaveLength(1);
    const chord = straightChord(model, link)!, at = cells.map(id => model.groups[id]!.bounds!.x), frame = box(model);
    const nodes = model.groups['loc-zone#1']!.nodes.concat(model.groups['loc#0']!.nodes);
    const nodeAt = Object.fromEntries(nodes.map(id => [id, model.nodes[id]!.bounds!.x]));
    // Stand the frame on the chord, as an earlier pass could leave it.
    for (const id of cells) moveGroup(model, model.groups[id]!, 12, 0);
    rebuildNodeGeometry(model, nodes, 'current');
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(true);
    expect(overlayPath(model, link).segments.length).toBeGreaterThan(1);
    expect(stepOverChords(model, undefined)).toBe(true);
    expect(overlayPath(model, link).segments).toHaveLength(1);
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(false);
    const dx = model.groups['loc#0']!.bounds!.x - at[0]!;
    expect(dx).not.toBe(12);
    expect(Math.abs(dx)).toBeLessThanOrEqual(20 + 1e-6);
    // Every cell and node took the same dx, and the frame keeps its size.
    expect(model.groups['loc-zone#1']!.bounds!.x - at[1]!).toBeCloseTo(dx, 6);
    for (const id of nodes) expect(model.nodes[id]!.bounds!.x - nodeAt[id]!).toBeCloseTo(dx, 6);
    expect(box(model).width).toBeCloseTo(frame.width, 6);
    expect(Math.abs(box(model).x - frame.x)).toBeLessThanOrEqual(20 + 1e-6);
  }, 60000);

  it('a node of a cell moves alone inside the cell box, and the frame stays as it is', async () => {
    const model = copy(await run(fixture(NAME)));
    const link = overlay(model), zone = model.groups['loc-zone#1']!, node = model.nodes['sw2']!;
    const chord = straightChord(model, link)!;
    const y = node.bounds!.y + node.bounds!.height / 2;
    const on = chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y);
    const shift = on - (node.bounds!.x + node.bounds!.width / 2);
    node.bounds!.x += shift;
    for (const port of node.ports) if (port.anchor) port.anchor.x += shift;
    rebuildNodeGeometry(model, ['sw2'], 'current');
    const before = { zone: { ...zone.bounds! }, frame: { ...box(model) }, sw: model.nodes['sw']!.bounds!.x };
    expect(overlayPath(model, link).segments.length).toBeGreaterThan(1);
    // The frame's own step is spent: the node is the one that moves.
    expect(stepOverChords(model, undefined, new Set(['frame:loc']))).toBe(true);
    expect(overlayPath(model, link).segments).toHaveLength(1);
    expect(crosses(chord.from, chord.to, node.bounds!)).toBe(false);
    expect(node.bounds!.x).not.toBeCloseTo(before.zone.x, 6);
    expect(zone.bounds).toEqual(before.zone);
    expect(box(model)).toEqual(before.frame);
    expect(model.nodes['sw']!.bounds!.x).toBe(before.sw);
  }, 60000);

  it('a frame with no slack to clear the chord stays where it is', async () => {
    const model = copy(await run(fixture(NAME)));
    const stood = JSON.stringify(cells.map(id => model.groups[id]!.bounds));
    expect(stepOverChords(model, undefined)).toBe(false);
    expect(JSON.stringify(cells.map(id => model.groups[id]!.bounds))).toBe(stood);
  }, 60000);
});

/** Ticket 80, review: the paths the first tests did not reach, and the growth of a canton by a slide (coordinator decision). */
describe('the slide paths of a frame, judged and capped (ticket 80)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
  const NAME = 'a-frame-slides-off-a-straight-chord-inside-its-column-slack';
  const overlay = (model: LayoutModel) => model.links.find(link => link.layer === 'overlay')!;
  const box = (model: LayoutModel) => deriveFrames(model)!.find(frame => frame.id === 'loc')!.box;
  const stand = (model: LayoutModel, ids: string[], dx: number): void => {
    for (const id of ids) {
      const node = model.nodes[id]!;
      node.bounds!.x += dx;
      for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
    }
    rebuildNodeGeometry(model, ids, 'current');
  };

  it('the row of a cell of a canton member slides as one, and the cell box stays', async () => {
    const model = copy(await run(fixture('a-canton-member-frame-slides-off-a-straight-chord')));
    const link = overlay(model), chord = straightChord(model, link)!, zone = model.groups['loc-zone#1']!;
    const cell = { ...zone.bounds! };
    stand(model, ['sw', 'sw2'], 10);
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(true);
    const history = new Set(['frame:loc']);
    expect(stepOverChords(model, undefined, history)).toBe(true);
    expect(history.has('row:loc-zone#1') || history.has('node:sw2')).toBe(true);
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(false);
    expect(zone.bounds).toEqual(cell);
  }, 60000);

  it('a cell slides alone inside its frame where every frame box stays', async () => {
    const model = copy(await run(fixture(NAME)));
    const core = model.groups['loc#0']!, frames = deriveFrames(model)!.map(frame => frame.box);
    const link = overlay(model), chord = straightChord(model, link)!;
    moveGroup(model, core, 60, 0);
    rebuildNodeGeometry(model, core.nodes, 'current');
    const at = core.bounds!.x;
    expect(stepOverChords(model, undefined, new Set(['frame:loc']))).toBe(true);
    expect(Math.abs(core.bounds!.x - at)).toBeGreaterThan(1);
    expect(deriveFrames(model)!.map(frame => frame.box)).toEqual(frames);
    expect(crosses(chord.from, chord.to, model.nodes['gw']!.bounds!)).toBe(false);
  }, 60000);

  it('a cell of a frame that is not in a canton never moves its frame edge', async () => {
    const model = copy(await run(fixture(NAME)));
    for (const id of ['sw', 'sw2']) stand(model, [id], 40);
    const frame = { ...box(model) };
    stepOverChords(model, undefined, new Set(['frame:loc']));
    expect(box(model)).toEqual(frame);
  }, 60000);

  it('a slide of a canton member may pass the wall, and is refused when the growth is spent', async () => {
    const yaml = fixture('a-canton-member-frame-slides-off-a-straight-chord');
    const model = copy(await run(yaml));
    const link = overlay(model), chord = straightChord(model, link)!;
    const cellsOf = ['loc#0', 'loc-zone#1'], nodes = ['gw', 'sw', 'sw2'];
    const standOn = (m: LayoutModel): void => {
      for (const id of cellsOf) moveGroup(m, m.groups[id]!, 20, 0);
      rebuildNodeGeometry(m, nodes, 'current');
    };
    const spentUp = copy(model);
    standOn(model);
    standOn(spentUp);
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(true);
    const at = model.groups['loc#0']!.bounds!.x;
    expect(stepOverChords(model, undefined)).toBe(true);
    const slid = Math.abs(model.groups['loc#0']!.bounds!.x - at);
    expect(slid).toBeGreaterThan(0);
    expect(slid).toBeLessThanOrEqual(40 + 1e-6);
    expect(crosses(chord.from, chord.to, model.nodes['sw2']!.bounds!)).toBe(false);
    // The growth of all the slides together is used up: the same candidate is refused and the frame stays.
    spent.set(spentUp, { base: 100, grown: 5 });
    const stood = spentUp.groups['loc#0']!.bounds!.x;
    stepOverChords(spentUp, undefined);
    expect(spentUp.groups['loc#0']!.bounds!.x).toBe(stood);
  }, 60000);

  it('a slide the column rules would undo is refused in a real layout (three-canton-groups-close-up-to-a-band-gap)', async () => {
    const model = await layout(parse(fixture('three-canton-groups-close-up-to-a-band-gap')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false });
    // A slide of a member frame by 63 px straightened two chords in an earlier build and left the finished layout off the fixed point of the
    // column rules: `packBesideRows` moved it back. The canvas is the one of main (1921.3), not the widened one (1984.5).
    expect(model.canvas!.width).toBeLessThan(1930);
  }, 120000);
});

describe('the mover takes the position that clears the most chords (ticket 110)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

  it('a group that stands on two close chords goes to the edge that clears both, not the nearest edge that clears one', async () => {
    const model = copy(await layout(parse(fixture("a-mover-takes-the-position-that-clears-most-chords")), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false }));
    const chords = model.links.filter(link => link.layer === 'overlay' && link.attachments!.from.node.startsWith('src-'));
    expect(chords).toHaveLength(2);
    const group = model.groups['middle']!, node = model.nodes['mid']!;
    // Stand `mid` on the first chord, as an earlier centring could leave it: the second chord is close, so the nearest edge clears one only.
    const chord = straightChord(model, chords[0]!, overlayBlockers(model, new Set(group.nodes)))!;
    const y = node.bounds!.y + node.bounds!.height / 2;
    const at = chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y);
    moveGroup(model, group, at - (node.bounds!.x + node.bounds!.width / 2), 0);
    rebuildNodeGeometry(model, group.nodes, 'current');
    const straight = (): number => chords.filter(link => overlayPath(model, link).segments.length === 1).length;
    expect(straight()).toBeLessThan(2);
    expect(stepOverChords(model, () => undefined)).toBe(true);
    expect(straight()).toBe(2);
  }, 60000);
});

/**
 * Ticket 146. A lower rank of a ranked group stands on the overlay chords of the ranks above it, and its cell has no room of its own: the step
 * gives it the frame span and the growth budget of ticket 80, and keeps the move with the fewest overlay crossings.
 */
describe('a lower rank steps off the chords of the ranks above (ticket 146)', () => {
  const NAME = 'a-lower-rank-steps-off-the-chords-of-rank-0';
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
  const x = (model: LayoutModel, id: string): number => model.nodes[id]!.bounds!.x;
  const overlays = (model: LayoutModel) => model.links.filter(link => link.layer === 'overlay');
  const crossingsOf = (model: LayoutModel): number => {
    const blockers = overlayBlockers(model);
    return overlayCrossings(overlays(model).map(link => overlayPath(model, link, blockers).segments));
  };
  /** The state main leaves: the row of the lower rank stands under rank 0 (low-a 0.5 px left of up-a, as the column pass sets it). */
  const restore = (model: LayoutModel): void => {
    const row = model.groups['zone#2']!;
    moveGroup(model, row, x(model, 'up-a') - 0.5 - x(model, 'low-a'), 0);
    rebuildNodeGeometry(model, row.nodes, 'current');
    // The grid widened the boxes of the column to hold the row where it stood: they go back to the span of rank 0 and the row.
    const left = x(model, 'low-a'), width = x(model, 'low-b') + model.nodes['low-b']!.bounds!.width - left;
    for (const id of ['core', 'site#0', 'zone#1', 'zone#2']) model.groups[id]!.bounds = { ...model.groups[id]!.bounds!, x: left, width };
  };

  it('both sync links are one segment, and the feeds stay one segment each', async () => {
    const model = await run(fixture(NAME));
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(overlays(model)).toHaveLength(2);
    for (const link of overlays(model)) expect(link.path!.segments, link.id).toHaveLength(1);
    for (const link of model.links.filter(item => item.layer === 'routed')) expect(link.path!.segments, link.id).toHaveLength(1);
    expect(model.diagnostics.some(d => d.code === 'RANK_STEPPED_OFF_CHORD')).toBe(true);
  }, 60000);

  it('the row of the lower rank moves as one, inside 40 px, and the overlay crossings are not above main', async () => {
    const model = await run(fixture(NAME));
    const a = x(model, 'low-a') - x(model, 'up-a'), b = x(model, 'low-b') - x(model, 'up-b');
    // On main the two ranks stand under one another (0.5 px apart and 0).
    expect(Math.abs(a)).toBeGreaterThan(20);
    expect(Math.abs(a)).toBeLessThanOrEqual(40.5);
    expect(a - b).toBeCloseTo(-0.5, 1);
    expect(x(model, 'low-b') - (x(model, 'low-a') + model.nodes['low-a']!.bounds!.width)).toBeCloseTo(21.5, 1);
    expect(crossingsOf(model)).toBe(0);
  }, 60000);

  it('rank 0 and its parent keep their x (no rank 0 moves by this rule)', async () => {
    const model = await run(fixture(NAME));
    expect(x(model, 'gw')).toBeCloseTo(84.0, 0);
    expect(x(model, 'up-a')).toBeCloseTo(72.5, 0);
    expect(x(model, 'up-b')).toBeCloseTo(149.0, 0);
  }, 60000);

  it('one node of a lower rank moves into the room the step gives it, and the step says so', async () => {
    const model = copy(await run(fixture(NAME)));
    restore(model);
    expect(overlays(model).filter(link => overlayPath(model, link).segments.length === 1)).toHaveLength(0);
    const at = { a: x(model, 'low-a'), b: x(model, 'low-b') };
    // The row mover is spent: one node moves alone, and the cell box follows it.
    model.diagnostics = [];
    const history = new Set(['rank:zone#2']);
    expect(stepOverChords(model, undefined, history)).toBe(true);
    expect([...history]).toContain('node:low-a');
    expect(Math.abs(x(model, 'low-a') - at.a) + Math.abs(x(model, 'low-b') - at.b)).toBeGreaterThan(1);
    const box = model.groups['zone#2']!.bounds!;
    for (const id of ['low-a', 'low-b']) {
      expect(x(model, id)).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(x(model, id) + model.nodes[id]!.bounds!.width).toBeLessThanOrEqual(box.x + box.width + 1e-6);
    }
    expect(model.diagnostics.some(d => d.code === 'RANK_STEPPED_OFF_CHORD')).toBe(true);
  }, 60000);

  it('a move that needs more growth than the budget holds is refused', async () => {
    const model = copy(await run(fixture(NAME)));
    restore(model);
    // Control: with the budget unspent the same state moves.
    const control = copy(model);
    spent.set(control, { base: control.canvas!.width, grown: 0 });
    expect(stepOverChords(control, undefined)).toBe(true);
    // 20 px of the 40 are spent: the row needs 32.8 and each node 23.4.
    spent.set(model, { base: model.canvas!.width, grown: 20 });
    const row = JSON.stringify(model.groups['zone#2']!.bounds);
    const history = new Set<string>();
    expect(stepOverChords(model, undefined, history), [...history].join()).toBe(false);
    expect(JSON.stringify(model.groups['zone#2']!.bounds)).toBe(row);
  }, 60000);

  it('a candidate that adds a crossing on the settled copy is no longer refused for it (the crossings are the third key)', async () => {
    const model = copy(await run(fixture(NAME)));
    restore(model);
    const at = { a: x(model, 'low-a'), b: x(model, 'low-b') };
    const moved = (probe: LayoutModel): boolean => Math.abs(x(probe, 'low-a') - at.a) > 1 || Math.abs(x(probe, 'low-b') - at.b) > 1;
    // The settled copy of a move puts client 1 beyond client 2, so the two sync chords cross: the move adds a crossing.
    const crossed = (probe: LayoutModel): void => {
      if (!moved(probe)) return;
      const node = probe.nodes['c-1']!, shift = x(probe, 'c-2') + 5 - node.bounds!.x;
      node.bounds!.x += shift;
      for (const port of node.ports) if (port.anchor) port.anchor.x += shift;
    };
    const control = copy(model), taken = copy(model);
    expect(stepOverChords(control, () => undefined)).toBe(true);
    // Architecture ticket 13, phase 4: a crossing added is no veto (the order of the user: fewer bent links, then fewer turns, then fewer crossings), so the move
    // that leaves fewer bent links stays although its settled copy crosses the two chords.
    expect(stepOverChords(taken, crossed)).toBe(true);
    expect(moved(taken)).toBe(true);
  }, 60000);

  it('a move that straightens three links and bends one (+3 / -1, no crossing added) is taken', async () => {
    const model = copy(await run(fixture(NAME)));
    restore(model);
    // Two more sync links that end like link-7, and client 1 far to the left: link-6 is straight, the other three bend.
    const seven = model.links.find(link => link.id === 'link-7')!;
    for (const id of ['link-7b', 'link-7c']) model.links.push({ ...JSON.parse(JSON.stringify(seven)) as typeof seven, id });
    const client = model.nodes['c-1']!;
    client.bounds!.x -= 200;
    for (const port of client.ports) if (port.anchor) port.anchor.x -= 200;
    rebuildNodeGeometry(model, ['c-1'], 'current');
    const straight = (probe: LayoutModel): string[] => overlays(probe).filter(link => overlayPath(probe, link).segments.length === 1).map(link => link.id);
    expect(straight(model)).toEqual(['link-6']);
    const at = x(model, 'low-a');
    // On the settled copy of a move a body stands on the chord of link-6 (core-1 is no end of a sync link): the move bends it.
    const bend = (probe: LayoutModel): void => {
      if (Math.abs(x(probe, 'low-a') - at) < 1) return;
      const chord = straightChord(probe, probe.links.find(link => link.id === 'link-6')!, undefined, true)!, body = probe.nodes['core-1']!.bounds!;
      body.x = (chord.from.x + chord.to.x) / 2 - body.width / 2;
      body.y = (chord.from.y + chord.to.y) / 2 - body.height / 2;
    };
    const control = copy(model);
    expect(stepOverChords(model, bend)).toBe(true);
    expect(Math.abs(x(model, 'low-a') - at)).toBeGreaterThan(1);
    expect(stepOverChords(control, () => undefined)).toBe(true);
  }, 60000);

  it('a node of a lower rank does not stand on the bodies of a child frame beside it (same tier)', async () => {
    const yaml = `portograph: 2
groups:
  core: { tier: 0, label: Core }
  west: { label: West }
  site: { tier: 1, canton: west, label: Site }
  zone: { parent: site, label: Zone }
  clients: { tier: 3, canton: west, label: Clients }
nodes:
  core-1: { group: core, class: router, label: Core 1 }
  gw: { group: site, class: router, label: Gateway }
  sw: { group: site, class: switch, label: Switch }
  sx: { group: site, class: switch, label: Switch X }
  up-a: { group: zone, class: switch, label: Upper A }
  up-b: { group: zone, class: switch, label: Upper B }
  c-1: { group: clients, class: server, label: Client 1 }
  c-2: { group: clients, class: server, label: Client 2 }
links:
  - [core-1, gw]
  - [gw, sw]
  - [gw, sx]
  - [gw, up-a]
  - [gw, up-b]
  - [gw, c-1, { class: sync }]
  - [gw, c-2, { class: sync }]
`;
    const model = copy(await run(yaml));
    // site#1 (sw, sx) and zone#1 (up-a, up-b) stand beside each other on one tier; the chords of gw pass over both.
    expect(model.groups['site#1']!.tier).toBe(model.groups['zone#1']!.tier);
    // Stand sx on the chord of the first sync link, as an earlier pass could leave it; the row mover is spent, so a node moves alone.
    const chord = straightChord(model, model.links.find(link => link.layer === 'overlay')!, undefined, true)!, sx = model.nodes['sx']!;
    const y = sx.bounds!.y + sx.bounds!.height / 2, on = chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y);
    const shift = on - (sx.bounds!.x + sx.bounds!.width / 2);
    sx.bounds!.x += shift;
    for (const port of sx.ports) if (port.anchor) port.anchor.x += shift;
    rebuildNodeGeometry(model, ['sx'], 'current');
    expect(crosses(chord.from, chord.to, sx.bounds!)).toBe(true);
    stepOverChords(model, undefined, new Set(['rank:site#1', 'row:site#1']));
    const mine = ['sw', 'sx'].map(id => model.nodes[id]!.bounds!), theirs = ['up-a', 'up-b'].map(id => model.nodes[id]!.bounds!);
    for (const a of mine) for (const b of theirs) expect(a.x + a.width <= b.x || b.x + b.width <= a.x, `${a.x} ${b.x}`).toBe(true);
  }, 60000);

  it('the settled copies of a cell are counted over the calls of the step, not in each call', async () => {
    const model = copy(await run(fixture(NAME)));
    restore(model);
    // Six copies are already spent for the cell: nothing is judged, nothing moves.
    const history = new Set(Array.from({ length: 6 }, (_, n) => `rank-spent:zone#2:${n}`));
    const row = JSON.stringify(model.groups['zone#2']!.bounds);
    expect(stepOverChords(model, () => undefined, history)).toBe(false);
    expect(JSON.stringify(model.groups['zone#2']!.bounds)).toBe(row);
  }, 60000);

  it('the guard fixture (a fan over the row): the lower rank moves, for fewer bent links, though it adds a crossing', async () => {
    const yaml = `portograph: 2
groups:
  core: { tier: 0, label: Core }
  west: { label: West }
  site: { tier: 1, canton: west, label: Site }
  zone: { parent: site, label: Zone }
  clients: { tier: 2, canton: west, label: Clients }
nodes:
  core-1: { group: core, class: router, label: Core 1 }
  gw: { group: site, class: router, label: Gateway }
  sw: { group: site, class: switch, label: Switch }
  up-a: { group: zone, class: switch, label: Upper A }
  up-b: { group: zone, class: switch, label: Upper B }
  up-c: { group: zone, class: switch, label: Upper C }
  low-a: { group: zone, class: server, label: Lower A }
  low-b: { group: zone, class: server, label: Lower B }
  c-1: { group: clients, class: server, label: Client 1 }
  c-2: { group: clients, class: server, label: Client 2 }
  c-3: { group: clients, class: server, label: Client 3 }
links:
  - [core-1, gw]
  - [gw, sw]
  - [sw, up-a]
  - [sw, up-b]
  - [sw, up-c]
  - [up-a, low-a]
  - [up-b, low-b]
  - [up-a, c-1, { class: sync }]
  - [up-a, c-2, { class: sync }]
  - [up-b, c-1, { class: sync }]
  - [up-b, c-3, { class: sync }]
`;
    const model = await run(yaml);
    // Architecture ticket 13, phase 4: a crossing added is no veto any more. The move straightens two links and adds one crossing: fewer bent links decide.
    expect(model.diagnostics.filter(d => d.code === 'RANK_STEPPED_OFF_CHORD').map(d => d.message)).toEqual([
      'The lower rank zone#3 moved -28.4 px off the overlay chords of the ranks above: 2 more straight overlay links, overlay crossings 0 to 1.']);
    expect(overlays(model).filter(link => link.path!.segments.length > 1)).toHaveLength(1);
  }, 60000);

  it('four-locations-each-with-a-zone: nothing moves (its lower rank stands outside a canton)', async () => {
    const model = await run(fixture('four-locations-each-with-a-zone'));
    expect(model.diagnostics.some(d => d.code === 'RANK_STEPPED_OFF_CHORD')).toBe(false);
  }, 60000);
});

describe('overlayCrossings (ticket 146)', () => {
  it('counts a strict crossing once, and not a touch at an end or a parallel pair', () => {
    const seg = (a: [number, number], b: [number, number]) => [{ from: { x: a[0], y: a[1] }, to: { x: b[0], y: b[1] } }];
    expect(overlayCrossings([seg([0, 0], [10, 10]), seg([0, 10], [10, 0])])).toBe(1);
    expect(overlayCrossings([seg([0, 0], [10, 10]), seg([10, 10], [20, 0])])).toBe(0);
    expect(overlayCrossings([seg([0, 0], [10, 10]), seg([0, 5], [10, 15])])).toBe(0);
  });
});
