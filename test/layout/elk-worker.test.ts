import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { createWorkerElkAttempt, runElkAttempt, elkDeadlineMs, type ElkWorker } from '../../src/layout/elk-worker.js';
const require = createRequire(import.meta.url);
const { createWarmElk: warmElk } = require('../../runtime/warm-elk.cjs') as { createWarmElk: (create: typeof createWorkerElkAttempt, make: () => ElkWorker) => { attempt: () => ReturnType<typeof createWorkerElkAttempt>; warm(): void; close(): void } };
const createWarmElk = (make: () => ElkWorker) => warmElk(createWorkerElkAttempt, make);
const Worker = require('web-worker') as new (url: string) => ElkWorker;
const workerUrl = require.resolve('elkjs/lib/elk-worker.min.js');
const graph: ElkNode = { id: 'root', children: [{ id: 'n', width: 50, height: 35 }] };
export function realAttempt() { return createWorkerElkAttempt(new Worker(workerUrl)); }

describe('real ELK worker lifecycle', () => {
  it('layouts in a real worker and terminates exactly once on success', async () => {
    const attempt = realAttempt();
    const terminate = vi.spyOn(attempt, 'terminateWorker');
    const result = await runElkAttempt(graph, () => attempt, 3000);
    expect(result.children?.[0]?.width).toBe(50);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels a real no-reply worker and allows a fresh fallback worker', async () => {
    const worker = new Worker(workerUrl);
    worker.postMessage = () => {};
    const terminate = vi.spyOn(worker, 'terminate');
    const started = Date.now();
    await expect(runElkAttempt(graph, () => createWorkerElkAttempt(worker), 40)).rejects.toThrow('deadline');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect((await runElkAttempt(graph, realAttempt, 3000)).children?.[0]?.id).toBe('n');
  });
  it('terminates a worker that throws during layout', async () => {
    const attempt = { layout: () => Promise.reject(new Error('injected')), terminateWorker: vi.fn() };
    await expect(runElkAttempt(graph, () => attempt, 1000)).rejects.toThrow('injected');
    expect(attempt.terminateWorker).toHaveBeenCalledTimes(1);
  });
  it('applies the node-count deadline boundary', () => {
    expect([0, 300, 301, 1000].map(elkDeadlineMs)).toEqual([10000, 10000, 20000, 20000]);
  });
});

describe('one warm ELK worker for the attempts of a command', () => {
  const spawned = (): { made: ElkWorker[]; make: () => ElkWorker } => {
    const made: ElkWorker[] = [];
    return { made, make: () => { const worker = new Worker(workerUrl); made.push(worker); vi.spyOn(worker, 'terminate'); return worker; } };
  };
  it('keeps one worker across attempts and gives the layout a cold worker would give', async () => {
    const { made, make } = spawned();
    const warm = createWarmElk(make);
    warm.warm();
    expect(made).toHaveLength(1);
    const first = await runElkAttempt(graph, warm.attempt, 3000);
    const second = await runElkAttempt(graph, warm.attempt, 3000);
    const cold = await runElkAttempt(graph, realAttempt, 3000);
    expect(made).toHaveLength(1);
    expect(made[0]!.terminate).not.toHaveBeenCalled();
    // `$H` is the identity counter of the compiled Java in the reply; it grows with the layouts a worker has run, and ELK reads no order off it.
    const geometry = (node: ElkNode): string => JSON.stringify(node, (key, value: unknown) => (key === '$H' ? undefined : value));
    expect(geometry(first)).toBe(geometry(cold));
    expect(geometry(second)).toBe(geometry(cold));
    warm.close();
    expect(made[0]!.terminate).toHaveBeenCalledTimes(1);
  });
  it('gives a mixed history of graphs (A, B, C, A, B) the geometry a cold worker gives each', async () => {
    const chain = (n: number, size: number): ElkNode => ({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.randomSeed': '1' },
      children: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, width: size + i, height: 30 })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, sources: [`n${i}`], targets: [`n${i + 1}`] })) });
    const fan: ElkNode = { id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.randomSeed': '1' },
      children: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, width: 40 + 5 * i, height: 25 })),
      edges: ['b', 'c', 'd', 'e'].map(id => ({ id: `a-${id}`, sources: ['a'], targets: [id] })) };
    const history = [chain(6, 40), fan, chain(11, 55), chain(6, 40), fan];
    const geometry = (node: ElkNode): string => JSON.stringify(node, (key, value: unknown) => (key === '$H' ? undefined : value));
    const { make } = spawned();
    const warm = createWarmElk(make);
    for (const input of history) {
      const warmed = await runElkAttempt(structuredClone(input), warm.attempt, 5000);
      const cold = await runElkAttempt(structuredClone(input), realAttempt, 5000);
      expect(geometry(warmed)).toBe(geometry(cold));
    }
    warm.close();
  });
  it('starts the worker on the first attempt when warm() was not called', async () => {
    const { made, make } = spawned();
    const warm = createWarmElk(make);
    expect(made).toHaveLength(0);
    await runElkAttempt(graph, warm.attempt, 3000);
    expect(made).toHaveLength(1);
    warm.close();
  });
  it('terminates a worker whose layout times out and starts a new one for the next attempt', async () => {
    const { made, make } = spawned();
    const warm = createWarmElk(make);
    warm.warm();
    made[0]!.postMessage = () => {};
    await expect(runElkAttempt(graph, warm.attempt, 40)).rejects.toThrow('deadline');
    expect(made[0]!.terminate).toHaveBeenCalledTimes(1);
    expect((await runElkAttempt(graph, warm.attempt, 3000)).children?.[0]?.id).toBe('n');
    expect(made).toHaveLength(2);
    expect(made[1]!.terminate).not.toHaveBeenCalled();
    warm.close();
  });
  it('drops a worker whose layout fails and starts a new one for the next attempt', async () => {
    const { made, make } = spawned();
    let starts = 0;
    const failing = `data:application/javascript;base64,${Buffer.from('setTimeout(() => { throw new Error("injected worker failure"); }, 0);').toString('base64')}`;
    const warm = createWarmElk(() => (++starts === 1 ? new Worker(failing) : make()));
    await expect(runElkAttempt(graph, warm.attempt, 3000)).rejects.toThrow();
    expect((await runElkAttempt(graph, warm.attempt, 3000)).children?.[0]?.id).toBe('n');
    expect(starts).toBe(2);
    expect(made).toHaveLength(1);
    warm.close();
  });
});

describe('worker errors and invalid options', () => {
  it('rejects a real worker execution error before the deadline and disposes the worker', async () => {
    const worker = new Worker(`data:application/javascript;base64,${Buffer.from('setTimeout(() => { throw new Error("injected worker failure"); }, 0);').toString('base64')}`);
    const terminate = vi.spyOn(worker, 'terminate');
    const started = Date.now();
    await expect(runElkAttempt(graph, () => createWorkerElkAttempt(worker), 3000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects non-string option values before starting a worker', async () => {
    const invalid = { id: 'root', children: [{ id: 'n', layoutOptions: { 'elk.nodeSize.constraints': ['MINIMUM_SIZE'] } }] };
    const create = vi.fn(realAttempt);
    await expect(runElkAttempt(invalid as unknown as ElkNode, create, 3000)).rejects.toThrow('string');
    expect(create).not.toHaveBeenCalled();
  });
});
