import { describe, expect, it } from 'vitest';
import { byKeys, compare, gains, holds, keys, lazyCount, profiles, reading, straightFell, straightOf, type Family, type Reading } from '../../src/layout/objective.js';
import { sheetGains, windowsHold } from '../../src/layout/overlay-place.js';
import { pickTarget } from '../../src/layout/overlay-window.js';

/** Architecture ticket 04: one Reading, one compare. The profiles of the judges that stand, and the unified order that nothing calls yet. */
const family = (bent: number, turns: number, extra: Partial<Family> = {}): Family => ({ straight: 0, bent, turns, ...extra });
const mk = (overlay: Family, routed: Family, crossings: number, tie: readonly number[] = [0]): Reading =>
  reading({ overlay, routed, crossings: lazyCount(() => crossings), crossingMode: 'points', tie });

describe('byKeys', () => {
  const byCrossings = byKeys([keys.fewerCrossings]);
  it('ends in a deterministic key, so equal readings of different candidates are ordered', () => {
    const near = mk(family(0, 0), family(0, 0), 3, [1, 5]), far = mk(family(0, 0), family(0, 0), 3, [2, 1]);
    expect(byCrossings(near, far)).toBeLessThan(0);
    expect(byCrossings(far, near)).toBeGreaterThan(0);
    expect(byCrossings(near, near)).toBe(0);
  });

  it('compares the tie numbers in turn, and a missing tie reads as equal', () => {
    const a = mk(family(0, 0), family(0, 0), 1, [1, 2]), b = mk(family(0, 0), family(0, 0), 1, [1, 3]), none = reading({ overlay: family(0, 0), crossings: lazyCount(() => 1), crossingMode: 'points' });
    expect(byCrossings(a, b)).toBeLessThan(0);
    expect(byCrossings(a, none)).toBeGreaterThan(0);
    expect(byCrossings(none, none)).toBe(0);
  });

  it('refuses a gate profile to the sort, and an equal unified reading without a tie is an error and no accident', () => {
    const one = reading({ crossings: lazyCount(() => 1), crossingMode: 'points' });
    // @ts-expect-error a gate profile has a key that is not antisymmetric: it may not sort
    expect(compare(one, one, profiles.windowsHold)).toBe(0);
    expect(() => compare(one, one, profiles.unified)).toThrow(/tie/);
    expect(profiles.windowsHold.kind).toBe('gate');
    expect(profiles.unified.kind).toBe('order');
  });

  it('refuses to compare crossing counts of two modes', () => {
    const points = reading({ crossings: lazyCount(() => 1), crossingMode: 'points' }), pairs = reading({ crossings: lazyCount(() => 1), crossingMode: 'pairs' });
    expect(() => compare(points, pairs, profiles.unified)).toThrow(/no pair/);
  });

  it('reads the crossings only when the first keys tie', () => {
    let asked = 0;
    const a = reading({ overlay: family(1, 1), crossings: lazyCount(() => { asked++; return 0; }), crossingMode: 'points' }), b = reading({ overlay: family(2, 2), crossings: lazyCount(() => 0), crossingMode: 'points' });
    expect(compare(a, b, profiles.unified)).toBeLessThan(0);
    expect(asked).toBe(0);
  });
});

describe('the unified profile', () => {
  const by = profiles.unified;

  it('puts fewer bent links over both layers first, and a trade of one layer for the other is no gain', () => {
    const base = mk(family(1, 1), family(1, 1), 0);
    expect(compare(mk(family(0, 0), family(1, 1), 5), base, by)).toBeLessThan(0);
    expect(compare(mk(family(1, 1), family(0, 0), 5), base, by)).toBeLessThan(0);
    expect(compare(mk(family(2, 2), family(1, 1), 0), base, by)).toBeGreaterThan(0);
    expect(compare(mk(family(0, 0), family(2, 2), 0), mk(family(2, 2), family(0, 0), 0), by)).toBe(0);
  });

  it('puts the turns before the crossings: fewer bent links with more turns lose to the same count with fewer turns', () => {
    const base = mk(family(2, 9), family(0, 0), 0);
    expect(compare(mk(family(2, 4), family(0, 0), 7), base, by)).toBeLessThan(0);
    expect(compare(mk(family(3, 3), family(0, 0), 0), base, by)).toBeGreaterThan(0);
  });

  it('puts the crossings last, then the deterministic key', () => {
    const base = mk(family(1, 1), family(0, 0), 4, [3, 0]);
    expect(compare(mk(family(1, 1), family(0, 0), 3, [9, 9]), base, by)).toBeLessThan(0);
    expect(compare(mk(family(1, 1), family(0, 0), 4, [2, 0]), base, by)).toBeLessThan(0);
    expect(compare(mk(family(1, 1), family(0, 0), 4, [3, 0]), base, by)).toBe(0);
  });

  it('accepts a net gain that bends some other link: the ids are shown, not vetoed', () => {
    const base = mk(family(3, 3, { bentIds: new Set(['a', 'b', 'c']) }), family(0, 0), 2);
    const after = mk(family(2, 2, { bentIds: new Set(['a', 'd']) }), family(0, 0), 2);
    expect(gains(after, base, by)).toBe(true);
    expect([...after.overlay.bentIds!].filter(id => !base.overlay.bentIds!.has(id))).toEqual(['d']);
  });

  it('is a total order: antisymmetric and transitive over every reading of small counts', () => {
    const all: Reading[] = [];
    for (const ob of [0, 1]) for (const rb of [0, 1]) for (const ot of [0, 2]) for (const rt of [0, 1]) for (const c of [0, 1, 2]) for (const t of [0, 1])
      all.push(mk(family(ob, ot + ob), family(rb, rt + rb), c, [t]));
    const sign = (x: number): number => Math.sign(x);
    for (const a of all) for (const b of all) expect(sign(compare(a, b, by)) + sign(compare(b, a, by))).toBe(0);
    for (const a of all) for (const b of all) for (const c of all) if (compare(a, b, by) <= 0 && compare(b, c, by) <= 0) expect(compare(a, c, by)).toBeLessThanOrEqual(0);
  });

  it('holds when equal and gains only when strictly better', () => {
    const one = mk(family(1, 1), family(0, 0), 1);
    expect(holds(one, one, by)).toBe(true);
    expect(gains(one, one, by)).toBe(false);
  });
});

