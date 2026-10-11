import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';
import { plannedTurns } from '../../src/layout/turn-order.js';
import { portId } from '../../src/layout/skeleton-graph.js';

/**
 * Architecture ticket 24, review findings 2: every planned turn is read from the reservation (the runs of the course, the margin side, the tier of the far end), not from
 * where two ports happen to stand. Each model below is built so that the geometry of the ends says the opposite turn.
 */
const ref = (node: string, ordinal = 1) => ({ node, ordinal, anonymous: true as const });
const port = (node: string, side: string, x: number, y: number, extra: object = {}) => ({ ref: ref(node), side, anchor: { x, y }, ...extra });

function mini(parts: { a: object; b: object; link?: object; courses?: object[]; tiers?: [number, number] }): LayoutModel {
  const tiers = parts.tiers ?? [0, 1];
  return {
    turnOrder: true, lanes: [], courses: parts.courses ?? [],
    groups: { g0: { tier: tiers[0] }, g1: { tier: tiers[1] } },
    document: { nodes: { a: { group: 'g0' }, b: { group: 'g1' } } },
    nodes: { a: parts.a, b: parts.b },
    links: [{ id: 'l', layer: 'routed', attachments: { from: ref('a'), to: ref('b') }, ...(parts.link ?? {}) }],
  } as unknown as LayoutModel;
}

describe('the planned turn is read from the reservation', () => {
  it('a column-gap skirt turns toward the lane beside the lateral end, whatever the centre of its own node says', () => {
    // `a` leaves by its bottom face (a U part) and `b` keeps its left face. The lane stands left of `b`, so `a` turns right (high), although its port sits left of its centre.
    const model = mini({
      a: { bounds: { x: 100, y: 0, width: 400, height: 40 }, ports: [port('a', 'bottom', 150, 40)] },
      b: { bounds: { x: 600, y: 0, width: 60, height: 40 }, ports: [port('b', 'left', 600, 20)] },
      courses: [{ link: 'l', kind: 'skirt', from: { face: 'bottom' }, to: { face: 'left' }, runs: ['u', 'gap'] }], tiers: [0, 0],
    });
    const turns = plannedTurns(model);
    expect(turns.get(portId(ref('a')))).toEqual({ turn: 'high', shape: 'return', reach: 600 });
    expect(turns.get(portId(ref('b')))).toEqual({ turn: 'high', shape: 'onward', reach: 40 });
  });

  it('a perimeter skirt turns toward its margin, whatever side the far end stands on', () => {
    const model = mini({
      a: { bounds: { x: 300, y: 0, width: 60, height: 40 }, ports: [port('a', 'top', 330, 0)] },
      b: { bounds: { x: 0, y: 200, width: 60, height: 40 }, ports: [port('b', 'right', 60, 220)] },
      courses: [{ link: 'l', kind: 'skirt', side: 'right', from: { face: 'top' }, to: { face: 'right' }, runs: ['padding', 'perimeter'] }],
    });
    expect(plannedTurns(model).get(portId(ref('a')))).toMatchObject({ turn: 'high' });
    expect(plannedTurns({ ...model, courses: [{ ...model.courses![0]!, side: 'left' }] } as LayoutModel).get(portId(ref('a')))).toMatchObject({ turn: 'low' });
  });

  it('a side lane turns toward the tier of its far end, not the y of its far port', () => {
    // `b` is in the lower sub-tier but its port stands higher on the sheet than the lateral port of `a` (a far port can move under 7c): the lane still runs down.
    const model = mini({
      a: { bounds: { x: 0, y: 300, width: 60, height: 40 }, ports: [port('a', 'right', 60, 320, { laneHint: true })] },
      b: { bounds: { x: 200, y: 100, width: 60, height: 40 }, ports: [port('b', 'top', 230, 100)] },
    });
    expect(plannedTurns(model).get(portId(ref('a')))).toMatchObject({ turn: 'high', shape: 'onward' });
  });

  it('a gap skirt beside a shorter neighbour is planned high, as the lane beside its lateral end runs down (reviewer probe)', () => {
    // `a` is a wide, tall node with its bottom port left of its centre; `b` is shorter and keeps its left face at x 600. The old reading took the far port against the centre of `a`
    // (600 < 700, so low); the lane stands left of `b`, so the end turns right (high).
    const model = mini({
      a: { bounds: { x: 0, y: 0, width: 1400, height: 200 }, ports: [port('a', 'bottom', 100, 200)] },
      b: { bounds: { x: 600, y: 0, width: 60, height: 40 }, ports: [port('b', 'left', 600, 20)] },
      courses: [{ link: 'l', kind: 'skirt', from: { face: 'bottom' }, to: { face: 'left' }, runs: ['u', 'gap'] }], tiers: [0, 0],
    });
    expect(plannedTurns(model).get(portId(ref('a')))).toEqual({ turn: 'high', shape: 'return', reach: 600 });
  });
});
