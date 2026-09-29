import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { keepOutShifts } from '../../src/layout/columns.js';
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
});
