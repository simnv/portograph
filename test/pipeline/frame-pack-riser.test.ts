import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { lanes, rows } from '../../src/internal.js';
import { packBesideRows } from '../../src/layout/columns.js';
import { deriveFrames, riserHostGrowth } from '../../src/layout/frames.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Snack-theme ticket 159 (card nodes): the NTP sheet threw "Lane riser:mesh-bus-1:10 crosses occupied group" in 7f. Two defects:
 * `packBesideRows` moved a child frame without the move guard every other column move asks (R2), so the pack pushed a frame onto a riser
 * lane; and 7a hosted a riser lane in the group with the nearest centre, so a canton across the canton gap grew over the gap to the lane (G9).
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const thaw = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
/** A frame box read off the cells as they stand (`model.frames` is rebuilt only by a producer). */
const frame = (model: LayoutModel, id: string) => deriveFrames(model)!.find(item => item.id === id)!.box;
const cellsOf = (model: LayoutModel, prefix: string): string[] => Object.keys(model.groups).filter(id => id.startsWith(`${prefix}#`));
const gap = (model: LayoutModel): number => frame(model, 'w-site-b').x - (frame(model, 'w-site-a').x + frame(model, 'w-site-a').width);
const held = (model: LayoutModel) => model.diagnostics.filter(item => item.code === 'FRAME_PACK_HELD');
const xs = (model: LayoutModel, ids: readonly string[]): number[] => ids.map(id => model.groups[id]!.bounds!.x);
/** No body of a riser lane's sub-tier stands across the lane. */
function risersClear(model: LayoutModel): void {
  for (const lane of model.lanes.filter(item => item.owner.kind === 'mesh-bus')) {
    for (const group of Object.values(model.groups).filter(item => item.tier === lane.tier)) {
      for (const id of group.nodes) {
        const body = model.nodes[id]!.bounds!;
        expect(body.x + body.width <= lane.bounds.x + 1e-6 || body.x >= lane.bounds.x + lane.bounds.width - 1e-6, `${id} / ${lane.id}`).toBe(true);
      }
    }
  }
}

describe('the beside-row pack asks the move guard (snack-theme ticket 159)', () => {
  it('publishes the sheet whose pack met a riser lane: the sites stand 40 px apart and every gate passes', async () => {
    const model = await run(fixture('a-frame-pack-stops-at-a-riser-lane'));
    expect(model.lanes.filter(lane => lane.owner.kind === 'mesh-bus').map(lane => lane.group)).toEqual(['w-site-b#0', 'w-site-b#1', 'w-zone-b#2']);
    expect(gap(model)).toBeCloseTo(40, 6);
    expect(held(model)).toEqual([]);
    expect(failed(model)).toEqual([]);
    risersClear(model);
  });

  it('keeps a child that would cross a riser lane where it stands and closes the row up from the other side', async () => {
    const model = thaw(await run(fixture('a-frame-pack-stops-at-a-riser-lane')));
    const a = [...cellsOf(model, 'w-site-a'), ...cellsOf(model, 'w-zone-a')], b = [...cellsOf(model, 'w-site-b'), ...cellsOf(model, 'w-zone-b')];
    const before = { a: xs(model, a), b: xs(model, b) };
    // Open the row from the left: the pack now asks `w-site-b` to move 30 px right, onto the riser lane flush with its right edge.
    for (const id of a) moveGroup(model, model.groups[id]!, 30, 0);
    rebuildNodeGeometry(model, a.flatMap(id => model.groups[id]!.nodes), 'current');
    expect(gap(model)).toBeCloseTo(10, 6);
    expect(packBesideRows(model)).toBe(true);
    expect(xs(model, b)).toEqual(before.b);
    expect(xs(model, a).map((x, i) => x - before.a[i]!).every(dx => Math.abs(dx) < 1e-6)).toBe(true);
    expect(gap(model)).toBeCloseTo(40, 6);
    expect(held(model)).toEqual([]);
    risersClear(model);
  });

  it('names the child it holds when the row cannot close up from the other side either', async () => {
    const model = thaw(await run(fixture('a-frame-pack-stops-at-a-riser-lane')));
    const a = [...cellsOf(model, 'w-site-a'), ...cellsOf(model, 'w-zone-a')], b = [...cellsOf(model, 'w-site-b'), ...cellsOf(model, 'w-zone-b')];
    for (const id of a) moveGroup(model, model.groups[id]!, 30, 0);
    rebuildNodeGeometry(model, a.flatMap(id => model.groups[id]!.nodes), 'current');
    const before = xs(model, b), fixed = new Set(a);
    // The caller may not move `w-site-a` (as centring may not move the anchor tier): nothing closes the row, and the warning says so.
    expect(packBesideRows(model, cell => !fixed.has(cell))).toBe(false);
    expect(xs(model, b)).toEqual(before);
    expect(gap(model)).toBeCloseTo(10, 6);
    expect(held(model).map(item => item.owners)).toEqual([[{ kind: 'group', id: 'w-site-b' }]]);
    risersClear(model);
    // A later pack that finds the row packed withdraws it.
    for (const id of a) moveGroup(model, model.groups[id]!, -30, 0);
    rebuildNodeGeometry(model, a.flatMap(id => model.groups[id]!.nodes), 'current');
    packBesideRows(model, cell => !fixed.has(cell));
    expect(held(model)).toEqual([]);
  });
});

describe('a riser lane is held by the group whose frames grow least (snack-theme ticket 159)', () => {
  it('hosts the lane in the canton whose margin it stands in, not in the nearer centre across the canton gap', async () => {
    const yaml = fixture('a-riser-lane-grows-only-the-canton-it-stands-in');
    const staged = lanes(rows(await placed(yaml)));
    const lane = staged.lanes.find(item => item.id === 'riser:mesh-bus-1:3')!;
    expect(lane.group).toBe('w-zone-a#2');
    // The rule the host replaced: the zone of `east` has the nearer centre, so it was the host, and the `east` canton grew across the gap.
    const centre = (id: string): number => Math.abs(lane.x - (staged.groups[id]!.bounds!.x + staged.groups[id]!.bounds!.width / 2));
    expect(centre('e-zone#2')).toBeLessThan(centre('w-zone-a#2'));
    const members = [...staged.meshBuses![0]!.nodes, ...staged.meshBuses![1]!.nodes], at = { x: lane.bounds.x, width: lane.bounds.width };
    expect(riserHostGrowth(staged, 'w-zone-a#2', members, at)).toBeLessThan(riserHostGrowth(staged, 'e-zone#2', members, at));
    const model = await run(yaml);
    expect(model.lanes.find(item => item.id === 'riser:mesh-bus-1:3')!.group).toBe('w-zone-a#2');
    const west = frame(model, 'west'), east = frame(model, 'east');
    expect(east.x).toBeGreaterThanOrEqual(west.x + west.width - 1e-6);
    expect(failed(model)).toEqual([]);
  });
});
