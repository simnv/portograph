import { createLayoutModel } from '../../src/model/index.js';
import type { LayoutModel, Point, Rect } from '../../src/model/index.js';

export function empty(): LayoutModel {
  return createLayoutModel({ portograph: 2, profile: 'network', nodes: {}, groups: {}, links: [] });
}

export function node(model: LayoutModel, id: string, bounds: Rect, tier = 0): void {
  const group = `g-${id}`;
  const groupBounds = { x: bounds.x - 10, y: bounds.y - 10, width: bounds.width + 20, height: bounds.height + 20 };
  model.document.groups[group] = { label: group, shape: 'row', tier };
  model.document.nodes[id] = { group, label: id, ports: [] };
  model.nodes[id] = { id, owner: { kind: 'group', id: group }, layer: 'routed', ports: [], bounds };
  model.groups[group] = { id: group, owner: { kind: 'group', id: group }, layer: 'routed', nodes: [id], tier, bounds: groupBounds };
  let band = model.tierBands.find(item => item.tier === tier);
  if (!band) {
    band = { tier, groups: [], bounds: { x: -10000, y: bounds.y - 20, width: 20000, height: bounds.height + 40 } };
    model.tierBands.push(band);
  }
  band.groups.push(group);
  model.canvas = { x: -10, y: -10, width: 1000, height: 1000 };
}

export function link(model: LayoutModel, id: string, from: string, to: string, points: Point[], sides: ['top' | 'bottom' | 'left' | 'right', 'top' | 'bottom' | 'left' | 'right'] = ['bottom', 'top']): void {
  const refs = [from, to].map((name, index) => {
    const target = model.nodes[name]!;
    const ref = { node: name, name: id, ordinal: target.ports.length + 1 };
    target.ports.push({ ref, side: sides[index]!, anchor: { ...(index === 0 ? points[0]! : points.at(-1)!) }, owner: { kind: 'node', id: name }, layer: 'routed' });
    return ref;
  });
  const owner = { kind: 'link' as const, id };
  model.links.push({ id, sourceIndex: model.links.length, owner, from: refs[0]!, to: refs[1]!, family: 'routed', layer: 'routed', technique: 'orthogonal', path: { owner, layer: 'routed', fixed: true, segments: points.slice(1).map((to, index) => ({ from: { ...points[index]! }, to: { ...to }, owner })) } });
}

export function simple(): LayoutModel {
  const model = empty();
  node(model, 'a', { x: 0, y: 0, width: 60, height: 40 }, 0);
  node(model, 'b', { x: 0, y: 140, width: 60, height: 40 }, 1);
  link(model, 'ab', 'a', 'b', [{ x: 30, y: 40 }, { x: 30, y: 140 }]);
  return model;
}

/** Parallel runs through a clear gap, with enough distance for all stroke clearances. */
export function parallel(gap = 30): LayoutModel {
  const model = empty();
  node(model, 'a', { x: 0, y: 0, width: 100, height: 40 }, 0);
  node(model, 'b', { x: 0, y: 140, width: 100, height: 40 }, 1);
  link(model, 'one', 'a', 'b', [{ x: 30, y: 40 }, { x: 30, y: 140 }]);
  link(model, 'two', 'a', 'b', [{ x: 30 + gap, y: 40 }, { x: 30 + gap, y: 140 }]);
  return model;
}

export function bundle(model: LayoutModel): void {
  const owner = { kind: 'bundle' as const, id: 'bundle' };
  model.bundles.push({ id: 'bundle', owner, layer: 'routed', nodes: ['a', 'b'], members: model.links.map(l => l.id), memberGap: 16, envelope: { x: 0, y: 40, width: 100, height: 100 }, inversions: 3 });
  model.links.forEach(l => { l.bundle = 'bundle'; l.path!.segments.forEach(s => { s.owner = owner; }); });
  if (model.links.every(l => JSON.stringify(l.path!.segments) === JSON.stringify(model.links[0]!.path!.segments))) {
    model.links.forEach(l => { l.technique = 'merge'; });
    model.bundles[0]!.mergeRuns = [{ id: 'merge', members: model.links.map(l => l.id), count: model.links.length, path: structuredClone(model.links[0]!.path!) }];
    model.bundles[0]!.mergeRuns[0]!.path.owner = owner;
  }
}
