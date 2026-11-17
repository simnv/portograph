import { describe, expect, it } from 'vitest';
import { choosePairOrder, PAIR_ORDER_BOUND, PAIR_SEARCH_VISITS, type RowPair } from '../../src/layout/row-pairs.js';

// Dense-16x9 ticket 32: the joint order of two rows, an exact search, bounded.
const declared = (nodes: readonly string[]): Map<string, number> => new Map(nodes.map((node, at) => [node, at]));
const pair = (fields: Partial<RowPair> & Pick<RowPair, 'upper' | 'lower' | 'links'>): RowPair =>
  ({ peers: [], keys: new Map(), above: [], feeders: [], declared: declared([...fields.upper, ...fields.lower]), ...fields });

/** The competition case of ticket 30's review: a1 and a2 fed in that order, b1 and b2 unfed, the row below free. */
const competition: RowPair = pair({
  upper: ['a1', 'a2', 'b1', 'b2'],
  lower: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
  links: [['a1', 'c1'], ['a1', 'c5'], ['a2', 'c3'], ['a2', 'c4'], ['a2', 'c5'], ['b1', 'c2'], ['b1', 'c3'], ['b2', 'c0'], ['b2', 'c3'], ['b2', 'c4']],
  keys: new Map([['a1', 0], ['a2', 1]]),
});

