import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import type { Point, Side } from '../../src/model/geometry.js';
import { checkpointsHonoured } from '../../src/route/paths.js';
import { completedCrossingObstacles, crossedStems, pendingStemObstacles, planRoute } from '../../src/route/plan.js';
import type { RouteBatch, RoutedConnector } from '../../src/route/types.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** Two links whose ports face left, so each gap must leave its port by a stem and a slanted leg joins the tips. */
function slanted(from: Point, to: Point) {
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
  node('b', { x: -30, y: 50 }, 'top');
  node('c', from, 'left');
  node('d', to, 'left');
  return model;
}

const run = (y: number, x0: number, x1: number) => ({
  obstacle: { id: 'routed:test', bounds: { x: x0, y: y - 11.5, width: x1 - x0, height: 23 }, consumers: ['link-1'] },
  segment: { from: { x: x0, y }, to: { x: x1, y } },
});

describe('a gap owes passage to the runs its orthogonal legs cross (ticket 21)', () => {
  // Checkpoints (-5, 25) and (75, 60): the straight leg is a slant, the router walks an L.
  const plan = planRoute(slanted({ x: 10, y: 25 }, { x: 90, y: 60 }));

  it('a run under the first stem tip is crossed by the L that leaves the tip along its stem, though the slant misses it', () => {
    // The slant is at x = 64 where y = 55, past the run's end at x = 40; the L down x = -5 crosses it.
    const granted = completedCrossingObstacles(plan, { links: ['link-2'] }, [run(55, -20, 40)]);
    expect(granted[0]!.consumers).toEqual(['link-1', 'link-2']);
  });

  it('a run only the other L crosses (along the far tip, not the near one) is granted too', () => {
    // A vertical run at x = 40, y 10 to 40: the slant passes it at y = 44.7 and the L down x = -5 is far away;
    // only the L along y = 25 and down x = 75 crosses it.
    const vertical = { obstacle: { id: 'routed:vertical', bounds: { x: 28.5, y: -1.5, width: 23, height: 53 }, consumers: ['link-1'] },
      segment: { from: { x: 40, y: 10 }, to: { x: 40, y: 40 } } };
    const granted = completedCrossingObstacles(plan, { links: ['link-2'] }, [vertical]);
    expect(granted[0]!.consumers).toEqual(['link-1', 'link-2']);
  });

  it('a run that neither the slant nor either L crosses stays an obstacle', () => {
    const granted = completedCrossingObstacles(plan, { links: ['link-2'] }, [run(55, 80, 100)]);
    expect(granted[0]!.consumers).toEqual(['link-1']);
  });
});

describe('a later part of a batch keeps its stems (ticket 21, the part order)', () => {
  // Link 2 leaves c at y = 10 and its checkpoints (-5, 10), (75, 10); link 1 leaves a down x = -2 to y = 15.
  const plan = planRoute(slanted({ x: 10, y: 10 }, { x: 90, y: 10 }));
  const stem = plan.stems.find(item => item.link === 'link-1')!;

  it('the stem of a later part is an obstacle to the part before it', () => {
    const items = pendingStemObstacles(plan, { links: ['link-2'] }, new Set(['link-1']));
    expect(items.map(item => item.bounds)).toContainEqual(stem.bounds);
    expect(items.every(item => item.consumers.length === 0)).toBe(true);
  });

  it('a link whose gap has to cross that stem is its consumer, so the crossing stays open', () => {
    const items = pendingStemObstacles(plan, { links: ['link-2'] }, new Set(['link-1']), new Set(['link-1']));
    expect(items.find(item => item.bounds === stem.bounds)!.consumers).toEqual(['link-2']);
  });
});

describe('a batch splits by the batchmate stems its links cross (ticket 22)', () => {
  it('only the link whose gap crosses a batchmate stem carries that stem in its key', () => {
    const model = resolve(parse(`portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g}, b: {group: g}, c: {group: g}, d: {group: g}, e: {group: g}, f: {group: g}}
links: [[a, b], [c, d], [e, f]]`));
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
    node('b', { x: -40, y: 80 }, 'top');
    node('c', { x: 10, y: 10 }, 'left');
    node('d', { x: 90, y: 10 }, 'left');
    node('e', { x: 10, y: 60 }, 'left');
    node('f', { x: 90, y: 60 }, 'left');
    const plan = planRoute(model);
    const stem = plan.stems.findIndex(item => item.link === 'link-1' && item.node === 'a');
    const batch = { links: ['link-1', 'link-2', 'link-3'] };
    expect(crossedStems(plan, batch, 'link-2')).toEqual([`stem:${stem}:link-1`]);
    // Link 3 runs at y = 60, below the stem of a (y 0 to 15).
    expect(crossedStems(plan, batch, 'link-3')).toEqual([]);
  });
});

describe('the fixture whose far checkpoints stood in a pocket', () => {
  /** Routes the real plan and keeps every batch request with its answer; the layout is allowed to stop later. */
  async function routedBatches(): Promise<{ batch: RouteBatch; routes: RoutedConnector[] }[]> {
    const requests: RouteBatch[] = [], replies: { routes?: RoutedConnector[] }[] = [];
    const attempt = () => {
      const made = createAvoidAttempt();
      const post = made.worker.postMessage.bind(made.worker), listen = made.worker.addEventListener.bind(made.worker);
      made.worker.postMessage = (message: unknown) => { requests.push((message as { batch: RouteBatch }).batch); post(message); };
      made.worker.addEventListener = (type: string, listener: (event: { data?: unknown; message?: string }) => void) =>
        listen(type, type === 'message' ? event => { replies.push(event.data as { routes?: RoutedConnector[] }); listener(event); } : listener);
      return made;
    };
    await layout(parse(fixture('a-band-holds-the-group-that-set-its-edge')),
      { createElkAttempt: createAttempt, createRouteAttempt: attempt }).catch(() => undefined);
    return requests.map((batch, index) => ({ batch, routes: replies[index]?.routes ?? [] }));
  }

  it('routes link-22 (its near stem tip stood walled in by link-18) and link-24 (link-23 ran through its stem)', async () => {
    const batches = await routedBatches();
    for (const id of ['link-22#0', 'link-24#0']) {
      const held = batches.find(item => item.batch.connectors.some(connector => connector.id === id))!;
      const connector = held.batch.connectors.find(item => item.id === id)!;
      const points = held.routes.find(item => item.connector === id)!.points;
      expect(checkpointsHonoured(points, connector.checkpoints), id).toBe(true);
      expect(points.length, id).toBeGreaterThan(2);
    }
  }, 60000);

  // link-35 and link-37 stop the layout next: a far stem tip lies on the bottom edge of link-17's completed
  // cover (y = 442), so libavoid answers the tip and never leaves it. See the ticket's Comments.
  it.todo('routes the whole fixture through the real route plan without a throw');
});
