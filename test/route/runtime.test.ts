import { describe, expect, it } from 'vitest';
import { RouteDeadlineError, RouteSession, withRouteSession, systemRouteClock,
  type CreateRouteAttempt, type RouteWorker } from '../../src/route/worker.js';
import { ALL_DIRECTIONS, DIRECTION_BITS, type RouteBatch, type RouteCheckpoint } from '../../src/route/types.js';
import { checkpointsHonoured } from '../../src/route/paths.js';
import { disjointShapes } from '../../src/route/plan.js';
import { avoidAssets, createAvoidAttempt, spawnAvoidWorker } from './fixture.js';

interface AvoidPoint { x: number; y: number }
interface WorkerApi {
  loadAvoid(moduleUrl: string, wasmUrl: string, importModule?: (specifier: string) => Promise<unknown>): Promise<Record<string, never>>;
  routeBatch(avoid: unknown, batch: RouteBatch): { connector: string; points: AvoidPoint[] }[];
  handleRouteMessage(message: unknown, reply: (response: unknown) => void): Promise<void>;
  checkpointsVisited(points: AvoidPoint[], checkpoints: RouteCheckpoint[]): boolean;
}
// The worker is plain JavaScript with no published declarations, so it loads through a URL.
const worker = await import(new URL('../../runtime/avoid-worker.mjs', import.meta.url).href) as WorkerApi;
const avoid = await worker.loadAvoid(avoidAssets.moduleUrl, avoidAssets.wasmUrl) as unknown as Record<string, {
  new (...args: unknown[]): unknown; [key: string]: unknown }>;

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const batch = (connectors: RouteBatch['connectors'], shapes: RouteBatch['shapes']): RouteBatch =>
  ({ id: 'contract', shapeBufferDistance: 0, parameters: {}, shapes, connectors });