describe('the joint order of two rows (dense-16x9 ticket 32)', () => {
  it('reaches the least crossings of the competition case: 2, with the fed members in their key order', () => {
    expect(choosePairOrder(competition)).toEqual({ kind: 'chosen', upper: ['a1', 'a2', 'b2', 'b1'], lower: ['c1', 'c5', 'c4', 'c0', 'c3', 'c2'], crossings: 2, was: 21 });
  });

  it('chooses the same order whatever order the links and the members are given in (R3), declaration order aside', () => {
    const turned = { ...competition, links: [...competition.links].reverse(), upper: [...competition.upper].reverse() };
    expect(choosePairOrder({ ...turned, upper: competition.upper })).toEqual(choosePairOrder(competition));
  });

  it('keeps today\'s order when it is a minimum', () => {
    const today = { upper: ['a1', 'a2', 'b2', 'b1'], lower: ['c1', 'c5', 'c4', 'c0', 'c3', 'c2'] };
    expect(choosePairOrder({ ...competition, ...today })).toEqual({ kind: 'kept', ...today, crossings: expect.any(Number) });
  });

  it('keeps an earlier joint choice while it is still a minimum', () => {
    const previous = { upper: ['a1', 'a2', 'b2', 'b1'], lower: ['c1', 'c5', 'c4', 'c0', 'c3', 'c2'] };
    expect(choosePairOrder({ ...competition, previous })).toEqual({ kind: 'stays', ...previous, crossings: expect.any(Number) });
  });

  it('counts a peer link whose ends a member stands between: the peer pair stays side by side', () => {
    // Top-1 and top-2 are fed in that order. Mid-3 links to both: between mid-1 and mid-2 it crosses nothing, but the peer link mid-1 to
    // mid-2 then passes its two links.
    const base = pair({ upper: ['top-1', 'top-2'], lower: ['mid-1', 'mid-2', 'mid-3'], links: [['top-1', 'mid-1'], ['top-2', 'mid-2'], ['top-1', 'mid-3'], ['top-2', 'mid-3']],
      keys: new Map([['top-1', 0], ['top-2', 1]]) });
    expect(choosePairOrder({ ...base, peers: [['mid-1', 'mid-2']] })).toMatchObject({ kind: 'kept' });
    expect(choosePairOrder(base)).toMatchObject({ kind: 'chosen', lower: ['mid-1', 'mid-3', 'mid-2'], crossings: 0 });
  });

  it('puts no member between two members one node of the row above links to, among the minima', () => {
    // Up links e1 and e2. Without that key, declaration order would stand e3 between them.
    const base = pair({ upper: ['e1', 'e3', 'e2'], lower: ['p1', 'p2', 'p3'], links: [['e1', 'p1'], ['e2', 'p2'], ['e3', 'p3']], declared: declared(['e1', 'e3', 'e2', 'p1', 'p3', 'p2']) });
    // Today's order is a minimum (no crossing): it stays, the key ranks only the minima of a search that runs.
    expect(choosePairOrder({ ...base, lower: ['p1', 'p3', 'p2'], above: [['e1', 'e2']] })).toMatchObject({ kind: 'kept' });
    expect(choosePairOrder({ ...base, lower: ['p2', 'p3', 'p1'], above: [['e1', 'e2']] })).toMatchObject({ kind: 'chosen', upper: ['e1', 'e2', 'e3'], lower: ['p1', 'p2', 'p3'] });
  });

  it('merges members no rule tells apart: they stand in declaration order and cost one order', () => {
    // Six lower members link to u only: one class, one order.
    const lower = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const choice = choosePairOrder(pair({ upper: ['u', 'v'], lower, links: [...lower.map(node => ['u', node] as const), ['v', 'm1']] }));
    expect(choice.kind).not.toBe('bound');
  });

  it('names a pair past the bound and searches one at it', () => {
    // Two upper members told apart by their links, and seven lower members each with its own links: 2 x 7! = 10080 orders.
    const lower = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    const links: [string, string][] = [['t1', 'm1'], ['t1', 'm2'], ['t1', 'm3'], ['t2', 'm4'], ['t2', 'm5'], ['t1', 'm6'], ['t2', 'm6'], ['t1', 'm7'], ['t2', 'm7']];
    const feeders = [['m1', 'm4', 'm6'], ['m2', 'm5', 'm7']];
    expect(PAIR_ORDER_BOUND).toBe(10000);
    expect(choosePairOrder(pair({ upper: ['t1', 't2'], lower, links, feeders }))).toEqual({ kind: 'bound', reason: 'orders', count: 10080 });
    // Without m7: 2 x 6! = 1440, searched.
    const six = lower.slice(0, 6);
    expect(choosePairOrder(pair({ upper: ['t1', 't2'], lower: six, links: links.filter(([, node]) => node !== 'm7'), feeders: [['m1', 'm4', 'm6'], ['m2', 'm5']] })).kind).not.toBe('bound');
  });

  it('searches nothing when a peer run straddles two keys the wrong way', () => {
    expect(choosePairOrder(pair({ upper: ['a', 'b'], lower: ['x'], links: [['a', 'x']], peers: [['a', 'b']], keys: new Map([['a', 1], ['b', 0]]) }))).toEqual({ kind: 'infeasible' });
  });

  it('counts the orders on the merged classes without a factorial: one member among 170 twins is 171 orders, searched (32 review 1)', () => {
    // 171! overflows a double: the old count read Infinity and called the pair past the bound.
    const lower = ['special', ...Array.from({ length: 170 }, (_, i) => `l${i}`)];
    const choice = choosePairOrder(pair({ upper: ['a', 'b'], lower, links: lower.map(node => [node === 'special' ? 'b' : 'a', node] as const), keys: new Map([['a', 0], ['b', 1]]) }));
    expect(choice).toMatchObject({ kind: 'chosen', crossings: 0, was: 170 });
    expect(choice.kind === 'chosen' && choice.lower.at(-1)).toBe('special');
  });

  it('refuses peer runs whose key ranges overlap before it walks (32 review 1)', () => {
    // Runs [a0, a2] and [b1, b3] with keys 0, 2 and 1, 3 stand in no order. With nine free members beside them the walk of 10fa07cc visited
    // every order of the free members (tens of millions of prefixes, factorial in their number) before it found none. The work is read as
    // time here only because 10fa07cc had no count to read; the search itself counts (R4).
    const loose = Array.from({ length: 9 }, (_, i) => `u${i}`), upper = ['a0', 'a2', 'b1', 'b3', ...loose];
    const started = performance.now();
    const choice = choosePairOrder(pair({ upper, lower: ['x'], links: upper.map(node => [node, 'x'] as const), peers: [['a0', 'a2'], ['b1', 'b3']],
      keys: new Map([['a0', 0], ['a2', 2], ['b1', 1], ['b3', 3]]), feeders: loose.map(node => [node]) }));
    expect(choice).toEqual({ kind: 'infeasible' });
    expect(performance.now() - started).toBeLessThan(1000);
  }, 600000);

  it('stops a walk past the bound of visited prefixes, and names it as a bound (32 review 1)', () => {
    expect(PAIR_SEARCH_VISITS).toBe(20 * PAIR_ORDER_BOUND);
    expect(choosePairOrder(competition, { orders: PAIR_ORDER_BOUND, visits: 100 })).toEqual({ kind: 'bound', reason: 'visits', count: 101 });
    expect(choosePairOrder(competition, { orders: PAIR_ORDER_BOUND, visits: PAIR_SEARCH_VISITS }).kind).toBe('chosen');
  });

  it('walks only the prefixes that can still keep the keys: two keyed members and four free ones stay under a small bound', () => {
    // Keys 1 then 0 in declaration: every prefix that places the member keyed 1 before the one keyed 0 is cut at once.
    const loose = Array.from({ length: 4 }, (_, i) => `u${i}`), upper = ['k1', 'k0', ...loose];
    const choice = choosePairOrder(pair({ upper, lower: ['x', 'y'], links: [['k0', 'x'], ['k1', 'y'], ...loose.map(node => [node, 'x'] as const)],
      keys: new Map([['k1', 1], ['k0', 0]]), feeders: loose.map(node => [node]) }), { orders: PAIR_ORDER_BOUND, visits: 3000 });
    expect(choice.kind).not.toBe('bound');
  });
});
