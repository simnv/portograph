import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import type { Point, Side } from '../../src/model/geometry.js';
import { completedCrossingObstacles, planRoute } from '../../src/route/plan.js';

/**
 * A run of link 1 (a to b) at x = -2, and a gap of link 2 (c to d) whose two ports face left. The chord
 * from c to d stays right of the run; the stems the gap must pass (checkpoints at x = -5 and x = 75)
 * carry it across the run and back. Ticket 14: a checkpoint that lies past a run puts that run in the
 * gap's way, so the run must grant passage to the link, the chord notwithstanding.
 */
function pocket() {
  const model = resolve(parse(`portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g}, b: {group: g}, c: {group: g}, d: {group: g}}
links: [[a, b], [c, d]]`));
  model.groups.g!.bounds = { x: -200, y: -200, width: 600, height: 600 };
  model.groups.g!.tier = 0;
  const node = (id: string, point: Point, side: Side): void => {
    model.nodes[id]!.bounds = { x: point.x - (side === 'left' ? 0 : side === 'right' ? 20 : 10),
      y: point.y - (side === 'top' ? 0 : side === 'bottom' ? 20 : 10), width: 20, height: 20 };
    const port = model.nodes[id]!.ports[0]!;
    port.side = side;
    port.anchor = point;
  };
  node('a', { x: -2, y: 0 }, 'bottom');
  node('b', { x: -2, y: 50 }, 'top');
  node('c', { x: 10, y: 25 }, 'left');
  node('d', { x: 90, y: 25 }, 'left');
  return model;
}

describe('a run the checkpoints of a gap cross grants passage to it', () => {
  it('a claimed straight run grants the link whose stem checkpoint lies past it', () => {
    const plan = planRoute(pocket());
    const cover = plan.obstacles.find(item => item.id === 'routed:straight:link-1#0:0')!;
    expect(plan.links[1]!.connectors[0]!.checkpoints.map(item => item.x)).toEqual([-5, 75]);
    expect(cover.consumers).toEqual(['link-1', 'link-2']);
  });

  it('a completed run grants the link whose checkpoint lies past it, and not one whose polyline stays clear', () => {
    const plan = planRoute(pocket());
    const obstacle = { id: 'routed:test', bounds: { x: -12, y: -5, width: 20, height: 60 }, consumers: ['link-1'] };
    const covers = [{ obstacle, segment: { from: { x: -2, y: 0 }, to: { x: -2, y: 50 } } }];
    expect(completedCrossingObstacles(plan, { links: ['link-2'] }, covers)[0]!.consumers).toEqual(['link-1', 'link-2']);
    const clear = [{ obstacle, segment: { from: { x: -40, y: 0 }, to: { x: -40, y: 50 } } }];
    expect(completedCrossingObstacles(plan, { links: ['link-2'] }, clear)[0]!.consumers).toEqual(['link-1']);
  });
});
