import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { createWorkerElkAttempt, runElkAttempt, elkDeadlineMs, type ElkWorker } from '../../src/layout/elk-worker.js';
const require = createRequire(import.meta.url);
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
