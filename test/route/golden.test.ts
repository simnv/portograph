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

  // The datacenter label band spans its group, so each feed leaves the group sideways, drops
  // beside the band and enters its top port through the 16 px clearance stage 7f reserved.
  const band = model.labelBands.find(item => item.group === 'datacenter')!;
  for (const id of ['link-1', 'link-2']) {
    const segments = model.links.find(link => link.id === id)!.path!.segments;
    const stem = segments.at(-1)!;
    expect(stem.from.x).toBe(stem.to.x);
    expect(stem.to.y - stem.from.y).toBe(15);
    expect(stem.from.y).toBe(band.bounds.y + band.bounds.height + 1);
    expect(segments.every(segment => segment.from.y >= band.bounds.y + band.bounds.height + 0.75
      || segment.to.y <= band.bounds.y - 0.75
      || segment.from.x <= band.bounds.x - 0.75 || segment.from.x >= band.bounds.x + band.bounds.width + 0.75)).toBe(true);
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
  expect(report.Q).toBeCloseTo(0.818586208746674, 12);

  // Placement is frozen: stage 8 adds paths only, and the result restores byte-equal.
  expect(model.freeze!.placement).toEqual(before.freeze!.placement);
  expect(model.links.slice(2).map(link => link.path)).toEqual(before.links.slice(2).map(link => link.path));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);