describe('the profiles of the judges that stand give their old verdicts', () => {
  it('sheetGains: turns not up, then fewer bent links, or as many and fewer crossings', () => {
    const old = (w: { bent: number; turns: number; crossings: number }, b: { bent: number; turns: number; crossings: number }): boolean =>
      w.turns <= b.turns && (w.bent < b.bent || (w.bent === b.bent && w.crossings < b.crossings));
    for (const wb of [0, 1, 2]) for (const wt of [0, 1, 2]) for (const wc of [0, 1, 2]) for (const bb of [0, 1, 2]) for (const bt of [0, 1, 2]) for (const bc of [0, 1, 2]) {
      expect(sheetGains({ bent: wb, turns: wt, crossings: wc }, { bent: bb, turns: bt, crossings: bc })).toBe(old({ bent: wb, turns: wt, crossings: wc }, { bent: bb, turns: bt, crossings: bc }));
    }
  });

  it('windowsHold: more straight, or the same set and no more crossings', () => {
    const sets = [[], ['a'], ['b'], ['a', 'b'], ['a', 'b', 'c']].map(list => new Set(list));
    for (const after of sets) for (const before of sets) for (const ca of [0, 1, 2]) for (const cb of [0, 1, 2]) {
      const old = after.size > before.size || (after.size === before.size && [...before].every(id => after.has(id)) && ca <= cb);
      expect(windowsHold(after, before, () => ca, cb)).toBe(old);
    }
  });

  it('windowsHold asks for the crossings only where the straight sets tie', () => {
    let asked = 0;
    expect(windowsHold(new Set(['a', 'b']), new Set(['a']), () => { asked++; return 0; }, 0)).toBe(true);
    expect(windowsHold(new Set(['b']), new Set(['a']), () => { asked++; return 0; }, 0)).toBe(false);
    expect(asked).toBe(0);
  });

  it('pickTarget: more straight, then fewer crossings unless the candidate bends a chord straight at the mean; the nearest of equals stays', () => {
    const table = new Map<number, { crossings: number; straight: number; bendsMean: boolean }>([
      [10, { crossings: 4, straight: 2, bendsMean: false }], [12, { crossings: 1, straight: 2, bendsMean: true }], [8, { crossings: 3, straight: 2, bendsMean: false }],
      [20, { crossings: 9, straight: 3, bendsMean: false }], [21, { crossings: 0, straight: 3, bendsMean: false }], [30, { crossings: 0, straight: 3, bendsMean: false }],
    ]);
    const pick = (list: number[]) => pickTarget(10, list, x => table.get(x)!);
    expect(pick([12]).target).toBe(10);
    expect(pick([12, 8])).toEqual({ target: 8, gained: 0, saved: 1 });
    expect(pick([20, 21, 30])).toEqual({ target: 21, gained: 1, saved: 4 });
    expect(pick([30, 21]).target).toBe(21);
  });

  it('pickTarget: a candidate that bends the mean has no say on crossings, even against an incumbent that bends it too', () => {
    const table = new Map<number, { crossings: number; straight: number; bendsMean: boolean }>([
      [14, { crossings: 5, straight: 3, bendsMean: true }], [15, { crossings: 1, straight: 3, bendsMean: true }], [16, { crossings: 2, straight: 3, bendsMean: false }],
      [10, { crossings: 4, straight: 2, bendsMean: false }],
    ]);
    const pick = (list: number[]) => pickTarget(10, list, x => table.get(x)!);
    expect(pick([14, 15]).target).toBe(14);
    expect(pick([14, 15, 16]).target).toBe(16);
  });

  it('straightFell: by count a swap is no loss, by link it is', () => {
    const was = [{ id: 'a' }, { id: 'b' }];
    expect(straightFell([{ id: 'a' }, { id: 'c' }], was, true)).toBe(false);
    expect(straightFell([{ id: 'a' }, { id: 'c' }], was, false)).toBe(true);
    expect(straightFell([{ id: 'a' }], was, true)).toBe(true);
    expect(straightFell([{ id: 'a' }, { id: 'b' }], was, false)).toBe(false);
  });

  it('keeps the straight set as a family of ids', () => {
    expect(straightOf(new Set(['a', 'b'])).straight).toBe(2);
  });
});
