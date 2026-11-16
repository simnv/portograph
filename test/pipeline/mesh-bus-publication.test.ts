import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { busGeometry, busLegCounts, busVerticalCounts, busVerticals } from '../../src/layout/bus.js';
import { produceLinkLabels } from '../../src/layout/link-labels.js';
import { linkIds } from '../../src/model/index.js';
import { inFile } from '../render/drawio-cells.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** The id a link carries in the draw.io file: its stable id, which no longer follows its place in the YAML. */
const cellOf = (model: LayoutModel, id: string): string => `pg-link~${inFile(linkIds(model.document)[model.links.find(link => link.id === id)!.sourceIndex]!)}`;

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
const thaw = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

const NAMES = [
  'a-full-mesh-on-one-row-draws-as-one-bus',
  'a-partial-mesh-keeps-its-largest-complete-part',
  'a-mesh-across-frames-draws-one-bus',
  'a-mesh-of-one-node-groups-draws-one-bus',
  'a-bus-across-cantons-crosses-the-canton-edges',
] as const;

describe('the bus publishes member paths, scores, renders and exports (ticket 84)', () => {
  it('draws the full mesh as one bar, five stubs, five marks and one label; ten members with three-segment paths', async () => {
    const model = await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus'));
    const members = model.links.filter(link => link.meshBus !== undefined);
    expect(members).toHaveLength(10);
    for (const link of members) {
      expect(link.technique).toBe('mesh-bus');
      expect(link.layer).toBe('overlay');
      expect(link.path!.segments).toHaveLength(3);
      const [stub, run, other] = link.path!.segments;
      expect(stub!.from.x).toBeCloseTo(stub!.to.x, 6);
      expect(run!.from.y).toBeCloseTo(run!.to.y, 6);
      expect(other!.from.x).toBeCloseTo(other!.to.x, 6);
    }
    // Neither straight nor bent: no overlay link outside the bus.
    expect(model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined)).toEqual([]);
    const bus = model.meshBuses![0]!;
    expect(bus.label).toBe('label:bus:mesh-bus-1');
    const label = model.labels.find(item => item.id === bus.label)!;
    expect(label).toMatchObject({ role: 'mesh-bus', text: 'sync mesh (5 nodes)', textRotation: 0, layer: 'overlay' });
    expect(label.omitted).toBeUndefined();
    // The label stands beyond the bar, on the room 7f reserved.
    expect(label.bounds!.x).toBeGreaterThanOrEqual(bus.labelRoom!.from - 1e-6);
    expect(label.bounds!.x + label.bounds!.width).toBeLessThanOrEqual(bus.labelRoom!.to + 1e-6);
    expect(label.bounds!.y).toBeGreaterThan(bus.bar!.from.y);
    expect(gates(model)).toEqual([]);
    const svg = render(model);
    expect(count(svg, /<g class="mesh-bus overlay sync"/g)).toBe(1);
    expect(count(svg, /<g class="link overlay/g)).toBe(0);
    expect(count(svg, /<circle class="overlay-endpoint sync"/g)).toBe(5);
    // Six bus lines, and the legend's `sync` sample: every `sync` link is an overlay link, so it draws as one (audit A1-16).
    expect(count(svg, /class="link-line overlay-line sync/g)).toBe(7);
    expect(svg).toContain('sync mesh (5 nodes)');
  }, 60000);

  it('counts the bus in the score, and reads its label in G3', async () => {
    const model = await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus'));
    const snapshot = score(model).snapshot;
    expect(snapshot.counters.meshBuses).toBe(1);
    // Members are in neither the bends nor the crossings.
    expect(snapshot.metrics.bends.total).toBe(0);
    expect(snapshot.metrics.crossings.routedLinks).toBe(2);
    // A model without a bus keeps the counters it always had.
    const plain = await run('portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a: { group: g }\n  b: { group: g }\nlinks:\n  - [a, b]\n');
    expect('meshBuses' in score(plain).snapshot.counters).toBe(false);
    // G3 reads the bus label against routed geometry: a label that stands on a node is a hit.
    const forged = thaw(model);
    const node = forged.nodes['n1']!.bounds!;
    const label = forged.labels.find(item => item.role === 'mesh-bus')!;
    label.bounds = { ...label.bounds!, x: node.x + 2, y: node.y + 2 };
    const violations = score(forged).snapshot.gates.G3.violations;
    expect(violations.some(item => item.elements.includes(label.id))).toBe(true);
  }, 60000);

  it('puts a label that no interval holds in the tooltip and counts it as omitted', async () => {
    const model = thaw(await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    delete model.meshBuses![0]!.labelRoom;
    model.labels = model.labels.filter(item => item.role !== 'mesh-bus');
    produceLinkLabels(model);
    const label = model.labels.find(item => item.role === 'mesh-bus')!;
    expect(label).toMatchObject({ omitted: true, tooltip: 'sync mesh (5 nodes)' });
    expect(score(model).snapshot.counters.labelsOmitted).toBe(1);
    expect(render(model)).not.toContain('sync mesh (5 nodes)</tspan>');
  }, 60000);

  it('keeps a plain overlay link beside the bus of a partial mesh', async () => {
    const model = await run(fixture('a-partial-mesh-keeps-its-largest-complete-part'));
    const bus = model.meshBuses![0]!;
    expect(bus.stubs).toHaveLength(4);
    const plain = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined);
    expect(plain).toHaveLength(3);
    const svg = render(model);
    expect(count(svg, /<g class="mesh-bus overlay sync"/g)).toBe(1);
    expect(count(svg, /<g class="link overlay/g)).toBe(3);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('draws the mesh across frames as one bar and six stubs with no group-link line', async () => {
    const model = await run(fixture('a-mesh-across-frames-draws-one-bus'));
    const bus = model.meshBuses![0]!;
    expect(bus).toMatchObject({ placement: 'across-frames', side: 'bottom' });
    expect(bus.members).toHaveLength(15);
    expect(model.links.filter(link => link.meshBus !== undefined && link.technique === 'mesh-bus')).toHaveLength(15);
    expect(model.groupLinks).toEqual([]);
    expect(bus.stubs).toHaveLength(6);
    expect(model.labels.find(item => item.id === bus.label)!.text).toBe('sync mesh (6 nodes)');
    const svg = render(model);
    expect(count(svg, /<g class="mesh-bus overlay sync"/g)).toBe(1);
    expect(count(svg, /<g class="link overlay/g)).toBe(0);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('counts the verticals across each bar in the published layout', async () => {
    const across = await run(fixture('a-mesh-across-frames-draws-one-bus'));
    expect(busVerticals(across, across.meshBuses![0]!)).toBe(0);
    // The rank-gap fixture: of the two down links of rank 0, the one over the span crosses the bar and the other passes beside its end.
    const gap = await run(fixture('a-bus-in-a-rank-gap-grows-the-gap'));
    const bus = gap.meshBuses![0]!;
    expect(busVerticals(gap, bus)).toBe(1);
    expect(busVerticalCounts(gap, bus)[bus.side!]).toBe(1);
    expect(busLegCounts(gap, bus)[bus.side!]).toBeGreaterThanOrEqual(busVerticals(gap, bus));
    expect(busLegCounts(gap, bus)[bus.side!]).toBeLessThan(busLegCounts(gap, bus)[bus.side === 'top' ? 'bottom' : 'top']);
  }, 60000);

  it('keeps the members of a bus contiguous in the row: a foreign node is not left between two of them', async () => {
    // Without the rule (bus pairs read as row partners) ELK's order leaves `f1` between `n2` and `n3`.
    const model = await run(fixture('a-foreign-node-stays-out-of-a-bus-row'));
    const bus = model.meshBuses![0]!;
    expect(bus.nodes).toHaveLength(5);
    const xs = bus.nodes.map(id => model.nodes[id]!.bounds!.x), low = Math.min(...xs), high = Math.max(...xs);
    const f1 = model.nodes['f1']!.bounds!.x;
    expect(f1 < low || f1 > high).toBe(true);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('keeps the member frames of a bus contiguous in the tier: a foreign frame does not lengthen the bar', async () => {
    // Without the rule the order is east, other, west, middle... with `other` between two member frames and the bar 150 px longer.
    const model = await run(fixture('a-foreign-frame-stays-out-of-a-bus-tier'));
    const bus = model.meshBuses![0]!;
    const members = ['west', 'middle', 'east'].map(id => model.groups[id]!.bounds!);
    const low = Math.min(...members.map(box => box.x)), high = Math.max(...members.map(box => box.x + box.width));
    const foreign = model.groups['other']!.bounds!;
    expect(foreign.x >= high - 1e-6 || foreign.x + foreign.width <= low + 1e-6).toBe(true);
    expect(bus.stubs).toHaveLength(6);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('restores the published layout of every bus fixture, and refuses a forged member path or bus label', async () => {
    for (const name of NAMES) {
      const model = await run(fixture(name));
      const restored = restoreLayoutModel(JSON.stringify(model));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(model));
    }
    const model = thaw(await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    const path = model.links.find(link => link.meshBus !== undefined)!.path!;
    path.segments[1]!.to.x += 1;
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/Overlay path/);
    const forged = thaw(await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    forged.labels.find(item => item.role === 'mesh-bus')!.text = 'sync mesh (9 nodes)';
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow();
  }, 120000);

  it('keeps the label room inside the bar when a chord crosses the band beyond its end', async () => {
    const model = thaw(await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    const bus = model.meshBuses![0]!, band = model.busBands![0]!.bounds;
    const lo = Math.min(bus.bar!.from.x, bus.bar!.to.x), hi = Math.max(bus.bar!.from.x, bus.bar!.to.x);
    const link = model.links.find(item => item.layer === 'routed')!;
    // One chord over the centre of the bar, where the label would stand, and one past its end.
    const centre = (lo + hi) / 2, owner = link.path!.segments[0]!.owner;
    link.path!.segments = [
      { from: { x: centre - 5, y: band.y - 20 }, to: { x: centre + 5, y: band.y + band.height + 20 }, owner },
      { from: { x: hi + 80, y: band.y - 20 }, to: { x: hi + 140, y: band.y + band.height + 20 }, owner },
    ];
    const room = busGeometry(model, bus)!.labelRoom!;
    expect(room.from).toBeGreaterThanOrEqual(lo - 1e-6);
    expect(room.to).toBeLessThanOrEqual(hi + 1e-6);
  }, 60000);

  it('keeps the bus label clear of frame side edges and cuts it out of the overlay mask', async () => {
    const model = await run(fixture('a-bus-across-cantons-crosses-the-canton-edges'));
    const label = model.labels.find(item => item.role === 'mesh-bus')!, box = label.bounds!;
    for (const frame of model.frames!) {
      if (frame.box.y >= box.y + box.height || frame.box.y + frame.box.height <= box.y) continue;
      for (const x of [frame.box.x, frame.box.x + frame.box.width]) expect(x > box.x - 1e-6 && x < box.x + box.width + 1e-6).toBe(false);
    }
    const svg = render(model);
    expect(svg).toContain(`<rect class="pg-mask-hide"`);
    expect(svg).toContain(`x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`);
  }, 60000);

  it('hides a bus with its class, and lists its class in the legend', async () => {
    const model = await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus'));
    expect(model.legend!.entries.some(entry => entry.key === 'sync')).toBe(true);
    const hidden = thaw(model);
    hidden.document.overlays = { sync: 'hidden' };
    const svg = render(hidden);
    expect(count(svg, /<g class="mesh-bus/g)).toBe(0);
    expect(svg).not.toContain('sync mesh (5 nodes)');
    expect(render(model, { layers: ['routed'] })).not.toContain('<g class="mesh-bus');
  }, 60000);

  for (const name of NAMES) {
    it(`snapshots the SVG and the draw.io export of ${name}`, async () => {
      const model = await run(fixture(name));
      expect(render(model)).toMatchSnapshot('svg');
      const xml = drawio(model);
      expect(xml).toMatchSnapshot('drawio');
      const bus = model.meshBuses![0]!;
      // One edge for the bar with two free points, one edge and one mark per stub, and the label as a text vertex.
      expect(count(xml, /style="edgeStyle=none;[^"]*"[^>]*edge="1"/g)).toBeGreaterThanOrEqual(1);
      expect(count(xml, /id="pg-busStub~/g)).toBe(bus.stubs!.length);
      expect(count(xml, /id="pg-busMark~/g)).toBe(bus.stubs!.length);
      expect(xml).toContain(`${bus.class} mesh (${bus.nodes.length} nodes)`);
      for (const member of bus.members) expect(xml).not.toContain(`id="${cellOf(model, member)}"`);
    }, 60000);
  }
});
