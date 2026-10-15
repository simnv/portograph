import { describe, expect, it } from 'vitest';
import { courseEntries, coursesOf, declinedEntries, declinedTrunksOf, DeclinedTrunks, laneKeysOf, laneOwners, nodeFloors, nodeFloorsOf, pitchFloors, pitchFloorsOf, portRefOf, reserve, validateReservations, sideFaces, sideHintsOf, spanEntries, spansOf, turnEntries, turnOf } from '../../src/layout/reservations.js';
import { portKey } from '../../src/layout/sides-one.js';

describe('reservation ledger', () => {
  it('refuses a restored model whose pitch is under a reserved floor, and one that holds twice an id', () => {
    const ledger = pitchFloors(new Map([['n', { left: 10 }]]), 'fan', 0);
    const model = (pitch: number, reservations = ledger): never => ({ reservations, nodes: { n: { sidePitch: { left: pitch } } } }) as never;
    expect(() => validateReservations(model(10))).not.toThrow();
    expect(() => validateReservations(model(9))).toThrow(/does not hold/);
    expect(() => validateReservations(model(10, [...ledger, ...ledger]))).toThrow(/held twice/);
  });
  it('merges pitch and node floors by componentwise maximum and keeps declaration order', () => {
    const a = reserve([], pitchFloors(new Map([['n', { left: 10 }], ['m', { right: 4 }]]), 'fan', 0));
    const b = reserve(a, pitchFloors(new Map([['n', { left: 8, right: 6 }]]), 'fan', 1));
    expect([...pitchFloorsOf(b)]).toEqual([['n', { left: 10, right: 6 }], ['m', { right: 4 }]]);
    const sizes = reserve(reserve([], nodeFloors(new Map([['n', { width: 10, height: 30 }]]), 'side', 0)), nodeFloors(new Map([['n', { width: 20, height: 5 }]]), 'side', 1));
    expect(nodeFloorsOf(sizes).get('n')).toEqual({ width: 20, height: 30 });
  });
  it('round-trips a port key and the hints and lanes built from it', () => {
    const key = portKey({ node: 'n', name: 'p', ordinal: 2 }), anonymous = portKey({ node: 'n', anonymous: true, ordinal: 1 });
    expect(portKey(portRefOf(key))).toBe(key);
    expect(portKey(portRefOf(anonymous))).toBe(anonymous);
    const hints = new Map<string, 'left' | 'right'>([[key, 'left'], [anonymous, 'right']]);
    const promised = new Map([[key, { link: 'l', bends: 1, shape: 'lane' as const }], [anonymous, { link: 'k', bends: 0, shape: 'straight' as const }]]);
    const ledger = reserve(sideFaces(hints, promised, 'side', 1), laneOwners([key], hints, promised, 'side', 1));
    expect([...sideHintsOf(ledger)]).toEqual([...hints]);
    expect([...laneKeysOf(ledger)]).toEqual([key]);
  });
  it('rejects a side that disagrees and a course that conflicts', () => {
    const key = portKey({ node: 'n', name: 'p', ordinal: 1 });
    const left = sideFaces(new Map([[key, 'left' as const]]), new Map(), 'side', 0), right = sideFaces(new Map([[key, 'right' as const]]), new Map(), 'side', 0);
    expect(() => reserve(left, right)).toThrow(/asks for the side/);
    const course = { link: 'l', kind: 'gap', from: { face: 'left' }, to: { face: 'right' }, runs: [] } as never;
    const other = { ...(course as object), kind: 'perimeter' } as never;
    expect(coursesOf(reserve(courseEntries([course], undefined, 'course', 0), courseEntries([course], undefined, 'course', 1)))).toHaveLength(1);
    expect(() => reserve(courseEntries([course], undefined, 'course', 0), courseEntries([other], undefined, 'course', 1))).toThrow(/conflicts/);
  });
  it('unions spans, turn links and declines', () => {
    expect([...spansOf(reserve(spanEntries(['a'], 'span', 0), spanEntries(['b', 'a'], 'span', 1)))]).toEqual(['a', 'b']);
    const turn = reserve(turnEntries(false, ['a'], false, 'course', 0), turnEntries(false, ['b', 'a'], false, 'course', 1));
    expect(turnOf(turn)).toEqual({ all: false, links: ['a', 'b'], requireChanged: false });
    expect(turnOf(reserve(turn, turnEntries(true, [], true, 'turn', 2))).all).toBe(true);
    const declined = new DeclinedTrunks();
    declined.set('k', 'blocked');
    declined.all = true;
    const back = declinedTrunksOf(declinedEntries(declined, 0));
    expect(back.get('k')).toBe('blocked');
    expect(back.get('other')).toBe('the placement budget is spent');
  });
});
