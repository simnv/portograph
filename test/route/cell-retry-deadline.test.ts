import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBudget, layout, parse, restoreFinalLayout, RouteDeadlineError, serializeLayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';
import type { CreateRouteAttempt } from '../../src/route/worker.js';

/**
 * Field-2026-11 ticket 05, re-check of 05b (P1, retry timeout). The injected clock of the review: the first `cell-retry:` request fires the
 * pending timer, the route-session deadline, and is never sent. With 5,000 ms of command budget and a 1,200 ms session limit the command
 * has time left: the batch routes stand, and each retry still to run leaves its link removed with its batch rejection, its warning and the
 * cut mark (`ROUTE_CELL_RETRY_CUT`). With 800 ms of command budget the session limit is the command's deadline: a hard stop.
 */
const text = readFileSync(new URL('../../goldens/synthetic/two-links-retry-into-one-node-one-at-a-time.yaml', import.meta.url), 'utf8');

const run = (commandMs: number, fire: boolean) => {
  let ms = 0, current: { run: () => void; delay: number } | undefined, fired = false;
  const calls: string[] = [];
  const clock = {
    now: () => ms,
    setTimeout(callback: () => void, delay: number) { const handle = { run: callback, delay }; current = handle; return handle; },
    clearTimeout(handle: unknown) { if (current === handle) current = undefined; },
  };
  const createRouteAttempt: CreateRouteAttempt = () => {
    const attempt = createAvoidAttempt();
    return { assets: attempt.assets, worker: {
      postMessage: message => {
        const id = (message as { batch: { id: string } }).batch.id;
        calls.push(id);
        if (fire && !fired && id.startsWith('cell-retry:')) { fired = true; ms += current!.delay; current!.run(); return; }
        attempt.worker.postMessage(message);
      },
      terminate: () => attempt.worker.terminate(),
      addEventListener: (type, listener) => attempt.worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => attempt.worker.removeEventListener(type, listener),
    } };
  };
  const model = layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt, clock, budget: createBudget(commandMs, clock.now), routeBudgetMs: 1200 });
  return { model, calls, clock: () => ms };
};

describe('a route-session deadline during the cell retry (field-2026-11 ticket 05, re-check of 05b)', () => {
  it('control: with no deadline every link is drawn', async () => {
    const model = await run(5000, false).model;
    expect(model.removedLinks).toBeUndefined();
  }, 120000);

  it('keeps the batch routes and leaves the outstanding retries removed with their warnings; the model restores', async () => {
    const { model: pending, calls, clock } = run(5000, true);
    const model = await pending;
    expect(clock()).toBe(1200);
    expect(calls.slice(0, 2)).toEqual(['batch-0', 'cell-retry:link-6']);
    expect(model.removedLinks).toEqual(['link-6', 'link-7']);
    expect(model.links.filter(link => link.cellRetryCut === true).map(link => link.id)).toEqual(['link-6', 'link-7']);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_GAP_REJECTED' || item.code === 'ROUTE_CELL_RETRY_CUT').map(item => [item.code, item.message.split(' ')[0]])).toEqual([
      ['ROUTE_GAP_REJECTED', 'link-6'], ['ROUTE_CELL_RETRY_CUT', 'link-6'], ['ROUTE_GAP_REJECTED', 'link-7'], ['ROUTE_CELL_RETRY_CUT', 'link-7'],
    ]);
    for (const link of model.links) if (link.removed !== true) expect(link.path, link.id).toBeDefined();
    expect(restoreFinalLayout(serializeLayoutModel(model)).removedLinks).toEqual(['link-6', 'link-7']);
    // Round 2: the genuine cut restores only with its warnings (a warning is no proof of a deadline; it keeps the cut visible).
    const without = structuredClone(model);
    without.diagnostics = without.diagnostics.filter(item => !(item.code === 'ROUTE_CELL_RETRY_CUT' && item.message.startsWith('link-7 ')));
    expect(() => restoreFinalLayout(serializeLayoutModel(without))).toThrow('Removed link link-7 marks a cut cell retry without its ROUTE_CELL_RETRY_CUT warning');
  }, 120000);

  it('stops the command when the session deadline is the command deadline', async () => {
    const { model, calls, clock } = run(800, true);
    await expect(model).rejects.toThrow(RouteDeadlineError);
    expect(clock()).toBe(800);
    expect(calls).toEqual(['batch-0', 'cell-retry:link-6']);
  }, 120000);
});