describe('libavoid-js 0.5.0-beta.5 runtime contract', () => {
  it('routes around the exact union of near-contained rectangles in every input order', () => {
    const box = (id: string, x: number, y: number, r: number, b: number) =>
      ({ id, bounds: { x, y, width: r - x, height: b - y } });
    const cycle = [box('a', 0, 0, 10, 10), box('b', -1.6e-7, 8e-8, 9.99999992, 10), box('c', -8e-8, -8e-8, 9.99999984, 10)];
    const chain = [box('a', 0, 0, 10, 10), box('b', -8e-8, 1, 9.5, 9), box('c', -1.6e-7, 2, 9, 8)];
    for (const shapes of [cycle, chain]) {
      for (const [i, j, k] of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
        const filtered = disjointShapes([shapes[i!]!, shapes[j!]!, shapes[k!]!]);
        expect(filtered).toHaveLength(3);
        const points = worker.routeBatch(avoid, batch([{ id: 'near-containment',
          from: { kind: 'point', x: -20, y: 5 }, to: { kind: 'point', x: 30, y: 5 }, checkpoints: [],
        }], filtered))[0]!.points;
        expect(points[0]).toEqual({ x: -20, y: 5 });
        expect(points.at(-1)).toEqual({ x: 30, y: 5 });
        for (let n = 1; n < points.length; n++) {
          const a = points[n - 1]!, b = points[n]!;
          for (const { bounds: r } of shapes) {
            const crosses = a.y === b.y
              ? a.y > r.y && a.y < r.y + r.height && Math.max(Math.min(a.x, b.x), r.x) < Math.min(Math.max(a.x, b.x), r.x + r.width)
              : a.x > r.x && a.x < r.x + r.width && Math.max(Math.min(a.y, b.y), r.y) < Math.min(Math.max(a.y, b.y), r.y + r.height);
            expect(crosses).toBe(false);
          }
        }
      }
    }
  });

  it('binds the exact constructors, enums and route extraction stage 8 depends on', () => {
    const Avoid = avoid as unknown as Record<string, { OrthogonalRouting?: { value: number }; prototype?: object }>;
    // The router flag is a nested enum object; its numeric `.value` is what the constructor takes.
    expect(typeof (Avoid.RouterFlag as { OrthogonalRouting: { value: number } }).OrthogonalRouting.value).toBe('number');
    expect((Avoid as unknown as Record<string, unknown>).OrthogonalRouting).toBeUndefined();
    // A routing parameter is passed as the enum object itself, not its value.
    expect(typeof (Avoid.RoutingParameter as unknown as Record<string, unknown>).shapeBufferDistance).toBe('object');
    // Neither a real JunctionRef class nor a fixed-route API exists in this build.
    expect((Avoid as unknown as Record<string, unknown>).JunctionRef).toBeUndefined();
    expect((Avoid.ConnRef as { prototype: Record<string, unknown> }).prototype.setFixedRoute).toBeUndefined();
    expect(typeof (Avoid.ConnRef as { prototype: Record<string, unknown> }).prototype.setRoutingCheckpoints).toBe('function');
    expect(typeof (Avoid.ShapeConnectionPin as { prototype: Record<string, unknown> }).prototype.setExclusive).toBe('function');
  });

  // The ticket's probe on every side: one pin on the drawn boundary inside its expanded obstacle,
  // two connectors through it, and the 15 px stem they must share before they fan out.
  const SIDES = [
    { side: 'top', out: { x: 0, y: -1 }, tangent: { x: 1, y: 0 }, inward: 2 },
    { side: 'bottom', out: { x: 0, y: 1 }, tangent: { x: 1, y: 0 }, inward: 1 },
    { side: 'left', out: { x: -1, y: 0 }, tangent: { x: 0, y: 1 }, inward: 8 },
    { side: 'right', out: { x: 1, y: 0 }, tangent: { x: 0, y: 1 }, inward: 4 },
  ] as const;
  const bitOf = (x: number, y: number): number => y < 0 ? 1 : y > 0 ? 2 : x < 0 ? 4 : 8;
  it.each(SIDES)('accepts two connectors on one shared non-exclusive $side pin', ({ out, tangent, inward }) => {
    const at = (along: number, across: number): AvoidPoint =>
      ({ x: out.x * along + tangent.x * across, y: out.y * along + tangent.y * across });
    const box = (centre: AvoidPoint) => rect(centre.x - 21.75, centre.y - 21.75, 43.5, 43.5);
    const anchor = at(10, 0), fan = at(25, 0);
    const shapes: RouteBatch['shapes'] = [
      { id: 'shared', bounds: box(at(0, 0)), pins: [{ classId: 1, ...anchor, directions: bitOf(out.x, out.y), exclusive: false }] },
    ];
    const connectors: RouteBatch['connectors'] = [-40, 40].map((across, index) => {
      const target = at(110, across);
      shapes.push({ id: `end-${index}`, bounds: box(at(120, across)),
        pins: [{ classId: 1, ...target, directions: inward, exclusive: true }] });
      return { id: `link-${index}`, from: { kind: 'pin' as const, shape: 'shared', classId: 1 },
        to: { kind: 'pin' as const, shape: `end-${index}`, classId: 1 },
        checkpoints: [{ ...fan, arrival: inward, departure: bitOf(tangent.x * across, tangent.y * across) },
          { ...at(25, across), arrival: 15, departure: 15 }] };
    });
    const routes = worker.routeBatch(avoid, batch(connectors, shapes));
    expect(routes.map(item => [item.points[0], item.points[1], item.points.at(-1)])).toEqual([
      [anchor, fan, at(110, -40)],
      [anchor, fan, at(110, 40)],
    ]);
    // The shared stem is exactly the reserved 15 px, and each route then leaves it.
    for (const item of routes) expect(item.points.length).toBeGreaterThan(3);
  });

  it('routes from a free point and reports a route that libavoid could not complete', () => {
    const shapes: RouteBatch['shapes'] = [{ id: 'wall', bounds: rect(40, -100, 20, 200) }];
    const routes = worker.routeBatch(avoid, batch([{ id: 'gap', from: { kind: 'point', x: 0, y: 0 },
      to: { kind: 'point', x: 100, y: 0 }, checkpoints: [] }], shapes));
    const points = routes[0]!.points;
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 100, y: 0 });
    expect(points.length).toBeGreaterThan(2);
  });

  it('skips a checkpoint it cannot reach instead of failing, which stage 8 then rejects', () => {
    const shapes: RouteBatch['shapes'] = [{ id: 'wall', bounds: rect(40, -100, 20, 200) }];
    // The checkpoint sits inside the obstacle; the C++ contract allows libavoid to drop it.
    const routes = worker.routeBatch(avoid, batch([{ id: 'blocked', from: { kind: 'point', x: 0, y: 0 },
      to: { kind: 'point', x: 100, y: 0 }, checkpoints: [{ x: 50, y: 0, arrival: 15, departure: 15 }] }], shapes));
    expect(routes[0]!.points.some(point => point.x === 50 && point.y === 0)).toBe(false);
  });

  it('releases every native copy it extracts from a finished route', () => {
    const connector = (avoid.ConnRef as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = connector.displayRoute as (this: unknown) => { at(index: number): unknown; isDeleted(): boolean };
    const handles: { isDeleted(): boolean }[] = [];
    connector.displayRoute = function display(this: unknown) {
      const route = original.call(this);
      handles.push(route);
      const at = route.at.bind(route);
      route.at = (index: number): unknown => { const point = at(index) as { isDeleted(): boolean }; handles.push(point); return point; };
      return route;
    };
    try {
      worker.routeBatch(avoid, batch([{ id: 'free', from: { kind: 'point', x: 0, y: 0 },
        to: { kind: 'point', x: 60, y: 0 }, checkpoints: [] }], []));
    } finally { connector.displayRoute = original; }
    // One polyline and one copy per extracted point, all released before the worker replies.
    expect(handles.length).toBeGreaterThan(2);
    expect(handles.filter(handle => !handle.isDeleted())).toEqual([]);
  });

  it('shares one initialization between simultaneous first calls on a cold cache', async () => {
    // Upstream `load()` only checks a finished instance, so two first calls could otherwise
    // instantiate two modules. The loader here stays pending until both callers have asked.
    let begin: (module: unknown) => void = () => undefined;
    const importing = new Promise<unknown>(resolve => { begin = resolve; });
    let imports = 0, loads = 0;
    const loader = (): Promise<unknown> => { imports++; return importing; };
    const key = `cold://${Math.random()}`;
    const first = worker.loadAvoid(key, `${key}/wasm`, loader);
    const second = worker.loadAvoid(key, `${key}/wasm`, loader);
    expect(first).toBe(second);
    expect(imports).toBe(1);
    const instance = { cold: true };
    begin({ AvoidLib: { load: (url: string) => { expect(url).toBe(`${key}/wasm`); loads++; return Promise.resolve(); },
      getInstance: () => instance } });
    expect(await first).toBe(instance);
    expect(await second).toBe(instance);
    expect([imports, loads]).toEqual([1, 1]);
  });

  it('caches one initialization promise per module and WASM pair', async () => {
    const first = worker.loadAvoid(avoidAssets.moduleUrl, avoidAssets.wasmUrl);
    const second = worker.loadAvoid(avoidAssets.moduleUrl, avoidAssets.wasmUrl);
    expect(first).toBe(second);
    expect(await first).toBe(avoid);
    // A failed load is evicted, so a corrected URL can still be loaded afterwards.
    const broken = worker.loadAvoid('./missing-module.mjs', avoidAssets.wasmUrl, () => Promise.reject(new Error('no module')));
    await expect(broken).rejects.toThrow(/no module/);
    await expect(worker.loadAvoid('./missing-module.mjs', avoidAssets.wasmUrl, () => Promise.reject(new Error('again')))).rejects.toThrow(/again/);
  });

  it('answers a malformed request with a failure instead of leaving the host waiting', async () => {
    const replies: unknown[] = [];
    await worker.handleRouteMessage({ id: 7, moduleUrl: avoidAssets.moduleUrl, wasmUrl: avoidAssets.wasmUrl,
      batch: batch([{ id: 'x', from: { kind: 'pin', shape: 'missing', classId: 1 }, to: { kind: 'point', x: 0, y: 0 }, checkpoints: [] }], []) },
    response => replies.push(response));
    expect(replies).toEqual([{ kind: 'portograph-routed', id: 7, ok: false,
      error: 'Connector endpoint references unknown obstacle missing' }]);
  });

  it('asks the same question about a visited checkpoint as the host does', () => {
    // The adapter re-solves a route the host would reject. It must therefore reach the host's own
    // answer on every polyline, tolerance included: a stricter worker re-solves a route the host
    // already accepts, and a looser one lets a dropped checkpoint through to the host.
    const point = (x: number, y: number): RouteCheckpoint => ({ x, y, arrival: ALL_DIRECTIONS, departure: ALL_DIRECTIONS });
    const straight = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const bent = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 0 }];
    const cases: [AvoidPoint[], RouteCheckpoint[]][] = [
      // Within the collision tolerance, so both must accept. A 1e-9 worker rejected this one.
      [straight, [point(50, 5e-8)]],
      [straight, [point(50, 5e-6)]],
      [straight, [point(50, 0)]],
      [straight, [point(120, 0)]],
      // Order along the route, not along one segment.
      [straight, [point(70, 0), point(30, 0)]],
      [straight, [point(30, 0), point(70, 0)]],
      [bent, [point(0, 50), point(100, 50)]],
      [bent, [point(100, 50), point(0, 50)]],
      [bent, [point(50, 50), point(50, 0)]],
      [bent, []],
      [[], [point(0, 0)]],
    ];
    for (const [points, checkpoints] of cases) {
      expect([points, checkpoints, worker.checkpointsVisited(points, checkpoints)])
        .toEqual([points, checkpoints, checkpointsHonoured(points, checkpoints)]);
    }
  });

  it('keeps a checkpoint whose direction mask this build cannot meet', () => {
    // A blind corridor around (100, 100), open at the top only: every route through the checkpoint
    // has to enter and leave through that one opening. The host names the entry side in screen
    // coordinates — `top`, DIRECTION_BITS.top — while this build names its two vertical sides the
    // other way round, so the mask is unsatisfiable and libavoid drops the whole checkpoint. The
    // point is a reservation the host verifies, so the adapter asks again without the mask.
    const walls = [
      { id: 'w-bottom', bounds: rect(70, 120, 60, 10) },
      { id: 'w-left', bounds: rect(70, 70, 10, 60) },
      { id: 'w-right', bounds: rect(120, 70, 10, 60) },
    ];
    // The third pair asks for an entry through the left side, which the walls make impossible in
    // any convention: the recovery is general, not a correction of the vertical bits alone.
    for (const [arrival, departure] of [[DIRECTION_BITS.top, ALL_DIRECTIONS], [ALL_DIRECTIONS, DIRECTION_BITS.top],
      [DIRECTION_BITS.left, ALL_DIRECTIONS]]) {
      const points = worker.routeBatch(avoid, batch([{ id: 'blind-corridor',
        from: { kind: 'point', x: 20, y: 20 }, to: { kind: 'point', x: 180, y: 20 },
        checkpoints: [{ x: 100, y: 100, arrival: arrival!, departure: departure! }] }], walls))[0]!.points;
      expect(points.some(point => point.x === 100 && point.y === 100)).toBe(true);
    }
  });
});

