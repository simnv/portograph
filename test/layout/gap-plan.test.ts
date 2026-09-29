import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { planGap, tierGapPlan, tierGapPlans, type GapPlan, type PlanFrame, type PlanInput } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { placed } from './phase-two-fixture.js';

/**
 * The tier-gap row plan (`docs/design/tier-gap-rows.md`, ranked-groups ticket 48) on the four shapes of Section 2.4, read from the
 * models `allocateGapRuns` sees (after 7f), and on hand-built parts for the shapes that need no model.
 */

const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const place = async (name: string): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(read(name)))))))));

/** `link-4#0a` is `link-4a`; the spec names the halves of a Z part so. */
const short = (id: string): string => id.replace('link-', '').replace('#0', '').replace(/#(\d)/, '.$1');
const rowsOf = (plan: GapPlan): Record<string, number[]> =>
  Object.fromEntries(plan.parts.filter(part => part.rows.length).map(part => [short(part.id), part.rows]));
const pairs = (plan: GapPlan): string[] => plan.crossings.map(item => [short(item.run).replace(/[ab]$/, ''), short(item.vertical)].sort().join('x')).sort();
const BAND_GAP = 60;

function expectRows(plan: GapPlan, expected: Record<string, number[]>): void {
  const got = rowsOf(plan);
  expect(Object.keys(got).sort()).toEqual(Object.keys(expected).sort());
  for (const [id, wanted] of Object.entries(expected)) {
    expect(got[id], id).toHaveLength(wanted.length);
    for (const [index, y] of wanted.entries()) expect(got[id]![index]!, `${id} row ${index}`).toBeCloseTo(y, 6);
  }
}

/** The gap that holds parts: the one the fixture is about. */
type Busy = { gap: ReturnType<typeof tierGaps>[number]; plan: GapPlan };
function busy(model: LayoutModel): Busy[] {
  return tierGapPlans(model).filter(({ plan }) => plan.parts.length);
}

describe('the tier-gap plan on the four shapes of the spec (Section 2.4)', () => {
  it('orders the ticket 36 shape 8, 5, 6, 7, 4 and asks for 45 px of growth', async () => {
    const [first, ...rest] = busy(await place('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row')).filter(({ plan }) => plan.order.length);
    expect(rest).toEqual([]);
    const { plan, gap } = first!;
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(short)).toEqual(['8', '5', '6', '7', '4']);
    expectRows(plan, { 8: [263], 5: [292], 6: [303.5], 7: [315], 4: [326.5] });
    // The O1 and O2 edges of the spec: 5 above 4 and 6 above 7 (same way), 8 above 5 and 7 above 4 (shared vertical).
    expect(plan.edges.map(edge => `${short(edge.above)}>${short(edge.below)}:${edge.kind}`).sort())
      .toEqual(['5>4:O1', '6>7:O1', '7>4:O2', '8>5:O2']);
    // link-9 is a drop at x 277.5 and takes no row.
    expect(plan.parts.find(part => part.shape === 'drop')!.upper.x).toBe(277.5);
    // Five forced crossings, one per interleaved pair, and no other.
    expect(pairs(plan)).toEqual(['4x6', '4x7', '5x6', '5x7', '5x8']);
    expect(plan.crossings.filter(item => item.kind === 'middle-drop' || item.kind === 'drop')).toEqual([]);
    expect(plan.height).toBeCloseTo(105, 6);
    expect(plan.setBy).toBe('link-4#0');
    // 7f grew the gap by the plan (ticket 50): it stands 105 px tall, 45 above the band gap (main grew 39.5), and asks for nothing more.
    expect(gap.high - gap.low - BAND_GAP).toBeCloseTo(45, 6);
    expect(plan.height - BAND_GAP).toBeCloseTo(45, 6);
    expect(plan.growth).toBe(0);
  });

  it('gives the ticket 41 shape a Z part: 4a 263, 3 274.5, 4b 286, one crossing on the middle drop, no growth', async () => {
    const [{ plan }] = busy(await place('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips')).filter(({ plan }) => plan.order.length) as [Busy];
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(short)).toEqual(['4a', '3', '4b']);
    expectRows(plan, { 4: [263, 286], 3: [274.5] });
    expect(plan.parts.find(part => part.shape === 'z')!.middle).toBeCloseTo(92.75, 6);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toMatchObject({ run: 'link-3#0', vertical: 'link-4#0', kind: 'middle-drop' });
    expect(plan.crossings[0]!.at.x).toBeCloseTo(92.75, 6);
    expect(plan.crossings[0]!.at.y).toBeCloseTo(274.5, 6);
    // The spec quotes the term: 286 + 15 - 248 = 53, under the 60 px band gap.
    expect(plan.demand).toBeCloseTo(53, 6);
    expect(plan.height).toBe(BAND_GAP);
    expect(plan.growth).toBe(0);
  });

  it('seats the ticket 43 shape, tips in the group padding, on rows of its own: 2a 131.75, 1 143.25, 2b 154.75', async () => {
    const [{ plan, gap }] = busy(await place('a-plain-tip-in-the-group-padding-holds-its-row')).filter(({ plan }) => plan.order.length) as [Busy];
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(short)).toEqual(['2a', '1', '2b']);
    // The first row stands one group-edge margin (10 + stroke / 2) below the low boundary, past the tip row in the padding.
    expect(gap.low).toBe(121);
    expectRows(plan, { 2: [131.75, 154.75], 1: [143.25] });
    expect(plan.parts.find(part => part.shape === 'z')!.middle).toBeCloseTo(97.75, 6);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toMatchObject({ run: 'link-1#0', vertical: 'link-2#0', kind: 'middle-drop' });
    expect(plan.crossings[0]!.at.x).toBeCloseTo(97.75, 6);
    // 154.75 + e - 121, with the lower tip 5 px into the padding of the band below.
    expect(plan.demand).toBeCloseTo(44.5, 6);
    expect(plan.growth).toBe(0);
  });

  it('plans both gaps of the v5-4-0 shape: rows, forced crossings, link-3 residual under the label, growth 0 after 7f', async () => {
    const model = await place('a-tier-gap-plan-orders-every-part');
    const [upper, lower] = tierGapPlans(model).filter(({ plan }) => plan.order.length);
    // Ticket 50: the spec's link-3 (row 179.5, the term that asked for 9.25 px) stands 102.5 under the `access` group label, whose
    // box the leg from the row to the nested lower tip would cross. It is residual, `leg-blocked`, and the router lays it.
    expect(upper!.plan.residual.map(item => `${short(item.id)}:${item.reason}`)).toEqual(['3:leg-blocked']);
    expect(lower!.plan.residual).toEqual([]);

    expect(upper!.plan.order.map(short)).toEqual(['11', '1', '5', '2']);
    expectRows(upper!.plan, { 11: [145], 1: [156.5], 5: [156.5], 2: [168] });
    expect(upper!.plan.edges.map(edge => `${short(edge.above)}>${short(edge.below)}:${edge.kind}`).sort()).toEqual(['11>1:O2', '5>2:O2']);
    // Four interleaved pairs of the spec (link-3's are gone) and two on link-4's drop.
    expect(pairs(upper!.plan)).toEqual(['11x2', '11x4', '11x5', '2x5', '4x5']);
    // Without link-3 nothing asks for more than the band gap: the floor sets H, and the old 69.25 is gone with it.
    expect(upper!.plan.height).toBe(BAND_GAP);
    expect(upper!.plan.growth).toBe(0);
    expect(upper!.plan.setBy).toBe('floor');

    expect(lower!.plan.order.map(short)).toEqual(['12.1', '10', '8', '7', '9']);
    expectRows(lower!.plan, { '12.1': [303.75], 10: [315.25], 8: [326.75], 7: [338.25], 9: [349.75] });
    expect(lower!.plan.edges.map(edge => `${short(edge.above)}>${short(edge.below)}:${edge.kind}`).sort())
      .toEqual(['10>7:O1', '10>8:O1', '10>9:O1', '12.1>10:O1', '12.1>7:O2', '12.1>8:O1', '8>7:O1']);
    // 7x9 and 8x9, and four on link-11's drop.
    expect(pairs(lower!.plan)).toEqual(['10x11.1', '11.1x7', '11.1x8', '11.1x9', '7x9', '8x9']);
    // The lanes overhang from the band above: the plan measures from the clipped low boundary (288.75); the spec quotes
    // 82.5 from the band bottom (278), the same 10.75 px further. 7f grew the gap to H (71.75 from the clipped low), so it asks for nothing more.
    expect(lower!.gap.low).toBeCloseTo(288.75, 6);
    expect(lower!.plan.height).toBeCloseTo(71.75, 6);
    expect(lower!.plan.bandTop - lower!.gap.low).toBeCloseTo(71.75, 6);
    expect(lower!.plan.growth).toBe(0);
    expect(lower!.plan.setBy).toBe('link-9#0');
  });

  it('reads the same plan through tierGapPlan and tierGapPlans, and writes nothing to the model', async () => {
    const model = await place('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row');
    const before = JSON.stringify(model);
    const all = tierGapPlans(model);
    expect(JSON.stringify(model)).toBe(before);
    for (const { gap, plan } of all) expect(tierGapPlan(model, gap)).toEqual(plan);
  });
});

