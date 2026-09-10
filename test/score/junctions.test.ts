import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment, Side } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { empty, link, node, parallel } from './fixtures.js';

function fan(orientation: 'source' | 'target' | 'mixed', side: Side): LayoutModel {
  const model = empty();
  node(model, 'a', { x: 0, y: 0, width: 100, height: 40 });
  node(model, 'b', { x: 0, y: 220, width: 100, height: 40 }, 1);
  link(model, 'one', 'a', 'b', [{ x: 50, y: 40 }, { x: 50, y: 80 }, { x: 20, y: 80 }, { x: 20, y: 220 }]);
  link(model, 'two', 'a', 'b', [{ x: 50, y: 40 }, { x: 50, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 220 }]);
  model.links[1]!.from = model.links[0]!.from;
  const owner = { kind: 'shared-stem' as const, id: 'j' };
  for (const item of model.links) item.path!.segments.slice(0, 2).forEach(s => { s.owner = owner; });
  model.junctions.push({ id: 'j', owner, layer: 'routed', port: model.nodes.a!.ports[0]!.ref,
    links: model.links.map(l => l.id), point: { x: 50, y: 80 }, stem: { ...model.links[0]!.path!.segments[0]! } });
  const rotate = (p: { x: number; y: number }) => side === 'bottom' ? p : side === 'top' ? { x: p.x, y: -p.y }
    : side === 'right' ? { x: p.y, y: p.x } : { x: -p.y, y: p.x };
  for (const item of model.links) for (const s of item.path!.segments) { s.from = rotate(s.from); s.to = rotate(s.to); }
  for (const n of Object.values(model.nodes)) for (const p of n.ports) { p.anchor = rotate(p.anchor!); if (n.id === 'a') p.side = side; }
  model.junctions[0]!.stem = { ...model.links[0]!.path!.segments[0]! };
  model.junctions[0]!.point = model.junctions[0]!.stem!.to;
  for (const [i, item] of model.links.entries()) if (orientation === 'target' || orientation === 'mixed' && i === 1) {
    [item.from, item.to] = [item.to, item.from];
    item.path!.segments = [...item.path!.segments].reverse().map(s => ({ ...s, from: s.to, to: s.from }));
  }
  return model;
}

describe('verified shared runs', () => {
  for (const side of ['top', 'right', 'bottom', 'left'] as const) for (const orientation of ['source', 'target', 'mixed'] as const) {
    it(`recognizes ${orientation} incidence on ${side}`, () => {
      const model = fan(orientation, side), scored = score(model);
      expect(scored.snapshot.gates.G4).toMatchObject({ passed: true });
      expect(scored.snapshot.gates.G6.violations.filter(v => v.code === 'parallel-clearance')).toEqual([]);
      model.junctions[0]!.links = ['one', 'forged'];
      expect(score(model).snapshot.gates.G4.passed).toBe(false);
    });
  }
  it('exempts only local branches at a valid tree vertex', () => {
    const model = fan('mixed', 'bottom'), root = model.junctions[0]!;
    // A child is shared by a strict subset of three incident members.
    const third = structuredClone(model.links[0]!); third.id = 'three';
    third.path!.segments = [structuredClone(third.path!.segments[0]!), { from: root.point!, to: { x: 0, y: 80 }, owner: root.owner }];
    model.links.push(third); root.links.push('three');
    const owner = { kind: 'shared-stem' as const, id: 'child' };
    const child: PathSegment = { from: root.point!, to: { x: 50, y: 120 }, owner };
    const one = model.links[0]!, two = model.links[1]!;
    one.path!.segments.splice(1, 1, structuredClone(child), { from: child.to, to: { x: 20, y: 120 }, owner });
    one.path!.segments.at(-1)!.from.y = 120;
    two.path!.segments.splice(1, 1, { from: { x: 80, y: 120 }, to: child.to, owner }, { ...child, from: child.to, to: child.from });
    two.path!.segments[0]!.to.y = 120;
    model.junctions.push({ id: 'child', parent: root.id, owner, layer: 'routed', port: root.port, links: ['one', 'two'], point: child.to, stem: child });
    expect(score(model).snapshot.gates.G4).toMatchObject({ passed: true });
    expect(score(model).snapshot.gates.G6.violations.filter(v => v.code === 'parallel-clearance')).toEqual([]);
    model.junctions[1]!.parent = 'child';
    expect(score(model).snapshot.gates.G4.passed).toBe(false);
  });
  it('leaves ordinary distinct-port reversed order invalid but allows overlapping peer ranges', () => {
    const model = parallel(30), one = model.links[0]!, two = model.links[1]!;
    const a = structuredClone(one), b = structuredClone(two);
    a.id = 'cross-one'; a.to = two.to; b.id = 'cross-two'; b.to = one.to;
    model.links.push(a, b);
    expect(score(model).snapshot.gates.G5.violations.filter(v => v.code === 'port-order')).toEqual([]);
    model.links = [a, b];
    expect(score(model).snapshot.gates.G5.violations.some(v => v.code === 'port-order')).toBe(true);
  });
});

it('requires exact selected membership/count for a merged overlap', () => {
  const model = parallel(0), owner = { kind: 'bundle' as const, id: 'b' };
  model.bundles = [{ id: 'b', owner, layer: 'routed', nodes: ['a', 'b'], members: ['one', 'two'], memberGap: 16, envelope: { x: 0, y: 40, width: 100, height: 100 }, mergeRuns: [] }];
  model.links.forEach(l => { l.bundle = 'b'; l.technique = 'merge'; l.path!.segments.forEach(s => { s.owner = owner; }); });
  model.bundles[0]!.mergeRuns!.push({ id: 'counted', members: ['one', 'two'], count: 2, path: { ...structuredClone(model.links[0]!.path!), owner } });
  expect(score(model).snapshot.gates.G4.passed).toBe(true);
  model.bundles[0]!.mergeRuns![0]!.count = 1;
  expect(score(model).snapshot.gates.G4.passed).toBe(false);
  model.bundles[0]!.mergeRuns![0]!.count = 2;
  model.links[1]!.technique = 'bundle';
  expect(score(model).snapshot.gates.G4.passed).toBe(false);
});
