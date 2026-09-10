import { describe, expect, it } from 'vitest';
import { placed, simple } from './phase-two-fixture.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { serializeLayoutModel, serializeLayoutSnapshot } from '../../src/model/model.js';
import { withLayoutMutation, restoreLayoutModel, freezePortTopology, type PlacementRule } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
const advance = (model: LayoutModel, rules: PlacementRule[]) => rules.reduce((m, rule) => withLayoutMutation(m, rule, () => {}), model);
const throughCentre: PlacementRule[] = ['rows', 'lanes', 'flanks', 'centre'];
const bundleYaml = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, class: router, description: detail, ports: [{name: p, side: bottom, order: -2}, {name: free, side: bottom}, {name: r, side: bottom, order: 4}]}
  b: {group: h, ports: [p, q, r]}
links: [[a.p, b.p], [a.free, b.q], [a.r, b.r]]`;
describe('checked public layout transactions', () => {
  it.each([
    ['name', (m: LayoutModel) => { m.nodes.a!.ports[0]!.ref = { node: 'a', name: 'changed', ordinal: 1 }; }],
    ['ordinal', (m: LayoutModel) => { m.nodes.a!.ports[0]!.ref.ordinal++; }],
    ['node', (m: LayoutModel) => { m.nodes.a!.ports[0]!.ref.node = 'b'; }],
    ['anonymous', (m: LayoutModel) => { m.nodes.a!.ports[0]!.ref = { node: 'a', anonymous: true, ordinal: 1 }; }],
    ['add', (m: LayoutModel) => { m.nodes.a!.ports.push({ ...m.nodes.a!.ports[0]! }); }],
    ['delete', (m: LayoutModel) => { m.nodes.a!.ports.pop(); }],
    ['replace', (m: LayoutModel) => { m.nodes.a!.ports.reverse(); }],
    ['side', (m: LayoutModel) => { m.nodes.a!.ports[0]!.side = 'left'; }],
    ['order insertion', (m: LayoutModel) => { m.nodes.a!.ports[1]!.authorOrder = 0; }],
    ['order deletion', (m: LayoutModel) => { delete m.nodes.a!.ports[0]!.authorOrder; }],
    ['floor', (m: LayoutModel) => { m.nodes.a!.sizeFloor!.width = 1; }],
    ['stage', (m: LayoutModel) => { m.stage = 'bars'; }],
    ['attachment', (m: LayoutModel) => { m.links[0]!.attachments!.from = { ...m.nodes.a!.ports[0]!.ref }; }],
  ] as const)('rejects %s changes and leaves input byte-equivalent', async (_name, edit) => {
    const model = await placed(simple), before = serializeLayoutModel(model);
    expect(() => withLayoutMutation(model, 'rows', edit)).toThrow();
    expect(serializeLayoutModel(model)).toBe(before);
  });
  it('rejects map replacement, raw JSON, wrong stage, async callbacks and retained-draft writes', async () => {
    const model = await placed(simple);
    expect(() => { model.nodes = {}; }).toThrow();
    expect(() => { model.nodes.a!.ports = []; }).toThrow();
    expect(() => withLayoutMutation(JSON.parse(serializeLayoutModel(model)), 'rows', () => {})).toThrow(/protected/);
    expect(() => withLayoutMutation(model, 'bars', () => {})).toThrow(/predecessor/);
    expect(() => withLayoutMutation(model, 'rows', async () => {})).toThrow(/synchronous/);
    let retained: LayoutModel | undefined;
    const committed = withLayoutMutation(model, 'rows', draft => { retained = draft; draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'TEST', message: 'test' }); });
    retained!.nodes.a!.bounds!.x = 999;
    expect(committed.nodes.a!.bounds!.x).not.toBe(999);
    expect(committed.runtime.stages.at(-1)!.stage).toBe('rows');
  });
  it('allows free bundle slots around author keys and rejects reversed authored slots', async () => {
    const model = advance(await placed(bundleYaml), [...throughCentre, 'bars']);
    const moved = withLayoutMutation(model, 'bundles', draft => {
      const [a, free, b] = draft.nodes.a!.ports;
      free!.engineOrder = 0; a!.engineOrder = 1; b!.engineOrder = 2;
      rebuildNodeGeometry(draft, ['a'], 'from-slots');
    });
    expect(moved.nodes.a!.ports[0]!.engineOrder).toBe(1);
    expect(moved.nodes.a!.ports[0]!.authorOrder).toBe(-2);
    expect(() => withLayoutMutation(model, 'bundles', draft => {
      draft.nodes.a!.ports[0]!.engineOrder = 2; draft.nodes.a!.ports[2]!.engineOrder = 0;
      rebuildNodeGeometry(draft, ['a'], 'from-slots');
    })).toThrow(/Author order/);
  });
  it('rebuilds content once after growth with asymmetric insets and preserves explicit anchors', async () => {
    const model = advance(await placed(bundleYaml.replace('g: {tier: 0}', 'g: {tier: 0, shape: bar}')), throughCentre);
    const before = serializeLayoutModel(model);
    const moved = withLayoutMutation(model, 'bars', draft => {
      const node = draft.nodes.a!;
      node.bounds!.width += 50; node.size!.width += 50;
      // Anchors remain deliberately left of their default newly centred slots.
    });
    expect(moved.nodes.a!.ports[0]!.anchor).toEqual(model.nodes.a!.ports[0]!.anchor);
    expect(moved.nodes.a!.icon!.bounds.x).toBeCloseTo(model.nodes.a!.icon!.bounds.x + 25);
    expect(moved.labels.filter(label => label.id === 'node:"a":description')).toHaveLength(1);
    expect(serializeLayoutModel(model)).toBe(before);
    expect(() => withLayoutMutation(model, 'bars', draft => { draft.nodes.a!.ports[0]!.anchor!.y++; })).toThrow(/Anchor/);
  });
  it('restores and checks topology, semantic attachments, finite geometry and final placement', async () => {
    const model = await placed(simple);
    const corrupted = (edit: (m: LayoutModel) => void) => { const m: LayoutModel = JSON.parse(serializeLayoutModel(model)); edit(m); return JSON.stringify(m); };
    expect(() => restoreLayoutModel(corrupted(m => { delete m.freeze; }))).toThrow(/freeze/);
    expect(() => restoreLayoutModel(corrupted(m => { m.freeze!.topology[0]!.ports[0]!.side = 'left'; }))).toThrow(/topology/);
    expect(() => restoreLayoutModel(corrupted(m => { m.links[0]!.attachments!.from = { ...m.nodes.a!.ports[0]!.ref }; }))).toThrow(/semantics/);
    expect(() => restoreLayoutModel(corrupted(m => { m.nodes.a!.bounds!.width = -1; }))).toThrow();
    const bands = advance(model, [...throughCentre, 'bars', 'bundles', 'bands']);
    const restored = restoreLayoutModel(serializeLayoutModel(bands));
    expect(() => withLayoutMutation(restored, 'route', draft => { draft.nodes.a!.bounds!.x++; })).toThrow(/placement/);
    expect(() => freezePortTopology(restored)).toThrow();
    const routed = withLayoutMutation(restored, 'route', draft => { draft.runtime.totalMs = 100; });
    expect(routed.runtime.totalMs).toBe(100);
    expect(serializeLayoutSnapshot(routed)).not.toContain('totalMs');
  });
  it('rejects unimplemented path claims instead of accepting a validator flag', async () => {
    const model = await placed(simple);
    expect(() => withLayoutMutation(model, 'rows', draft => {
      draft.links[0]!.path = { owner: draft.links[0]!.owner, layer: 'routed', fixed: true, segments: [] };
    })).toThrow(/not implemented/);
  });
});

it('allows measured flank pitch growth with matching geometry and rejects unrelated movement', async () => {
  const model = advance(await placed(`portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: left}, {name: q, side: left}]}
  b: {group: f, class: router, description: text, ports: [{name: p, side: right}, {name: q, side: right}]}
