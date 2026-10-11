import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// The channel a chain bundle needs is read through `bundleChannelNeed`; here it asks for far more than any gap holds, so a
// planner that never calls the guard (or whose guard reads another figure) publishes no error.
const ask = vi.hoisted(() => ({ big: false }));
vi.mock('../../src/layout/bundle-need.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/bundle-need.js')>();
  return { ...actual, bundleChannelNeed: (...args: Parameters<typeof actual.bundleChannelNeed>) => ask.big ? 1e6 : actual.bundleChannelNeed(...args) };
});

it('stage 7e checks every chain bundle against the channel the packer reserved', async () => {
  const text = readFileSync(new URL('../../goldens/synthetic/a-bundle-in-a-grid-stands-as-a-grid.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const draft = JSON.parse(JSON.stringify(model)) as LayoutModel;
  draft.diagnostics = [];
  prepareBundleGeometry(draft);
  expect(draft.diagnostics.filter(item => item.code === 'GRID_BUNDLE_CHANNEL_SHORT')).toEqual([]);
  ask.big = true;
  prepareBundleGeometry(draft);
  expect(draft.diagnostics.filter(item => item.code === 'GRID_BUNDLE_CHANNEL_SHORT')).toHaveLength(1);
}, 60000);
