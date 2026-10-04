import { describe, expect, it } from 'vitest';
import { score } from '../../src/score/index.js';
import { empty, node } from './fixtures.js';

function scale(count: number) {
  const model = empty();
  for (let i = 0; i < count; i++) node(model, `n${i}`, { x: i * 200, y: 0, width: 40, height: 40 });
  model.tierBands[0]!.bounds!.width = count * 200 + 20000;
  model.canvas = { x: -20, y: -20, width: count * 200 + 40, height: 80 };
  model.labels.push({ id: 'collision', text: 'collision', owner: { kind: 'group', id: 'g-n0' }, layer: 'routed', bounds: { x: 10, y: 10, width: 10, height: 10 } });
  return model;
}

describe('size enforcement', () => {
  it('enforces G3 at 300 and warns at 301', () => {
    const at = score(scale(300)).snapshot, above = score(scale(301)).snapshot;
    expect(at.gates.G3).toMatchObject({ passed: false, severity: 'error' });
    expect(at.passed).toBe(false);
    expect(above.gates.G3).toMatchObject({ passed: false, severity: 'warning' });
    expect(above.passed).toBe(true);
  });
  it('requires force only above 1000, while retaining all other gates', () => {
    expect(score(scale(1000)).snapshot.passed).toBe(true);
    const model = scale(1001);
    expect(() => score(model)).toThrow(/force/);
    expect(score(model, { force: true }).snapshot.passed).toBe(true);
    model.nodes.n0!.bounds!.x = 5;
    model.nodes.n1!.bounds!.x = 5;
    const failed = score(model, { force: true }).snapshot;
    expect(failed.gates.G1.severity).toBe('error');
    expect(failed.gates.G1.passed).toBe(false);
    expect(failed.passed).toBe(false);
  });
});
