import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { stemCheckpoint } from '../../src/route/plan.js';
import { score } from '../../src/score/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const EPS = 1e-6;

type Segment = { from: { x: number; y: number }; to: { x: number; y: number } };

/** The interior crossings of two routed paths: a point strictly inside a segment of each. */
function strictCrossings(a: LayoutLink, b: LayoutLink): { x: number; y: number }[] {
  const inside = (value: number, one: number, other: number): boolean => value > Math.min(one, other) + EPS && value < Math.max(one, other) - EPS;
  const points: { x: number; y: number }[] = [];
  for (const one of a.path!.segments as Segment[]) {
    for (const other of b.path!.segments as Segment[]) {
      const oneVertical = Math.abs(one.from.x - one.to.x) < EPS, otherVertical = Math.abs(other.from.x - other.to.x) < EPS;
      if (oneVertical === otherVertical) continue;
      const [vertical, horizontal] = oneVertical ? [one, other] : [other, one];
      if (inside(vertical.from.x, horizontal.from.x, horizontal.to.x) && inside(horizontal.from.y, vertical.from.y, vertical.to.y)) {
        points.push({ x: vertical.from.x, y: horizontal.from.y });
      }
    }
  }
  return points;
}

/** The two stem tip rows of a link, upper first. */
function tipRows(model: LayoutModel, link: LayoutLink): [number, number] {
  const rows = (['from', 'to'] as const).map(end => stemCheckpoint(model, findPort(model, link.attachments![end])!).y).sort((x, y) => x - y);
  return [rows[0]!, rows[1]!];
}

/** The y of every horizontal segment of a routed path that spans more than a stem. */
const horizontals = (link: LayoutLink): number[] => (link.path!.segments as Segment[])
  .filter(segment => Math.abs(segment.from.y - segment.to.y) < EPS && Math.abs(segment.from.x - segment.to.x) > 1).map(segment => segment.from.y);

/** The rows the tier-gap plan gives each link, read from the placement stage 8 receives (tier-gap-rows.md, Section 2.3). */
async function planRows(name: string): Promise<Map<string, number[]>> {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture(name)))))))));
  const result = new Map<string, number[]>();
  for (const part of tierGapPlans(model).flatMap(({ plan }) => plan.parts)) result.set(part.link, [...result.get(part.link) ?? [], ...part.rows]);
  return result;
}

async function routed(name: string): Promise<LayoutModel> {
  const model = await layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
  return model;
}

function gatesPass(model: LayoutModel): void {
  const report = score(model).snapshot;
  for (const [id, gate] of Object.entries(report.gates)) expect(gate.passed, id).toBe(true);
}