describe('router worker session', () => {
  const trivial: RouteBatch = { id: 'trivial', shapeBufferDistance: 0, parameters: {}, shapes: [],
    connectors: [{ id: 'free', from: { kind: 'point', x: 0, y: 0 }, to: { kind: 'point', x: 40, y: 0 }, checkpoints: [] }] };

  it('routes through a real worker and terminates it on every exit', async () => {
    let terminated = 0;
    const attempt: CreateRouteAttempt = () => {
      const created = createAvoidAttempt();
      const stop = created.worker.terminate.bind(created.worker);
      created.worker.terminate = (): void => { terminated++; stop(); };
      return created;
    };
    const routes = await withRouteSession(attempt, 20000, systemRouteClock, route => route(trivial));
    expect(routes[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(terminated).toBe(1);
    await expect(withRouteSession(attempt, 20000, systemRouteClock, () => Promise.reject(new Error('caller failed'))))
      .rejects.toThrow(/caller failed/);
    expect(terminated).toBe(2);
  });

  it('rejects every request once the session is disposed', async () => {
    const session = new RouteSession(createAvoidAttempt);
    session.dispose();
    session.dispose();
    await expect(session.route(trivial)).rejects.toThrow(/terminated/);
  });

  // Node's worker shim logs a module bootstrap failure instead of dispatching an error event, so
  // the budget is what ends this attempt; the browser factory gets a real error event.
  it('ends a worker that fails to bootstrap at the budget and terminates it', async () => {
    const attempt: CreateRouteAttempt = () => ({
      worker: spawnAvoidWorker('data:text/javascript,throw new Error("injected bootstrap failure")'),
      assets: avoidAssets,
    });
    const started = Date.now();
    await expect(withRouteSession(attempt, 400, systemRouteClock, route => route(trivial))).rejects.toBeInstanceOf(RouteDeadlineError);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('reports a worker failure message as the stage error', async () => {
    const failing: CreateRouteAttempt = () => {
      let listener: ((event: { data?: unknown }) => void) | undefined;
      const fake: RouteWorker = {
        postMessage: message => {
          const id = (message as { id: number }).id;
          setTimeout(() => listener?.({ data: { kind: 'portograph-routed', id, ok: false, error: 'router said no' } }), 0);
        },
        terminate: () => undefined,
        addEventListener: (type, next) => { if (type === 'message') listener = next; },
        removeEventListener: () => { listener = undefined; },
      };
      return { worker: fake, assets: avoidAssets };
    };
    await expect(withRouteSession(failing, 2000, systemRouteClock, route => route(trivial))).rejects.toThrow(/router said no/);
  });
});