links: [[a.p, b.p], [a.q, b.q]]`), ['rows', 'lanes']);
  const result = withLayoutMutation(model, 'flanks', draft => {
    for (const [id, side] of [['a', 'left'], ['b', 'right']] as const) {
      const node = draft.nodes[id]!;
      node.sidePitch![side] = 30;
      node.size!.height = Math.max(node.size!.height, 80); node.bounds!.height = node.size!.height;
    }
    rebuildNodeGeometry(draft, ['a', 'b'], 'from-slots');
  });
  expect(result.nodes.b!.ports[1]!.anchor!.y - result.nodes.b!.ports[0]!.anchor!.y).toBe(30);
  expect(result.nodes.b!.icon).toBeDefined();
  expect(restoreLayoutModel(serializeLayoutModel(result)).nodes.b!.sidePitch!.right).toBe(30);
});

it('rejects semantic attachment replacement for expanded group links', async () => {
  const model = await placed(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes: {a: {group: g}, b: {group: g}, c: {group: h}, d: {group: h}}
links: [{from: {group: g}, to: {group: h}}]`);
  const copy: LayoutModel = JSON.parse(serializeLayoutModel(model));
  copy.links[0]!.attachments!.from = { ...copy.links[1]!.attachments!.from };
  // Select a different valid port even if expansion puts the first two on the same node.
  copy.links[0]!.attachments!.from = { ...copy.nodes.b!.ports[0]!.ref };
  expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/semantics/);
});

it('preserves integer declaration order and accepts an empty canvas', async () => {
  const model = await placed(`portograph: 2
groups: {'20': {tier: 0}, '3': {tier: 1}}
nodes: {'10': {group: '20'}, '2': {group: '3'}}
links: []`);
  expect(model.freeze!.topology.map(entry => entry.node)).toEqual(['10', '2']);
  expect(restoreLayoutModel(serializeLayoutModel(model)).freeze!.floors.map(entry => entry.node)).toEqual(['10', '2']);
  const empty = await placed('portograph: 2\ngroups: {}\nnodes: {}\nlinks: []');
  const emptyJson: LayoutModel = JSON.parse(serializeLayoutModel(empty));
  emptyJson.canvas = { x: 0, y: 0, width: 0, height: 0 };
  expect(restoreLayoutModel(JSON.stringify(emptyJson)).canvas!.width).toBe(0);
});
