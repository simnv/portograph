import { goldenWithRemainders } from '../golden-remainders.js';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, restoreLayoutModel, route, routeRemainders, rows, score } from '../../src/index.js';
import type { GateId } from '../../src/index.js';
import { planRoute } from '../../src/route/plan.js';
import { reservationConflicts } from '../../src/route/validate.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

// The two provider links are read on the variant that keeps them orthogonal: on the golden they hold their chord (ticket 100).
const yaml = goldenWithRemainders();

it('routes the measured JPEG golden remainder and scores the complete diagram', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  // Measured after stage 7f: the two provider feeds are all libavoid is left. Each is one straight
  // run between two anchors on one x with a clear corridor. Ticket 50: each is a planned drop, reserved tip to tip between its two claimed
  // stems (one piece before), so stage 8 asks for no route at all — the prototype's idle router, and byte-for-byte the geometry libavoid returned.
  expect(routeRemainders(before)).toEqual(['link-1', 'link-2']);
  expect(before.links.filter(link => !link.path)).toHaveLength(2);
  const plan = planRoute(before);
  expect(plan.batches).toEqual([]);
  expect(plan.links.filter(item => ['link-1', 'link-2'].includes(item.link))
    .map(item => item.pieces.map(piece => piece.kind))).toEqual([['straight', 'allocated', 'straight'], ['straight', 'allocated', 'straight']]);
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
  // The Q of the golden before ticket 100 gave its two provider links their chord (the variant keeps them orthogonal).
  expect(report.Q).toBeCloseTo(0.8986107135065587, 12);

  // Placement is frozen: stage 8 adds paths only, and the result restores byte-equal.
  expect(model.freeze!.placement).toEqual(before.freeze!.placement);
  expect(model.links.slice(2).map(link => link.path)).toEqual(before.links.slice(2).map(link => link.path));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);
