import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { Point } from '../../src/model/geometry.js';
import type { CreateRouteAttempt, RouteWorker } from '../../src/route/worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { avoidAssets, createAvoidAttempt, spawnAvoidWorker } from './fixture.js';

/**
 * Ticket 24. A route that skips a required checkpoint is unusable, and one such route may not stop the
 * sheet. Ticket 21's fixture reproduces the skip through the real router: the far checkpoint of link-22
 * stands in a pocket 1 px wide, so libavoid drops it (ticket 14 comment, ticket 21).
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-band-holds-the-group-that-set-its-edge.yaml', import.meta.url), 'utf8');
const SKIPPED = 'link-22#0';

/** The real router, and a record of every answer it gave: one map of connector to points per request, in order. */
function recording(answers: Map<string, Point[]>[]): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    const wrapped: RouteWorker = {
      postMessage: message => worker.postMessage(message),
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => {
        if (type !== 'message') return worker.addEventListener(type, listener);
        worker.addEventListener(type, event => {
          const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
          if (data?.routes) answers.push(new Map(data.routes.map(item => [item.connector, item.points])));
          listener(event);
        });
      },
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
    return { worker: wrapped, assets: avoidAssets };
  };
}

/** The link a diagnostic is owned by. */
const linkOf = (item: { owners?: { kind: string; id?: string }[] }): string | undefined => item.owners![0]!.id;

const run = (createRouteAttempt: CreateRouteAttempt, strictCheckpoints?: boolean): Promise<LayoutModel> =>
  layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt,
    ...(strictCheckpoints === undefined ? {} : { strictCheckpoints }) });

describe('a route that skips a required checkpoint removes its link and not the sheet', () => {
  it('throws under the strict option, as the router has always done', async () => {
    await expect(run(createAvoidAttempt, true)).rejects.toThrow(/Router skipped a required checkpoint on link-22#0/);
  }, 120000);

  it('removes the links whose routes are unusable, names each one and why, and renders the rest', async () => {
    const model = await run(createAvoidAttempt);
    const removed = model.links.filter(link => link.removed === true).map(link => link.id);
    expect(removed).toContain('link-22');
    expect(model.removedLinks).toEqual(removed);
    for (const link of model.links) expect(link.path === undefined, link.id).toBe(removed.includes(link.id));

    // One warning per removed link, naming the link and carrying the reason; the skipped checkpoint also its coordinates and producer.
    const found = model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED' || item.code === 'ROUTE_GAP_REJECTED');
    expect(found.map(item => linkOf(item))).toEqual(removed);
    for (const item of found) {
      expect(item.severity).toBe('warning');
      expect(item.message).toContain(`${linkOf(item)} was removed`);
    }
    const skipped = found.find(item => linkOf(item) === 'link-22')!;
    expect(skipped.code).toBe('ROUTE_CHECKPOINT_SKIPPED');
    expect(skipped.message).toMatch(/checkpoint \(-?\d+(\.\d+)?, -?\d+(\.\d+)?\) of link-22#0, reserved by (stem|lane|entry):/);
    const rejected = found.filter(item => item.code === 'ROUTE_GAP_REJECTED');
    expect(rejected.length).toBeGreaterThan(0);
    for (const item of rejected) expect(item.message).toMatch(/rejected \(.+\)/);

    // The score report counts them beside the other counters, and the sheet still renders and restores.
    expect(score(model).snapshot.counters.removedLinks).toBe(removed.length);
    expect(render(model)).toContain('<svg');
    expect(restoreFinalLayout(JSON.stringify(model)).removedLinks).toEqual(removed);
  }, 120000);

  it('leaves every link routed up to link-22 on the route the router gave it in strict mode', async () => {
    const strict: Map<string, Point[]>[] = [], lenient: Map<string, Point[]>[] = [];
    await expect(run(recording(strict), true)).rejects.toThrow(/skipped a required checkpoint/);
    await run(recording(lenient));
    // A discarded route leaves no cover behind, so a batch after link-22's may route differently, and only that one.
    const last = strict.findIndex(batch => batch.has(SKIPPED));
    expect(last).toBeGreaterThanOrEqual(0);
    for (const [index, batch] of strict.slice(0, last + 1).entries()) {
      for (const [id, points] of batch) if (id !== SKIPPED) expect(lenient[index]!.get(id), id).toEqual(points);
    }
  }, 120000);
});
