import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import type { Point, Side } from '../../src/model/geometry.js';
import { batchRequest, completedCrossingObstacles, planRoute } from '../../src/route/plan.js';
import { completedRouteCovers } from '../../src/route/obstacles.js';
import { withRouteSession, systemRouteClock } from '../../src/route/worker.js';
import { createAvoidAttempt } from './fixture.js';

/** A short claimed run whose trimmed cover is wider than it is long. */
function crossing(horizontal = false, from: Point = { x: -90, y: 25 }, to: Point = { x: 90, y: 25 }) {
  const model = resolve(parse(`portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g}, b: {group: g}, c: {group: g}, d: {group: g}}
links: [[a, b], [c, d]]`));
  model.groups.g!.bounds = { x: -200, y: -200, width: 600, height: 600 };
  model.groups.g!.tier = 0;
  const rotate: Record<Side, Side> = { top: 'left', bottom: 'right', left: 'top', right: 'bottom' };
  const node = (id: string, point: Point, side: Side): void => {
    const anchor = horizontal ? { x: point.y, y: point.x } : point;
    const facing = horizontal ? rotate[side] : side;
    model.nodes[id]!.bounds = { x: anchor.x - (facing === 'left' ? 0 : facing === 'right' ? 20 : 10),
      y: anchor.y - (facing === 'top' ? 0 : facing === 'bottom' ? 20 : 10), width: 20, height: 20 };
    const port = model.nodes[id]!.ports[0]!;
    port.side = facing;
    port.anchor = anchor;
  };
  node('a', { x: 0, y: 0 }, 'bottom');
  node('b', { x: 0, y: 50 }, 'top');
  node('c', from, 'right');
  node('d', to, 'left');
  return model;
}

describe('crossing a claimed straight run', () => {
  it.each([false, true])('admits a transverse gap without changing the claim (horizontal=%s)', async horizontal => {
    const model = crossing(horizontal), plan = planRoute(model);
    const cover = plan.obstacles.find(item => item.id === 'routed:straight:link-1#0:0')!;
    expect(cover.consumers).toEqual(['link-1', 'link-2']);
    expect(plan.links[0]!.pieces[0]!.kind).toBe('straight');
    const request = batchRequest(plan, plan.batches[0]!, []);
    expect(request.shapes.some(item => item.id === cover.id)).toBe(false);
    // Pin/node obstacles remain: permission belongs to this run, not its owners' geometry.
    expect(request.shapes.filter(item => item.id.startsWith('node:'))).toHaveLength(4);
    const [route] = await withRouteSession(createAvoidAttempt, 3000, systemRouteClock, route => route(request));
    // Both strokes cross perpendicularly with no parallel overlap, and keep clear of the
    // expanded end nodes on either side of this narrow channel.
    expect(route!.points.every(point => horizontal ? point.x === 25 : point.y === 25)).toBe(true);
  });

  it.each([
    [{ x: 60, y: 25 }, { x: 120, y: 25 }],
    [{ x: 60, y: -50 }, { x: 60, y: 100 }],
    [{ x: -90, y: 0 }, { x: 90, y: 0 }],
    [{ x: -90, y: 50 }, { x: 90, y: 50 }],
    [{ x: -90, y: 55 }, { x: 90, y: 55 }],
  ])('retains the cover when the chord does not cross the run interior (%j → %j)', (from, to) => {
    const plan = planRoute(crossing(false, from, to));
    const cover = plan.obstacles.find(item => item.id === 'routed:straight:link-1#0:0')!;
    expect(cover.consumers).toEqual(['link-1']);
  });

  it('does not grant a new crossing through a path placement already fixed', () => {
    const model = crossing();
    model.links[0]!.path = { owner: { kind: 'link', id: 'link-1' }, layer: 'routed', fixed: true,
      segments: [{ from: { x: 0, y: 0 }, to: { x: 0, y: 50 },
      owner: { kind: 'link', id: 'link-1' } }] };
    const plan = planRoute(model);
    const cover = plan.obstacles.find(item => item.id.startsWith('link-1:path:'))!;
    expect(cover.consumers).toEqual(['link-1']);
    expect(plan.links[0]!.exclusions).not.toContain(cover.id);
    expect(batchRequest(plan, plan.batches[0]!, []).shapes.some(shape => shape.id === cover.id)).toBe(true);
  });
});

describe('crossing a completed routed remainder', () => {
  it.each([false, true])('admits only the actual transverse segment (horizontal=%s)', async horizontal => {
    const model = crossing(horizontal), plan = planRoute(model), batch = plan.batches[0]!;
    const run = horizontal
      ? [{ x: 23, y: 10 }, { x: 27, y: 10 }]
      : [{ x: 10, y: 23 }, { x: 10, y: 27 }];
    const covers = completedRouteCovers(model, model.links[0]!, 'prior', run);
    const permitted = completedCrossingObstacles(plan, batch, covers);
    expect(horizontal ? covers[0]!.obstacle.bounds.height > covers[0]!.obstacle.bounds.width
      : covers[0]!.obstacle.bounds.width > covers[0]!.obstacle.bounds.height).toBe(true);
    expect(permitted[0]!.consumers).toContain('link-2');
    const request = batchRequest(plan, batch, permitted);
    expect(request.shapes.some(shape => shape.id === permitted[0]!.id)).toBe(false);
    expect(request.shapes.filter(shape => shape.id.startsWith('node:'))).toHaveLength(4);
    const [route] = await withRouteSession(createAvoidAttempt, 3000, systemRouteClock, route => route(request));
    expect(route!.points.every(point => horizontal ? point.x === 25 : point.y === 25)).toBe(true);
  });

  it('retains a parallel or terminal-touching completed run', () => {
    const model = crossing(), plan = planRoute(model), batch = plan.batches[0]!;
    for (const run of [
      [{ x: -20, y: 25 }, { x: 70, y: 25 }],
      [{ x: -20, y: 10 }, { x: -20, y: 25 }],
    ]) {
      const covers = completedRouteCovers(model, model.links[0]!, 'prior', run);
      const protectedRun = completedCrossingObstacles(plan, batch, covers);
      expect(protectedRun[0]!.consumers).toEqual(['link-1']);
      expect(batchRequest(plan, batch, protectedRun).shapes.some(shape => shape.id === protectedRun[0]!.id)).toBe(true);
    }
  });

  it('retains a completed cover for a batch with an unrelated link', () => {
    const model = crossing(), plan = planRoute(model);
    plan.links.push({ ...plan.links.find(link => link.link === 'link-2')!, link: 'unrelated',
      pieces: [], connectors: [] });
    const batch = { id: 'mixed', links: ['link-2', 'unrelated'] };
    const covers = completedRouteCovers(model, model.links[0]!, 'prior', [{ x: 10, y: 23 }, { x: 10, y: 27 }]);
    const permitted = completedCrossingObstacles(plan, batch, covers);
    expect(batchRequest(plan, batch, permitted).shapes.some(shape => shape.id === permitted[0]!.id)).toBe(true);
  });
});