/** The gap of the hand-built shapes: 248..308, flat stems (tips at 263 and 293), pitch and clearance 11.5. */
const frame = (): PlanFrame => ({ low: 248, bandTop: 308, floor: BAND_GAP, keep: 11.5, pitch: 11.5, edge: 10.75, tips: [], lowerTips: [], obstacles: [], residual: [] });
const part = (id: string, order: number, from: number, to: number): PlanInput => ({ id, link: id, order,
  upper: { x: from, y: 263, kind: 'tip', source: `up${from}` }, lower: { x: to, y: 293, kind: 'tip', source: `low${to}` } });

describe('the tier-gap plan on hand-built parts', () => {
  it('splits C of A 0 to 100, B 100 to 200, C 200 to 0 with D 188 to 12: D above the first half of C, five crossings, H 99', () => {
    const plan = planGap([part('A', 0, 0, 100), part('B', 1, 100, 200), part('C', 2, 200, 0), part('D', 3, 188, 12)], frame());
    expect(plan.residual).toEqual([]);
    // O2: B above A, C above B, A above C; the cycle splits C (the latest), and D goes above the first half.
    expect(plan.parts.find(item => item.id === 'C')!.shape).toBe('z');
    expect(plan.parts.find(item => item.id === 'C')!.middle).toBeCloseTo(56, 6);
    expect(plan.order).toEqual(['D', 'Ca', 'B', 'A', 'Cb']);
    expectRows(plan, { D: [274.5], C: [286, 320.5], B: [297.5], A: [309] });
    expect(plan.edges.map(edge => `${edge.above}>${edge.below}:${edge.kind}`).sort())
      .toEqual(['B>A:O2', 'Ca>B:O2', 'Ca>Cb:Z', 'A>Cb:O2', 'D>Ca:ZX'].sort());
    // D x B on D's run, C x B on C's first run, A x D and A x C (over the middle drop) on A's run, C x D on C's second run.
    expect(plan.crossings.map(item => `${item.run}|${item.vertical}|${item.kind}`).sort()).toEqual([
      'A|C|middle-drop', 'A|D|lower-leg', 'Ca|B|upper-leg', 'Cb|D|lower-leg', 'D|B|upper-leg',
    ].sort());
    expect(plan.demand).toBeCloseTo(99, 6);
    expect(plan.height).toBeCloseTo(99, 6);
    expect(plan.setBy).toBe('Cb');
  });

  it('splits the latest part of an O2 three-cycle without D, and orders the halves around the other two', () => {
    const plan = planGap([part('A', 0, 0, 100), part('B', 1, 100, 200), part('C', 2, 200, 0)], frame());
    expect(plan.residual).toEqual([]);
    expect(plan.parts.map(item => [item.id, item.shape])).toEqual([['A', 'stepped'], ['B', 'stepped'], ['C', 'z']]);
    // The widest clear intervals are 11.5..88.5 and 111.5..188.5, equally wide: the first, centre 50.
    expect(plan.parts.find(item => item.id === 'C')!.middle).toBeCloseTo(50, 6);
    expect(plan.order).toEqual(['Ca', 'B', 'A', 'Cb']);
    expectRows(plan, { C: [274.5, 309], B: [286], A: [297.5] });
    expect(plan.crossings.map(item => `${item.run}|${item.vertical}|${item.kind}`).sort())
      .toEqual(['A|C|middle-drop', 'Ca|B|upper-leg'].sort());
  });

  it('makes the later of two parts with legs of two sources within a run clearance residual, and grants it the earlier cover', () => {
    const close = { ...part('E', 1, 5, 150), upper: { x: 5, y: 263, kind: 'tip' as const, source: 'other' } };
    const plan = planGap([part('A', 0, 0, 100), close], frame());
    expect(plan.residual.map(item => [item.id, item.reason, item.granted])).toEqual([['E', 'legs-within-k', 'A']]);
    expect(plan.parts.map(item => item.id)).toEqual(['A']);
    // The residual part keeps 2k between its tip rows: (263 - 248) + 23 + (308 - 293).
    expect(plan.demand).toBeGreaterThanOrEqual(15 + 23 + 15 - 1e-9);
  });

  it('makes a stepped part residual whose lower leg runs beside the vertical of a jogged drop', () => {
    const plan = planGap([part('D', 0, 100, 110), part('B', 1, 0, 91)], frame());
    expect(plan.residual.map(item => [item.id, item.reason, item.granted])).toEqual([['B', 'legs-within-k', 'D']]);
    expect(plan.parts.map(item => item.id)).toEqual(['D']);
  });

  it('takes a part whose ends stand under a run clearance apart as a drop, and lets a run cross it once', () => {
    const plan = planGap([part('A', 0, 50, 55), part('B', 1, 0, 100)], frame());
    expect(plan.parts.find(item => item.id === 'A')!.shape).toBe('drop');
    expect(plan.parts.find(item => item.id === 'A')!.jog).toBeCloseTo(293 - 11.5, 6);
    expect(plan.crossings.map(item => `${item.run}|${item.vertical}|${item.kind}`)).toEqual(['B|A|drop']);
    // The run keeps 2k and the drop's depth from the lower tip row: k + depth + k for the jog.
    expect(plan.demand).toBeGreaterThanOrEqual(2 * 11.5 + 15 - 1e-9);
  });

  it('makes a part residual (leg-blocked) whose leg would pass through a fixed obstacle, and leaves the others their rows', () => {
    // A label anchored to the band below stands over x 90..110 with its top 20 px above the band top: the lower leg of A (x 100, tip 15 deep)
    // reaches down into it; B (x 200) does not.
    const blocks = [{ x0: 90, x1: 110, anchor: 'below' as const, bound: 20 }];
    const plan = planGap([part('A', 0, 0, 100), part('B', 1, 0, 200)], { ...frame(), blocks });
    expect(plan.residual.map(item => `${item.id}:${item.reason}`)).toEqual(['A:leg-blocked']);
    expect(plan.parts.map(item => item.id)).toEqual(['B']);
    // An obstacle the leg stops short of (its top below the tip) blocks nothing.
    const clear = planGap([part('A', 0, 0, 100)], { ...frame(), blocks: [{ x0: 90, x1: 110, anchor: 'below' as const, bound: 10 }] });
    expect(clear.residual).toEqual([]);
  });

  it('reads the edges of a half from its own span and breaks the cycle at the widest interval that leaves none (ticket 50, the chord fixture)', () => {
    // link-11 87 to 265.5 crosses 4 (241.5 to 63), 5, 6 and 10 (75 to 194); the whole edges close 11 > 9 > 4 > 6 > 11. Split at the widest clear
    // interval (164.25) the half 11b (164.25 to 265.5) would still be ordered above link-9 (63 to 122.5), whose span it cannot cross: the
    // cycle stays. The interval 217.5 to 230 (223.75) breaks it.
    const plan = planGap([part('4', 0, 241.5, 63), part('5', 1, 253.5, 134.5), part('6', 2, 265.5, 206), part('9', 3, 63, 122.5),
      part('10', 4, 75, 194), part('11', 5, 87, 265.5)], frame());
    expect(plan.residual).toEqual([]);
    expect(plan.parts.find(item => item.id === '11')!.middle).toBeCloseTo(223.75, 6);
    expect(plan.order).toEqual(['11a', '10', '9', '4', '5', '6', '11b']);
    expect(plan.edges.some(item => item.above === '11b' && item.below === '9')).toBe(false);
  });
});
