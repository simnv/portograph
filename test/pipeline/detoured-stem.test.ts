import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, checkpointsHonoured, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
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
  // The precondition: the crossing pair really is split across two ownership batches.
  const plan = planRoute(before);
  expect(plan.batches.map(batch => batch.links)).toEqual([['link-1', 'link-2'], ['link-3']]);

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
  // The diagram is poor — the detour runs along a foreign group edge — but it is a diagram.
  // A failed gate is a judgement about one; a failed pipeline is the absence of one.
  const report = score(model).snapshot;
  expect(Number.isFinite(report.Q)).toBe(true);
  expect(Object.entries(report.gates).flatMap(([id, gate]) => gate.violations.map(item => [id, item.code, item.elements])))
    .toEqual([['G6', 'segment-group-edge', ['link-1', 'g-right']]]);
}, 60000);
