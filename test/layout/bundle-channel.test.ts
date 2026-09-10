import { expect, it } from 'vitest';
import { empty, node, link } from '../score/fixtures.js';
import { rebuildBundlePaths } from '../../src/layout/bundle-paths.js';
import { endpoints } from '../../src/score/model.js';
import { score } from '../../src/score/index.js';

it.each([17.5, 30])('routes the whole swept channel around a foreign box at pitch %s', (spacing) => {
  const model = empty();
  node(model, 'a', { x: 0, y: 0, width: 60, height: 80 });
  node(model, 'b', { x: 300, y: 0, width: 60, height: 80 });
  node(model, 'middle', { x: 150, y: 0, width: 60, height: 80 });
  for (const [id, y] of [['one', 20], ['two', 20 + spacing]] as const) link(model, id, 'a', 'b', [{ x: 60, y }, { x: 300, y }], ['right', 'left']);
  const owner = { kind: 'bundle' as const, id: 'bundle' };
  model.bundles = [{ id: 'bundle', owner, layer: 'routed', nodes: ['a', 'b'], members: model.links.map(l => l.id) }];
  model.links.forEach(l => { l.bundle = 'bundle'; l.technique = 'bundle'; l.attachments = endpoints(l); });
  rebuildBundlePaths(model);
  expect(model.links.every(l => l.path!.segments.length > 1)).toBe(true);
  expect(model.bundles[0]!.centreline!.segments.length).toBeGreaterThan(1);
  for (const [index, segment] of model.bundles[0]!.centreline!.segments.entries()) {
    const extent = model.bundles[0]!.envelopeParts![index]!;
    expect(segment.from.x === segment.to.x ? extent.width : extent.height).toBeCloseTo(spacing + 1.5);
  }
  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
});

it('centres a straight bundle on physical extrema despite shuffled declaration order', () => {
  const model = empty();
  node(model, 'a', { x: 0, y: 0, width: 60, height: 80 });
  node(model, 'b', { x: 300, y: 0, width: 60, height: 80 });
  for (const [id, y] of [['one', 20], ['three', 60], ['two', 40]] as const) link(model, id, 'a', 'b', [{ x: 60, y }, { x: 300, y }], ['right', 'left']);
  const owner = { kind: 'bundle' as const, id: 'bundle' };
  model.bundles = [{ id: 'bundle', owner, layer: 'routed', nodes: ['a', 'b'], members: model.links.map(l => l.id) }];
  model.links.forEach(l => { l.bundle = 'bundle'; l.technique = 'bundle'; l.attachments = endpoints(l); });
  rebuildBundlePaths(model);
  expect(model.bundles[0]!.centreline!.segments).toEqual([{ from: { x: 60, y: 40 }, to: { x: 300, y: 40 }, owner }]);
});
