import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { stemCheckpoint } from '../../src/route/plan.js';
import { score } from '../../src/score/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
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
    const [upper, lower] = tipRows(model, earlier);
    const mid = (upper + lower) / 2;
    // The earlier link runs on the row midway between its tip rows, and on no other.
    expect(horizontals(earlier)).toEqual([expect.closeTo(mid, 6)]);
    // The pair crosses once, and the crossing lies on that row.
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo(mid, 6);
    gatesPass(model);
  }, 60000);

  it('gives an earlier link with no run of its own the row midway between tip rows more than a pitch apart', async () => {
    const model = await routed('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-3')!, later = model.links.find(link => link.id === 'link-4')!;
    const [upper, lower] = tipRows(model, earlier);
    expect(lower - upper).toBeGreaterThan(23);
    expect(horizontals(earlier)).toEqual([expect.closeTo((upper + lower) / 2, 6)]);
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo((upper + lower) / 2, 6);
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
    const port = findPort(model, earlier.attachments!.from)!;
    const tip = stemCheckpoint(model, port).y, approach = earlier.fixedSegments![0]!.from.y - 15;
    const mid = (tip + approach) / 2;
    const rows = horizontals(earlier);
    expect(rows).toEqual([expect.closeTo(mid, 6)]);
    const crossings = strictCrossings(earlier, later);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.y).toBeCloseTo(mid, 6);
    gatesPass(model);
  }, 60000);
});

describe('a plain stem tip in the group padding holds its row (ranked-groups ticket 43)', () => {
  // Known failing: main never seats the piece (link-1 rides the shared tip row 116). The attempted fix is in
  // .scratch/ranked-groups/ticket-43-attempt.patch; it made the Enterprise NTP sheet throw, so it is not applied.
  // When the ticket lands, turn `it.fails` into `it`.
  it.fails('seats the earlier link of an interleaved pair whose tips stand in the padding, so the later link does not ride its tip row', async () => {
    const model = await routed('a-plain-tip-in-the-group-padding-holds-its-row');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-1')!, later = model.links.find(link => link.id === 'link-2')!;
    const [upper, lower] = tipRows(model, earlier);
    const mid = (upper + lower) / 2;
    // The tips stand in the padding, outside the gap, and the earlier link still holds the row midway between them.
    const bands = [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y);
    expect(upper).toBeLessThan(bands[0]!.bounds!.y + bands[0]!.bounds!.height);
    expect(lower).toBeGreaterThan(bands[1]!.bounds!.y);
    expect(horizontals(earlier)).toEqual([expect.closeTo(mid, 6)]);
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
    expect(crossings[0]!.y).toBeCloseTo(mid, 6);
    gatesPass(model);
  }, 60000);
});
