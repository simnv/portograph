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
function strictCrossings(a: LayoutLink, b: LayoutLink): number {
  const inside = (value: number, one: number, other: number): boolean => value > Math.min(one, other) + EPS && value < Math.max(one, other) - EPS;
  let count = 0;
  for (const one of a.path!.segments as Segment[]) {
    for (const other of b.path!.segments as Segment[]) {
      const oneVertical = Math.abs(one.from.x - one.to.x) < EPS, otherVertical = Math.abs(other.from.x - other.to.x) < EPS;
      if (oneVertical === otherVertical) continue;
      const [vertical, horizontal] = oneVertical ? [one, other] : [other, one];
      if (inside(vertical.from.x, horizontal.from.x, horizontal.to.x) && inside(horizontal.from.y, vertical.from.y, vertical.to.y)) count++;
    }
  }
  return count;
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

describe('two interleaved links of one tier gap cross on a reserved row (ranked-groups ticket 39)', () => {
  it('reserves the row between the tip rows of the earlier link, so the later link crosses a run it can cross', async () => {
    const model = await routed('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row');
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(diagnostic => diagnostic.code === 'ROUTE_CHECKPOINT_SKIPPED')).toEqual([]);
    // The gap answers for the run: the nested tip band of a neighbour refuses the row one pitch inside the tips.
    expect(model.diagnostics.some(diagnostic => diagnostic.code === 'TIER_GAP_GROWN' && /hold the run/.test(diagnostic.message))).toBe(true);
    const earlier = model.links.find(link => link.id === 'link-4')!, later = model.links.find(link => link.id === 'link-6')!;
    const [upper, lower] = tipRows(model, earlier);
    // The earlier link runs on the row midway between its tip rows, and on no other.
    expect(horizontals(earlier)).toEqual([expect.closeTo((upper + lower) / 2, 6)]);
    expect(lower - upper).toBeGreaterThanOrEqual(23 - EPS);
    expect(strictCrossings(earlier, later)).toBe(1);
    gatesPass(model);
  }, 60000);

  it('gives an earlier link with no run of its own the row midway between tip rows more than a pitch apart', async () => {
    const model = await routed('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    expect(model.removedLinks ?? []).toEqual([]);
    const earlier = model.links.find(link => link.id === 'link-3')!, later = model.links.find(link => link.id === 'link-4')!;
    const [upper, lower] = tipRows(model, earlier);
    expect(lower - upper).toBeGreaterThan(23);
    expect(horizontals(earlier)).toEqual([expect.closeTo((upper + lower) / 2, 6)]);
    expect(strictCrossings(earlier, later)).toBe(1);
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
});
