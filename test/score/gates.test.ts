import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { describe, expect, it } from 'vitest';
import type { LayoutLabel, LayoutModel, PathSegment } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { alongside } from '../../src/score/gates.js';
import { horizontal, vertical } from '../../src/score/geometry.js';
import { bundle, empty, link, node, parallel, simple } from './fixtures.js';

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
  it('allows a link label only on the clearance zone of its own supporting segment', () => {
    const model = simple();
    const support = { kind: 'link-segment' as const, link: 'ab', segment: 0 };
    // Inside segment 0's 0.75 px stroke zone, but not across its centreline at x = 30.
    model.labels.push({ ...label('link text', 30.5, 80, { kind: 'link', id: 'ab' }), role: 'link', support });
    expect(gate(model, 'G3').passed).toBe(true);
    model.labels[0]!.owner = { kind: 'link', id: 'wrong' };
    expect(gate(model, 'G3').passed).toBe(false); // Centerline misses, stroke hits.
    model.labels[0]!.bounds!.x = 31;
    expect(gate(model, 'G3').passed).toBe(true);
    // The exemption covers the clearance zone only; text drawn across the segment is always a hit.
    model.labels[0]!.owner = { kind: 'link', id: 'ab' };
    model.labels[0]!.bounds!.x = 29.5;
    expect(gate(model, 'G3').violations.map(v => v.elements)).toEqual([['link text', 'ab']]);
  });
  it('gives a link label with no, stale or foreign support no segment exemption at all', () => {
    const model = simple();
    const label0 = { ...label('link text', 30.5, 80, { kind: 'link' as const, id: 'ab' }), role: 'link' as const };
    // Same box, same owner, no reference: the blanket link exemption is gone.
    model.labels.push(label0);
    expect(gate(model, 'G3').violations.map(v => v.elements)).toEqual([['link text', 'ab']]);
    // A reference to a segment index the path does not have exempts nothing either.
    model.labels[0] = { ...label0, support: { kind: 'link-segment', link: 'ab', segment: 1 } };
    expect(gate(model, 'G3').passed).toBe(false);
    // Nor does a reference whose link contradicts the label's own owner.
    model.labels[0] = { ...label0, owner: { kind: 'link', id: 'other' }, support: { kind: 'link-segment', link: 'ab', segment: 0 } };
    expect(gate(model, 'G3').passed).toBe(false);
    // A merge-run reference is never a segment exemption.
    model.labels[0] = { ...label0, owner: { kind: 'bundle', id: 'bundle' }, support: { kind: 'merge-run', bundle: 'bundle', run: 'merge' } };
    expect(gate(model, 'G3').passed).toBe(false);
    model.labels[0] = { ...label0, support: { kind: 'link-segment', link: 'ab', segment: 0 } };
    expect(gate(model, 'G3').passed).toBe(true);
  });
  it('exempts the supporting segment only, never another segment of the same link', () => {
    const model = simple(), link = model.links[0]!;
    // A dog-leg: the label sits on segment 1 but names segment 0 of the same link.
    link.path!.segments = [
      { from: { x: 30, y: 40 }, to: { x: 30, y: 90 }, owner: link.owner },
      { from: { x: 30, y: 90 }, to: { x: 200, y: 90 }, owner: link.owner },
      { from: { x: 200, y: 90 }, to: { x: 200, y: 140 }, owner: link.owner },
    ];
    model.nodes.b!.ports[0]!.anchor = { x: 200, y: 140 };
    model.nodes.b!.bounds = { x: 170, y: 140, width: 60, height: 40 };
    model.groups['g-b']!.bounds = { x: 160, y: 130, width: 80, height: 60 };
    model.labels.push({ ...label('link text', 100, 90.5, { kind: 'link', id: 'ab' }), role: 'link',
      support: { kind: 'link-segment', link: 'ab', segment: 0 } });
    expect(gate(model, 'G3').violations.map(v => v.elements)).toEqual([['link text', 'ab']]);
    model.labels[0]!.support = { kind: 'link-segment', link: 'ab', segment: 1 };
    expect(gate(model, 'G3').passed).toBe(true);
  });
  it('exempts every piece of a joined run from its label support (ticket 142)', () => {
    const model = simple(), link = model.links[0]!;
    // Segment 0 is cut in two collinear pieces; the label stands on the second and names both.
    link.path!.segments = [
      { from: { x: 30, y: 40 }, to: { x: 30, y: 60 }, owner: link.owner },
      { from: { x: 30, y: 60 }, to: { x: 30, y: 90 }, owner: link.owner },
    ];
    model.labels.push({ ...label('link text', 30.5, 80, { kind: 'link', id: 'ab' }), role: 'link',
      support: { kind: 'link-segment', link: 'ab', segment: 0 } });
    expect(gate(model, 'G3').violations.map(v => v.elements)).toEqual([['link text', 'ab']]);
    model.labels[0]!.support = { kind: 'link-segment', link: 'ab', segment: 0, through: 1 };
    expect(gate(model, 'G3').passed).toBe(true);
    model.labels[0]!.support = { kind: 'link-segment', link: 'ab', segment: 0, through: 0 };
    expect(gate(model, 'G3').passed).toBe(false);
  });
  it('exempts pill text only from its specific pill and incident stem', () => {
    const model = simple(), p = model.nodes.a!.ports[0]!;
    p.pill = { size: { width: 24, height: 10 }, bounds: { x: 18, y: 35, width: 24, height: 10 }, owner: { kind: 'node', id: 'a' }, layer: 'routed', radius: 2, textRotation: 0 };
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
  it('exempts one link\'s own staircase tread, and only that', () => {
    const hit = (model: LayoutModel): boolean => gate(model, 'G6').violations.some(v => v.code === 'parallel-clearance');
    // Two vertical runs 5 px apart that share their whole extent are a corridor two links share.
    expect(hit(parallel(5))).toBe(true);

    // One link's own staircase: its two vertical runs lie above and below the 5 px tread that joins
    // them, so they never appear side by side and the measured distance is a corner of one wire.
    const own = parallel(5);
    own.links[1]!.path!.segments = [{ from: { x: 60, y: 40 }, to: { x: 60, y: 140 }, owner: { kind: 'link', id: 'two' } }];
    own.links[0]!.path!.segments = [
      { from: { x: 30, y: 40 }, to: { x: 30, y: 90 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 30, y: 90 }, to: { x: 35, y: 90 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 35, y: 90 }, to: { x: 35, y: 140 }, owner: { kind: 'link', id: 'one' } }];
    expect(alongside(own.links[0]!.path!.segments[0]!, own.links[0]!.path!.segments[2]!)).toBe(false);
    expect(hit(own)).toBe(false);
    // The same link's runs that really do lie alongside each other are still measured.
    own.links[0]!.path!.segments[2] = { from: { x: 35, y: 45 }, to: { x: 35, y: 140 }, owner: { kind: 'link', id: 'one' } };
    expect(hit(own)).toBe(true);

    // Two different links are always measured, whatever their extents: their painted corners can
    // still meet. Only the vertical pair is close here, and its extents are disjoint, so this
    // fails for exactly the reason the blanket exclusion would have hidden.
    const corners = parallel(5);
    corners.links[0]!.path!.segments = [
      { from: { x: 30, y: 0 }, to: { x: 30, y: 50 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 30, y: 50 }, to: { x: 200, y: 50 }, owner: { kind: 'link', id: 'one' } }];
    corners.links[1]!.path!.segments = [
      { from: { x: 35, y: 55 }, to: { x: 35, y: 200 }, owner: { kind: 'link', id: 'two' } },
      { from: { x: 35, y: 200 }, to: { x: -100, y: 200 }, owner: { kind: 'link', id: 'two' } }];
    expect(alongside(corners.links[0]!.path!.segments[0]!, corners.links[1]!.path!.segments[0]!)).toBe(false);
    expect(alongside(corners.links[0]!.path!.segments[1]!, corners.links[1]!.path!.segments[1]!)).toBe(true);
    expect(hit(corners)).toBe(true);
    // Move the only close pair apart and nothing is left to report.
    corners.links[1]!.path!.segments[0] = { from: { x: 90, y: 55 }, to: { x: 90, y: 200 }, owner: { kind: 'link', id: 'two' } };
    corners.links[1]!.path!.segments[1] = { from: { x: 90, y: 200 }, to: { x: -100, y: 200 }, owner: { kind: 'link', id: 'two' } };
    expect(hit(corners)).toBe(false);

    // One link's loop is not a tread: two bends it brings together are three segments apart, so
    // they are measured like any other pair.
    const loop = parallel(5);
    loop.links[1]!.path!.segments = [{ from: { x: 400, y: 40 }, to: { x: 400, y: 140 }, owner: { kind: 'link', id: 'two' } }];
    loop.links[0]!.path!.segments = [
      { from: { x: -20, y: 0 }, to: { x: 100, y: 0 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 100, y: 0 }, to: { x: 100, y: -100 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 100, y: -100 }, to: { x: 300, y: -100 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 300, y: -100 }, to: { x: 300, y: 200 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 300, y: 200 }, to: { x: 101, y: 200 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 101, y: 200 }, to: { x: 101, y: 1 }, owner: { kind: 'link', id: 'one' } },
      { from: { x: 101, y: 1 }, to: { x: 201, y: 1 }, owner: { kind: 'link', id: 'one' } }];
    expect(hit(loop)).toBe(true);
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
    a.ports.forEach((p, i) => { p.authorOrder = i; });
    b.ports.forEach((p, i) => { p.authorOrder = b.ports.length - 1 - i; });
    expect(gate(model, 'G5').passed).toBe(true);
  });
});

