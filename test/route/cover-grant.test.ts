import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import type { Point, Side } from '../../src/model/geometry.js';
import { batchRequest, completedCrossingObstacles, planRoute } from '../../src/route/plan.js';

/**
 * Ticket 37, closed by ticket 52 (the rule holds by deletion). A completed cover is granted to a later link only where a leg or an L
 * shape of the link crosses the run's interior, never by the endpoint chord alone. The chord flag of `gapNeeds` is gone: on the corpus
 * (150 synthetic goldens, 72 sweep sheets, the M1 golden and the NTP sheet) no cover was granted by the chord alone. The plan is forged
 * and does not depend on placement. Link 2 runs from c to d, both facing left: checkpoints (-5, 25) and (75, 45), chord (10, 25) to
 * (90, 45). A vertical run at x = 60 crosses the chord at y 37.5; the leg between the checkpoints crosses x = 60 at y 41.25, and its
 * L shapes at y 25 and y 45.
 */
function plan() {
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
  node('a', { x: 200, y: 100 }, 'bottom');
  node('b', { x: 200, y: 160 }, 'top');
  node('c', { x: 10, y: 25 }, 'left');
  node('d', { x: 90, y: 45 }, 'left');
  return planRoute(model);
}

/** A completed run of link 1 at x = 60 between `low` and `high`, with its cover. */
const cover = (low: number, high: number) => ({
  obstacle: { id: 'routed:link-1#0:0', bounds: { x: 50, y: low, width: 20, height: high - low }, consumers: ['link-1'] },
  segment: { from: { x: 60, y: low }, to: { x: 60, y: high } },
});

/** The ids of the shapes a request for link 2 carries, with the cover granted as the router path grants it. */
const request = (run: ReturnType<typeof cover>) => {
  const batch = { id: 'batch-2', links: ['link-2'] };
  return batchRequest(plan(), batch, completedCrossingObstacles(plan(), batch, [run])).shapes.map(item => item.id);
};

describe('a completed cover is granted by a leg or an L shape and never by the chord alone', () => {
  it('forges the plan the comment describes', () => {
    expect(plan().links[1]!.connectors[0]!.checkpoints.map(item => [item.x, item.y])).toEqual([[-5, 25], [75, 45]]);
  });

  it('keeps the cover an obstacle of the request when only the endpoint chord crosses it', () => {
    const run = cover(33, 39);
    expect(request(run)).toContain('routed:link-1#0:0');
    expect(completedCrossingObstacles(plan(), { links: ['link-2'] }, [run])[0]!.consumers).toEqual(['link-1']);
  });

  it('drops the cover from the request when the leg between the checkpoints crosses its interior', () => {
    expect(request(cover(38, 43))).not.toContain('routed:link-1#0:0');
  });

  it('drops the cover from the request when only an L shape of the leg crosses its interior', () => {
    expect(request(cover(43, 47))).not.toContain('routed:link-1#0:0');
  });
});
