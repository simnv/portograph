import { expect, it } from 'vitest';
import { score } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, restoreLayoutModel, route, rows } from '../../src/internal.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

it.each([10, 50])('routes %i aligned tier links through unused label-band space without detours or crossings', async count => {
  const yaml = ['portograph: 2', 'groups: {t0: {tier: 0}, t1: {tier: 1}}', 'nodes:',
    ...[0, 1].flatMap(tier => Array.from({ length: count }, (_, i) =>
      `  n${tier}_${i}: {group: t${tier}, class: switch, ports: []}`)),
    'links:', ...Array.from({ length: count }, (_, i) => `  - [n0_${i}, n1_${i}]`)].join('\n');
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  const report = score(model).snapshot;
  expect(report.metrics.crossings.count).toBe(0);
  expect(report.passed).toBe(true);
  for (const link of model.links) {
    expect(link.path!.segments.every(segment => segment.from.x === segment.to.x)).toBe(true);
  }
  expect(model.freeze!.placement).toEqual(before.freeze!.placement);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);
