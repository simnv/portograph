import { describe, expect, it } from 'vitest';
import { straightCorridorClear } from '../../src/layout/row-paths.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../../src/model/index.js';
import { score } from '../../src/score/index.js';
import { empty, link, node } from './fixtures.js';

/**
 * The gates and the straight-corridor rule skip a pair whose boxes, grown by the clearance the
 * measured test uses, do not meet. Two properties of that reject are checked here, because both
 * were broken once:
 *
 * 1. A box must keep its far edges. Held as `x` plus a width it states the wrong edge at a large
 *    coordinate, because `x + width` rounds.
 * 2. Beyond `REJECT_LIMIT` the measured tests themselves cancel and report contact that is not
 *    there. The reject cannot reproduce such an answer, so it stands down and the pair is
 *    measured, exactly as before.
 */
describe('gate and corridor rejection at large coordinates', () => {
  const crossedLabel = (far: number, at: number, width: number): LayoutModel => {
    const model = empty();
    node(model, 'a', { x: -(2 ** 56) - 100, y: -20, width: 100, height: 40 });
    node(model, 'b', { x: far, y: -20, width: 100, height: 40 });
    link(model, 'ab', 'a', 'b', [{ x: -(2 ** 56), y: 0 }, { x: far, y: 0 }], ['right', 'left']);
    model.labels.push({ id: 'hit', owner: { kind: 'node', id: 'b' }, layer: 'routed', role: 'node',
      bounds: { x: at, y: -1, width, height: 2 }, text: 'x' });
    return model;
  };

  it('still reports the label a long segment ends on', () => {
    const snapshot = score(crossedLabel(2, 2, 1)).snapshot;
    expect(snapshot.counters.labelHits).toBe(1);
    expect(snapshot.gates.G3.violations.map(item => item.elements)).toContainEqual(['hit', 'ab']);
  });

  it('still reports the label the measured test calls contact through cancellation', () => {
    const snapshot = score(crossedLabel(10, 16, 1)).snapshot;
    expect(snapshot.counters.labelHits).toBe(1);
    expect(snapshot.gates.G3.violations.map(item => item.elements)).toContainEqual(['hit', 'ab']);
  });

  it('still closes a corridor the measured distance calls contact through cancellation', () => {
    const owner = { kind: 'link' as const, id: 'other' };
    const run: PathSegment = { from: { x: -(2 ** 60), y: 0 }, to: { x: 200, y: 0 }, owner };
    const at = (node: string): { node: string; name: string; ordinal: number } => ({ node, name: 'p', ordinal: 0 });
    const other: LayoutLink = { id: 'other', sourceIndex: 1, owner, from: at('a'), to: at('b'),
      layer: 'routed', path: { owner, layer: 'routed', fixed: true, segments: [run] } };
    const candidate: LayoutLink = { id: 'candidate', sourceIndex: 0, layer: 'routed',
      owner: { kind: 'link', id: 'candidate' }, from: at('c'), to: at('d'),
      attachments: { from: at('c'), to: at('d') } };
    const model = { ...empty(), links: [candidate, other] };
    const segment: PathSegment = { from: { x: 240, y: -20 }, to: { x: 240, y: 20 },
      owner: { kind: 'link', id: 'candidate' } };
    expect(straightCorridorClear(model, candidate, segment)).toBe(false);
  });
});