describe('G6 stroke-aware clearance', () => {
  it('uses node strokes at the 20 px boundary', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 40, height: 40 });
    // 20 px between the strokes: 40 + 20 + two half node strokes of 0.75.
    node(model, 'b', { x: 61.5, y: 0, width: 40, height: 40 });
    expect(gate(model, 'G6').passed).toBe(true);
    model.nodes.b!.bounds!.x = 61.4;
    expect(gate(model, 'G6').passed).toBe(false);
    model.nodes.a!.strokeWidth = model.nodes.b!.strokeWidth = 0;
    expect(gate(model, 'G6').passed).toBe(true);
  });
  it('uses segment and foreign-node strokes at the 10 px boundary', () => {
    const model = simple();
    node(model, 'c', { x: 41.5, y: 80, width: 30, height: 10 });
    // The fixture's 10 px group padding puts c's box within the group edge margin; that is the
    // separate segment-group-edge code (ADR-0013), so only the node-clearance code is read here.
    const nodeClearance = (): boolean => !gate(model, 'G6').violations.some(v => v.code === 'segment-node-clearance');
    expect(nodeClearance()).toBe(true);
    model.nodes.c!.bounds!.x = 41.4;
    expect(nodeClearance()).toBe(false);
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

describe('ADR-0013 group boxes', () => {
  it('fails a routed segment through a foreign group box and admits its own groups', () => {
    const model = simple();
    // c sits beside the a→b drop at x = 30; its 10 px fixture padding makes g-c span x 20..70.
    node(model, 'c', { x: 30, y: 80, width: 30, height: 10 });
    model.nodes.c!.bounds!.x = 40; model.groups['g-c']!.bounds = { x: 20, y: 70, width: 80, height: 30 };
    const violations = gate(model, 'G2').violations;
    expect(violations.filter(v => v.code === 'through-group').map(v => v.elements)).toEqual([['ab', 'g-c']]);
    expect(violations.some(v => v.code === 'through-group' && v.elements.includes('g-a'))).toBe(false);
    // A declared bar crossing admits the bar's group as well as the bar.
    model.document.groups['g-c']!.shape = 'bar';
    const l = model.links[0]!, owner = { kind: 'barCross' as const, node: 'c', link: l.id };
    l.path!.segments[0]!.barCross = ['c'];
    model.barDrops.push({ id: 'drop', owner, layer: 'routed', link: l.id, source: model.nodes.a!.ports[0]!.ref, port: model.nodes.b!.ports[0]!.ref, slotX: 30, span: { min: 0, max: 60 }, barCross: ['c'] });
    expect(gate(model, 'G2').violations.filter(v => v.code === 'through-group')).toEqual([]);
  });
  it('fails a segment running along a group edge from outside, stroke-aware, and admits turns inside the box', () => {
    const model = simple();
    // A foreign box whose right edge lies exactly the margin plus half stroke from the drop's centreline.
    node(model, 'd', { x: -60, y: 60, width: 30, height: 20 });
    const stroke = 1.5, edge = 30 - GROUP_EDGE_LINK_CLEARANCE - stroke / 2;
    model.groups['g-d']!.bounds = { x: edge - 60, y: 50, width: 60, height: 40 };
    const along = () => gate(model, 'G6').violations.filter(v => v.code === 'segment-group-edge');
    expect(along()).toEqual([]);
    model.groups['g-d']!.bounds!.width += 0.1;
    expect(along().map(v => v.elements)).toEqual([['ab', 'g-d']]);
    // The same run strictly inside a box it attaches to is the group's own routing space.
    model.groups['g-d']!.bounds!.width -= 0.1;
    model.groups['g-a']!.bounds = { x: 25, y: -10, width: 80, height: 60 };
    expect(along()).toEqual([]);
  });
});

describe('ADR-0017 straight bundle members in the gates', () => {
  /**
   * Two crossing links between wide nodes, each drawn stem, declared diagonal, stem. `offset` is the
   * distance between the two source tracks; `collinear` makes the second member repeat the first.
   */
  const diagonals = (offset: number, collinear = false): LayoutModel => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 300, height: 40 }, 0);
    node(model, 'b', { x: 0, y: 140, width: 300, height: 40 }, 1);
    const path = (id: string, x0: number, x1: number) =>
      link(model, id, 'a', 'b', [{ x: x0, y: 40 }, { x: x0, y: 55 }, { x: x1, y: 125 }, { x: x1, y: 140 }]);
    path('one', 30, 200);
    path('two', collinear ? 30 : 30 + offset, collinear ? 200 : 200 + offset);
    // A declared diagonal is legal only on a member of a bundle that owns it (ADR-0017).
    bundle(model);
    for (const item of model.links) item.path!.segments[1]!.straight = true;
    return model;
  };

  it('measures the clearance between two parallel diagonals against the bundle member gap', () => {
    expect(gate(diagonals(60), 'G6').passed).toBe(true);
    const close = gate(diagonals(4), 'G6');
    expect(close.passed).toBe(false);
    expect(close.violations.some(v => v.code === 'bundle-member-gap')).toBe(true);
  });

  it('reports a collinear overlap between two diagonals, measured along the run', () => {
    // Two members on one line whose *stems* do not overlap: only the diagonals do, and steeply, so
    // the overlap is longer along the run than along x.
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 300, height: 40 }, 0);
    node(model, 'b', { x: 0, y: 300, width: 300, height: 40 }, 1);
    link(model, 'one', 'a', 'b', [{ x: 30, y: 40 }, { x: 30, y: 60 }, { x: 60, y: 260 }, { x: 60, y: 300 }]);
    link(model, 'two', 'a', 'b', [{ x: 45, y: 40 }, { x: 45, y: 160 }, { x: 75, y: 360 }, { x: 75, y: 300 }]);
    // `two`'s diagonal continues `one`'s line: same direction, same offset, overlapping halves.
    model.links[1]!.path!.segments = [
      { from: { x: 45, y: 40 }, to: { x: 45, y: 160 }, owner: model.links[1]!.owner },
      { from: { x: 45, y: 160 }, to: { x: 75, y: 360 }, owner: model.links[1]!.owner, straight: true },
      { from: { x: 75, y: 360 }, to: { x: 75, y: 300 }, owner: model.links[1]!.owner },
    ];
    model.links[0]!.path!.segments[1]!.straight = true;
    bundle(model);
    for (const item of model.links) for (const segment of item.path!.segments) if (segment.straight) segment.straight = true;
    const overlapX = Math.min(60, 75) - Math.max(30, 45);
    expect(overlapX).toBeLessThan(16);
    const overlap = gate(model, 'G4');
    expect(overlap.passed).toBe(false);
    expect(overlap.violations.some(v => v.code === 'collinear-overlap')).toBe(true);
  });

  it('finds a near-EPS collinear overlap far from the origin, where a float key would miss it', () => {
    // Codex round 9: two collinear runs at large coordinates whose normalised directions differ by
    // less than EPS. The sweep is by bounding box, so the pair is compared and the overlap reported.
    const model = empty();
    node(model, 'a', { x: 99000, y: 99000, width: 2000, height: 40 }, 0);
    node(model, 'b', { x: 99000, y: 101000, width: 2000, height: 40 }, 1);
    link(model, 'one', 'a', 'b', [{ x: 100000, y: 99040 }, { x: 100000, y: 100000 }, { x: 100100, y: 100100 }, { x: 100100, y: 101000 }]);
    link(model, 'two', 'a', 'b', [{ x: 100050, y: 99040 }, { x: 100050, y: 100050 }, { x: 100150, y: 100150.0000001 }, { x: 100150, y: 101000 }]);
    model.links[0]!.path!.segments[1]!.straight = true;
    model.links[1]!.path!.segments[1]!.straight = true;
    bundle(model);
    const overlap = gate(model, 'G4');
    expect(overlap.violations.some(v => v.code === 'collinear-overlap')).toBe(true);
  });

  it('finds a collinear overlap that straddles a grid cell boundary, in either argument order', () => {
    // Codex round 11: the pair sits either side of x = 256 and is EPS-collinear; the cell walk takes
    // each crossed cell's neighbours, and the predicate is symmetric, so order cannot matter.
    const build = (swap: boolean): LayoutModel => {
      const model = empty();
      node(model, 'a', { x: 100, y: 0, width: 400, height: 40 }, 0);
      node(model, 'b', { x: 100, y: 400, width: 400, height: 40 }, 1);
      const one: [number, number] = [200, 320], two: [number, number] = [240, 360];
      const [first, second] = swap ? [two, one] : [one, two];
      link(model, 'one', 'a', 'b', [{ x: first[0], y: 40 }, { x: first[0], y: 60 }, { x: first[1], y: 380 }, { x: first[1], y: 400 }]);
      link(model, 'two', 'a', 'b', [{ x: second[0], y: 40 }, { x: second[0], y: 60 }, { x: second[1], y: 380 }, { x: second[1], y: 400 }]);
      // Put the second run exactly on the first's line, shifted along it, so they overlap.
      const line = model.links[swap ? 1 : 0]!.path!.segments[1]!;
      const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y, at = 0.4;
      model.links[swap ? 0 : 1]!.path!.segments[1] = {
        from: { x: line.from.x + dx * at, y: line.from.y + dy * at },
        to: { x: line.from.x + dx * (at + 0.8), y: line.from.y + dy * (at + 0.8) },
        owner: model.links[swap ? 0 : 1]!.owner, straight: true,
      };
      line.straight = true;
      bundle(model);
      return model;
    };
    for (const swap of [false, true]) {
      expect(gate(build(swap), 'G4').violations.some(v => v.code === 'collinear-overlap'), `swap ${swap}`).toBe(true);
    }
  });

  it('finds a near-axis declared pair split by a cell boundary', () => {
    // Codex round 12: two declared members that are vertical within EPS and lie either side of
    // x = 256 — exact axis buckets would separate them; the grid, taken first for declared members,
    // does not. Their overlap along y is far longer than the gate's 1 px.
    const model = empty();
    node(model, 'a', { x: 100, y: 0, width: 400, height: 40 }, 0);
    node(model, 'b', { x: 100, y: 600, width: 400, height: 40 }, 1);
    link(model, 'one', 'a', 'b', [{ x: 255.99999999, y: 40 }, { x: 255.99999999, y: 60 }, { x: 255.99999999, y: 500 }, { x: 255.99999999, y: 600 }]);
    link(model, 'two', 'a', 'b', [{ x: 256.000000001, y: 40 }, { x: 256.000000001, y: 300 }, { x: 256.000000001, y: 560 }, { x: 256.000000001, y: 600 }]);
    for (const item of model.links) item.path!.segments[1]!.straight = true;
    bundle(model);
    expect(gate(model, 'G4').violations.some(v => v.code === 'collinear-overlap')).toBe(true);
  });

  it('finds a declared member that overlaps an ordinary collinear run', () => {
    // Codex round 13: the declared member is vertical within EPS, the other link's run is exactly
    // vertical and undeclared, so their exact buckets differ and only the grid can pair them. An
    // ordinary run joins the grid whenever the diagram declares a straight member.
    const model = empty();
    node(model, 'a', { x: 100, y: 0, width: 400, height: 40 }, 0);
    node(model, 'b', { x: 100, y: 600, width: 400, height: 40 }, 1);
    link(model, 'one', 'a', 'b', [{ x: 300.000000001, y: 40 }, { x: 300.000000001, y: 60 }, { x: 300.000000001, y: 500 }, { x: 300.000000001, y: 600 }]);
    link(model, 'two', 'a', 'b', [{ x: 300, y: 40 }, { x: 300, y: 300 }, { x: 300, y: 560 }, { x: 300, y: 600 }]);
    model.links[0]!.path!.segments[1]!.straight = true;
    bundle(model);
    expect(model.links[1]!.path!.segments[1]!.straight).toBeUndefined();
    expect(gate(model, 'G4').violations.some(v => v.code === 'collinear-overlap')).toBe(true);
  });

  it('finds a collinear overlap between two ordinary runs whose exact coordinates differ by less than EPS', () => {
    // Codex round 14: exact line buckets can straddle the collinearity tolerance, so buckets no more
    // than EPS apart are swept as one chain. Neither run is declared; a declared member elsewhere
    // must not change the answer.
    const build = (withDeclared: boolean): LayoutModel => {
      const model = empty();
      node(model, 'a', { x: 100, y: 0, width: 600, height: 40 }, 0);
      node(model, 'b', { x: 100, y: 600, width: 600, height: 40 }, 1);
      link(model, 'one', 'a', 'b', [{ x: 300, y: 40 }, { x: 300, y: 60 }, { x: 300, y: 500 }, { x: 300, y: 600 }]);
      link(model, 'two', 'a', 'b', [{ x: 300.00000001, y: 40 }, { x: 300.00000001, y: 300 }, { x: 300.00000001, y: 560 }, { x: 300.00000001, y: 600 }]);
      if (withDeclared) {
        link(model, 'three', 'a', 'b', [{ x: 600, y: 40 }, { x: 600, y: 60 }, { x: 660, y: 560 }, { x: 660, y: 600 }]);
        model.links[2]!.path!.segments[1]!.straight = true;
      }
      bundle(model);
      return model;
    };
    for (const withDeclared of [false, true]) {
      expect(gate(build(withDeclared), 'G4').violations.some(v => v.code === 'collinear-overlap'), `declared ${withDeclared}`).toBe(true);
    }
  });

  it('rejects a straight claim on an axis-aligned segment that no bundle owns', () => {
    // Codex round 14: the marker drives G4's grid and the renderer, so G5 reads it whatever the
    // segment's angle — an axis-aligned segment cannot smuggle it past the orthogonality test.
    const forged = simple();
    expect(gate(forged, 'G5').passed).toBe(true);
    const axis = forged.links[0]!.path!.segments[0]!;
    expect(vertical(axis) || horizontal(axis)).toBe(true);
    axis.straight = true;
    expect(gate(forged, 'G5').violations.some(v => v.code === 'orthogonal-path')).toBe(true);
  });

  it('rejects a second declared diagonal on one member', () => {
    const two = diagonals(60);
    expect(gate(two, 'G5').passed).toBe(true);
    const path = two.links[0]!.path!.segments;
    path.splice(2, 1, { from: path[1]!.to, to: { x: path[2]!.to.x + 4, y: path[2]!.to.y }, owner: path[1]!.owner, straight: true },
      { from: { x: path[2]!.to.x + 4, y: path[2]!.to.y }, to: path[2]!.to, owner: path[2]!.owner });
    expect(gate(two, 'G5').violations.some(v => v.code === 'orthogonal-path')).toBe(true);
  });

  it('compares a run too long to index against the declared members instead of walking its cells', () => {
    // Codex round 15: a hand-written layout can carry a run whose half-cell walk would never finish.
    // Such a run skips the grid and is compared directly, so the gate still terminates and reports.
    const model = diagonals(60);
    const far = model.links[1]!.path!.segments[0]!;
    const line = model.links[0]!.path!.segments[1]!;
    const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y, scale = 1e18;
    model.links[1]!.path!.segments[0] = { from: line.from, to: { x: line.from.x + dx * scale, y: line.from.y + dy * scale }, owner: far.owner, straight: true };
    const started = Date.now();
    const found = gate(model, 'G4').violations.some(v => v.code === 'collinear-overlap');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(found).toBe(true);
  });

  it('returns on an axis run whose coordinate is far past the safe key range', () => {
    // Codex round 16: the EPS key stops being a safe integer past about 9e8 px, where its
    // neighbours no longer move. The float spacing there already exceeds EPS, so the exact key is
    // complete and the sweep must simply finish.
    const model = simple();
    const far = model.links[0]!.path!.segments[0]!;
    far.from = { x: -1e30, y: far.from.y };
    far.to = { x: -1e30, y: far.to.y };
    const started = Date.now();
    expect(gate(model, 'G4').violations.some(v => v.code === 'collinear-overlap')).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('accepts a declared diagonal on an owning bundle member, and nothing else', () => {
    expect(gate(diagonals(60), 'G5').passed).toBe(true);
    const undeclared = diagonals(60);
    delete undeclared.links[0]!.path!.segments[1]!.straight;
    expect(gate(undeclared, 'G5').violations.some(v => v.code === 'orthogonal-path')).toBe(true);
    // The same claim outside a bundle, or on a link the bundle does not list, is not accepted.
    const loose = diagonals(60);
    delete loose.links[0]!.bundle;
    expect(gate(loose, 'G5').violations.some(v => v.code === 'orthogonal-path')).toBe(true);
    const unlisted = diagonals(60);
    unlisted.bundles[0]!.members = [unlisted.links[1]!.id];
    expect(gate(unlisted, 'G5').violations.some(v => v.code === 'orthogonal-path')).toBe(true);
  });
});
