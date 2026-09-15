import { describe, expect, it } from 'vitest';
import { score } from '../../src/score/index.js';
import { empty, link, node } from './fixtures.js';

/**
 * The gates skip a pair whose boxes, grown by the clearance the measured test uses, do not meet.
 * A box kept as `x` plus a width cannot state its far edge at a large coordinate: `x + width`
 * rounds, and a reject read from it would drop a pair the measured test fails. Every box the
 * rejects use therefore keeps its far edges.
 */
describe('gate rejection boxes at large coordinates', () => {
  it('still reports the label a long segment crosses', () => {
    const model = empty();
    node(model, 'a', { x: -(2 ** 56) - 100, y: -20, width: 100, height: 40 });
    node(model, 'b', { x: 2, y: -20, width: 100, height: 40 });
    link(model, 'ab', 'a', 'b', [{ x: -(2 ** 56), y: 0 }, { x: 2, y: 0 }], ['right', 'left']);
    model.labels.push({ id: 'hit', owner: { kind: 'node', id: 'b' }, layer: 'routed', role: 'node',
      bounds: { x: 2, y: -1, width: 1, height: 2 }, text: 'x' });

    const snapshot = score(model).snapshot;
    expect(snapshot.counters.labelHits).toBe(1);
    expect(snapshot.gates.G3.violations.map(item => item.elements)).toContainEqual(['hit', 'ab']);
  });
});
