import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import { ownedLanes } from '../../src/route/paths.js';
import { segmentRect } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/own-lane-is-an-obstacle.yaml', import.meta.url), 'utf8');

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
