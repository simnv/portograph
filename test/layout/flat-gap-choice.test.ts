import { describe, expect, it } from 'vitest';
import { aspectFlatGaps, nearerAim } from '../../src/layout/flat-gap-choice.js';
import type { BlockReservation } from '../../src/model/layout.js';

// Dense-16x9 ticket 42: one choice of the flat gaps for the first choice and the final one.
const record = (family: string, below: number, chosen: number, floor: number, target: number): BlockReservation =>
  ({ family, above: below - 1, below, target, cap: 600, chosen, pitch: 21, mode: 'flat', floor });

describe('aspectFlatGaps', () => {
  it('shares the missing height equally, and a gap at its demand passes the rest on', () => {
    // W / aim = 2000 / 2 = 1000; the sheet is 700 high: 300 px missing. Tier 2 can grow 100 px, tier 4 can grow 500 px.
    const gaps = aspectFlatGaps([record('a', 2, 300, 300, 400), record('b', 4, 500, 500, 1000)], { width: 2000, height: 700 }, 2, undefined);
    expect(gaps).toEqual([{ family: 'a', gap: 400 }, { family: 'b', gap: 700 }]);
  });

  it('gives no gaps when the sheet is at the aim, or higher and no choice raised a gap', () => {
    const records = [record('a', 2, 300, 300, 900)];
    expect(aspectFlatGaps(records, { width: 2000, height: 1000 }, 2, undefined)).toBeUndefined();
    expect(aspectFlatGaps(records, { width: 2000, height: 1200 }, 2, undefined)).toBeUndefined();
    // A gap that no choice raised stands at its mandatory height, though it stands above its floor.
    expect(aspectFlatGaps([record('a', 2, 500, 300, 900)], { width: 2000, height: 1200 }, 2, [{ family: 'other', gap: 1 }])).toBeUndefined();
  });

  it('drops a raised gap toward the aim, never below the largest floor of its tier gap', () => {
    // 200 px too high; the tier gap stands at 700, its floors are 450 and 600: it drops to 600 at most, by 100 px.
    const records = [record('a', 2, 700, 450, 900), record('b', 2, 700, 600, 800)];
    const asked = [{ family: 'a', gap: 700 }, { family: 'b', gap: 700 }];
    expect(aspectFlatGaps(records, { width: 2000, height: 1200 }, 2, asked)).toEqual([{ family: 'a', gap: 600 }, { family: 'b', gap: 600 }]);
    // 50 px too high: the gap drops by 50 px.
    expect(aspectFlatGaps(records, { width: 2000, height: 1050 }, 2, asked)).toEqual([{ family: 'a', gap: 650 }, { family: 'b', gap: 650 }]);
  });

  it('reads no record under the cap', () => {
    const steep: BlockReservation = { family: 's', above: 1, below: 2, target: 300, cap: 600, chosen: 300, pitch: 21 };
    expect(aspectFlatGaps([steep], { width: 2000, height: 100 }, 2, undefined)).toBeUndefined();
  });
});

describe('nearerAim', () => {
  it('asks for a smaller aspect gap by more than ASPECT_EPS', () => {
    expect(nearerAim({ width: 1600, height: 900 }, { width: 1600, height: 800 }, 16 / 9)).toBe(true);
    expect(nearerAim({ width: 1600, height: 800 }, { width: 1600, height: 900 }, 16 / 9)).toBe(false);
    expect(nearerAim({ width: 1600, height: 900 }, { width: 1600, height: 900 }, 16 / 9)).toBe(false);
  });
});
