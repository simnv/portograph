import type { RouteBatch, RoutedConnector } from './types.js';

/** The common subset of a native Worker and `web-worker`. No DOM type reaches declarations. */
export interface RouteWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void): void;
}
/** URLs the worker loads. The host resolves them; the worker never inspects its environment. */
export interface RouteAssets { moduleUrl: string; wasmUrl: string }
export interface RouteAttempt { worker: RouteWorker; assets: RouteAssets }
export type CreateRouteAttempt = () => RouteAttempt;
export interface RouteClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
const host = globalThis as unknown as {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  location?: { href: string };
  URL: new (url: string, base?: string) => { href: string };
  Worker?: new (url: string, options?: { type: 'module' }) => RouteWorker;
};
export const systemRouteClock: RouteClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => host.setTimeout(callback, delay),
  clearTimeout: handle => host.clearTimeout(handle),
};

export const ROUTE_REQUEST = 'portograph-route';
export const ROUTE_RESPONSE = 'portograph-routed';
/** Default whole-stage budget; stage 17 injects whatever remains of the pipeline budget. */
export const ROUTE_BUDGET_MS = 30000;

export class RouteDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) { super(`Routing deadline after ${deadlineMs} ms`); this.name = 'RouteDeadlineError'; }
}

interface RouteResponse { kind?: string; id?: number; ok?: boolean; routes?: RoutedConnector[]; error?: string }

/**
 * One worker for one diagram. `processTransaction()` is synchronous WASM work, so the deadline is
 * enforced by terminating a real thread; a same-thread race could not interrupt it.
 */
export class RouteSession {
  private readonly attempt: RouteAttempt;
  private readonly pending = new Map<number, { resolve: (routes: RoutedConnector[]) => void; reject: (error: Error) => void }>();
  private next = 1;
  private failure: Error | undefined;
  private closed = false;
  private readonly onMessage = (event: { data?: unknown }): void => {
    const message = event.data as RouteResponse | undefined;
    if (!message || message.kind !== ROUTE_RESPONSE || typeof message.id !== 'number') return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.ok && Array.isArray(message.routes)) waiting.resolve(message.routes);
    else waiting.reject(new Error(message.error ?? 'Router worker failed'));
  };
  private readonly onError = (event: { message?: string }): void => {
    this.failure = new Error(event.message ?? 'Router worker bootstrap or message failure');
    for (const waiting of this.pending.values()) waiting.reject(this.failure);
    this.pending.clear();
  };

  constructor(createAttempt: CreateRouteAttempt) {
    this.attempt = createAttempt();
    try {
      this.attempt.worker.addEventListener('message', this.onMessage);
      this.attempt.worker.addEventListener('error', this.onError);
      this.attempt.worker.addEventListener('messageerror', this.onError);
    } catch (error) { this.dispose(); throw error; }
  }

  route(batch: RouteBatch): Promise<RoutedConnector[]> {
    if (this.closed) return Promise.reject(new Error('Router worker is terminated'));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.next++;
    return new Promise<RoutedConnector[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.attempt.worker.postMessage({ kind: ROUTE_REQUEST, id, batch, ...this.attempt.assets });
      } catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.attempt.worker.removeEventListener('message', this.onMessage);
      this.attempt.worker.removeEventListener('error', this.onError);
      this.attempt.worker.removeEventListener('messageerror', this.onError);
    } finally {
      this.attempt.worker.terminate();
      for (const waiting of this.pending.values()) waiting.reject(new Error('Router worker is terminated'));
      this.pending.clear();
    }
  }
}

/**
 * Run one bounded routing session. The whole stage shares one budget and one worker; every exit —
 * success, failure or deadline — terminates that worker, so no thread survives a rejected stage
 * and a worker that never replies cannot hold the pipeline.
 */
export async function withRouteSession<T>(createAttempt: CreateRouteAttempt, budgetMs: number, clock: RouteClock,
  run: (route: (batch: RouteBatch) => Promise<RoutedConnector[]>) => Promise<T>): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Route budget must be positive and finite');
  const session = new RouteSession(createAttempt);
  let timer: unknown;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      // Reject with the deadline first: disposal also rejects the pending request, and the caller
      // needs to know the budget expired rather than that the worker vanished.
      timer = clock.setTimeout(() => { try { reject(new RouteDeadlineError(budgetMs)); } finally { session.dispose(); } }, budgetMs);
    });
    return await Promise.race([run(batch => session.route(batch)), deadline]);
  } finally {
    clock.clearTimeout(timer);
    session.dispose();
  }
}

/**
 * Serve `portograph-avoid-worker.mjs`, `portograph-avoid.mjs` and `portograph-libavoid.wasm`
 * beside the page, or pass their URLs. Asset locations are always explicit: nothing is inferred
 * from `cwd` or `document.currentScript`, so the page must be served over HTTP.
 */
export function createBrowserRouteFactory(options: Partial<RouteAssets & { workerUrl: string }> = {}): CreateRouteAttempt {
  const base = host.location?.href;
  const resolve = (url: string, against?: string): string => {
    try { return against === undefined ? new host.URL(url).href : new host.URL(url, against).href; }
    catch { throw new Error(`Router asset ${url} must be an absolute URL on a page without a location`); }
  };
  const workerUrl = resolve(options.workerUrl ?? './portograph-avoid-worker.mjs', base);
  const assets: RouteAssets = {
    moduleUrl: resolve(options.moduleUrl ?? './portograph-avoid.mjs', workerUrl),
    wasmUrl: resolve(options.wasmUrl ?? './portograph-libavoid.wasm', workerUrl),
  };
  return () => {
    if (host.Worker === undefined) throw new Error('A real Worker is required; Node callers must supply createNodeRouteFactory()');
    return { worker: new host.Worker(workerUrl, { type: 'module' }), assets };
  };
}

/** Build a factory from already-resolved asset locations; Node and the browser share this seam. */
export function createRouteFactory(assets: RouteAssets & { workerUrl: string }, spawn: (url: string) => RouteWorker): CreateRouteAttempt {
  for (const [name, value] of Object.entries(assets)) {
    if (typeof value !== 'string' || !value.length) throw new Error(`Router asset ${name} is missing`);
  }
  return () => ({ worker: spawn(assets.workerUrl), assets: { moduleUrl: assets.moduleUrl, wasmUrl: assets.wasmUrl } });
}
