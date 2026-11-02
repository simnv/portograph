import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { score } from '../../src/index.js';
import { bands, bars, bundles, centre, checkpointsHonoured, flanks, lanes, linkLabels, planRoute, route, rows } from '../../src/internal.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/detoured-stem-checkpoint.yaml', import.meta.url), 'utf8');

/**
 * Stress-test reproducer (`.scratch/stress/issues/01`). `b1 → b2` and `b3 → b4` are the two
 * diagonals of one rectangle, so they cross; their groups differ, so they land in two ownership
 * batches and the first path becomes a wall the second has to go round. On that detour libavoid
 * dropped the source stem checkpoint — its direction mask is one this build cannot meet — and
 * stage 8 rejected the route, which failed the whole pipeline.
 */
it('keeps every reserved stem checkpoint on a route forced round an earlier batch', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  // Ticket 50: the crossing pair (`b1 → b2` and `b3 → b4`, the two diagonals of one rectangle) are planned parts now: two rows, one crossing
  // reserved on the row of one and the leg of the other, stems claimed. Neither joins a batch (main: two batches, `link-1` then `link-3`,
  // and the second detoured round the first, which is what the checkpoint rule was measured on). The end-to-end assertions below still hold
  // on the reserved geometry; the router detour itself needs a residual pair (ticket 51).
  const plan = planRoute(before);
  expect(plan.batches).toEqual([]);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  for (const item of plan.links) {
    const link = model.links.find(entry => entry.id === item.link)!;
    const points = [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
    for (const connector of item.connectors) {
      expect([connector.id, checkpointsHonoured(points, connector.checkpoints)]).toEqual([connector.id, true]);
    }
    // Both ends keep the perpendicular stem that placement reserved for them.
    for (const segment of [link.path!.segments[0]!, link.path!.segments.at(-1)!]) {
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  }
  // The detour ran along a foreign group edge while `link-2` shared the first batch. Stage 8 now
  // claims that straight run instead of routing it, the batch is one connector smaller, and the
  // detour it leaves passes every gate.
  const report = score(model).snapshot;
  expect(Number.isFinite(report.Q)).toBe(true);
  expect(Object.entries(report.gates).flatMap(([id, gate]) => gate.violations.map(item => [id, item.code, item.elements])))
    .toEqual([]);
}, 60000);

it('keeps every reserved stem checkpoint on the routes of residual links that share ownership batches (ticket 50 review)', async () => {
  // Three links of this fixture are residual (`leg-blocked`, a leg under a group label), so they stay with the router in several
  // batches, beside planned parts whose covers and stems are reserved. The real router publishes every one of them through its
  // checkpoints and removes none: the situation of the detour above, with residual links in place of the crossing pair.
  const text = readFileSync(new URL('../../goldens/synthetic/three-lateral-legs-stay-with-the-router.yaml', import.meta.url), 'utf8');
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(text))))))));
  const plan = planRoute(before);
  expect(plan.batches.length).toBeGreaterThanOrEqual(2);
  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  expect(model.removedLinks ?? []).toEqual([]);
  for (const item of plan.links) {
    const link = model.links.find(entry => entry.id === item.link)!;
    const points = [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
    for (const connector of item.connectors) expect([connector.id, checkpointsHonoured(points, connector.checkpoints)]).toEqual([connector.id, true]);
  }
}, 60000);
