import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, restoreLayoutModel, route, routeRemainders, rows, score } from '../../src/index.js';
import type { GateId } from '../../src/index.js';
import { planRoute } from '../../src/route/plan.js';
import { reservationConflicts } from '../../src/route/validate.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

const yaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');

it('routes the measured JPEG golden remainder and scores the complete diagram', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  // Measured after stage 7f: the two provider feeds are all libavoid is left, and both really
  // reach the router. The deviation from the prototype's idle router is recorded in pipeline.md.
  expect(routeRemainders(before)).toEqual(['link-1', 'link-2']);
  expect(before.links.filter(link => !link.path)).toHaveLength(2);
  const plan = planRoute(before);
  expect(plan.batches).toEqual([{ id: 'batch-0', links: ['link-1', 'link-2'] }]);
  expect(plan.overlay).toEqual([]);

  const model = await route(before, { createAttempt: createAvoidAttempt });
  expect(model.links.every(link => link.path)).toBe(true);
  expect(model.links.some(link => link.stubCandidate)).toBe(false);

  // Unused label-band space is traversable; the actual group label remains an obstacle.
  // Both feeds still reach their exact top ports, with at least the required outward stem.
  for (const id of ['link-1', 'link-2']) {
    const segments = model.links.find(link => link.id === id)!.path!.segments;
    const stem = segments.at(-1)!;
    expect(stem.from.x).toBe(stem.to.x);
    expect(stem.to.y - stem.from.y).toBeGreaterThanOrEqual(15);
  }
  expect(reservationConflicts(model)).toEqual([]);

  const report = score(model, { golden: true }).snapshot;
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as GateId[]) {
    expect([id, report.gates[id].violations]).toEqual([id, []]);
  }
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  expect(report.counters).toMatchObject({ overlaps: 0, labelHits: 0, barCross: 3, lanesUsed: 4, stubs: 0 });
  expect(report.assertions).toEqual([{ code: 'golden-crossings', passed: true, actual: 0, expected: 0, tolerance: 0 }]);
  expect(report.Q).toBeCloseTo(0.9004061377064178, 12);

  // Placement is frozen: stage 8 adds paths only, and the result restores byte-equal.
  expect(model.freeze!.placement).toEqual(before.freeze!.placement);
  expect(model.links.slice(2).map(link => link.path)).toEqual(before.links.slice(2).map(link => link.path));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);
