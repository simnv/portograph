import { describe, expect, it } from 'vitest';
import { turnOrder, turnOrderViolated, type TurnPort } from '../../src/layout/turn-order.js';

type Item = TurnPort & { id: string };
/** A bracket (overlay course) is a low-turn return with its reach. */
const bracket = (id: string, far: number, reach: number): Item => ({ id, far, reach, turn: 'low', shape: 'return' });

describe('the port order of a face (ticket 15 brackets, one comparator)', () => {
  const ports: Item[] = [bracket('c1', 10, 300), bracket('c2', 500, 200), { id: 'above', far: 50 }, { id: 'below', far: 450 }, { id: 'none', far: Infinity }];
  const sorted = (list: Item[]): string[] => [...list].sort(turnOrder(list)).map(item => item.id);
  it('is total: the same order from every start', () => {
    const expected = sorted(ports);
    for (let shift = 0; shift < ports.length; shift++) expect(sorted([...ports.slice(shift), ...ports.slice(0, shift)])).toEqual(expected);
    expect(sorted([...ports].reverse())).toEqual(expected);
  });
  it('puts a routed port whose peer is above the brackets above them, and the others below', () => {
    expect(sorted(ports)).toEqual(['above', 'c1', 'c2', 'below', 'none']);
  });
});

describe('the five groups of the turn order', () => {
  const sorted = (list: Item[]): string[] => [...list].sort(turnOrder(list)).map(item => item.id);
  it('stand low return, low onward, none, high onward, high return', () => {
    const list: Item[] = [
      { id: 'hr', far: 0, turn: 'high', shape: 'return', reach: 10 }, { id: 'ho', far: 0, turn: 'high', shape: 'onward', reach: 10 },
      { id: 'n', far: 50 }, { id: 'lo', far: 0, turn: 'low', shape: 'onward', reach: 10 }, { id: 'lr', far: 0, turn: 'low', shape: 'return', reach: 10 },
    ];
    expect(sorted(list)).toEqual(['lr', 'lo', 'n', 'ho', 'hr']);
  });
  it('orders a group by reach: return descending, onward ascending', () => {
    const lo = (id: string, reach: number): Item => ({ id, far: 0, turn: 'low', shape: 'onward', reach });
    const hr = (id: string, reach: number): Item => ({ id, far: 0, turn: 'high', shape: 'return', reach });
    expect(sorted([lo('far', 30), lo('near', 10)])).toEqual(['near', 'far']);
    expect(sorted([hr('near', 10), hr('far', 30)])).toEqual(['far', 'near']);
  });
  it('keeps the far-end order with no planned turn, and the input order on a tie', () => {
    expect(sorted([{ id: 'b', far: 9 }, { id: 'a', far: 1 }])).toEqual(['a', 'b']);
    expect(sorted([{ id: 'x', far: 1 }, { id: 'y', far: 1 }])).toEqual(['x', 'y']);
  });
});

describe('G5 on a turn-ordered face', () => {
  const low: TurnPort = { far: 0, turn: 'low', shape: 'onward', reach: 5 }, none: TurnPort = { far: 0 };
  const near: TurnPort = { far: 0, turn: 'high', shape: 'return', reach: 10 }, far: TurnPort = { far: 0, turn: 'high', shape: 'return', reach: 30 };
  it('judges two ports with no turn by their far-end ranges', () => {
    expect(turnOrderViolated(none, none, true)).toBe(true);
    expect(turnOrderViolated(none, none, false)).toBe(false);
  });
  it('judges other pairs by the groups, not the ranges', () => {
    expect(turnOrderViolated(low, none, true)).toBe(false);
    expect(turnOrderViolated(none, low, false)).toBe(true);
  });
  it('puts the shorter return at the high end', () => {
    expect(turnOrderViolated(far, near, false)).toBe(false);
    expect(turnOrderViolated(near, far, false)).toBe(true);
  });
});
