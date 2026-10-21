import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { alignLinkedGroupGrid, alignLinkedGroupGridAndPack } from '../../src/layout/bands.js';
import { gapsHoldGrowth, holdsGrowth, reservedGeometryBreaches } from '../../src/layout/growth-guard.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { rebuildBands } from '../../src/layout/skeleton-geometry.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { growTierGaps } from '../../src/layout/gap-room.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { lanes } from '../../src/layout/lanes.js';
import { rebuildRegionGeometry } from '../../src/layout/region-rebuild.js';
import { rows } from '../../src/layout/rows.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { createAttempt, placed } from './phase-two-fixture.js';

// Architecture ticket 16: a box grows only where its reservations allow, on both axes, and a finished model is judged for reserved room on its own.
const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const publish = (name: string): Promise<LayoutModel> => layout(parse(read(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** The flank stands 42.5 px shorter than its core, as it did before the grid grew it: the grid owes it a y-widening and no pack or flank move. */
async function short(): Promise<LayoutModel> {
  const model = structuredClone(await publish('a-grid-growth-stops-at-a-reserved-lane'));
  const flank = model.groups['side']!.bounds!, core = model.groups['core']!.bounds!;
  flank.y = core.y + 20.5; flank.height = core.height - 42.5;
  rebuildBands(model);
  return model;
}
/** A reserved run of another sub-tier in the room above the flank: the lane tier is not the flank's, so only the room it claims can refuse the growth. */
function withWindowAboveFlank(model: LayoutModel): LayoutModel {
  const flank = model.groups['side']!.bounds!, lane = model.lanes[0]!;
  model.lanes.push({ ...structuredClone(lane), id: 'lane:"probe":9', tier: 9, bounds: { x: flank.x + 20, y: flank.y - 15, width: 10, height: 12 } });
  return model;
}

it('the grid grows a flank on the y axis, with no pack and no flank move, where nothing is reserved', async () => {
  const model = await short();
  const core = model.groups['core']!.bounds!;
  expect(alignLinkedGroupGrid(model)).toBe(true);
  expect(model.groups['side']!.bounds!.y).toBeCloseTo(core.y, 6);
  expect(model.groups['side']!.bounds!.height).toBeCloseTo(core.height, 6);
});

it('a reserved lane window in the room a y-widening would claim keeps the flank short', async () => {
  const model = withWindowAboveFlank(await short());
  const before = JSON.stringify(model.groups['side']!.bounds);
  expect(alignLinkedGroupGrid(model)).toBe(false);
  expect(JSON.stringify(model.groups['side']!.bounds)).toBe(before);
});

it('a reserved lane window in the room an x-widening would claim refuses it', async () => {
  const model = structuredClone(await publish('a-grid-growth-stops-at-a-reserved-lane'));
  const core = model.groups['core']!, side = model.groups['side']!;
  const wider = { group: side, bounds: { ...side.bounds!, width: side.bounds!.width + 40 } };
  expect(holdsGrowth(model, [wider])).toBe(true);
  const probe = structuredClone(model.lanes[0]!);
  model.lanes.push({ ...probe, id: 'lane:"probe":9', tier: 9, bounds: { x: side.bounds!.x + side.bounds!.width + 10, y: core.bounds!.y + 10, width: 10, height: 12 } });
  expect(holdsGrowth(model, [wider])).toBe(false);
});

it('an exhausted budget still grows the box where the reservations allow, and refuses it where they do not', async () => {
  const spent = (): { remaining: number; passes: number } => ({ remaining: 0, passes: 0 });
  const open = await short();
  expect(alignLinkedGroupGridAndPack(open, spent())).toBe(true);
  expect(open.groups['side']!.bounds!.height).toBeCloseTo(open.groups['core']!.bounds!.height, 6);
  expect(reservedGeometryBreaches(open)).toEqual([]);

  const held = withWindowAboveFlank(await short());
  const before = JSON.stringify(held.groups['side']!.bounds);
  expect(alignLinkedGroupGridAndPack(held, spent())).toBe(false);
  expect(JSON.stringify(held.groups['side']!.bounds)).toBe(before);
});

it('a y-widening that would take the room of a seated tier gap row is refused', async () => {
  // Stress ticket 05's fixture: the gap under the middle tier owes four rows, 7f grows it to seat them, and the plan then fits.
  const model = structuredClone(await bundles(bars(centre(flanks(lanes(rows(await placed(read('a-tier-gap-grows-to-its-rows')))))))));
  expect(growTierGaps(model)).toBe(true);
  rebuildRegionGeometry(model, undefined, undefined, true);
  expect(tierGapPlans(model).map(({ plan }) => plan.growth)).toEqual([0, 0]);
  const middle = model.groups['g1']!;
  expect(gapsHoldGrowth(model, [{ group: middle, bounds: { ...middle.bounds! } }])).toBe(true);
  expect(gapsHoldGrowth(model, [{ group: middle, bounds: { ...middle.bounds!, height: middle.bounds!.height + 20 } }])).toBe(false);
});

it('a finished model is judged for reserved room on its own, at publication and at restore', async () => {
  const model = await publish('a-grid-growth-stops-at-a-reserved-lane');
  expect(reservedGeometryBreaches(model)).toEqual([]);
  const tampered = structuredClone(model);
  tampered.groups['lower']!.bounds = { ...tampered.lanes[0]!.bounds };
  expect(reservedGeometryBreaches(tampered)).toEqual([expect.stringContaining('lower stands in the reserved run of')]);
  expect(() => restoreLayoutModel(JSON.stringify(tampered))).toThrow();
});
