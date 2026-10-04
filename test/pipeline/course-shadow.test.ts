import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { naturalPolyline, polylineCrossings, polylineTurns, simplify } from '../../src/layout/course-plan.js';
import type { ShadowLink, ShadowPlan } from '../../src/layout/course-shadow.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phases 2 and 3: the geometry of the course plan, and the shadow plan that reports and applies nothing.
 * The agreement table pins what the shadow's natural-course turns measure against the published turns on the acceptance sheets (stage 5 against
 * stage 8). It is a record, not a promise: the stop rule of phase 3 asks for 90 % and the table shows where the estimate stays below it.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/${name === 'm1-sip-edge' ? '' : 'synthetic/'}${name}.yaml`, import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

afterEach(() => { attemptCounters.ledger = false; resetAttemptCounters(); });

describe('the polyline readers', () => {
  it('simplify drops repeated points and collinear middles, and keeps a reversal', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 9 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 9 }]);
    expect(polylineTurns([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 0 }])).toBe(2);
    expect(polylineTurns([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 2 }])).toBe(1);
  });

  // The natural polyline joins two ports through their stems, so the corner at the end of a stem is a real corner.
  it.each<[string, { x: number; y: number }, Side, { x: number; y: number }, Side, number]>([
    ['a straight drop', { x: 0, y: 0 }, 'bottom', { x: 0, y: 100 }, 'top', 0],
    ['a step in a gap', { x: 0, y: 0 }, 'bottom', { x: 40, y: 100 }, 'top', 2],
    ['an L into a lateral face', { x: 0, y: 0 }, 'bottom', { x: 60, y: 100 }, 'left', 1],
    ['a U under two nodes', { x: 0, y: 0 }, 'bottom', { x: 80, y: 0 }, 'bottom', 2],
    ['a target behind the source', { x: 0, y: 100 }, 'bottom', { x: 0, y: 0 }, 'top', 4],
    ['two faces closer than two stems', { x: 0, y: 0 }, 'bottom', { x: 40, y: 20 }, 'top', 2],
  ])('naturalPolyline: %s', (_name, a, from, b, into, turns) => {
    const points = naturalPolyline(a, from, b, into);
    expect(polylineTurns(points)).toBe(turns);
    expect(points[0]).toEqual(a);
    expect(points.at(-1)).toEqual(b);
  });

  it('counts proper crossings only', () => {
    const across = [{ x: 0, y: 5 }, { x: 10, y: 5 }];
    expect(polylineCrossings(across, [{ x: 5, y: 0 }, { x: 5, y: 10 }])).toBe(1);
    expect(polylineCrossings(across, [{ x: 10, y: 0 }, { x: 10, y: 10 }])).toBe(0);
    expect(polylineCrossings(across, [{ x: 0, y: 5 }, { x: 0, y: 10 }])).toBe(0);
  });
});

/** The shadow of the last placement run against the published turns, per covered link. */
async function measure(name: string): Promise<{ plan: ShadowPlan; model: LayoutModel; rows: (ShadowLink & { published: number })[] }> {
  resetAttemptCounters(); attemptCounters.ledger = true;
  const model = await layout(parse(source(name)), options);
  const plan = attemptCounters.shadows.at(-1)!;
  const rows = plan.links.flatMap(item => {
    const published = pathBends(model.links.find(link => link.id === item.link)!);
    return published === undefined ? [] : [{ ...item, published }];
  });
  return { plan, model, rows };
}

// [sheet, links the shadow covers, links whose estimated natural turns equal the published turns, links with a trigger, of those the ones that agree]
const AGREEMENT: [string, number, number, number, number][] = [
  ['a-ring-link-between-the-ends-of-a-row-goes-round-the-outside', 8, 8, 1, 1],
  ['a-sync-chord-through-the-middle-tier-leaves-the-gateway-clear', 4, 4, 0, 0],
  ['a-crossing-pair-across-two-tiers-keeps-its-course', 6, 6, 0, 0],
  ['a-mesh-across-a-tier-goes-round-the-outside', 11, 4, 6, 2],
  ['a-flank-link-across-a-neighbour-enters-a-bundle-envelope', 4, 4, 0, 0],
  ['a-flank-bundle-into-a-ranked-group-stays-beside-the-frame', 3, 3, 0, 0],
  ['a-lower-rank-under-the-chord-takes-side-faces', 6, 6, 0, 0],
  ['a-link-past-a-canton-runs-in-the-margin', 7, 2, 1, 0],
  ['a-flank-link-around-a-neighbour-runs-along-the-core-edge', 6, 5, 2, 1],
  ['a-bundle-in-a-grid-stands-as-a-grid', 2, 2, 0, 0],
  ['a-sync-mesh-on-three-rows-has-one-trunk-in-the-margin', 2, 2, 0, 0],
  ['a-port-with-two-peers-in-two-directions-takes-a-side-per-link', 4, 4, 2, 2],
  ['a-cross-link-with-another-label-keeps-two-buses', 7, 6, 0, 0],
  ['m1-sip-edge', 2, 2, 0, 0],
];

describe('the shadow plan against the published turns (ticket 15, phase 3)', () => {
  it.each(AGREEMENT)('%s', async (name, covered, agree, triggered, triggeredAgree) => {
    const { rows } = await measure(name);
    const cands = rows.filter(row => row.triggers.length > 0);
    expect([rows.length, rows.filter(row => row.natural.turns === row.published).length, cands.length, cands.filter(row => row.natural.turns === row.published).length])
      .toEqual([covered, agree, triggered, triggeredAgree]);
  }, 60000);

  it('names the detours the design lists: transit on the mesh, a skirt on the ring and beside the core, a shared port on case 12', async () => {
    const triggers = async (name: string): Promise<Record<string, string>> =>
      Object.fromEntries((await measure(name)).rows.filter(row => row.triggers.length).map(row => [row.link, row.triggers.join('')]));
    expect(await triggers('a-ring-link-between-the-ends-of-a-row-goes-round-the-outside')).toEqual({ 'link-4': 'T3' });
    expect(Object.values(await triggers('a-mesh-across-a-tier-goes-round-the-outside')).every(item => item === 'T1')).toBe(true);
    expect(Object.keys(await triggers('a-flank-link-around-a-neighbour-runs-along-the-core-edge')).sort()).toEqual(['link-5', 'link-6']);
    expect(Object.values(await triggers('a-port-with-two-peers-in-two-directions-takes-a-side-per-link'))).toEqual(['T4', 'T4']);
  }, 60000);

  it('offers a perimeter course only to an end that the order facts allow, and picks it only for fewer turns', async () => {
    const { rows } = await measure('a-mesh-across-a-tier-goes-round-the-outside');
    for (const row of rows) {
      expect(row.candidates[0]!.kind).toBe('natural');
      const better = row.candidates.slice(1).filter(item => item.turns < row.candidates[0]!.turns || (item.turns === row.candidates[0]!.turns && item.crossings < row.candidates[0]!.crossings));
      expect(row.chosen.kind === 'natural').toBe(better.length === 0);
    }
  }, 60000);

  it('applies nothing: the layout with the shadow on equals the layout with it off', async () => {
    const name = 'a-flank-link-around-a-neighbour-runs-along-the-core-edge';
    const strip = (model: LayoutModel): string => { const copy: Partial<LayoutModel> = { ...model }; delete copy.runtime; return JSON.stringify(copy); };
    resetAttemptCounters(); attemptCounters.ledger = false;
    const off = await layout(parse(source(name)), options);
    expect(attemptCounters.shadows).toEqual([]);
    attemptCounters.ledger = true;
    const on = await layout(parse(source(name)), options);
    expect(attemptCounters.shadows.length).toBeGreaterThan(0);
    expect(strip(on)).toBe(strip(off));
    expect(on.courses).toBeUndefined();
  }, 60000);
});
