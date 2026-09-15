import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import { ownedLanes } from '../../src/route/paths.js';
import { segmentRect } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/own-lane-is-an-obstacle.yaml', import.meta.url), 'utf8');
const twoRuns = readFileSync(new URL('../../goldens/synthetic/two-runs-share-a-tier-gap.yaml', import.meta.url), 'utf8');

/**
 * Stress-test reproducer (`.scratch/stress/issues/02`). Two groups of one tier are fed from nearly
 * the same x, so 7c can seat only one of them; the other keeps its port far from the lane 7a
 * reserved for its link. Stage 8 then had to route that gap sideways into the link's own corridor,
 * and the stitcher refused the geometry. A lane admits only its owner's collinear run, so it is now
 * an obstacle for the owner as well, and the reserved stems of the links a batch has not routed yet
 * are obstacles too.
 */
it('keeps a routed gap out of the corridor its own link reserved', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  // The precondition: placement really did leave one child off its lane.
  expect(before.diagnostics.map(item => item.code)).toContain('PLACEMENT_NON_CONVERGENCE');
  const plan = planRoute(before);
  expect(plan.batches.length).toBeGreaterThan(1);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // Every routed segment that meets one of its link's own lanes runs along that lane's centre.
  for (const link of model.links) {
    for (const lane of ownedLanes(model, link)) {
      for (const segment of link.path!.segments.filter(item => segmentRect(item, lane.bounds))) {
        expect([link.id, lane.id, segment.from.x, segment.to.x]).toEqual([link.id, lane.id, lane.x, lane.x]);
      }
    }
  }
  // Every link reaches both of its ports with the reserved perpendicular stem.
  for (const link of model.links) {
    const segments = link.path!.segments;
    for (const segment of [segments[0]!, segments.at(-1)!]) {
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  }
  // The diagram is poor, but it is a diagram: a failed gate is a judgement, a failed pipeline is not.
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);

/**
 * Ticket 02 of `.scratch/synthetics-review`. The child 7c could not seat is the same one, and the
 * corridor now follows it: 7f moves the lane to the child's port x, because the corridor there is
 * free and the corridors of the tier keep the order of the children they serve. The link then
 * descends straight into its port and turns once, in the tier gap above.
 */
it('moves a corridor to the child 7c could not seat under it', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  const link = model.links.find(item => item.id === 'link-3')!;
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-3')!;
  const child = model.nodes['node-ba002']!.ports[0]!;
  expect(model.diagnostics.map(item => item.code)).toContain('LANE_FOLLOWS_ITS_CHILD');
  expect(lane.x).toBe(child.anchor!.x);
  expect(lane.bounds.x).toBe(lane.x - lane.bounds.width / 2);
  expect(lane.side).toBe('right');
  // The reservation and its extents follow the corridor, so the allocation that reads lane x after
  // 7a and 7c reads the new one.
  expect(link.fixedSegments!.map(run => [run.from.x, run.to.x])).toEqual([[lane.x, lane.x]]);
  // The other corridor of the tier keeps its own child, and the two keep the children's order.
  const other = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-1')!;
  expect(other.x).toBe(model.nodes['node-ba001']!.ports[0]!.anchor!.x);
  expect(other.x).toBeLessThan(lane.x);
  // Nothing moved for the corridor: the rule runs after the last centring replay, so the child's
  // node keeps the width and the canvas keeps the extent 7f published.
  expect(model.nodes['node-ba002']!.bounds!.width).toBeCloseTo(145.775146484375, 6);
}, 60000);

/**
 * The refusal. `two-runs-share-a-tier-gap` has an unseated child and a free corridor at its port x
 * as well, but following it opens an alignment 7c could not reach, and the centring invariant would
 * then read the published placement as unfinished work. The corridor stays where 7a put it.
 */
it('keeps a corridor that would leave the centring invariant unverified', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(twoRuns))))))));
  const lane = model.lanes.find(item => item.id === 'lane:"link-3":2')!;
  const child = model.nodes.d!.ports[0]!;
  expect(child.anchor!.x).not.toBe(lane.x);
  expect(lane.x).toBe(59);
  expect(model.diagnostics.map(item => item.code)).not.toContain('LANE_FOLLOWS_ITS_CHILD');
  expect(model.diagnostics.map(item => item.code)).not.toContain('CENTRE_INVARIANT_UNVERIFIED');
}, 60000);
