import { describe, expect, it } from 'vitest';
import { pullForwardOrder } from '../../src/layout/reservation-order.js';

/** `edges` as [a, b]: a goes before b. */
const graph = (count: number, edges: readonly [number, number][]): number[][] => {
  const after = Array.from({ length: count }, () => [] as number[]);
  for (const [a, b] of edges) after[a]!.push(b);
  return after;
};

describe('pullForwardOrder: the reservation order of stage 7a (field-2026-11 ticket 05)', () => {
  it('keeps the base order when no edge goes against it', () => {
    expect(pullForwardOrder(graph(4, []))).toEqual([0, 1, 2, 3]);
    expect(pullForwardOrder(graph(4, [[0, 2], [1, 3]]))).toEqual([0, 1, 2, 3]);
  });

  it('moves a component only as early as an edge needs (review 1, re-check P3: edges 2>0, 3>0, 4>3 give 2, 4, 3, 0, 1)', () => {
    expect(pullForwardOrder(graph(5, [[2, 0], [3, 0], [4, 3]]))).toEqual([2, 4, 3, 0, 1]);
  });

  it('keeps the base order inside a cycle, and orders the cycle as one component', () => {
    expect(pullForwardOrder(graph(2, [[0, 1], [1, 0]]))).toEqual([0, 1]);
    // 1 and 2 form a cycle that must precede 0; 3 stays last.
    expect(pullForwardOrder(graph(4, [[1, 2], [2, 1], [2, 0]]))).toEqual([1, 2, 0, 3]);
  });

  it('orders a chain of 20,000 components in both directions without exhausting the call stack (re-check P2)', () => {
    const count = 20_000;
    const forward = graph(count, Array.from({ length: count - 1 }, (_, at) => [at, at + 1] as [number, number]));
    expect(pullForwardOrder(forward)).toEqual(Array.from({ length: count }, (_, at) => at));
    const backward = graph(count, Array.from({ length: count - 1 }, (_, at) => [at + 1, at] as [number, number]));
    expect(pullForwardOrder(backward)).toEqual(Array.from({ length: count }, (_, at) => count - 1 - at));
    // One cycle through all of them: one component, the base order.
    const ring = graph(count, Array.from({ length: count }, (_, at) => [at, (at + 1) % count] as [number, number]));
    expect(pullForwardOrder(ring)).toEqual(Array.from({ length: count }, (_, at) => at));
  });
});
