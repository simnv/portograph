import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { alignLinkedGroupGrid, forgedRefusals, alignLinkedGroupGridAndPack } from '../../src/layout/bands.js';
import { exitsHoldGrowth, gapsHoldGrowth, GROWTH_GUARDS, lanesHoldGrowth } from '../../src/layout/growth-guard.js';
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
  expect(lanesHoldGrowth(model, [wider])).toBe(true);
  const probe = structuredClone(model.lanes[0]!);
  model.lanes.push({ ...probe, id: 'lane:"probe":9', tier: 9, bounds: { x: side.bounds!.x + side.bounds!.width + 10, y: core.bounds!.y + 10, width: 10, height: 12 } });
  expect(lanesHoldGrowth(model, [wider])).toBe(false);
});

it('an exhausted budget still grows the box where the reservations allow, and refuses it where they do not', async () => {
  const spent = (): { remaining: number; passes: number } => ({ remaining: 0, passes: 0 });
  const open = await short();
  expect(alignLinkedGroupGridAndPack(open, spent())).toBe(true);
  expect(open.groups['side']!.bounds!.height).toBeCloseTo(open.groups['core']!.bounds!.height, 6);
  expect(open.gridRefusals).toBeUndefined();

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

it('the grid records the pair a guard refused, and a lane that moves away later does not make the replay grow it', async () => {
  const model = withWindowAboveFlank(await short());
  expect(alignLinkedGroupGrid(model)).toBe(false);
  expect(model.gridRefusals).toEqual(['y:core|side']);
  const refusals = new Set(model.gridRefusals);
  // The lane leaves the room after 7e: live guards would grow the flank, the record does not.
  const later = structuredClone(model);
  later.lanes.at(-1)!.bounds.y -= 500;
  expect(alignLinkedGroupGrid(structuredClone(later))).toBe(true);
  expect(alignLinkedGroupGrid(later, refusals)).toBe(false);
  // A grid that is aligned records nothing.
  expect(alignLinkedGroupGrid(later)).toBe(true);
  expect(later.gridRefusals).toBeUndefined();
});

it('a restore of the output re-validates the grid, and a hand-added GROUP_GRID_REFUSED or a tampered grid does not pass it', async () => {
  const model = await publish('a-grid-growth-stops-at-a-reserved-lane');
  expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  const tampered = structuredClone(model);
  const flank = tampered.groups['side']!.bounds!;
  flank.height -= 20;
  expect(() => restoreLayoutModel(JSON.stringify(tampered))).toThrow();
  tampered.gridRefusals = ['y:core|side'];
  expect(() => restoreLayoutModel(JSON.stringify(tampered))).toThrow();
  tampered.diagnostics.push({ stage: 'placement', severity: 'info', code: 'GROUP_GRID_REFUSED', message: 'The linked-group grid would take reserved room.', owners: [] });
  expect(() => restoreLayoutModel(JSON.stringify(tampered))).toThrow();
});

it('a plan that cannot be read refuses a y-widening', async () => {
  const model = structuredClone(await publish('a-grid-growth-stops-at-a-reserved-lane'));
  const core = model.groups['core']!;
  model.tierBands[0]!.bounds = undefined as never;
  expect(gapsHoldGrowth(model, [{ group: core, bounds: { ...core.bounds!, height: core.bounds!.height + 5 } }])).toBe(false);
});

it('a recorded refusal stands whatever skip would apply to its pair, and is forged only when the pair shares an extent', async () => {
  const model = await short();
  const refusals = new Set(['y:core|side']);
  // The pair is apart and a growth through another pair has left it beyond the growth cap: the replay skips it before any guard, and the record is true.
  const flank = model.groups['side']!.bounds!;
  flank.height = model.groups['core']!.bounds!.height * 0.4;
  expect(forgedRefusals(structuredClone(model), refusals)).toEqual([]);
  // A pair that shares an extent in the final model is a forged record; so is a pair that is not linked.
  expect(forgedRefusals(structuredClone(await publish('a-grid-growth-stops-at-a-reserved-lane')), refusals)).toEqual(['y:core|side']);
  expect(forgedRefusals(structuredClone(model), new Set(['y:core|nobody']))).toEqual(['y:core|nobody']);
});

it('ticket 13: a growth that swallows the margin of a reserved group exit is refused (exitsHoldGrowth)', async () => {
  const model = await publish('a-claimed-run-clears-a-shared-run');
  const exit = model.groupExits![0]!, group = model.groups[exit.exited[0]!]!, box = group.bounds!;
  expect(GROWTH_GUARDS).toContain(exitsHoldGrowth);
  expect(exitsHoldGrowth(model, [{ group, bounds: box }])).toBe(true);
  // Growing the box by more than the slack past the exit's end puts the end inside the margin.
  expect(exitsHoldGrowth(model, [{ group, bounds: { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 } }])).toBe(false);
  // A model with no exit holds every growth.
  const bare = structuredClone(model);
  delete bare.groupExits;
  expect(exitsHoldGrowth(bare, [{ group, bounds: { ...box, width: box.width + 60 } }])).toBe(true);
}, 60000);

it('ticket 13: a cell that widens its frame over a reserved exit is refused, and an unrelated old violation does not block an unrelated growth', async () => {
  const model = structuredClone(await publish('a-link-leaves-a-ranked-group-through-its-frame'));
  const frame = model.frames!.find(item => item.id === 'home')!, link = model.links.find(item => item.attachments?.from.node === 's1')!;
  const cell = model.groups[frame.cells[0]!]!;
  // An exit that leaves the frame to the left, its end at the margin 7e reserves.
  const clearance = 12.75, exit = { link: link.id, end: 'from' as const, exited: ['home'], from: { x: frame.box.x + 20, y: frame.box.y + 20 }, to: { x: frame.box.x - clearance, y: frame.box.y + 20 }, clearance };
  model.groupExits = [exit];
  const widened = { x: cell.bounds!.x - 30, y: cell.bounds!.y, width: cell.bounds!.width + 30, height: cell.bounds!.height };
  // The stored frame box does not move with the proposal; the frame derived from the proposed cell does, and swallows the end.
  expect(exitsHoldGrowth(model, [{ group: cell, bounds: widened }])).toBe(false);
  expect(exitsHoldGrowth(model, [{ group: cell, bounds: { ...cell.bounds! } }])).toBe(true);
  // Another group's growth, away from the exit, is not judged on an exit already short of its margin, nor on a link without attachments.
  const old = { ...exit, to: { x: frame.box.x + 5, y: frame.box.y + 20 } };
  const lost = { ...exit, link: 'no-such-link' };
  model.groupExits = [old, lost];
  const other = Object.values(model.groups).find(group => group.frame === undefined && group.nodes.length > 0 && group.id !== 'home')!;
  const b = other.bounds!;
  expect(exitsHoldGrowth(model, [{ group: other, bounds: { x: b.x, y: b.y, width: b.width + 4, height: b.height } }])).toBe(true);
}, 60000);
