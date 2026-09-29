import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { settleKeepOut } from '../../src/layout/bands.js';
import { keepOutShifts, refreshHeldWarnings } from '../../src/layout/columns.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { findPort } from '../../src/layout/row-paths.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 75. A routed link drops to the x of a foreign port from a row in the padding of its frame. When that x stands outside the frame,
 * closer to an edge than the edge clearance and half the stroke, the drop runs along the edge (G6), and only routing would find it. Placement
 * reserves the clearance: the frame stands where every foreign drop is clear of both its edges.
 */
/** The x of the port of `core-2` that the link from `b-edge` drops to. */
const dropX = (model: LayoutModel): number => {
  const link = model.links.find(item => item.attachments?.from.node === 'b-edge' && item.attachments.to.node === 'core-2')!;
  return findPort(model, link.attachments!.to)!.anchor!.x;
};
const run = (): Promise<LayoutModel> => layout(parse(readFileSync(new URL('../../goldens/synthetic/a-frame-keeps-out-of-a-foreign-drop.yaml', import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a frame keeps out of the clearance of a foreign drop (ticket 75)', () => {
  it('the second site stands clear of the drop to core-2, and G6 finds no segment along a group edge', async () => {
    const model = await run();
    const drop = dropX(model);
    const frame = model.frames!.find(item => item.id === 'top-b')!.box;
    // The port stands outside the frame, to its left, clear of the edge by the clearance and half a stroke at least.
    expect(drop).toBeLessThan(frame.x);
    expect(frame.x - drop).toBeGreaterThanOrEqual(GROUP_EDGE_LINK_CLEARANCE + 0.5);
    expect(score(model).snapshot.gates.G6.violations.filter(item => item.code === 'segment-group-edge')).toEqual([]);
    // The published placement is a fixed point of the rule.
    expect(keepOutShifts(model).size).toBe(0);
  }, 120000);

  it('the rule reads a frame edge inside the band and moves it out by the smallest amount', async () => {
    const model = structuredClone(await run()) as LayoutModel;
    const drop = dropX(model);
    const frame = model.frames!.find(item => item.id === 'top-b')!.box;
    // Put the left edge 3 px to the right of the drop: the drop then runs 3 px outside the edge.
    const dx = drop + 3 - frame.x;
    for (const group of Object.values(model.groups).filter(item => item.id.startsWith('top-b'))) moveGroup(model, group, dx, 0);
    const shifts = keepOutShifts(model);
    expect(shifts.size).toBeGreaterThan(0);
    const wanted = [...shifts.values()];
    // Every cell of the frame moves right by the same amount: the clearance, half the stroke and a tolerance, less the 3 px it already has.
    expect(new Set(wanted.map(value => value.toFixed(6))).size).toBe(1);
    expect(wanted[0]!).toBeGreaterThan(GROUP_EDGE_LINK_CLEARANCE - 3);
    expect(wanted[0]!).toBeLessThan(GROUP_EDGE_LINK_CLEARANCE + 3);
  }, 120000);

  it('the frames after a moved frame give way: the band gap between the two sites holds after the settle', async () => {
    const model = structuredClone(await run()) as LayoutModel;
    const link = model.links.find(item => item.attachments?.from.node === 'a-edge' && item.attachments.to.node === 'core-1')!;
    const drop = findPort(model, link.attachments!.to)!.anchor!.x;
    const boxes = (): Map<string, { x: number; width: number }> => new Map(deriveFrames(model)!.map(frame => [frame.id, frame.box]));
    const group = (prefix: string) => Object.values(model.groups).filter(item => item.id.startsWith(prefix));
    // The first site stands with its right edge 3 px short of the drop that it holds (inside the band), the second exactly a band gap after it.
    const first = boxes().get('top-a')!;
    for (const item of group('top-a')) moveGroup(model, item, drop - 3 - (first.x + first.width), 0);
    const doctored = boxes();
    const second = doctored.get('top-b')!;
    for (const item of group('top-b')) moveGroup(model, item, doctored.get('top-a')!.x + doctored.get('top-a')!.width + bandGap(model) - second.x, 0);
    rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
    expect(keepOutShifts(model).size).toBeGreaterThan(0);
    const before = boxes();
    expect(before.get('top-b')!.x - before.get('top-a')!.x - before.get('top-a')!.width).toBeCloseTo(bandGap(model), 6);
    expect(settleKeepOut(model)).toBe(true);
    const after = boxes();
    expect(after.get('top-a')!.x).toBeGreaterThan(before.get('top-a')!.x);
    expect(after.get('top-b')!.x).toBeGreaterThan(before.get('top-b')!.x);
    // The second site moved with the first: the gap between them is still a band gap.
    expect(after.get('top-b')!.x - after.get('top-a')!.x - after.get('top-a')!.width).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    expect(keepOutShifts(model).size).toBe(0);
  }, 120000);

  it('the published held-axis warnings are those of the final geometry', async () => {
    const model = structuredClone(await run()) as LayoutModel;
    const messages = (): string[] => model.diagnostics.filter(item => item.code === 'COLUMN_AXIS_HELD').map(item => item.message);
    const published = messages();
    expect(published.length).toBeGreaterThan(0);
    refreshHeldWarnings(model);
    expect(messages()).toEqual(published);
  }, 120000);
});
