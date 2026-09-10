import { describe, expect, it } from 'vitest';
import { score } from '../../src/score/index.js';
import { empty, node, simple } from './fixtures.js';

describe('score contract', () => {
  it('gives truly empty geometry Q=1 and excludes timings from snapshots', () => {
    const model = empty();
    const initial = score(model);
    expect(initial.snapshot.Q).toBe(1);
    model.runtime.stages.push({ stage: 'route', durationMs: 19 });
    expect(score(model).snapshot).toEqual(initial.snapshot);
    expect(score(model).runtime.stages).toEqual(model.runtime.stages);
  });
  it('passes a self-consistent diagram and keeps raw counts', () => {
    const result = score(simple()).snapshot;
    expect(result.passed).toBe(true);
    expect(Object.values(result.gates).every(gate => gate.passed)).toBe(true);
    expect(result.metrics.crossings.count).toBe(0);
    expect(result.metrics.crossings.routedLinks).toBe(1);
  });
  it('retains node-aware metrics without routed links', () => {
    const model = empty();
    node(model, 'a', { x: 0, y: 0, width: 100, height: 20 });
    const result = score(model).snapshot;
    expect(result.metrics.aspectRatio).toBeCloseTo(0.2);
    expect(result.metrics.gridAlignment).toBe(0);
    expect(result.metrics.bends.value).toBe(1);
    expect(result.Q).toBeLessThan(1);
    expect(Number.isFinite(result.Q)).toBe(true);
  });
  it('rejects missing and nonfinite final geometry', () => {
    const model = simple();
    delete model.nodes.a!.bounds;
    expect(() => score(model)).toThrow(/bounds/);
    const invalid = simple();
    invalid.links[0]!.path!.segments[0]!.to.x = NaN;
    expect(() => score(invalid)).toThrow(/finite/);
    const overflow = simple();
    overflow.nodes.a!.bounds = { x: 1e308, y: 0, width: 1e308, height: 40 };
    expect(() => score(overflow)).toThrow(/finite/);
  });
});
