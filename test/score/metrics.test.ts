import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { bundle, empty, node, parallel, simple } from './fixtures.js';

function path(model: LayoutModel, points: Point[], index = 0): void {
  const link = model.links[index]!;
  link.path!.segments = points.slice(1).map((to, i) => ({ from: points[i]!, to, owner: link.owner }));
}

describe('soft metrics', () => {
  it('counts crossings separately from collinear overlap and shared endpoints', () => {
    const model = parallel();
    path(model, [{ x: 0, y: 80 }, { x: 100, y: 80 }], 1);
    let metrics = score(model).snapshot.metrics;
    expect(metrics.crossings).toEqual({ count: 1, routedLinks: 2, ratio: 0.5, value: 0.5 });
    expect(score(model).snapshot.counters.overlaps).toBe(0);
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 80 }, { x: 30, y: 140 }]);
    path(model, [{ x: 0, y: 80 }, { x: 30, y: 80 }, { x: 100, y: 80 }], 1);
    expect(score(model).snapshot.metrics.crossings.count).toBe(1); // Split points do not hide a crossing.
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 140 }]);
    path(model, [{ x: 30, y: 140 }, { x: 100, y: 140 }], 1);
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    path(model, [{ x: 30, y: 140 }, { x: 30, y: 40 }], 1);
    metrics = score(model).snapshot.metrics;
    expect(metrics.crossings.count).toBe(0);
    expect(score(model).snapshot.counters.overlaps).toBe(1);
  });
  it('excludes crossings only within a claimed bundle extent', () => {
    const model = parallel();
    path(model, [{ x: 0, y: 80 }, { x: 100, y: 80 }], 1);
    bundle(model);
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    model.links[1]!.path!.segments[0]!.owner = { kind: 'link', id: 'two' };
    expect(score(model).snapshot.metrics.crossings.count).toBe(1);
    model.links[1]!.path!.segments[0]!.owner = { kind: 'bundle', id: 'bundle' };
    model.bundles[0]!.envelope!.y = 90;
    expect(score(model).snapshot.metrics.crossings.count).toBe(1);
  });
  it('measures alternating turns, repeated turns, U-turns and redundant straight splits', () => {
    const model = simple();
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 80 }, { x: 60, y: 80 }, { x: 60, y: 140 }]);
    let metrics = score(model).snapshot.metrics;
    expect(metrics.bends).toMatchObject({ mean: 2, max: 2, total: 2 });
    expect(metrics.bends.value).toBeCloseTo(1 / 3);
    expect(metrics.continuity).toEqual({ value: 1, eligible: 1, alternating: 1 });
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 80 }, { x: 60, y: 80 }, { x: 60, y: 40 }]);
    expect(score(model).snapshot.metrics.continuity.value).toBe(0);
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 80 }, { x: 30, y: 40 }]);
    metrics = score(model).snapshot.metrics;
    expect(metrics.continuity.value).toBe(0);
    expect(metrics.bends.total).toBe(1);
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 80 }, { x: 30, y: 140 }]);
    expect(score(model).snapshot.metrics.bends.total).toBe(0);
    expect(score(model).snapshot.metrics.continuity.value).toBe(1);
  });
  it('reports global and per-group compactness and their mean', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 20, height: 20 });
    node(model, 'b', { x: 80, y: 0, width: 20, height: 20 });
    const compactness = score(model).snapshot.metrics.compactness;
    expect(compactness.global).toBeCloseTo(0.4);
    expect(compactness.groups).toEqual({ 'g-a': 1, 'g-b': 1 });
    expect(compactness.value).toBeCloseTo(0.8);
  });
  it('uses ±1 px coordinate tolerance with at least two other nodes', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 20, height: 20 });
    node(model, 'b', { x: 60, y: 1, width: 20, height: 20 });
    node(model, 'c', { x: 120, y: 0, width: 20, height: 20 });
    expect(score(model).snapshot.metrics.gridAlignment).toBe(1);
    model.nodes.b!.bounds!.y = 1.01;
    expect(score(model).snapshot.metrics.gridAlignment).toBe(0);
  });
  it('measures downward segments only for links whose target tier is lower', () => {
    const model = simple();
    path(model, [{ x: 30, y: 40 }, { x: 30, y: 100 }, { x: 60, y: 100 }, { x: 60, y: 80 }, { x: 30, y: 80 }, { x: 30, y: 140 }]);
    expect(score(model).snapshot.metrics.flow).toEqual({ value: 2 / 3, eligible: 3, downward: 2 });
    model.groups['g-a']!.tier = 2;
    expect(score(model).snapshot.metrics.flow).toEqual({ value: 1, eligible: 0, downward: 0 });
    model.groups['g-a']!.tier = 1;
    expect(score(model).snapshot.metrics.flow.value).toBe(1);
  });
  it('computes population deviation over actual segment lengths', () => {
    const model = simple();
    path(model, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }]);
    const uniformity = score(model).snapshot.metrics.segmentUniformity;
    expect(uniformity).toMatchObject({ mean: 20, count: 2 });
    expect(uniformity.std).toBeCloseTo(10);
    expect(uniformity.value).toBeCloseTo(0.5);
  });
  it('reports symmetry without including it in Q', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 20, height: 20 });
    node(model, 'b', { x: 80, y: 0, width: 20, height: 20 });
    expect(score(model).snapshot.metrics.symmetry).toBe(1);
    model.nodes.b!.bounds!.y = 4;
    expect(score(model).snapshot.metrics.symmetry).toBe(1);
    model.nodes.b!.bounds!.y = 4.1;
    expect(score(model).snapshot.metrics.symmetry).toBe(0);
  });
  it('normalizes the eight finite clamped metrics by 0.95', () => {
    const snapshot = score(simple()).snapshot, m = snapshot.metrics;
    const expected = (0.3 * m.crossings.value + 0.15 * m.bends.value + 0.1 * m.continuity.value + 0.1 * m.compactness.value + 0.1 * m.gridAlignment + 0.1 * m.flow.value + 0.05 * m.aspectRatio + 0.05 * m.segmentUniformity.value) / 0.95;
    expect(snapshot.Q).toBeCloseTo(expected);
    expect(snapshot.Q).toBeGreaterThanOrEqual(0);
    expect(snapshot.Q).toBeLessThanOrEqual(1);
  });
  it('preserves all model counters and keeps advisories separate from assertions', () => {
    const model = parallel(); bundle(model);
    model.fallbackUsed = true; model.deadlineHit = true;
    model.groupLinks.push({ id: 'gl', owner: { kind: 'group', id: 'g-a' }, layer: 'overlay', groups: ['g-a', 'g-b'], members: [] });
    const result = score(model).snapshot;
    expect(result.counters).toMatchObject({ inversions: 3, fallbackUsed: true, deadlineHit: true, groupLinks: 1 });
    expect(result.assertions).toEqual([]);
    expect(result.advisories.some(a => a.metric === 'grid alignment')).toBe(true);
    expect(score(simple(), { baseline: 0 }).snapshot.assertions[0]!.passed).toBe(false);
    expect(score(simple(), { golden: true }).snapshot.assertions[0]!.passed).toBe(true);
  });
});
