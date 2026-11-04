import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { facingTips, plannedSegments, planGap, tierGapPlan, tierGapPlans, type GapPlan, type PlanFrame, type PlanInput } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { placed } from './phase-two-fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';
import { withoutJointOrderOn } from './joint-off.js';

/**
 * The tier-gap row plan (`docs/design/tier-gap-rows.md`, ranked-groups ticket 48) on the four shapes of Section 2.4, read from the
 * models `allocateGapRuns` sees (after 7f), and on hand-built parts for the shapes that need no model.
 */

const read = (name: string): string => withoutJointOrderOn(name, readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const place = async (name: string): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(read(name)))))))));
/** The same input with every link authored `route: orthogonal`: Q108 gives a link between frames its chord, and the plan of the orthogonal parts is the subject here. */
const placeBent = async (name: string): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(orthogonalLinks(read(name))))))))));

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
    expectRows(plan, { 8: [264], 5: [293], 6: [304.5], 7: [316], 4: [327.5] }); // Verdana metrics (snack-theme ticket 157): 263, 292, 303.5, 315 and 326.5 with Arial.
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

  it('gives the ticket 41 shape a Z part: 4a 264, 3 275.5, 4b 287, one crossing on the middle drop, no growth', async () => {
    const [{ plan }] = busy(await place('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips')).filter(({ plan }) => plan.order.length) as [Busy];
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(short)).toEqual(['4a', '3', '4b']);
    expectRows(plan, { 4: [264, 287], 3: [275.5] }); // Verdana metrics (snack-theme ticket 157): 263, 286 and 274.5 with Arial.
    expect(plan.parts.find(part => part.shape === 'z')!.middle).toBeCloseTo(92.75, 6);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toMatchObject({ run: 'link-3#0', vertical: 'link-4#0', kind: 'middle-drop' });
    expect(plan.crossings[0]!.at.x).toBeCloseTo(92.75, 6);
    expect(plan.crossings[0]!.at.y).toBeCloseTo(275.5, 6); // Verdana metrics (snack-theme ticket 157): 274.5 with Arial.
    // The spec quotes the term: 286 + 15 - 248 = 53 (287 + 15 - 249 under Verdana, the same), under the 60 px band gap.
    expect(plan.demand).toBeCloseTo(53, 6);
    expect(plan.height).toBe(BAND_GAP);
    expect(plan.growth).toBe(0);
  });

  it('seats the ticket 43 shape, tips in the group padding, on rows of its own: 2a 132.75, 1 144.25, 2b 155.75', async () => {
    const [{ plan, gap }] = busy(await place('a-plain-tip-in-the-group-padding-holds-its-row')).filter(({ plan }) => plan.order.length) as [Busy];
    expect(plan.residual).toEqual([]);
    expect(plan.order.map(short)).toEqual(['2a', '1', '2b']);
    // The first row stands one group-edge margin (10 + stroke / 2) below the low boundary, past the tip row in the padding.
    expect(gap.low).toBe(122); // Verdana metrics (snack-theme ticket 157): 121 with Arial.
    expectRows(plan, { 2: [132.75, 155.75], 1: [144.25] }); // Verdana metrics (snack-theme ticket 157): 131.75, 154.75 and 143.25 with Arial.
    expect(plan.parts.find(part => part.shape === 'z')!.middle).toBeCloseTo(97.75, 6);
    expect(plan.crossings).toHaveLength(1);
    expect(plan.crossings[0]).toMatchObject({ run: 'link-1#0', vertical: 'link-2#0', kind: 'middle-drop' });
    expect(plan.crossings[0]!.at.x).toBeCloseTo(97.75, 6);
    // 155.75 + e - 122, with the lower tip 5 px into the padding of the band below.
    expect(plan.demand).toBeCloseTo(44.5, 6);
    expect(plan.growth).toBe(0);
  });

  it('plans both gaps of the v5-4-0 shape: rows, forced crossings, link-3 planned clear of the label, growth 0 after 7f', async () => {
    const model = await placeBent('a-tier-gap-plan-orders-every-part');
    const [upper, lower] = tierGapPlans(model).filter(({ plan }) => plan.order.length);
    // The spec's link-3 (row 179.5, the term that asked for 9.25 px) stands 102.5 under the `access` group label. Ticket 50 declined it
    // (`leg-blocked`); since ticket 62 the label is nudged along its edge off the leg at placement, so the plan lays it as the spec does.
    expect(upper!.plan.residual.map(item => `${short(item.id)}:${item.reason}`)).toEqual([]);
    expect(lower!.plan.residual).toEqual([]);

    // The spec numbers (tier-gap-rows.md, section 2.4). Ticket 57 left src at x -124.65 without the centring replay after its growth; since
    // ticket 65 the step keeps the verticals it reached and the settle after the 7f rounds puts src at -203.47 again.
    expect(upper!.plan.order.map(short)).toEqual(['11', '1', '5', '2', '3']);
    expectRows(upper!.plan, { 11: [146], 1: [157.5], 5: [157.5], 2: [169], 3: [180.5] }); // Verdana metrics (snack-theme ticket 157): 145, 156.5, 156.5, 168 and 179.5 with Arial.
    expect(upper!.plan.edges.map(edge => `${short(edge.above)}>${short(edge.below)}:${edge.kind}`).sort()).toEqual(['11>1:O2', '5>2:O2', '5>3:O1']);
    // The seven interleaved pairs of the spec, link-3's included, and two on link-4's drop.
    expect(pairs(upper!.plan)).toEqual(['11x2', '11x3', '11x4', '11x5', '2x3', '2x5', '4x5']);
    // Link-3's row is the term that asks for 9.25 px above the band gap, the spec's H = 69.25; 7f grew the gap to it, so nothing more is asked.
    expect(upper!.plan.height).toBeCloseTo(69.25, 6);
    expect(upper!.plan.growth).toBe(0);
    expect(upper!.plan.setBy).toBe('link-3#0');

    expect(lower!.plan.order.map(short)).toEqual(['12.1', '10', '8', '7', '9']);
    expectRows(lower!.plan, { '12.1': [315], 10: [326.5], 8: [338], 7: [349.5], 9: [361] }); // Verdana metrics (snack-theme ticket 157): 313, 324.5, 336, 347.5 and 359 with Arial.
    // Architecture-2 ticket 69: after the end trim `edge-near` closes up by 63.5 px, and 12.1 no longer shares a vertical with 7 (the O2 edge
    // `12.1>7` of the spec goes); the rows, the crossings and H stay.
    expect(lower!.plan.edges.map(edge => `${short(edge.above)}>${short(edge.below)}:${edge.kind}`).sort())
      .toEqual(['10>7:O1', '10>8:O1', '10>9:O1', '12.1>10:O1', '12.1>8:O1', '8>7:O1']);
    // 7x9 and 8x9, and four on link-11's drop.
    expect(pairs(lower!.plan)).toEqual(['10x11.1', '11.1x7', '11.1x8', '11.1x9', '7x9', '8x9']);
    // The lanes overhang from the band above: the plan measures from the clipped low boundary (300 under Verdana, 298 with Arial; the 9.25 px of the upper gap later); the spec quotes
    // 82.5 from the band bottom (278), the same 10.75 px further. 7f grew the gap to H (71.75 from the clipped low), so it asks for nothing more.
    expect(lower!.gap.low).toBeCloseTo(300, 6); // Verdana metrics (snack-theme ticket 157): 298 with Arial.
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
  describe('nests the runs of two nodes by their far ends (ticket 153)', () => {
    // P and Q interleave (P starts left of Q and ends right of it) and cross once in either order. Of equal need (an obstacle below the gap over
    // both spans) the hub end decides which order puts the crossing on the stubs next to the hub. A third part, R, is unrelated; the plan must
    // not depend on the order of the inputs.
    // The floor leaves room: the nesting never makes the gap taller than the plain order, and a gap in the sheet has slack.
    const obstacles: PlanFrame['obstacles'] = [{ x0: 90, x1: 620, anchor: 'below', bound: 30.75 }];
    const permutations = <T,>(items: T[]): T[][] => items.length < 2 ? [items] : items.flatMap((item, at) => permutations([...items.slice(0, at), ...items.slice(at + 1)]).map(rest => [item, ...rest]));
    const upper = (from: number, node: string): PlanInput['upper'] => ({ x: from, y: 263, kind: 'tip', source: `${node}|bottom|${from}` });
    const lower = (to: number, node: string): PlanInput['lower'] => ({ x: to, y: 293, kind: 'tip', source: `${node}|top|${to}` });
    const rowOf = (plan: GapPlan, id: string): number => plan.parts.find(item => item.id === id)!.rows[0]!;

    it('puts the run that ends further out on the nearer row when the hubs stand above the gap, whatever the order of the inputs', () => {
      // Q's port stands within P's span and its stem is long (a tip at 275), so P's lb is the lower and the plain sort puts Q first. R (500 to 600)
      // has the lb between them in the reviewer's case; the tips below make lb(Q) < lb(R) < lb(P).
      const p = { ...part('P', 0, 100, 400), upper: upper(100, 'hub-a'), lower: lower(400, 'r-p') };
      const q = { ...part('Q', 1, 130, 300), upper: upper(130, 'hub-b'), lower: lower(300, 'r-q') };
      const r = { ...part('R', 2, 500, 600), upper: upper(500, 'hub-c'), lower: lower(600, 'r-r') };
      // Each hub carries a second port in the gap, so the upper end is the hub end.
      const s1 = { ...part('S', 3, 700, 760), upper: upper(700, 'hub-a'), lower: lower(760, 'r-s') };
      const s2 = { ...part('T', 4, 720, 780), upper: upper(720, 'hub-b'), lower: lower(780, 'r-t') };
      const tips = [{ x: 120, y: 275 }, { x: 450, y: 266 }];
      for (const inputs of permutations([p, q, r, s1, s2])) {
        const plan = planGap(inputs, { ...frame(), floor: 100, tips, obstacles });
        expect(plan.residual, inputs.map(item => item.id).join()).toEqual([]);
        expect(rowOf(plan, 'P'), inputs.map(item => item.id).join()).toBeLessThan(rowOf(plan, 'Q'));
        expect(plan.crossings.filter(item => item.run === 'P' && item.vertical === 'Q').map(item => item.kind)).toEqual(['upper-leg']);
        expect(plan.crossings.filter(item => item.run === 'Q' && item.vertical === 'P')).toEqual([]);
      }
    });

    it('keeps the crossing on the lower leg of the nearer part when its own hub stands below, whatever the hubs of the farther part', () => {
      // P leaves hub-a (five ports in the gap) for a router; Q leaves a router for hub-c (three ports). The upper nodes weigh 5 + 1 against 1 + 3
      // below, but the crossing falls on Q alone, and Q's own hub is its lower node: the plain order stays, the crossing stays at hub-c.
      const p = { ...part('P', 0, 100, 400), upper: upper(100, 'hub-a'), lower: lower(400, 'r-p') };
      const q = { ...part('Q', 1, 130, 300), upper: upper(130, 'r-q'), lower: lower(300, 'hub-c') };
      const extras = [0, 1, 2, 3].map(i => ({ ...part(`A${i}`, 2 + i, 700 + 20 * i, 760 + 20 * i), upper: upper(700 + 20 * i, 'hub-a'), lower: lower(760 + 20 * i, `r-a${i}`) }))
        .concat([0, 1].map(i => ({ ...part(`C${i}`, 6 + i, 1000 + 20 * i, 1060 + 20 * i), upper: upper(1000 + 20 * i, `r-c${i}`), lower: lower(1060 + 20 * i, 'hub-c') })));
      const all = [p, q, ...extras];
      for (const inputs of [all, [...all].reverse(), [...all.slice(3), ...all.slice(0, 3)], [q, ...extras, p]]) {
        const plan = planGap(inputs, { ...frame(), floor: 100, obstacles });
        expect(plan.residual).toEqual([]);
        expect(rowOf(plan, 'Q'), inputs.map(item => item.id).join()).toBeLessThan(rowOf(plan, 'P'));
        expect(plan.crossings.filter(item => item.run === 'P' && item.vertical === 'Q').map(item => item.kind)).toEqual(['lower-leg']);
      }
    });

    it('keeps the plain order when the hub stands below the gap (the mirror case): the crossing stays on the hub stubs', () => {
      // The far ends are above (two routers), both lower ends are ports of one hub: the rule does not apply, and the crossing lies on the hub's stubs,
      // the lower legs, as it does without the rule.
      const p = { ...part('P', 0, 100, 400), upper: upper(100, 'r-p'), lower: lower(400, 'hub-a') };
      const q = { ...part('Q', 1, 130, 300), upper: upper(130, 'r-q'), lower: lower(300, 'hub-a') };
      for (const inputs of permutations([p, q])) {
        const plan = planGap(inputs, { ...frame(), floor: 100, obstacles });
        expect(plan.residual).toEqual([]);
        expect(rowOf(plan, 'Q'), inputs.map(item => item.id).join()).toBeLessThan(rowOf(plan, 'P'));
        expect(plan.crossings.map(item => `${item.run}x${item.vertical}:${item.kind}`)).toEqual(['PxQ:lower-leg'].map(() => 'PxQ:lower-leg'));
      }
    });
  });

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

  it('plans the later of two parts with legs of two sources within a run clearance anyway, and names the clash (spec 2.2, ticket 50)', () => {
    const close = { ...part('E', 1, 5, 150), upper: { x: 5, y: 263, kind: 'tip' as const, source: 'other' } };
    const plan = planGap([part('A', 0, 0, 100), close], frame());
    expect(plan.residual).toEqual([]);
    expect(plan.crowded).toEqual([{ id: 'E', link: 'E', with: 'A' }]);
    expect(plan.parts.map(item => item.id)).toEqual(['A', 'E']);
  });

  it('stands the vertical of a jogged drop on the end x that keeps a run clearance from the leg beside it (ticket 50, S3)', () => {
    // D 100 to 110 stands on 100 by default; B's lower leg at 91 is 9 px from it. On its lower x 110 it clears B, so B is not crowded and the
    // jog stands one clearance below the upper tip row (263 + 11.5), where the vertical below it is the lower leg.
    const plan = planGap([part('D', 0, 100, 110), part('B', 1, 0, 91)], frame());
    expect(plan.residual).toEqual([]);
    expect(plan.crowded).toEqual([]);
    const drop = plan.parts.find(item => item.id === 'D')!;
    expect([drop.shape, drop.stand]).toEqual(['drop', 'lower']);
    expect(drop.jog).toBeCloseTo(263 + 11.5, 6);
    // Where neither end clears (B's lower leg at 105 stands 5 px from 110 and 5 from 100), the clash is named.
    const both = planGap([part('D', 0, 100, 110), part('B', 1, 0, 105)], frame());
    expect(both.crowded).toEqual([{ id: 'B', link: 'B', with: 'D' }]);
  });

  it('keeps the jog of a drop that stands on its lower x one group-edge margin below the low boundary (O5, ticket 50 re-check)', () => {
    // The upper tip stands in the group padding (y 245, above low 248): one clearance below it is 256.5, 8.5 px under the boundary, but a run
    // keeps e = 10.75 from the group edge at low, so the jog stands at 258.75. The row above the drop's neighbour keeps k below that.
    const tip = { ...part('D', 0, 100, 110), upper: { x: 100, y: 245, kind: 'tip' as const, source: 'up100' } };
    const plan = planGap([tip, part('B', 1, 0, 91)], frame());
    const drop = plan.parts.find(item => item.id === 'D')!;
    expect([drop.shape, drop.stand]).toEqual(['drop', 'lower']);
    expect(drop.jog).toBeCloseTo(248 + 10.75, 6);
    // Away from the boundary the jog is still one clearance below the tip.
    const far = planGap([part('D', 0, 100, 110), part('B', 1, 0, 91)], frame()).parts.find(item => item.id === 'D')!;
    expect(far.jog).toBeCloseTo(263 + 11.5, 6);
  });

  it('keeps the jog of a drop that stands on its upper x one group-edge margin above a box lower than the band top (ticket 56)', () => {
    // The lower box stands 12 px below the band top (308, box top 320), and the lower tip 30 px below the band top (y 338, inside the box):
    // one clearance above the tip is 326.5, inside the box and its title band. The box is an O5 obstacle whatever the sign of its bound
    // (`tierGapPlan` pushes 10.75 + 308 − 320 = −1.25), so the jog stands e above the box, at 320 − 10.75.
    const deep = { ...part('D', 0, 100, 106), lower: { x: 106, y: 338, kind: 'tip' as const, source: 'low106' } };
    const open = planGap([deep], frame()).parts.find(item => item.id === 'D')!;
    expect([open.shape, open.stand]).toEqual(['drop', 'upper']);
    expect(open.jog).toBeCloseTo(338 - 11.5, 6);
    const box = { x0: 106 - 30 - 10.75, x1: 106 + 30 + 10.75, anchor: 'below' as const, bound: 10.75 + 308 - 320 };
    const held = planGap([deep], { ...frame(), obstacles: [box] }).parts.find(item => item.id === 'D')!;
    expect(held.jog).toBeCloseTo(320 - 10.75, 6);
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

  it('stands a jogged drop on its lower x where a title of the band below stands over its upper x (ticket 62)', () => {
    // A: upper x 108 to lower x 100, a drop with an 8 px jog. The long vertical of a drop on its upper x runs down to one clearance above the lower tip
    // (y 281.5, 26.5 above the band top), which a label anchored to the band below with its top 30 above the band top over x 103..130 stands in.
    // The drop stands on x 100, which the label does not cover, so the part is planned, not residual.
    const blocks = [{ x0: 103, x1: 130, anchor: 'below' as const, bound: 30 }];
    const plan = planGap([part('A', 0, 108, 100)], { ...frame(), blocks });
    expect(plan.residual).toEqual([]);
    expect(plan.parts[0]!.shape).toBe('drop');
    expect(plan.parts[0]!.stand).toBe('lower');
    // Nothing over the upper x: the drop keeps the default.
    expect(planGap([part('A', 0, 108, 100)], frame()).parts[0]!.stand).toBe('upper');
    // A label over both ends leaves no x for the vertical: residual.
    const both = planGap([part('A', 0, 108, 100)], { ...frame(), blocks: [{ x0: 90, x1: 130, anchor: 'below' as const, bound: 30 }] });
    expect(both.residual.map(item => `${item.id}:${item.reason}`)).toEqual(['A:leg-blocked']);
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

// Each entry is `run|vertical|kind` (2.1): a run crosses the upper leg of a part whose upper x lies inside its span and whose row is below it, the
// lower leg of one whose lower x lies inside and whose row is above it, and every drop inside its span. Hand-derived from the rows and x of the plan:
// upper gap, link-5 (38.9 to 245.5, row 156.5) over link-2's upper x 140 and the drop at 174, and link-3's lower leg; link-11 (-29.1 to 307.5, row 145) over the same and
// over link-5's upper x 38.9. Lower gap, links 7 and 8 (rows 347.5 and 336) over link-9's upper x 174 and the drop at 307.5, link-9 (row
// 359) and link-10 (row 324.5) over the drop.
// Ticket 57 left src at x -124.65, where these kinds differed; ticket 65 restores the spec's x -203.47 and with it the kinds below.
const KINDS_UPPER: string[] = ['11|2|upper-leg', '11|3|upper-leg', '11|4|drop', '11|5|upper-leg', '3|2|lower-leg', '5|2|upper-leg', '5|4|drop'];
const KINDS_LOWER: string[] = ['10|11.1|drop', '7|11.1|drop', '7|9|upper-leg', '8|11.1|drop', '8|9|upper-leg', '9|11.1|drop'];

/** Three tiers, a transit lane for link-2 through tier 1, and planned parts in both gaps (the pipeline test `residual-parts.test.ts` reads the same text). */
const transit = `portograph: 2
groups:
  top: { tier: 0 }
  mid: { tier: 1 }
  low: { tier: 2 }
nodes:
  a: { group: top, class: router, ports: [] }
  b: { group: top, class: router, ports: [] }
  c: { group: top, class: router, ports: [] }
  m0: { group: mid, class: switch, ports: [] }
  m1: { group: mid, class: switch, ports: [] }
  m2: { group: mid, class: switch, ports: [] }
  e: { group: low, class: server, ports: [] }
links:
  - [a, m0]
  - [b, e]
  - [c, m2]
  - [a, m2]
  - [b, m1]
  - [m0, e]
`;

describe('the follow-ups of ticket 48 (ticket 51)', () => {
  const edited = async (): Promise<LayoutModel> => structuredClone(bands(bundles(bars(centre(flanks(lanes(rows(await placed(transit))))))))) as LayoutModel;

  it('anchors an obstacle that starts inside the gap and ends below it to the band below: the rows stay above it, and H holds its need', async () => {
    const model = await edited();
    // Ticket 22: a's fan (link-1, link-4) is a direct family whose chords crowd after 7f, so both stay orthogonal and join this plan. The
    // test reads the parts it was written for, as when those two were held chords: the obstacle then stands under link-5 alone.
    model.links = model.links.filter(link => link.id !== 'link-1' && link.id !== 'link-4');
    const { gap, plan: free } = tierGapPlans(model).find(item => item.gap.above === 0)!;
    const top = gap.low + 20;
    // A box in the empty x between two ends, so that no leg runs into it and only the runs that pass over it feel it.
    const ends = [...new Set(free.parts.flatMap(item => [item.upper.x, item.lower.x]))].sort((a, b) => a - b);
    const at = ends.findIndex((x, index) => index + 1 < ends.length && ends[index + 1]! - x > 60);
    expect(at).toBeGreaterThanOrEqual(0);
    const middle = (ends[at]! + ends[at + 1]!) / 2;
    model.obstacles.push({ id: 'o', owner: { kind: 'group', id: 'mid' }, layer: 'routed', bounds: { x: middle - 2, y: top, width: 4, height: gap.high - top + 30 } });
    const plan = tierGapPlan(model, gap);
    // Anchored to the band above (the old reading) the rows of the parts over the box would pass below its bottom. A need moves no row.
    expect(rowsOf(plan)).toEqual(rowsOf(free));
    // The need is measured from the band below, k + (bandTop - box top), from the rows that pass over the box: H holds the highest of them plus it.
    const over = plan.parts.filter(item => Math.min(item.upper.x, item.lower.x) < middle && Math.max(item.upper.x, item.lower.x) > middle).flatMap(item => item.rows);
    expect(over.length).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThanOrEqual(Math.max(...over) - gap.low + 11.5 + (plan.bandTop - top) - 1e-9);
    expect(plan.height).toBeGreaterThan(free.height);
  }, 60000);

  it('keeps the stems of the bands that face the gap and no others', async () => {
    // Read on the orthogonal variant: on the input itself a link between the tiers takes its chord and leaves the plan (Q108).
    const model = structuredClone(bands(bundles(bars(centre(flanks(lanes(rows(await placed(orthogonalLinks(transit))))))))));
    const [upper, lower] = tierGapPlans(model).map(item => item.gap);
    const band = (tier: number) => model.tierBands.find(item => item.tier === tier)!.bounds!;
    const tier0 = facingTips(model, upper!).filter(item => item.side === 'bottom');
    expect(tier0.length).toBeGreaterThan(0);
    // Gap 1 > 2: the bottom stems are the tier 1 nodes'; the tier 0 stems hang from a band two above and never reach it.
    const bottoms = facingTips(model, lower!).filter(item => item.side === 'bottom');
    expect(bottoms.length).toBeGreaterThan(0);
    for (const item of bottoms) expect(item.anchor.y).toBeGreaterThanOrEqual(band(1).y);
    // Gap 0 > 1: the top stems are the tier 1 nodes'; the tier 2 node's stem is not among them.
    for (const item of facingTips(model, upper!).filter(entry => entry.side === 'top')) expect(item.anchor.y).toBeLessThanOrEqual(band(1).y + band(1).height);
  }, 60000);

  it('grows a through-lane wall by the run clearance like every other obstacle', async () => {
    const model = await edited();
    const { plan } = tierGapPlans(model).find(item => item.gap.above === 0)!;
    const part = plan.parts.find(item => item.link === 'link-3')!;
    const lo = Math.min(part.upper.x, part.lower.x);
    const above = model.tierBands.find(item => item.tier === 0)!.bounds!, below = model.tierBands.find(item => item.tier === 1)!.bounds!;
    const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-2')!;
    const wall = (right: number): void => {
      lane.bounds = { x: right - 10, y: above.y + above.height - 1, width: 10, height: below.y - above.y - above.height + 2 };
    };
    // The wall's right edge stands 5 px short of the part's span: within the 11.5 px clearance.
    const residual = (): string[] => tierGapPlans(model).flatMap(item => item.plan.residual.map(entry => `${entry.link}:${entry.reason}`));
    wall(lo - 5);
    expect(residual()).toContain('link-3:crosses-lane');
    // 15 px short: outside it.
    wall(lo - 15);
    expect(residual()).not.toContain('link-3:crosses-lane');
  }, 60000);

  it('names the kind of every forced crossing of the v5-4-0 shape, not only the pair', async () => {
    const model = await placeBent('a-tier-gap-plan-orders-every-part');
    const [upper, lower] = tierGapPlans(model).filter(({ plan }) => plan.order.length);
    const kinds = (plan: GapPlan): string[] => plan.crossings.map(item => `${short(item.run)}|${short(item.vertical)}|${item.kind}`).sort();
    expect(kinds(upper!.plan)).toEqual(KINDS_UPPER);
    expect(kinds(lower!.plan)).toEqual(KINDS_LOWER);
  }, 60000);

  it('packs rows at the pitch it is given: P = 17.5, the bundle pitch of the old allocation, is the spec alternative', () => {
    const at = (pitch: number): GapPlan => planGap([part('A', 0, 0, 100), part('B', 1, 100, 200), part('C', 2, 200, 0)], { ...frame(), pitch });
    const narrow = at(11.5), wide = at(17.5);
    // Ca, B, A, Cb: the rows after the first are one pitch apart.
    const rowOf = (plan: GapPlan): number[] => plan.order.map(id => plan.parts.find(item => id.startsWith(item.id))!.rows[id.endsWith('b') ? 1 : 0]!);
    expect(rowOf(narrow).slice(1).map((y, index) => y - rowOf(narrow)[index]!)).toEqual([11.5, 11.5, 11.5]);
    expect(rowOf(wide).slice(1).map((y, index) => y - rowOf(wide)[index]!)).toEqual([17.5, 17.5, 17.5]);
    expect(wide.height).toBeGreaterThan(narrow.height);
  });
});

describe('a riser vertical in the gap (mesh-bus.md, section 11.5)', () => {
  it('moves the middle drop of a Z part off the riser, and asks for no height', () => {
    const inputs = [part('A', 0, 0, 100), part('B', 1, 100, 200), part('C', 2, 200, 0), part('D', 3, 188, 12)];
    const base = planGap(inputs, frame());
    const middle = base.parts.find(item => item.id === 'C')!.middle!;
    const plan = planGap(inputs, { ...frame(), verticals: [middle] });
    expect(plan.residual).toEqual([]);
    const moved = plan.parts.find(item => item.id === 'C')!.middle!;
    expect(Math.abs(moved - middle)).toBeGreaterThanOrEqual(frame().keep - 1e-6);
    expect(plan.height).toBeCloseTo(base.height, 6);
  });
});

describe('a held routed chord in the gap (routed-chords.md, section 8)', () => {
  const inputs = [part('A', 0, 0, 100), part('B', 1, 100, 200), part('C', 2, 200, 0), part('D', 3, 188, 12)];

  it('takes the next interval for the middle drop of a Z part whose widest free interval holds the chord', () => {
    const base = planGap(inputs, frame());
    const middle = base.parts.find(item => item.id === 'C')!.middle!;
    expect(middle).toBeCloseTo(56, 6);
    // A slanted chord: 45 at the gap's low y, 67 at its high y. Its span is 45 to 67, and the drop keeps `keep` from all of it.
    const plan = planGap(inputs, { ...frame(), chords: [{ low: 45, high: 67 }] });
    expect(plan.residual).toEqual([]);
    const moved = plan.parts.find(item => item.id === 'C')!.middle!;
    expect(moved).toBeCloseTo(144, 6);
    expect(moved < 45 - frame().keep + 1e-6 || moved > 67 + frame().keep - 1e-6).toBe(true);
    // The chord asks for no height.
    expect(plan.height).toBeCloseTo(base.height, 6);
  });

  it('plans a row that crosses the chord unchanged, and H does not change', () => {
    const base = planGap(inputs, frame());
    // x 150 is under the run of B (100 to 200) and of D (188 to 12): both rows cross it. It lies in an interval as wide as the one the drop took.
    const plan = planGap(inputs, { ...frame(), chords: [{ low: 150, high: 150 }] });
    expect(plan.parts.map(item => [item.id, item.shape, item.rows, item.middle])).toEqual(base.parts.map(item => [item.id, item.shape, item.rows, item.middle]));
    expect(plan.order).toEqual(base.order);
    expect(plan.height).toBeCloseTo(base.height, 6);
    expect(plan.demand).toBeCloseTo(base.demand, 6);
    expect(plan.residual).toEqual([]);
  });

  it('with no chord the plan is the one it was', () => {
    expect(planGap(inputs, { ...frame(), chords: [] })).toEqual(planGap(inputs, frame()));
  });
});

describe('the U part (ticket 15, phase 5)', () => {
  // Both ends of a U part stand on the gap's low boundary (a bottom port's tip and the mouth of a column-gap lane). The plan gives it one row below both
  // ends and two legs that run down to it; it has no lower leg, so it asks for `keep` above the band below and nothing more.
  const tip = (x: number): PlanInput['upper'] => ({ x, y: 250, kind: 'tip', source: `t${x}` });
  const mouth = (x: number): PlanInput['upper'] => ({ x, y: 248 + 15, kind: 'mouth', source: `lane|${x}|low` });
  const u = (id: string, order: number, from: PlanInput['upper'], to: PlanInput['upper']): PlanInput => ({ id, link: id, order, index: 0, upperFirst: true, upper: from, lower: to, u: true });

  it('plans one row below both ends and no lower leg', () => {
    const plan = planGap([u('U', 0, tip(60), mouth(200))], frame());
    const only = plan.parts[0]!;
    expect(only.shape).toBe('u');
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0]!).toBeGreaterThanOrEqual(263);
    expect(plan.crossings).toEqual([]);
    expect(plan.residual).toEqual([]);
    // The row is the only demand: it lies `row - low` into the gap, and the band below keeps `keep` of it.
    expect(plan.height).toBeCloseTo(Math.max(frame().floor, only.rows[0]! - frame().low + frame().keep), 6);
    // The reserved geometry runs from the first end down, along the row and back up to the second end.
    const segments = plannedSegments(only, { low: 248, high: 308 });
    expect(segments.map(item => [item.from.x, item.from.y, item.to.x, item.to.y])).toEqual([
      [60, 250, 60, only.rows[0]!], [60, only.rows[0]!, 200, only.rows[0]!], [200, only.rows[0]!, 200, 248]]);
  });

  it('reads the ends in the order the link visits them', () => {
    const plan = planGap([u('U', 0, mouth(200), tip(60))], frame());
    const segments = plannedSegments(plan.parts[0]!, { low: 248, high: 308 });
    expect(segments[0]!.from).toEqual({ x: 200, y: 248 });
    expect(segments.at(-1)!.to).toEqual({ x: 60, y: 250 });
  });

  it('puts a U part nested inside another above it, so no row runs through a leg', () => {
    const plan = planGap([u('outer', 0, tip(20), mouth(220)), u('inner', 1, tip(100), mouth(160))], frame());
    const row = (id: string): number => plan.parts.find(item => item.id === id)!.rows[0]!;
    expect(row('inner')).toBeLessThan(row('outer'));
    expect(plan.crossings).toEqual([]);
  });

  it('puts a U part above a stepped part whose lower end stands between its legs', () => {
    // The stepped part runs from x 20 (outside) to x 120 (inside the U's span 60 to 200): its lower leg would cross the U's row if the U stood below.
    const plan = planGap([part('P', 0, 20, 120), u('U', 1, tip(60), mouth(200))], frame());
    const row = (id: string): number => plan.parts.find(item => item.id === id)!.rows[0]!;
    expect(row('U')).toBeLessThan(row('P'));
    expect(plan.crossings.filter(item => item.run === 'U')).toEqual([]);
  });

  it('keeps two U parts that do not overlap on one row', () => {
    const plan = planGap([u('A', 0, tip(20), mouth(80)), u('B', 1, tip(200), mouth(260))], frame());
    const rows = plan.parts.map(item => item.rows[0]!);
    expect(rows[0]).toBeCloseTo(rows[1]!, 6);
  });
});

describe('two runs from opposite sides of one face (architecture-2 ticket 22)', () => {
  const row = (plan: GapPlan, id: string): number => plan.parts.find(item => item.id === id)!.rows[0]!;

  it('share one row when both turn down at their facing ends and those ends stand a clearance apart', () => {
    // W runs from 0 right to 490 and E from 1000 left to 505: 15 px between the two lower legs, more than k = 11.5 and less than 2k.
    const plan = planGap([part('W', 0, 0, 490), part('E', 1, 1000, 505)], frame());
    expect(row(plan, 'W')).toBeCloseTo(row(plan, 'E'), 6);
    expect(plan.crossings).toEqual([]);
  });

  it('stack where the facing ends turn opposite ways, or stand less than a clearance apart', () => {
    // A turns down at 490, B turns up at 505: one row would read as one line through two turns.
    const mixed = planGap([part('A', 0, 0, 490), part('B', 1, 505, 1000)], frame());
    expect(row(mixed, 'A')).not.toBeCloseTo(row(mixed, 'B'), 6);
    const near = planGap([part('W', 0, 0, 495), part('E', 1, 1000, 505)], frame());
    expect(row(near, 'W')).not.toBeCloseTo(row(near, 'E'), 6);
  });
});

describe('the rows keep off the chords of a fan family (architecture-2 ticket 40)', () => {
  // A held fan member crosses the gap from (-50, 200) to (50, 330); A's run would turn at (0, 263), right on the chord. The fallback's leg is
  // crossed by the chord, so the row must cross it strictly with its legs clear of it, or keep the run clearance: the plan seats it lower.
  type P = { x: number; y: number };
  const chord = { from: { x: -50, y: 200 }, to: { x: 50, y: 330 }, owner: { kind: 'link' as const, id: 'F' } };
  const side = (a: P, b: P, c: P): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const distance = (p: P, a: P, b: P): number => {
    const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const strictOrClear = (segment: { from: P; to: P }): boolean => {
    const strict = side(segment.from, segment.to, chord.from) * side(segment.from, segment.to, chord.to) < 0
      && side(chord.from, chord.to, segment.from) * side(chord.from, chord.to, segment.to) < 0;
    const gap = Math.min(distance(segment.from, chord.from, chord.to), distance(segment.to, chord.from, chord.to),
      distance(chord.from, segment.from, segment.to), distance(chord.to, segment.from, segment.to));
    return strict || gap >= 11.5 - 1e-6;
  };

  it('seats the row as before when no fan chord crosses the gap', () => {
    expect(planGap([part('A', 0, 0, 100)], frame()).parts[0]!.rows[0]).toBeCloseTo(263, 6);
    expect(planGap([part('A', 0, 0, 100)], { ...frame(), slants: [] }).parts[0]!.rows[0]).toBeCloseTo(263, 6);
  });

  it('lowers the row until its legs and its run cross the chord strictly or keep the clearance, and the gap asks for it', () => {
    const before = planGap([part('A', 0, 0, 100)], frame());
    const plan = planGap([part('A', 0, 0, 100)], { ...frame(), slants: [chord] });
    const [planned] = plan.parts;
    expect(planned!.rows[0]).toBeGreaterThan(263);
    for (const segment of plannedSegments(planned!, { low: 248, high: 308 })) expect(strictOrClear(segment), JSON.stringify(segment)).toBe(true);
    expect(plan.height).toBeGreaterThanOrEqual(before.height);
  });
});
