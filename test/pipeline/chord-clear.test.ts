import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { spent, stepOverChords } from '../../src/layout/chord-clear.js';
import { POST_PLACEMENT_RESERVE_MS } from '../../src/pipeline/budget.js';
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
    const link = overlay(model), group = model.groups['middle']!;
    expect(link.path!.segments).toHaveLength(1);
    const copyOf = copy(model);
    // The layout here already stepped `mb` off the chord: put it back where the row packs it and step again.
    const mb = copyOf.nodes['mb']!, ma = copyOf.nodes['ma']!, box = copyOf.groups['middle']!.bounds!;
    const packed = ma.bounds!.x + ma.bounds!.width + 20;
    const shift = packed - mb.bounds!.x;
    mb.bounds!.x += shift;
    for (const port of mb.ports) if (port.anchor) port.anchor.x += shift;
    rebuildNodeGeometry(copyOf, ['mb'], 'current');
    const before = { ma: ma.bounds!.x, box: { ...box }, mb: mb.bounds!.x };
    expect(overlayPath(copyOf, overlay(copyOf)).segments.length).toBeGreaterThan(1);
    expect(stepOverChords(copyOf, undefined)).toBe(true);
    expect(overlayPath(copyOf, overlay(copyOf)).segments).toHaveLength(1);
    expect(copyOf.nodes['mb']!.bounds!.x).not.toBe(before.mb);
    expect(copyOf.nodes['ma']!.bounds!.x).toBe(before.ma);
    expect(copyOf.groups['middle']!.bounds).toEqual(before.box);
    expect(group.bounds).toEqual(before.box);
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
    const model = await run(fixture('three-canton-groups-close-up-to-a-band-gap'));
    // A slide of a member frame by 63 px straightened two chords in an earlier build and left the finished layout off the fixed point of the
    // column rules: `packBesideRows` moved it back. The canvas is the one of main (1921.3), not the widened one (1984.5).
    expect(model.canvas!.width).toBeLessThan(1930);
  }, 120000);
});

describe('the step over a chord reads the command budget (ticket 111)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
  const budgetOf = (ms: () => number) => ({ remainingMs: ms, share: (stage: number) => Math.min(stage, ms()) });
  const stood = async (): Promise<LayoutModel> => {
    const model = copy(await run(fixture('a-group-with-routed-links-steps-off-a-straight-chord')));
    const link = model.links.find(item => item.layer === 'overlay')!, group = model.groups['middle']!, node = model.nodes['mid']!;
    const chord = straightChord(model, link)!, y = node.bounds!.y + node.bounds!.height / 2;
    moveGroup(model, group, chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y) - (node.bounds!.x + node.bounds!.width / 2), 0);
    rebuildNodeGeometry(model, group.nodes, 'current');
    return model;
  };

  it('a budget under the reserve tries no mover, keeps the model and warns with the count', async () => {
    const model = await stood(), before = JSON.stringify(model.groups);
    expect(stepOverChords(model, undefined, new Set(), budgetOf(() => POST_PLACEMENT_RESERVE_MS - 1))).toBe(false);
    expect(JSON.stringify(model.groups)).toBe(before);
    const warning = model.diagnostics.find(item => item.code === 'CHORD_CLEAR_BUDGET')!;
    expect(warning.severity).toBe('warning');
    expect(warning.message).toMatch(/\d+ movers? (was|were) not tried/);
    expect(model.diagnostics.filter(item => item.code === 'CHORD_CLEAR_BUDGET')).toHaveLength(1);
  }, 60000);

  it('a budget that falls under the reserve after one trial keeps the accepted move and stops', async () => {
    const model = await stood();
    let reads = 0;
    // The first mover sees room; every later read sees none.
    expect(stepOverChords(model, undefined, new Set(), budgetOf(() => (reads++ === 0 ? Infinity : 0)))).toBe(true);
    expect(overlayPath(model, model.links.find(item => item.layer === 'overlay')!).segments).toHaveLength(1);
  }, 60000);

  it('a budget with room changes nothing against the unbounded step', async () => {
    const a = await stood(), b = await stood();
    stepOverChords(a, undefined);
    stepOverChords(b, undefined, new Set(), budgetOf(() => 1e9));
    expect(JSON.stringify(b.groups)).toBe(JSON.stringify(a.groups));
    expect(b.diagnostics.some(item => item.code === 'CHORD_CLEAR_BUDGET')).toBe(false);
  }, 60000);

  it('a command whose budget falls under the reserve at 7f publishes with exactly one warning (a-corridor-moves-after-the-grid-settles)', async () => {
    let late = false;
    const budget = budgetOf(() => (late ? POST_PLACEMENT_RESERVE_MS - 1000 : Infinity));
    const model = await layout(parse(fixture('a-corridor-moves-after-the-grid-settles')), {
      createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, budget,
      onProgress: progress => { if (progress.stage === 'bundles') late = true; },
    });
    expect(model.stage).toBe('link-labels');
    expect(model.diagnostics.filter(item => item.code === 'CHORD_CLEAR_BUDGET')).toHaveLength(1);
  }, 60000);
});

describe('the mover takes the position that clears the most chords (ticket 110)', () => {
  const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

  it('a group that stands on two close chords goes to the edge that clears both, not the nearest edge that clears one', async () => {
    const model = copy(await run(fixture('a-mover-takes-the-position-that-clears-most-chords')));
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
