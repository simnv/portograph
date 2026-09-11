import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 18: the maintainer approved this render on 2026-09-11. From here on the layout JSON is an
// exact snapshot (runtime block excluded) and Q is a baseline, per quality.md "Test design".
const APPROVED_Q = 0.9004061377064178;
const yamlUrl = new URL('../../goldens/m1-sip-edge.yaml', import.meta.url);
const snapshotUrl = new URL('../../goldens/m1-sip-edge.layout.json', import.meta.url);

const withoutRuntime = (model: LayoutModel) => {
  const copy: Partial<LayoutModel> = { ...model };
  delete copy.runtime;
  return copy;
};

let model: LayoutModel;
let approved: LayoutModel;
beforeAll(async () => {
  model = await layout(parse(readFileSync(yamlUrl, 'utf8')), {
    createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  });
  approved = JSON.parse(readFileSync(snapshotUrl, 'utf8')) as LayoutModel;
}, 60000);

it('reproduces the approved golden layout exactly, runtime block excluded', () => {
  expect(approved.runtime).toBeUndefined();
  expect(withoutRuntime(model)).toEqual(approved);
});

it('restores the committed snapshot as a final layout and scores it at the approved baseline', () => {
  const restored = restoreFinalLayout(JSON.stringify({ ...approved, runtime: { stages: [] } }));
  const report = score(restored, { golden: true, baseline: APPROVED_Q }).snapshot;
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  // Crossings outside bundles must stay 0; Q may drift within the scorer's ±0.05 baseline tolerance.
  expect(report.assertions).toEqual([
    { code: 'golden-crossings', passed: true, actual: 0, expected: 0, tolerance: 0 },
    { code: 'baseline', passed: true, actual: report.Q, expected: APPROVED_Q, tolerance: 0.05 },
  ]);
});
