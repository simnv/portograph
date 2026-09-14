import { describe, expect, it } from 'vitest';
import type { PathSegment } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { intersection, segmentRect, segmentRectDistance } from '../../src/score/geometry.js';
import { node, parallel, simple } from './fixtures.js';

function barDrop(reverse = false) {
  const model = simple(), link = model.links[0]!;
  node(model, 'bar', { x: 0, y: 80, width: 60, height: 10 });
  model.document.groups['g-bar']!.shape = 'bar';
  if (reverse) {
    [link.from, link.to] = [link.to, link.from];
    const segment = link.path!.segments[0]!;
    [segment.from, segment.to] = [segment.to, segment.from];
  }
  const source = model.nodes[reverse ? 'b' : 'a']!.ports[0]!.ref;
  const target = model.nodes[reverse ? 'a' : 'b']!.ports[0]!.ref;
  link.path!.segments[0]!.barCross = ['bar'];
  model.barDrops.push({ id: 'drop', owner: { kind: 'barCross', node: 'bar', link: link.id }, layer: 'routed', link: link.id, source, port: target, slotX: 30, span: { min: 0, max: 60 }, barCross: ['bar'] });
  return model;
}

describe('review round 1: bar span axes', () => {
  it.each([false, true])('uses the horizontal bar span, with below-bar mirror=%s', reverse => {
    const model = barDrop(reverse);
    const result = score(model).snapshot;
    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G6.violations.filter(v => v.code === 'segment-node-clearance')).toEqual([]);
    expect(result.counters.barCross).toBe(1);
  });
  it('requires the slot inside its horizontal span and the run within attachment y bounds', () => {
    const model = barDrop();
    model.barDrops[0]!.span.max = 20;
    expect(score(model).snapshot.gates.G2.passed).toBe(false);
    model.barDrops[0]!.span.max = 60;
    model.links[0]!.path!.segments[0]!.from.y = 20;
    expect(score(model).snapshot.gates.G2.violations.some(v => v.elements.includes('bar'))).toBe(true);
  });
});

describe('review round 1: label exception containment', () => {
  it('rejects a node label that partially overflows its own node', () => {
    const model = simple();
    model.labels.push({ id: 'label', text: 'label', role: 'node', owner: { kind: 'node', id: 'a' }, layer: 'routed', bounds: { x: -5, y: 5, width: 10, height: 6 } });
    expect(score(model).snapshot.gates.G3.passed).toBe(false);
    model.labels[0]!.bounds!.x = 0;
    expect(score(model).snapshot.gates.G3.passed).toBe(true);
  });
  it('permits pill text to straddle the node only while contained in its own pill', () => {
    const model = simple(), port = model.nodes.a!.ports[0]!;
    port.pill = { size: { width: 24, height: 10 }, bounds: { x: 18, y: 35, width: 24, height: 10 }, owner: { kind: 'node', id: 'a' }, layer: 'routed', radius: 2, textRotation: 0 };
    model.labels.push({ id: 'pill-text', text: 'pill', role: 'pill', port: port.ref, owner: { kind: 'node', id: 'a' }, layer: 'routed', bounds: { x: 26, y: 37, width: 10, height: 6 } });
    expect(score(model).snapshot.gates.G3.passed).toBe(true);
    // This overflow hits the pill but stays wholly inside the node and misses the stem.
    model.labels[0]!.bounds = { x: 17, y: 36, width: 10, height: 2 };
    expect(score(model).snapshot.gates.G3.passed).toBe(false);
    expect(score(model).snapshot.gates.G3.violations.some(v => v.elements.includes('pill:a:1'))).toBe(true);
  });
});

const segment = (fromX: number, toX: number): PathSegment => ({ from: { x: fromX, y: 80 }, to: { x: toX, y: 80 }, owner: { kind: 'link', id: 'horizontal' } });
const vertical: PathSegment = { from: { x: 30, y: 40 }, to: { x: 30, y: 140 }, owner: { kind: 'link', id: 'vertical' } };

describe('review round 1: tolerance in pixels', () => {
  it.each([1, 30, 1000000])('rejects a 0.000001 px segment near miss for length %s', size => {
    const horizontal = segment(30 - size, 29.999999);
    expect(intersection(horizontal, vertical)).toBeUndefined();
    expect(intersection(vertical, horizontal)).toBeUndefined();
    expect(intersection({ ...horizontal, from: horizontal.to, to: horizontal.from }, vertical)).toBeUndefined();
    const model = parallel();
    model.links[1]!.path!.segments = [horizontal];
    expect(score(model, { golden: true }).snapshot.metrics.crossings.count).toBe(0);
    expect(score(model, { golden: true }).snapshot.assertions[0]!.passed).toBe(true);
  });
  it.each([1, 30, 1000000])('rejects a 0.000001 px rectangle near miss for length %s', size => {
    const horizontal = segment(30 - size, 29.999999), rect = { x: 30, y: 70, width: 10, height: 20 };
    expect(segmentRect(horizontal, rect)).toBe(false);
    expect(segmentRect({ ...horizontal, from: horizontal.to, to: horizontal.from }, rect)).toBe(false);
    expect(segmentRectDistance(horizontal, rect)).toBeCloseTo(0.000001, 10);
  });
  it('retains exact contacts and tolerates at most the declared pixel epsilon', () => {
    expect(intersection(segment(0, 30), vertical)).toEqual({ x: 30, y: 80 });
    expect(segmentRect(segment(0, 30), { x: 30, y: 70, width: 10, height: 20 })).toBe(true);
    expect(intersection(segment(0, 30 - 0.00000005), vertical)).toBeDefined();
    expect(segmentRect(segment(0, 30 - 0.00000005), { x: 30, y: 70, width: 10, height: 20 })).toBe(true);
  });
});

describe('review round 1: effective route layer', () => {
  it.each(['orthogonal', 'straight'] as const)('gates and scores a flow-class link overridden to %s', technique => {
    const model = simple(), link = model.links[0]!;
    link.family = 'overlay'; link.layer = 'routed'; link.technique = technique;
    node(model, 'foreign', { x: 20, y: 80, width: 20, height: 10 });
    const result = score(model).snapshot;
    expect(result.metrics.crossings.routedLinks).toBe(1);
    expect(result.gates.G2.passed).toBe(false);
    expect(result.gates.G6.violations.some(v => v.code === 'segment-node-clearance')).toBe(true);
  });
  it('rejects a contradictory path layer instead of bypassing routed gates', () => {
    const model = simple();
    model.links[0]!.path!.layer = 'overlay';
    expect(() => score(model)).toThrow(/layer/);
  });
  it('scores a real routed fallback when stub was only requested in the source document', () => {
    const model = simple(), link = model.links[0]!;
    model.document.links.push({ from: link.from, to: link.to, route: 'stub' });
    expect(score(model).snapshot.metrics.crossings.routedLinks).toBe(1);
    expect(score(model).snapshot.counters.stubs).toBe(0);
    link.technique = 'stub';
    expect(score(model).snapshot.metrics.crossings.routedLinks).toBe(0);
    expect(score(model).snapshot.counters.stubs).toBe(1);
  });
});
