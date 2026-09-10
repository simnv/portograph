import { describe, expect, it } from 'vitest';
import type { LayoutLabel, LayoutModel, PathSegment } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { bundle, empty, node, parallel, simple } from './fixtures.js';

const gate = (model: LayoutModel, id: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8') => score(model).snapshot.gates[id];
const label = (id: string, x: number, y: number, owner: LayoutLabel['owner'] = { kind: 'node', id: 'a' }): LayoutLabel => ({ id, text: id, bounds: { x, y, width: 10, height: 6 }, owner, layer: 'routed' });

describe('G1 and G8 containment', () => {
  it('rejects overlapping nodes and groups', () => {
    const model = simple();
    node(model, 'c', { x: 20, y: 10, width: 40, height: 20 });
    expect(gate(model, 'G1').violations.map(v => v.code)).toEqual(expect.arrayContaining(['node-overlap', 'group-overlap']));
  });
  it('rejects nodes outside the owning group, including wrong ownership', () => {
    const model = simple();
    model.nodes.a!.bounds!.x = -20;
    expect(gate(model, 'G1').passed).toBe(false);
    model.nodes.a!.bounds!.x = 0;
    model.nodes.a!.owner = { kind: 'group', id: 'g-b' };
    expect(gate(model, 'G1').passed).toBe(false);
  });
  it('enforces group containment and band order even when bands are listed out of order', () => {
    const model = simple();
    model.tierBands.reverse();
    expect(gate(model, 'G8').passed).toBe(true);
    model.groups['g-a']!.bounds!.x = -20000;
    expect(gate(model, 'G8').violations.some(v => v.code === 'group-tier')).toBe(true);
    model.groups['g-a']!.bounds!.x = -10;
    model.tierBands[0]!.bounds!.y = 10;
    expect(gate(model, 'G8').violations.some(v => v.code === 'tier-order')).toBe(true);
  });
});

describe('G2 routed node contact', () => {
  it('allows incident anchor contact and rejects foreign node contact', () => {
    const model = simple();
    expect(gate(model, 'G2').passed).toBe(true);
    node(model, 'foreign', { x: 20, y: 75, width: 20, height: 20 });
    expect(gate(model, 'G2').passed).toBe(false);
    model.links[0]!.layer = model.links[0]!.path!.layer = 'overlay';
    expect(gate(model, 'G2').passed).toBe(true);
  });
  it('does not waive later segments that reenter an endpoint node', () => {
    const model = simple(), owner = model.links[0]!.owner;
    model.links[0]!.path!.segments.push({ from: { x: 30, y: 140 }, to: { x: 30, y: 0 }, owner });
    expect(gate(model, 'G2').passed).toBe(false);
  });
  it('allows only a bar-owned recorded drop crossing within its span', () => {
    const model = simple();
    node(model, 'bar', { x: 0, y: 80, width: 60, height: 10 });
    model.document.groups['g-bar']!.shape = 'bar';
    const l = model.links[0]!, owner = { kind: 'barCross' as const, node: 'bar', link: l.id };
    l.path!.segments[0]!.barCross = ['bar'];
    model.barDrops.push({ id: 'drop', owner, layer: 'routed', link: l.id, source: model.nodes.a!.ports[0]!.ref, port: model.nodes.b!.ports[0]!.ref, slotX: 30, span: { min: 0, max: 60 }, barCross: ['bar'] });
    expect(gate(model, 'G2').passed).toBe(true);
    expect(score(model).snapshot.counters.barCross).toBe(1);
    expect(gate(model, 'G6').violations.some(v => v.elements.includes('bar') && v.code === 'segment-node-clearance')).toBe(false);
    model.barDrops[0]!.owner = { kind: 'barCross', node: 'bar', link: 'other' };
    expect(gate(model, 'G2').passed).toBe(false);
    model.barDrops[0]!.owner = owner;
    model.barDrops[0]!.span.max = 20;
    expect(gate(model, 'G2').passed).toBe(false);
  });
  it('requires one bar-owned record for each of two crossed bars', () => {
    const model = simple(), l = model.links[0]!;
    for (const [id, y] of [['upper', 70], ['lower', 100]] as const) {
      node(model, id, { x: 0, y, width: 60, height: 10 });
      model.document.groups[`g-${id}`]!.shape = 'bar';
      model.barDrops.push({ id: `drop-${id}`, owner: { kind: 'barCross', node: id, link: l.id }, layer: 'routed', link: l.id, source: model.nodes.a!.ports[0]!.ref, port: model.nodes.b!.ports[0]!.ref, slotX: 30, span: { min: 0, max: 60 }, barCross: ['upper', 'lower'] });
    }
    l.path!.segments[0]!.barCross = ['upper', 'lower'];
    expect(gate(model, 'G2').passed).toBe(true);
    expect(score(model).snapshot.counters.barCross).toBe(2);
    model.barDrops[1]!.owner = { kind: 'barCross', node: 'upper', link: l.id };
    expect(gate(model, 'G2').violations.some(v => v.elements.includes('lower'))).toBe(true);
  });
});

describe('G3 labels', () => {
  it('allows owner node labels but rejects foreign owners and label pairs', () => {
    const model = simple();
    model.labels.push(label('text', 5, 5));
    expect(gate(model, 'G3').passed).toBe(true);
    model.labels[0]!.owner = { kind: 'node', id: 'b' };
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[0]!.owner = { kind: 'node', id: 'a' };
    model.labels.push(label('other', 6, 6));
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[1]!.layer = 'overlay';
    expect(gate(model, 'G3').passed).toBe(true);
  });
  it('allows link labels on their own clearance zone, not a different link', () => {
    const model = simple();
    model.labels.push(label('link text', 29.5, 80, { kind: 'link', id: 'ab' }));
    expect(gate(model, 'G3').passed).toBe(true);
    model.labels[0]!.owner = { kind: 'link', id: 'wrong' };
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[0]!.bounds!.x = 30.5;
    expect(gate(model, 'G3').passed).toBe(false); // Centerline misses, stroke hits.
    model.labels[0]!.bounds!.x = 31;
    expect(gate(model, 'G3').passed).toBe(true);
  });
  it('exempts pill text only from its specific pill and incident stem', () => {
    const model = simple(), p = model.nodes.a!.ports[0]!;
    p.pill = { size: { width: 24, height: 10 }, bounds: { x: 18, y: 35, width: 24, height: 10 }, owner: { kind: 'node', id: 'a' }, layer: 'routed', radius: 3, textRotation: 0 };
    model.labels.push({ ...label('pill', 26, 37), role: 'pill', port: p.ref });
    expect(gate(model, 'G3').passed).toBe(true);
    p.pill.owner = { kind: 'node', id: 'b' };
    expect(gate(model, 'G3').passed).toBe(false);
    p.pill.owner = { kind: 'node', id: 'a' };
    model.labels[0]!.port = { node: 'a', name: 'wrong', ordinal: 2 };
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[0]!.port = p.ref;
    model.labels[0]!.role = 'node';
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[0]!.role = 'pill';
    model.labels[0]!.bounds!.y = 43;
    expect(gate(model, 'G3').passed).toBe(false); // Beyond the own pill, the stem is an obstacle.
    model.labels[0]!.bounds!.y = 37;
    const l = model.links[0]!;
    l.path!.segments.push({ from: { x: 30, y: 140 }, to: { x: 30, y: 35 }, owner: l.owner });
    expect(gate(model, 'G3').passed).toBe(false); // Later segments do not inherit the incident exception.
    l.path!.segments.pop();
    const other = { ...l, id: 'other', from: { node: 'a', name: 'other', ordinal: 2 }, path: { ...l.path!, segments: l.path!.segments.map(s => ({ ...s })) } };
    model.nodes.a!.ports.push({ ...p, ref: { node: 'a', name: 'other', ordinal: 2 } });
    model.links.push(other);
    expect(gate(model, 'G3').passed).toBe(false); // A different port's stem remains an obstacle.
    model.links.pop(); model.nodes.a!.ports.pop();
    model.nodes.a!.ports.push({ ...p, ref: { node: 'a', name: 'second', ordinal: 2 }, pill: { ...p.pill, bounds: { ...p.pill.bounds } } });
    expect(gate(model, 'G3').passed).toBe(false);
  });
  it('ignores omitted and overlay labels but checks group labels against nodes', () => {
    const model = simple();
    model.labels.push({ id: 'missing', text: '', omitted: true, owner: { kind: 'link', id: 'ab' }, layer: 'routed' });
    expect(score(model).snapshot.counters.labelsOmitted).toBe(1);
    model.labels.push(label('group', 5, 5, { kind: 'group', id: 'g-a' }));
    expect(gate(model, 'G3').passed).toBe(false);
  });
});

describe('G4 overlap sweep and owners', () => {
  it('handles reversed intervals, shared endpoints, and the >1 px threshold', () => {
    const model = parallel(0), second = model.links[1]!.path!.segments[0]!;
    [second.from, second.to] = [second.to, second.from];
    expect(score(model).snapshot.counters.overlaps).toBe(1);
    second.from.y = 140; second.to.y = 150;
    expect(gate(model, 'G4').passed).toBe(true);
    second.from.y = 139;
    expect(gate(model, 'G4').passed).toBe(true);
    second.from.y = 138.9;
    expect(gate(model, 'G4').passed).toBe(false);
    model.links[1]!.layer = model.links[1]!.path!.layer = 'overlay';
    expect(gate(model, 'G4').passed).toBe(true);
  });
  it('reports bundle overlap length only for member-owned runs within the envelope', () => {
    const model = parallel(0); bundle(model);
    expect(gate(model, 'G4').passed).toBe(true);
    expect(score(model).snapshot.counters.bundledLength).toBe(100);
    model.links[1]!.path!.segments[0]!.owner = { kind: 'bundle', id: 'other' };
    expect(gate(model, 'G4').passed).toBe(false);
    model.links[1]!.path!.segments[0]!.owner = { kind: 'bundle', id: 'bundle' };
    model.bundles[0]!.envelope!.height = 50;
    expect(gate(model, 'G4').passed).toBe(false);
  });
  it('allows only the explicit common-port stem extent', () => {
    const model = parallel(0), a = model.links[0]!, b = model.links[1]!, owner = { kind: 'shared-stem' as const, id: 'j' };
    b.from = a.from;
    const stem: PathSegment = { from: { x: 30, y: 40 }, to: { x: 30, y: 70 }, owner };
    a.path!.segments = [{ ...stem }, { from: { x: 30, y: 70 }, to: { x: 0, y: 70 }, owner }];
    b.path!.segments = [{ ...stem }, { from: { x: 30, y: 70 }, to: { x: 60, y: 70 }, owner }];
    model.junctions.push({ id: 'j', owner, layer: 'routed', port: model.nodes.a!.ports[0]!.ref, links: ['one', 'two'], point: stem.to, stem });
    expect(gate(model, 'G4').passed).toBe(true);
    expect(gate(model, 'G6').violations.some(v => v.code === 'parallel-clearance')).toBe(false);
    model.junctions[0]!.links = ['one', 'wrong'];
    expect(gate(model, 'G4').passed).toBe(false);
    expect(gate(model, 'G6').violations.some(v => v.code === 'parallel-clearance')).toBe(true);
    model.junctions[0]!.links = ['one', 'two'];
    model.junctions[0]!.stem = { ...stem, to: { x: 30, y: 60 } };
    expect(gate(model, 'G4').passed).toBe(false);
  });
  it('allows lane runs only for their explicit owner', () => {
    const model = simple();
    model.lanes.push({ id: 'lane', owner: { kind: 'link', id: 'ab' }, layer: 'routed', group: 'g-a', tier: 0, side: 'left', x: 30, bounds: { x: 20, y: 60, width: 20, height: 60 } });
    model.links[0]!.path!.segments[0]!.lane = 'lane';
    expect(gate(model, 'G4').passed).toBe(true);
    expect(score(model).snapshot.counters.lanesUsed).toBe(1);
    model.lanes[0]!.owner = { kind: 'link', id: 'wrong' };
    expect(gate(model, 'G4').passed).toBe(false);
    model.links[0]!.bundle = 'bundle';
    model.bundles.push({ id: 'bundle', owner: { kind: 'bundle', id: 'bundle' }, layer: 'routed', nodes: ['a', 'b'], members: ['ab'] });
    model.lanes[0]!.owner = { kind: 'bundle', id: 'bundle' };
    expect(gate(model, 'G4').passed).toBe(true);
    model.bundles[0]!.owner = { kind: 'bundle', id: 'wrong' };
    expect(gate(model, 'G4').passed).toBe(false);
  });
});

describe('G5 stems and port order', () => {
  it('checks normal, direction and length and skips overlays and stubs', () => {
    const model = simple(), segment = model.links[0]!.path!.segments[0]!;
    segment.to = { x: 40, y: 50 };
    expect(gate(model, 'G5').passed).toBe(false);
    segment.to = { x: 30, y: 54 };
    expect(gate(model, 'G5').passed).toBe(false);
    model.links[0]!.technique = 'stub';
    expect(gate(model, 'G5').passed).toBe(true);
    delete model.links[0]!.path;
    expect(gate(model, 'G7').passed).toBe(true);
  });
  it('rejects inverted far-end order unless the port order is authored', () => {
    const model = parallel(), a = model.nodes.a!, b = model.nodes.b!;
    expect(gate(model, 'G5').passed).toBe(true);
    [b.ports[0]!.anchor, b.ports[1]!.anchor] = [b.ports[1]!.anchor!, b.ports[0]!.anchor!];
    model.links[0]!.path!.segments = [
      { from: a.ports[0]!.anchor!, to: { x: 30, y: 80 }, owner: model.links[0]!.owner },
      { from: { x: 30, y: 80 }, to: { x: 60, y: 80 }, owner: model.links[0]!.owner },
      { from: { x: 60, y: 80 }, to: b.ports[0]!.anchor!, owner: model.links[0]!.owner },
    ];
    model.links[1]!.path!.segments = [
      { from: a.ports[1]!.anchor!, to: { x: 60, y: 100 }, owner: model.links[1]!.owner },
      { from: { x: 60, y: 100 }, to: { x: 30, y: 100 }, owner: model.links[1]!.owner },
      { from: { x: 30, y: 100 }, to: b.ports[1]!.anchor!, owner: model.links[1]!.owner },
    ];
    expect(gate(model, 'G5').violations.some(v => v.code === 'port-order')).toBe(true);
    [...a.ports, ...b.ports].forEach((p, i) => { p.authorOrder = i; });
    expect(gate(model, 'G5').passed).toBe(true);
  });
});

describe('G6 stroke-aware clearance', () => {
  it('uses node strokes at the 20 px boundary', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 40, height: 40 });
    node(model, 'b', { x: 62, y: 0, width: 40, height: 40 });
    expect(gate(model, 'G6').passed).toBe(true);
    model.nodes.b!.bounds!.x = 61.9;
    expect(gate(model, 'G6').passed).toBe(false);
    model.nodes.a!.strokeWidth = model.nodes.b!.strokeWidth = 0;
    expect(gate(model, 'G6').passed).toBe(true);
  });
  it('uses segment and foreign-node strokes at the 10 px boundary', () => {
    const model = simple();
    node(model, 'c', { x: 41.75, y: 80, width: 30, height: 10 });
    expect(gate(model, 'G6').passed).toBe(true);
    model.nodes.c!.bounds!.x = 41.7;
    expect(gate(model, 'G6').passed).toBe(false);
    model.links[0]!.layer = model.links[0]!.path!.layer = 'overlay';
    expect(gate(model, 'G6').passed).toBe(true);
  });
  it('uses path strokes for parallel clearance and explicit bundle member gap', () => {
    const model = parallel(11.5);
    expect(gate(model, 'G6').passed).toBe(true);
    model.links.forEach(l => { l.path!.strokeWidth = 2; });
    expect(gate(model, 'G6').passed).toBe(false);
    const bundled = parallel(17.5); bundle(bundled);
    expect(gate(bundled, 'G6').passed).toBe(true);
    bundled.bundles[0]!.memberGap = 18;
    expect(gate(bundled, 'G6').violations.some(v => v.code === 'bundle-member-gap')).toBe(true);
    bundled.links[1]!.path!.segments[0]!.owner = { kind: 'bundle', id: 'wrong' };
    expect(gate(bundled, 'G6').passed).toBe(true); // Falls back to ordinary 10 px clearance.
  });
});

describe('G7 attachment', () => {
  it('checks endpoint equality for routed links and overlays', () => {
    const model = simple();
    model.links[0]!.path!.segments[0]!.from.x++;
    expect(gate(model, 'G7').passed).toBe(false);
    model.links[0]!.layer = model.links[0]!.path!.layer = 'overlay';
    expect(gate(model, 'G7').passed).toBe(false);
  });
  it('checks every anchor even when no link uses it', () => {
    const model = simple();
    model.links = [];
    model.nodes.a!.ports[0]!.anchor!.y = 20;
    expect(gate(model, 'G7').passed).toBe(false);
  });
  it('checks path continuity and missing ports', () => {
    const model = simple(), l = model.links[0]!;
    l.path!.segments.push({ from: { x: 31, y: 140 }, to: { x: 30, y: 140 }, owner: l.owner });
    expect(gate(model, 'G7').violations.some(v => v.code === 'disconnected-path')).toBe(true);
    model.nodes.a!.ports = [];
    expect(gate(model, 'G7').violations.some(v => v.code === 'missing-port')).toBe(true);
  });
});
