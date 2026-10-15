import ElkImport from 'elkjs/lib/elk-api.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';

export interface ElkAttempt {
  layout(graph: ElkNode): Promise<ElkNode>;
  terminateWorker(): void;
}
export type CreateElkAttempt = () => ElkAttempt;

/** The common subset of native Worker and web-worker. No DOM types reach declarations. */
export interface ElkWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: { message?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { message?: string }) => void): void;
}
export interface ElkClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
const host = globalThis as unknown as {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  Worker?: new (url: string) => ElkWorker;
};
export const systemElkClock: ElkClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => host.setTimeout(callback, delay),
  clearTimeout: handle => host.clearTimeout(handle),
};

// elkjs declares an ESM default for its CJS constructor. This narrow bridge also works in NodeNext.
const ELK = ElkImport as unknown as new (options: { workerFactory: () => ElkWorker }) => ElkAttempt;

/** Wrap an already-created real worker; bootstrap and message errors reject the active layout. */
export function createWorkerElkAttempt(worker: ElkWorker): ElkAttempt {
  let rejectWorker: ((error: Error) => void) | undefined;
  let failure: Error | undefined;
  let terminated = false;
  const onError = (event: { message?: string }): void => {
    failure = new Error(event.message ?? 'ELK worker bootstrap or message failure');
    rejectWorker?.(failure);
  };
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onError);
  const terminateWorker = (): void => {
    if (terminated) return;
    terminated = true;
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onError);
    worker.terminate();
  };
  let elk: ElkAttempt;
  try { elk = new ELK({ workerFactory: () => worker }); }
  catch (error) { terminateWorker(); throw error; }
  return {
    layout(graph) {
      if (terminated) return Promise.reject(new Error('ELK worker is terminated'));
      if (failure) return Promise.reject(failure);
      return Promise.race([
        elk.layout(graph),
        new Promise<ElkNode>((_resolve, reject) => { rejectWorker = reject; }),
      ]);
    },
    terminateWorker,
  };
}

/**
 * One ELK worker for the attempts of one command. Starting a worker costs a script load and a cold engine, and a command asks for several layouts. A layout runs on
 * a fresh graph and ELK keeps nothing from the one before, so the worker is kept between attempts (the output of every layout is the same on a warm worker).
 * `warm()` starts the worker ahead of the first attempt. A worker is dropped, and the next attempt starts a new one, when an attempt ends while a layout is still
 * running (the deadline of `runElkAttempt` terminates it), when a layout fails, or on `close()`. The state is the factory's own: nothing is shared between two factories.
 */
export interface WarmElk {
  /** The factory to pass as `createElkAttempt`. */
  attempt: CreateElkAttempt;
  /** Start the worker now, so that it boots while the caller does other work. A failure to start is left for the first attempt to raise. */
  warm(): void;
  /** Terminate the worker, if one is running. */
  close(): void;
}
export function createWarmElk(makeWorker: () => ElkWorker): WarmElk {
  let shared: ElkAttempt | undefined;
  const open = (): ElkAttempt => shared ??= createWorkerElkAttempt(makeWorker());
  const drop = (worker: ElkAttempt): void => {
    if (shared === worker) shared = undefined;
    worker.terminateWorker();
  };
  return {
    attempt: () => {
      const worker = open();
      let running = 0;
      return {
        layout(graph) {
          running++;
          return worker.layout(graph).then(
            result => { running--; return result; },
            (error: unknown) => { running--; drop(worker); throw error; });
        },
        terminateWorker() { if (running > 0) drop(worker); },
      };
    },
    warm() { try { open(); } catch { /* the first attempt raises it */ } },
    close() { if (shared !== undefined) drop(shared); },
  };
}

/** Serve the emitted portograph-elk-worker.js asset beside the page, or pass its absolute URL. */
export function createBrowserElkFactory(workerUrl = 'portograph-elk-worker.js'): CreateElkAttempt {
  return () => {
    if (host.Worker === undefined) throw new Error('A real Worker is required; Node callers must supply createNodeElkFactory()');
    return createWorkerElkAttempt(new host.Worker(workerUrl));
  };
}
export const elkDeadlineMs = (nodeCount: number): number => nodeCount <= 300 ? 10000 : 20000;
export class ElkDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) { super(`ELK deadline after ${deadlineMs} ms`); this.name = 'ElkDeadlineError'; }
}

/** Each attempt owns one worker and timer, including when layout throws synchronously. */
export async function runElkAttempt(graph: ElkNode, createAttempt: CreateElkAttempt,
  deadlineMs: number, clock: ElkClock = systemElkClock,
): Promise<ElkNode> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('ELK deadline must be positive and finite');
  validateOptions(graph);
  const attempt = createAttempt();
  let timer: unknown;
  let terminated = false;
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    attempt.terminateWorker();
  };
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => {
        try { terminate(); } finally { reject(new ElkDeadlineError(deadlineMs)); }
      }, deadlineMs);
    });
    return await Promise.race([attempt.layout(graph), deadline]);
  } finally {
    clock.clearTimeout(timer);
    terminate();
  }
}

function validateOptions(graph: ElkNode): void {
  for (const element of [graph, ...(graph.ports ?? []), ...(graph.edges ?? []), ...(graph.labels ?? [])]) {
    for (const [key, value] of Object.entries(element.layoutOptions ?? {})) {
      if (typeof value !== 'string') throw new TypeError(`ELK option ${key} must be a string`);
    }
  }
  for (const child of graph.children ?? []) validateOptions(child);
}
