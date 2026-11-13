import { describe, expect, it, vi } from 'vitest';
import {
  createRouteFactory,
  createWarmRouteFactory,
  RouteDeadlineError,
  ROUTE_RESPONSE,
  systemRouteClock,
  withRouteSession,
  type CreateRouteAttempt,
  type RouteWorker,
} from '../../src/route/worker.js';
import type { RouteBatch } from '../../src/route/types.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

const trivialBatch = (id = 'trivial'): RouteBatch => ({
  id,
  shapeBufferDistance: 0,
  parameters: {},
  shapes: [],
  connectors: [{ id: 'free', from: { kind: 'point', x: 0, y: 0 }, to: { kind: 'point', x: 40, y: 0 }, checkpoints: [] }],
});

describe('createWarmRouteFactory', () => {
  it('reuses one real worker across sequential sessions and terminates on close()', async () => {
    const workers: RouteWorker[] = [];
    const cold = createRouteFactory(avoidAssets, url => {
      const worker = spawnAvoidWorker(url);
      vi.spyOn(worker, 'terminate');
      workers.push(worker);
      return worker;
    });
    const warm = createWarmRouteFactory(cold);
    warm.warm();
    expect(workers).toHaveLength(1);

    const first = await withRouteSession(warm.attempt, 20000, systemRouteClock, route => route(trivialBatch('first')));
    const second = await withRouteSession(warm.attempt, 20000, systemRouteClock, route => route(trivialBatch('second')));
    expect(first[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(second[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();

    warm.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    warm.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('starts lazily on first attempt when warm() is not called', async () => {
    const workers: RouteWorker[] = [];
    const cold = createRouteFactory(avoidAssets, url => {
      const worker = spawnAvoidWorker(url);
      vi.spyOn(worker, 'terminate');
      workers.push(worker);
      return worker;
    });
    const warm = createWarmRouteFactory(cold);
    expect(workers).toHaveLength(0);
    await withRouteSession(warm.attempt, 20000, systemRouteClock, route => route(trivialBatch()));
    expect(workers).toHaveLength(1);
    warm.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates and replaces the worker when a session times out (RouteDeadlineError)', async () => {
    const workers: RouteWorker[] = [];
    const cold = createRouteFactory(avoidAssets, url => {
      const worker = spawnAvoidWorker(url);
      vi.spyOn(worker, 'terminate');
      workers.push(worker);
      return worker;
    });
    const warm = createWarmRouteFactory(cold);
    warm.warm();
    // Silence the first worker so its request stays in flight until the deadline expires.
    workers[0]!.postMessage = () => undefined;

    await expect(withRouteSession(warm.attempt, 40, systemRouteClock, route => route(trivialBatch('stalled'))))
      .rejects.toBeInstanceOf(RouteDeadlineError);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);

    const recovered = await withRouteSession(warm.attempt, 20000, systemRouteClock, route => route(trivialBatch('recovered')));
    expect(recovered[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(workers).toHaveLength(2);
    expect(workers[1]!.terminate).not.toHaveBeenCalled();

    warm.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates and replaces the worker on ok === false response or worker error event', async () => {
    type Listener = (event: { data?: unknown; message?: string }) => void;
    const makeFake = (mode: 'fail-response' | 'error-event' | 'ok'): RouteWorker => {
      const listeners = new Map<string, Set<Listener>>();
      return {
        postMessage(message: unknown) {
          const id = (message as { id: number }).id;
          setTimeout(() => {
            if (mode === 'error-event') {
              for (const fn of listeners.get('error') ?? []) fn({ message: 'boom' });
            } else if (mode === 'fail-response') {
              for (const fn of listeners.get('message') ?? []) fn({ data: { kind: ROUTE_RESPONSE, id, ok: false, error: 'bad batch' } });
            } else {
              for (const fn of listeners.get('message') ?? []) fn({ data: { kind: ROUTE_RESPONSE, id, ok: true, routes: [{ connector: 'free', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }] } });
            }
          }, 0);
        },
        terminate: vi.fn(),
        addEventListener(type, fn) {
          let set = listeners.get(type);
          if (!set) { set = new Set(); listeners.set(type, set); }
          set.add(fn);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      };
    };

    const modes: ('fail-response' | 'error-event' | 'ok')[] = ['fail-response', 'error-event', 'ok'];
    const made: RouteWorker[] = [];
    const cold: CreateRouteAttempt = () => {
      const worker = makeFake(modes.shift()!);
      made.push(worker);
      return { worker, assets: avoidAssets };
    };
    const warm = createWarmRouteFactory(cold);

    await expect(withRouteSession(warm.attempt, 2000, systemRouteClock, route => route(trivialBatch())))
      .rejects.toThrow(/bad batch/);
    expect(made).toHaveLength(1);
    expect(made[0]!.terminate).toHaveBeenCalledTimes(1);

    await expect(withRouteSession(warm.attempt, 2000, systemRouteClock, route => route(trivialBatch())))
      .rejects.toThrow(/boom/);
    expect(made).toHaveLength(2);
    expect(made[1]!.terminate).toHaveBeenCalledTimes(1);

    const ok = await withRouteSession(warm.attempt, 2000, systemRouteClock, route => route(trivialBatch()));
    expect(ok[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(made).toHaveLength(3);
    expect(made[2]!.terminate).not.toHaveBeenCalled();

    warm.close();
    expect(made[2]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('spawns a cold fallback worker when two sessions overlap concurrently', async () => {
    const workers: RouteWorker[] = [];
    const cold = createRouteFactory(avoidAssets, url => {
      const worker = spawnAvoidWorker(url);
      vi.spyOn(worker, 'terminate');
      workers.push(worker);
      return worker;
    });
    const warm = createWarmRouteFactory(cold);

    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withRouteSession(warm.attempt, 20000, systemRouteClock, async route => {
      const res = await route(trivialBatch('first'));
      await gate;
      return res;
    });
    const second = withRouteSession(warm.attempt, 20000, systemRouteClock, async route => {
      try {
        return await route(trivialBatch('second'));
      } finally {
        releaseFirst();
      }
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(b[0]!.points.at(-1)).toEqual({ x: 40, y: 0 });
    expect(workers).toHaveLength(2);
    // Shared worker stays alive; concurrent cold fallback was terminated when its session ended.
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);

    // Subsequent sequential call reuses the original shared worker.
    await withRouteSession(warm.attempt, 20000, systemRouteClock, route => route(trivialBatch('third')));
    expect(workers).toHaveLength(2);

    warm.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});
