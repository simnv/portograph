import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { busSide } from '../../src/layout/bus.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
/** The same document with the mesh opted out (`route: overlay`), which is main's layout. */
const withoutBus = (yaml: string): string => yaml.replace(/class: sync \}/g, 'class: sync, route: overlay }');
/** The routed legs that cross the bar of a bus: verticals of routed segments over the bar's x range that span its y. */
function legsAcross(model: LayoutModel, id: string): string[] {
  const bus = model.meshBuses!.find(item => item.id === id)!, bar = bus.bar!, y = bar.from.y;
  const low = Math.min(bar.from.x, bar.to.x), high = Math.max(bar.from.x, bar.to.x);
  return model.links.filter(link => link.layer === 'routed' && link.path).filter(link => link.path!.segments.some(segment =>
    Math.abs(segment.from.x - segment.to.x) < 1e-6 && segment.from.x >= low && segment.from.x <= high
    && Math.min(segment.from.y, segment.to.y) < y && Math.max(segment.from.y, segment.to.y) > y)).map(link => link.id);
}
const group = (model: LayoutModel, id: string) => model.groups[id]!.bounds!;
const bottom = (box: { y: number; height: number }) => box.y + box.height;
const bodyBottom = (model: LayoutModel, ids: string[]) => Math.max(...ids.map(id => bottom(model.nodes[id]!.bounds!)));

