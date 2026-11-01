import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { DEFAULT_STROKE_WIDTHS } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gateFailures } from './open-min-separation.js';

it('horizontal pills clear lateral pills at the corners, including a bundle-seated face', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-horizontal-pill-clears-the-lateral-pill-at-a-corner.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.bundles).toHaveLength(1);
  expect(gateFailures(score(model).snapshot)).toEqual([]);
  const core = model.nodes.core!;
  const top = core.ports.find(port => port.side === 'top')!.pill!.bounds;
  const left = core.ports.filter(port => port.side === 'left').sort((a, b) => a.anchor!.y - b.anchor!.y)[0]!.pill!.bounds;
  // The two outlines need both half-strokes, even when G3's text clearance alone would pass.
  expect(left.y - (top.y + top.height)).toBeGreaterThanOrEqual(DEFAULT_STROKE_WIDTHS.pill - 1e-6);
  const forged = structuredClone(model), node = forged.nodes.core!;
  node.ports.find(port => port.side === 'left')!.anchor!.y = node.bounds!.y + 20;
  rebuildNodeGeometry(forged, ['core'], 'current');
  expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/corner clearance/);
});
