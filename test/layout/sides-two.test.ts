import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { withLayoutMutation, restoreLayoutModel } from '../../src/layout/mutation.js';
import { serializeLayoutModel } from '../../src/model/model.js';
import { placed, simple, createAttempt } from './phase-two-fixture.js';
describe('stage 5 sides and geometry', () => {
  it('runs the unchanged golden through the real worker and freezes facing EBR ports', async () => {
    const model = await placed(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8'));
    expect(model.stage).toBe('sides-two');
    expect(model.nodes['EBR-01']!.ports.slice(0, 2).map(p => p.side)).toEqual(['right', 'right']);
    expect(model.nodes['EBR-02']!.ports.slice(0, 2).map(p => p.side)).toEqual(['left', 'left']);
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    expect(model.labels.filter(label => label.role === 'pill')).toHaveLength(52);
    expect(model.nodes['EBR-01']!.icon?.bounds.width).toBe(12);
    expect(Object.isFrozen(model.nodes['EBR-01']!.ports)).toBe(true);
  });
  it('protects direct writes, transactions and restored snapshots', async () => {
    const model = await placed(simple);
    const before = serializeLayoutModel(model);
    expect(() => { model.nodes.a!.ports[0]!.side = 'left'; }).toThrow();
    expect(() => withLayoutMutation(model, 'rows', draft => { draft.nodes.a!.ports[0]!.ref.ordinal++; })).toThrow();
    expect(serializeLayoutModel(model)).toBe(before);
    const restored = restoreLayoutModel(before);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(() => withLayoutMutation(restored, 'rows', draft => { draft.nodes.a!.size!.width = 1; })).toThrow();
  });
});

it('separates measured facing pills including strokes', async () => {
  const model = await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: unusually-long-port, side: right}]}
  b: {group: g, ports: [{name: unusually-long-port, side: left}]}
links: [[a.unusually-long-port, b.unusually-long-port]]`);
  const a = model.nodes.a!.ports[0]!.pill!.bounds, b = model.nodes.b!.ports[0]!.pill!.bounds;
  expect(b.x - a.x - a.width).toBeGreaterThanOrEqual(1);
});

it('recomputes mixed shared-port majority and grows a newly crowded side in skeleton order', async () => {
  const yaml = `portograph: 2
groups: {g: {tier: 0, shape: row}, h: {tier: 1}}
nodes:
  a: {group: g, label: '', ports: [p, q, r, s, t]}
  b: {group: g, label: '', ports: [p]}
  c: {group: g, label: '', ports: [p]}
  d: {group: h, label: '', ports: [p]}
links: [[a.p, b.p], [a.p, c.p], [a.p, d.p], [a.q, b.p], [a.r, b.p], [a.s, b.p], [a.t, b.p]]`;
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  const original = model.nodes.a!.size!.height;
  await skeleton(model, { createAttempt });
  // ELK is allowed to reverse declaration order. This legal skeleton puts every same-tier peer to the right.
  model.groups.g!.rowOrder = ['a', 'b', 'c'];
  model.nodes.a!.bounds!.x = 24; model.nodes.b!.bounds!.x = 140; model.nodes.c!.bounds!.x = 240;
  // Capacity initially spreads across sides; the phase-two result must use all votes and remeasure.
  model.nodes.a!.size!.height = 35; model.nodes.a!.bounds!.height = 35;
  const result = sidesTwo(model);
  expect(result.nodes.a!.ports[0]!.side).toBe('right');
  expect(result.nodes.a!.size!.height).toBeGreaterThan(35);
  expect(result.nodes.a!.size!.height).toBeGreaterThanOrEqual(original);
  const order = result.groups.g!.rowOrder!;
  for (let i = 1; i < order.length; i++) {
    const prior = result.nodes[order[i - 1]!]!.bounds!, next = result.nodes[order[i]!]!.bounds!;
    expect(next.x - prior.x - prior.width).toBeGreaterThanOrEqual(22);
  }
});

it('orders slots by distinct far-end anchors on the same peer node', async () => {
  const model = sizeNodes(sidesOne(resolve(parse(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: h, size: {width: 300, height: 150}, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.q], [a.q, b.p]]`))));
  await skeleton(model, { createAttempt });
  const box = model.nodes.b!.bounds!;
  model.nodes.b!.ports[0]!.anchor = { x: box.x + 20, y: box.y };
  model.nodes.b!.ports[1]!.anchor = { x: box.x + 100, y: box.y };
  const result = sidesTwo(model);
  expect(result.nodes.a!.ports.map(port => port.engineOrder)).toEqual([1, 0]);
});

it('keeps a known top majority when final same-tier votes split left and right', async () => {
  const model = sizeNodes(sidesOne(resolve(parse(`portograph: 2
groups: {upper: {tier: 0}, row: {tier: 1, shape: row}}
nodes:
  up1: {group: upper, ports: [p]}
  up2: {group: upper, ports: [p]}
  left: {group: row, ports: [p]}
  middle: {group: row, ports: [p]}
  right: {group: row, ports: [p]}
links: [[middle.p, up1.p], [middle.p, up2.p], [middle.p, left.p], [middle.p, right.p]]`))));
  expect(model.nodes.middle!.ports[0]!.side).toBeUndefined();
  await skeleton(model, { createAttempt });
  model.groups.row!.rowOrder = ['left', 'middle', 'right'];
  expect(sidesTwo(model).nodes.middle!.ports[0]!.side).toBe('top');
});