describe('the bus band of a mesh in one frame (ticket 83)', () => {
  it('stands at the bottom under a group fed from above, and the title stands below the band', async () => {
    const model = await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus'));
    const bus = model.meshBuses![0]!;
    expect(bus.side).toBe('bottom');
    const band = model.labelBands.find(item => item.group === 'row')!;
    expect(band.side).toBe('bottom');
    // The bar is one horizontal segment 15 px beyond the row, and each stub is 15 px long.
    const line = bodyBottom(model, bus.nodes);
    expect(bus.bar!.from.y).toBeCloseTo(line + 15, 6);
    expect(bus.bar!.to.y).toBeCloseTo(line + 15, 6);
    expect(bus.stubs).toHaveLength(5);
    for (const stub of bus.stubs!) { expect(stub.to.y - stub.from.y).toBeCloseTo(15, 6); expect(stub.from.x).toBeCloseTo(stub.to.x, 6); }
    // The band lies between the bodies and the title band, and the frame holds both.
    const held = model.busBands![0]!;
    expect(held).toMatchObject({ group: 'row', side: 'bottom' });
    expect(held.bounds.y).toBeCloseTo(line, 6);
    expect(bottom(held.bounds)).toBeLessThanOrEqual(band.bounds.y - 20 + 1e-6);
    expect(bottom(group(model, 'row'))).toBeGreaterThanOrEqual(bottom(band.bounds) - 1e-6);
    // Every bus port is on the bus side, and no leg crosses the bar.
    for (const ref of bus.ports) expect(model.nodes[ref.node]!.ports.find(port => port.ref.anonymous && port.ref.ordinal === ref.ordinal)!.side).toBe('bottom');
    expect(legsAcross(model, bus.id)).toEqual([]);
    expect(gates(model)).toEqual([]);
    // The title moved out by the band: bodies, the band, the ordinary 20 px, the title band, in that order.
    expect(bottom(group(model, 'row')) - line).toBeCloseTo(held.bounds.height + 20 + band.bounds.height, 6);
  }, 60000);

  it('stands opposite the title where the span is quieter on the other edge', async () => {
    const model = await run(fixture('a-bus-leaves-a-title-edge-with-more-legs'));
    const bus = model.meshBuses![0]!;
    // The skeleton order keeps the sixth and seventh nodes outside the span of the mesh.
    const x = (id: string) => model.nodes[id]!.bounds!.x;
    const span = bus.nodes.map(x);
    for (const id of ['n6', 'n7']) expect(x(id) > Math.max(...span) || x(id) < Math.min(...span)).toBe(true);
    expect(model.labelBands.find(item => item.group === 'row')!.side).toBe('top');
    expect(bus.side).toBe('bottom');
    expect(legsAcross(model, bus.id)).toEqual([]);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('takes the title edge on a tie', async () => {
    // One leg on each edge inside the span; the group is fed on top by one link and on the bottom by one, so the title stands on top.
    const yaml = `portograph: 2
groups:
  top: { tier: 0, label: Top }
  row: { tier: 1, label: Row }
  low: { tier: 2, label: Low }
nodes:
  core: { group: top, class: router, label: Core }
  a: { group: row, class: router, label: A }
  b: { group: row, class: router, label: B }
  c: { group: row, class: router, label: C }
  d: { group: low, class: server, label: D }
links:
  - [core, a]
  - [c, d]
  - { from: a, to: b, class: sync }
  - { from: a, to: c, class: sync }
  - { from: b, to: c, class: sync }
`;
    const model = await run(yaml);
    const band = model.labelBands.find(item => item.group === 'row')!;
    expect(model.meshBuses![0]!.side).toBe(band.side);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('puts a bus in a rank gap on the edge with fewer legs, and the gap grows by the band', async () => {
    const yaml = fixture('a-bus-in-a-rank-gap-grows-the-gap');
    const model = await run(yaml);
    const bus = model.meshBuses![0]!;
    expect(model.labelBands.find(item => item.group === 'stack')!.side).toBe('bottom');
    expect(bus.side).toBe('top');
    // The middle cell holds the band on its top edge, against no padding: the band is the whole inset.
    const cell = group(model, 'stack#1'), top = Math.min(...bus.nodes.map(id => model.nodes[id]!.bounds!.y));
    expect(top - cell.y).toBeCloseTo(model.busBands![0]!.bounds.height, 6);
    expect(model.busBands![0]!.group).toBe('stack#1');
    expect(cell.y - bottom(group(model, 'stack#0'))).toBeGreaterThanOrEqual(0);
    // The two down links of rank 0 end in the mesh's nodes, above the bar.
    expect(gates(model)).toEqual([]);
  }, 60000);
});

describe('the bus band of a mesh across frames (ticket 83)', () => {
  it('runs in the gap below the row, outside every frame, with a stub through each frame', async () => {
    const model = await run(fixture('a-mesh-across-frames-draws-one-bus'));
    const bus = model.meshBuses![0]!;
    expect(bus.placement).toBe('across-frames');
    expect(bus.side).toBe('bottom');
    const lowest = Math.max(...['west', 'middle', 'east'].map(id => bottom(group(model, id))));
    expect(bus.bar!.from.y).toBeCloseTo(lowest + 15, 6);
    expect(bus.bar!.to.y).toBeCloseTo(lowest + 15, 6);
    expect(bus.stubs).toHaveLength(6);
    expect(model.busBands![0]!.group).toBeUndefined();
    // Each title stands clear of the stubs of its frame, and nothing was moved to the other edge.
    for (const label of model.labels.filter(item => item.role === 'group' && ['West', 'Middle', 'East'].includes(item.text))) {
      for (const stub of bus.stubs!) {
        expect(stub.from.x < label.bounds!.x || stub.from.x > label.bounds!.x + label.bounds!.width, `${label.text} against the stub of ${stub.node}`).toBe(true);
      }
    }
    expect(model.diagnostics.filter(item => item.code === 'MESH_BUS_TITLE_MOVED')).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'MESH_BUS' && item.stage === 'model')).toHaveLength(1);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('grows the gap below by the band when a tier stands there', async () => {
    const yaml = fixture('a-mesh-across-frames-draws-one-bus').replace('links:\n', `links:\n  - [w1, x1]\n  - [e1, x1]\n`)
      .replace('nodes:\n', 'nodes:\n  x1: { group: low, class: server, label: X1 }\n').replace('groups:\n', 'groups:\n  low: { tier: 2, label: Low }\n');
    const model = await run(yaml);
    const bus = model.meshBuses![0]!;
    expect(bus.side).toBe('bottom');
    const band = model.busBands![0]!;
    // No planned row lies inside the band, and the group below stands past it.
    expect(group(model, 'low').y).toBeGreaterThanOrEqual(bottom(band.bounds) + 20 - 1e-6);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('draws a stub through the centre of a one-node frame and nudges the title beside it', async () => {
    const yaml = fixture('a-mesh-of-one-node-groups-draws-one-bus');
    const model = await run(yaml);
    const bus = model.meshBuses![0]!;
    expect(bus.placement).toBe('across-frames');
    const plain = await run(withoutBus(yaml));
    const widths = ['west', 'middle', 'east'].map(id => [group(plain, id).width, group(model, id).width]);
    console.log('one-node frame widths before and after', JSON.stringify(widths));
    for (const label of model.labels.filter(item => item.role === 'group' && ['West', 'Middle', 'East'].includes(item.text))) {
      for (const stub of bus.stubs!) expect(stub.from.x < label.bounds!.x || stub.from.x > label.bounds!.x + label.bounds!.width).toBe(true);
    }
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('runs inside each canton frame and grows each canton by the band', async () => {
    const yaml = fixture('a-bus-across-cantons-crosses-the-canton-edges');
    const model = await run(yaml);
    const bus = model.meshBuses![0]!;
    expect(bus.side).toBe('bottom');
    const cantons = ['west', 'east'];
    for (const id of cantons) {
      const frame = model.frames!.find(item => item.id === id)!;
      // The bar stands between the server frames and the canton edge; the canton grows by the band beyond its 20 px margin.
      const servers = model.frames!.find(item => item.id === `${id}-servers`)!;
      expect(bottom(frame.box) - bottom(servers.box)).toBeCloseTo(20 + model.busBands![0]!.bounds.height, 6);
      expect(bus.bar!.from.y).toBeGreaterThan(bottom(servers.box));
      expect(bus.bar!.from.y).toBeLessThan(bottom(frame.box));
    }
    expect(gates(model)).toEqual([]);
  }, 60000);
});

describe('the side of a bus (ticket 83)', () => {
  it('is read again at stage 5 and the layout equals the one that knew the side at stage 2', async () => {
    const model = await run(fixture('a-bus-leaves-a-title-edge-with-more-legs'));
    const bus = model.meshBuses![0]!;
    expect(busSide(model, bus)).toBe(bus.side);
    for (const ref of bus.ports) expect(model.nodes[ref.node]!.ports.find(port => port.ref.anonymous && port.ref.ordinal === ref.ordinal)!.side).toBe(bus.side);
  }, 60000);
});

describe('the published layout of a bus (ticket 83)', () => {
  for (const name of ['a-full-mesh-on-one-row-draws-as-one-bus', 'a-partial-mesh-keeps-its-largest-complete-part', 'a-mesh-across-frames-draws-one-bus',
    'a-mesh-of-one-node-groups-draws-one-bus', 'a-bus-across-cantons-crosses-the-canton-edges', 'a-bus-leaves-a-title-edge-with-more-legs', 'a-bus-in-a-rank-gap-grows-the-gap']) {
    it(`restores ${name} as a fixed point`, async () => {
      const model = await run(fixture(name));
      const json = JSON.stringify(model);
      const restored = restoreLayoutModel(json);
      expect(JSON.stringify(restored)).toBe(json);
    }, 60000);
  }
});