describe('interleaved links of one tier gap cross on the row of the earlier link (ranked-groups ticket 39)', () => {
  it('gives the earlier link the row between its tip rows, so the later link crosses it and is not removed', async () => {
    const model = await routed('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row');
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(diagnostic => diagnostic.code === 'ROUTE_CHECKPOINT_SKIPPED')).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-4')!, later = model.links.find(link => link.id === 'link-7')!;
    // Every part holds the row the plan gave it (spec 2.4: link-4 327.5, the last of five), and on no other.
    // Verdana metrics (snack-theme ticket 157): 326.5 with Arial.
    const plan = await planRows('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row');
    expect(plan.get('link-4')).toEqual([expect.closeTo(327.5, 6)]);
    expect(horizontals(earlier)).toEqual([expect.closeTo(plan.get('link-4')![0]!, 6)]);
    // The pair crosses once, on link-4's run over link-7's lower leg (reserved by the plan, not discovered by the router).
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo(327.5, 6);
    gatesPass(model);
  }, 60000);

  it('gives an earlier link with no run of its own the row midway between tip rows more than a pitch apart', async () => {
    const model = await routed('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-3')!, later = model.links.find(link => link.id === 'link-4')!;
    const [upper, lower] = tipRows(model, earlier);
    expect(lower - upper).toBeGreaterThan(23);
    // The plan: link-3 275.5 between the halves of link-4, a Z part (4a 264, 4b 287); the pair crosses once, on link-4's middle drop.
    // Verdana metrics (snack-theme ticket 157): 274.5, 263 and 286 with Arial.
    const plan = await planRows('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    expect(plan.get('link-3')).toEqual([expect.closeTo(275.5, 6)]);
    expect(plan.get('link-4')).toEqual([expect.closeTo(264, 6), expect.closeTo(287, 6)]);
    expect(horizontals(earlier)).toEqual([expect.closeTo(275.5, 6)]);
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo(275.5, 6);
    // The later link does not ride the earlier link's row: no horizontal of theirs shares a y with an overlap in x.
    for (const one of earlier.path!.segments as Segment[]) {
      for (const other of later.path!.segments as Segment[]) {
        if (Math.abs(one.from.y - one.to.y) > EPS || Math.abs(other.from.y - other.to.y) > EPS || Math.abs(one.from.y - other.from.y) > EPS) continue;
        const overlap = Math.min(Math.max(one.from.x, one.to.x), Math.max(other.from.x, other.to.x))
          - Math.max(Math.min(one.from.x, one.to.x), Math.min(other.from.x, other.to.x));
        expect(overlap).toBeLessThanOrEqual(EPS);
      }
    }
    gatesPass(model);
  }, 60000);

  it('lets a lane-end piece the lane allocation left unseated hold the row between its port tip and its lane approach', async () => {
    const model = await routed('an-unseated-lane-end-piece-holds-the-row-between-its-tips');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-7')!, later = model.links.find(link => link.id === 'link-8')!;
    expect(earlier.fixedSegments).toHaveLength(1);
    // The piece runs from the stem tip of its port to the approach point one router stem short of the lane.
    // The plan reserves that piece tip to mouth on one row of its own; the routed path runs on it and on no other.
    const plan = await planRows('an-unseated-lane-end-piece-holds-the-row-between-its-tips');
    const wanted = plan.get('link-7')!;
    expect(wanted).toHaveLength(1);
    expect(horizontals(earlier)).toEqual([expect.closeTo(wanted[0]!, 6)]);
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    // The crossing lies on a reserved row: a run of link-7 or of link-8 (a Z part here) over the other's leg.
    expect([...wanted, ...plan.get('link-8')!].some(y => Math.abs(y - crossings[0]!.y) < 1e-6)).toBe(true);
    gatesPass(model);
  }, 60000);
});

describe('a plain stem tip in the group padding holds its row (ranked-groups ticket 43)', () => {
  // Ticket 50 (the tier-gap plan) lands it: link-2 is a Z part (2a 132.75, 2b 155.75), link-1 holds 144.25.
  // Verdana metrics (snack-theme ticket 157): 131.75, 154.75 and 143.25 with Arial.
  it('seats the earlier link of an interleaved pair whose tips stand in the padding, so the later link does not ride its tip row', async () => {
    const model = await routed('a-plain-tip-in-the-group-padding-holds-its-row');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-1')!, later = model.links.find(link => link.id === 'link-2')!;
    const [upper, lower] = tipRows(model, earlier);
    const plan = await planRows('a-plain-tip-in-the-group-padding-holds-its-row');
    expect(plan.get('link-1')).toEqual([expect.closeTo(144.25, 6)]);
    // The tips stand in the padding, outside the gap, and the earlier link holds the row of its own between the halves of the Z part.
    const bands = [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y);
    expect(upper).toBeLessThan(bands[0]!.bounds!.y + bands[0]!.bounds!.height);
    expect(lower).toBeGreaterThan(bands[1]!.bounds!.y);
    expect(horizontals(earlier)).toEqual([expect.closeTo(144.25, 6)]);
    // The tip row of the later link carries no run of another link.
    const [laterTip] = tipRows(model, later);
    for (const link of model.links) {
      if (link.id === later.id || !link.path) continue;
      const along = (link.path.segments as Segment[]).filter(segment => Math.abs(segment.from.y - segment.to.y) < EPS
        && Math.abs(segment.from.y - laterTip) < EPS && Math.abs(segment.from.x - segment.to.x) > 1);
      expect(along.map(segment => [segment.from.x, segment.to.x]), link.id).toEqual([]);
    }
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo(144.25, 6);
    gatesPass(model);
  }, 60000);
});
