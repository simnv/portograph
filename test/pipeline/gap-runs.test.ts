import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { ownedLanes } from '../../src/route/paths.js';
import { MEMBER_GAP } from '../../src/layout/bundle-geometry.js';
import { routedStroke } from '../../src/layout/bands.js';
import { horizontal, segmentRect, vertical } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8');

const place = async (fixture: string): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));

/**
 * Stress-test reproducers (`.scratch/stress/issues/04`). ADR-0015 rule 1 allocates the runs that
 * cross a tier gap before the first ownership batch runs, so no batch can take the corridor a
 * later link's own lane opens into.
 */
it('allocates every run of a tier gap two transit links share', async () => {
  const before = await place(read('two-runs-share-a-tier-gap.yaml'));
  const runs = allocateGapRuns(before);
  expect(runs.length).toBeGreaterThanOrEqual(2);

  // Two rows of one gap keep the pitch, and two stubs on one x never share length.
  const pitch = MEMBER_GAP + routedStroke(before);
  const rowsOf = runs.flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y));
  for (const [index, y] of rowsOf.entries()) {
    for (const other of rowsOf.slice(index + 1)) expect(Math.abs(other - y)).toBeGreaterThanOrEqual(pitch - 1e-9);
  }
  const stems = runs.flatMap(run => run.segments.filter(vertical)
    .map(segment => ({ x: segment.from.x, low: Math.min(segment.from.y, segment.to.y), high: Math.max(segment.from.y, segment.to.y) })));
  for (const [index, stem] of stems.entries()) {
    for (const other of stems.slice(index + 1)) {
      if (Math.abs(other.x - stem.x) > 1e-9) continue;
      expect(Math.min(stem.high, other.high) - Math.max(stem.low, other.low)).toBeLessThanOrEqual(1e-9);
    }
  }

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // Every allocated run is in the published path exactly as it was reserved.
  for (const run of runs) {
    const path = model.links.find(item => item.id === run.link)!.path!.segments;
    for (const segment of run.segments) {
      expect(path.some(item => item.from.x === segment.from.x && item.from.y === segment.from.y
        && item.to.x === segment.to.x && item.to.y === segment.to.y)).toBe(true);
    }
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);

it('reserves the row a transit approach needs and the lane jogs it crosses', async () => {
  const before = await place(read('a-row-crosses-two-lane-jogs.yaml'));
  const runs = allocateGapRuns(before);
  // The two lane-to-lane jogs of one gap are columns; the third link's approach takes the row and
  // crosses one of them. A crossing between two allocated runs is reserved, not discovered.
  const columns = runs.filter(run => run.segments.every(vertical));
  const rowUsers = runs.filter(run => run.segments.some(horizontal));
  expect(columns.length).toBeGreaterThanOrEqual(2);
  expect(rowUsers.length).toBeGreaterThanOrEqual(1);
  const row = rowUsers[0]!.segments.find(horizontal)!;
  expect(columns.some(column => column.segments.some(segment =>
    Math.min(row.from.x, row.to.x) < segment.from.x && segment.from.x < Math.max(row.from.x, row.to.x)))).toBe(true);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // The contract the reproducer broke: a routed segment that meets one of its link's own lanes
  // runs along that lane's centre, and every port keeps its reserved stem.
  for (const link of model.links) {
    for (const lane of ownedLanes(model, link)) {
      for (const segment of link.path!.segments.filter(item => segmentRect(item, lane.bounds))) {
        expect([link.id, lane.id, segment.from.x, segment.to.x]).toEqual([link.id, lane.id, lane.x, lane.x]);
      }
    }
    const segments = link.path!.segments;
    for (const segment of [segments[0]!, segments.at(-1)!]) {
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 120000);

it('allocates nothing where every run of a gap keeps one x', async () => {
  // The M1 golden's four transit links descend on the x of their own lanes, so no run needs a row
  // and the allocation is empty: a gap that has nothing to share changes no diagram.
  const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
  const before = await place(golden);
  expect(before.lanes.length).toBe(4);
  expect(allocateGapRuns(before)).toEqual([]);
  expect(planRoute(before).obstacles.some(item => item.id.startsWith('gap:'))).toBe(false);
}, 60000);
