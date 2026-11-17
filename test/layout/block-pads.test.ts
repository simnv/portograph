import { describe, expect, it } from 'vitest';
import type { LayoutLink, LayoutModel } from '../../src/model/layout.js';
import { blockBoxPadsAsked, blockRowGapsAsked } from '../../src/layout/block-pads.js';
import { blockBoxPadsFault, blockRowGapsFault } from '../../src/layout/placement-inputs.js';
import { GROUP_EDGE_LINK_CLEARANCE, DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../../src/theme/geometry.js';
import { STRAIGHT_PATH_CLEARANCE } from '../../src/layout/row-paths.js';
import { SIDE_EDGE_SLACK } from '../../src/layout/frame-paths.js';
import { blockReserve } from '../../src/layout/tolerance.js';

/**
 * The room a flat block member asks of placement (dense-16x9 ticket 04, slice 3, step 2), read at its angle at the block's floor: the side
 * padding of a box it leaves (`blockBoxPadsAsked`) and the row gap beside its end node (`blockRowGapsAsked`).
 */
type Box = { x: number; y: number; width: number; height: number };
const port = (node: string, side: string, x: number, y: number) => ({ ref: { node, name: 'p' }, side, anchor: { x, y } });
const link = { id: 'l', fanFamily: 'b', owner: { kind: 'link', id: 'l' }, attachments: { from: { node: 'hub', name: 'p' }, to: { node: 'far', name: 'p' } } } as unknown as LayoutLink;

/** A hub in `up` (tier 0, bottom 100) and a far node in `down` (tier 1 from y 360, so the gap is 260); the record's floor gap is 200. */
function model(far: { anchor: number; box: Box }, extra: Partial<Record<'hubNodes' | 'tall', unknown>> = {}): LayoutModel {
  return {
    document: { nodes: { hub: { group: 'up' }, far: { group: 'down' }, tall: { group: 'up' } }, groups: { up: {}, down: {} } },
    groups: { up: { nodes: extra.hubNodes ?? ['hub'], bounds: { x: 0, y: 0, width: 400, height: 100 } }, down: { nodes: ['far'], bounds: far.box } },
    tierBands: [{ tier: 0, bounds: { x: 0, y: 0, width: 2000, height: 100 } }, { tier: 1, bounds: { x: 0, y: 360, width: 2000, height: 100 } }],
    nodes: {
      hub: { bounds: { x: 160, y: 60, width: 40, height: 40 }, ports: [port('hub', 'bottom', 180, 100)] },
      far: { bounds: { x: far.anchor - 20, y: 400, width: 40, height: 40 }, ports: [port('far', 'top', far.anchor, 400)] },
      ...(extra.tall ? { tall: extra.tall } : {}),
    },
    links: [link],
    blockReservations: [{ family: 'b', mode: 'flat', above: 0, below: 1, floor: 200, chosen: 260, target: 400, cap: 600, pitch: 21 }],
  } as unknown as LayoutModel;
}

describe('blockBoxPadsAsked: the side room of a box a flat member leaves', () => {
  // The far end stands 40 px below the top edge of `down`; the chord runs left, 820 px across and 240 px down at the floor angle.
  const offset = 40, dx = 820, floorDy = 300 - (260 - 200);

  it('pads the wall toward the other end so that the chord leaves by the top edge at the floor angle, the margin from the corner', () => {
    const m = model({ anchor: 1000, box: { x: 900, y: 360, width: 200, height: 100 } });
    const asked = blockBoxPadsAsked(m);
    expect(asked.map(item => [item.box, item.side])).toEqual([['down', 'left']]);
    // With the padding, the run inside the box at the floor angle (offset dx / floorDy) ends the margin and the slack from the corner.
    const wall = 1000 - 900 + asked[0]!.pad;
    expect(wall - offset * dx / floorDy).toBeCloseTo(GROUP_EDGE_LINK_CLEARANCE + SIDE_EDGE_SLACK, 6);
    expect(blockBoxPadsFault({ ...m, blockBoxPads: asked })).toBeUndefined();
  });

  it('asks for nothing where the side exit holds at the steepest angle', () => {
    // 5 px from the left wall: at the 34 degree demand the chord meets that wall 37 px below the top corner.
    expect(blockBoxPadsAsked(model({ anchor: 905, box: { x: 900, y: 360, width: 200, height: 100 } }))).toEqual([]);
  });

  it('grows the recorded padding by what is still short, and keeps it when nothing is', () => {
    const box = { x: 900, y: 360, width: 200, height: 100 };
    const first = blockBoxPadsAsked(model({ anchor: 1000, box }));
    const again = blockBoxPadsAsked({ ...model({ anchor: 1000, box }), blockBoxPads: [{ box: 'down', side: 'left', pad: 5 }] });
    expect(again[0]!.pad).toBeCloseTo(first[0]!.pad + 5, 9);
    const held = [{ box: 'down', side: 'left' as const, pad: 7 }];
    expect(blockBoxPadsAsked({ ...model({ anchor: 905, box }), blockBoxPads: held })).toEqual(held);
  });

  it('refuses an unreadable or unordered record', () => {
    const m = model({ anchor: 1000, box: { x: 900, y: 360, width: 200, height: 100 } });
    expect(blockBoxPadsFault({ ...m, blockBoxPads: [] })).toMatch(/empty/);
    expect(blockBoxPadsFault({ ...m, blockBoxPads: [{ box: 'down', side: 'left', pad: -1 }] })).toMatch(/unreadable/);
    expect(blockBoxPadsFault({ ...m, blockBoxPads: [{ box: 'down', side: 'right', pad: 1 }, { box: 'down', side: 'left', pad: 1 }] })).toMatch(/order/);
  });
});

describe('blockRowGapsAsked: the row gap beside the end of a flat member', () => {
  // The chord runs right from the hub's port (180, 100); `tall` stands to the right of the hub, 30 px off.
  const far = { anchor: 1000, box: { x: 900, y: 360, width: 200, height: 100 } };
  const tall = (bottom: number) => ({ bounds: { x: 230, y: 60, width: 40, height: bottom - 60 } });
  const dx = 820, floorDy = 300 - (260 - 200), length = Math.hypot(dx, floorDy);
  const clearance = STRAIGHT_PATH_CLEARANCE.node + (linkStrokeWidth(link) + DEFAULT_STROKE_WIDTHS.node) / 2;

  it('asks a gap that holds the node clearance from the corner of a taller neighbour at the floor angle', () => {
    const asked = blockRowGapsAsked(model(far, { hubNodes: ['hub', 'tall'], tall: tall(120) }));
    expect(asked.map(item => [item.left, item.right])).toEqual([['hub', 'tall']]);
    // The corner of `tall` at that gap: its distance from the chord at the floor angle is the clearance, its reserved margin (the row room
    // backs G6: `blockReserve`) and the slack.
    const corner = { x: 200 + asked[0]!.gap, y: 120 };
    const distance = Math.abs((corner.x - 180) * floorDy - (corner.y - 100) * dx) / length;
    expect(distance).toBeCloseTo(clearance + blockReserve('room') + SIDE_EDGE_SLACK, 6);
    expect(blockRowGapsFault({ ...model(far), blockRowGaps: asked })).toBeUndefined();
  });

  it('asks for nothing beside a neighbour that does not reach past the face', () => {
    expect(blockRowGapsAsked(model(far, { hubNodes: ['hub', 'tall'], tall: tall(90) }))).toEqual([]);
  });

  it('refuses an unreadable or unordered record', () => {
    expect(blockRowGapsFault({ ...model(far), blockRowGaps: [] })).toMatch(/empty/);
    expect(blockRowGapsFault({ ...model(far), blockRowGaps: [{ left: 'b', right: 'c', gap: 1 }, { left: 'a', right: 'c', gap: 1 }] })).toMatch(/order/);
  });
});
