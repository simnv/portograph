import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { Point } from '../../src/model/geometry.js';
import type { CreateRouteAttempt, RouteWorker } from '../../src/route/worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

/**
 * Ticket 24. A route stage 8 cannot use is unusable, and one such route may not stop the sheet. Ticket
 * 21's fixture reproduced one through the real router (link-35's far stem tip lay on the edge of a
 * completed cover, so its routed gap did not meet its reserved endpoints); ticket 25 grows the gap under the far stem
 * (placement), so the fixture no longer rejects anything. The real router still answers every request
 * here, and the answer for link-35 alone is forged to end 30 px beside its port, which stitching
 * rejects with the same reason as before. The skipped-checkpoint case is forged in `route.test.ts`.
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-band-holds-the-group-that-set-its-edge.yaml', import.meta.url), 'utf8');
const REJECTED = 'link-35';
const REASON = /Routed gap on link-35 does not meet its reserved endpoints/;

/** The forged answer: every checkpoint is honoured, but the route ends 30 px beside the port it must reach. */
const forged = (id: string, points: Point[]): Point[] => id === `${REJECTED}#0`
  ? [...points, { x: points.at(-1)!.x + 30, y: points.at(-1)!.y }] : points;

/** The real router with link-35's answer forged, and a record of every answer it gave: one map of connector to points per request, in order. */
function recording(answers: Map<string, Point[]>[], requests: string[][] = []): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    const wrapped: RouteWorker = {
      postMessage: message => {
        const batch = (message as { batch?: { shapes?: { id: string }[] } }).batch;
        if (batch?.shapes) requests.push(batch.shapes.map(shape => shape.id));
        worker.postMessage(message);
      },
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => {
        if (type !== 'message') return worker.addEventListener(type, listener);
        worker.addEventListener(type, event => {
          const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
          const routes = data?.routes?.map(item => ({ ...item, points: forged(item.connector, item.points) }));
          if (routes) answers.push(new Map(routes.map(item => [item.connector, item.points])));
          listener(routes ? { ...event, data: { ...data, routes } } : event);
        });
      },
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
    return { worker: wrapped, assets: avoidAssets };
  };
}

/** The link a diagnostic is owned by. */
const linkOf = (item: { owners?: { kind: string; id?: string }[] }): string | undefined => item.owners![0]!.id;

const run = (createRouteAttempt: CreateRouteAttempt = recording([]), strictCheckpoints?: boolean): Promise<LayoutModel> =>
  layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt,
    ...(strictCheckpoints === undefined ? {} : { strictCheckpoints }) });

describe('a route that skips a required checkpoint removes its link and not the sheet', () => {
  it('throws under the strict option, as the router has always done', async () => {
    await expect(run(undefined, true)).rejects.toThrow(REASON);
  }, 120000);

  it('removes the links whose routes are unusable, names each one and why, and renders the rest', async () => {
    const model = await run();
    const removed = model.links.filter(link => link.removed === true).map(link => link.id);
    expect(removed).toContain(REJECTED);
    expect(model.removedLinks).toEqual(removed);
    for (const link of model.links) expect(link.path === undefined, link.id).toBe(removed.includes(link.id));

    // One warning per removed link, naming the link and carrying the reason.
    const found = model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED' || item.code === 'ROUTE_GAP_REJECTED');
    expect(found.map(item => linkOf(item))).toEqual(removed);
    for (const item of found) {
      expect(item.severity).toBe('warning');
      expect(item.message).toContain(`${linkOf(item)} was removed`);
    }
    const rejected = found.find(item => linkOf(item) === REJECTED)!;
    expect(rejected.code).toBe('ROUTE_GAP_REJECTED');
    expect(rejected.message).toMatch(/rejected \(Routed gap on link-35 does not meet its reserved endpoints\)/);

    // The score report counts them beside the other counters, and the sheet still renders and restores.
    expect(score(model).snapshot.counters.removedLinks).toBe(removed.length);
    expect(render(model)).toContain('<svg');
    expect(restoreFinalLayout(JSON.stringify(model)).removedLinks).toEqual(removed);
  }, 120000);

  it('leaves every link routed up to the rejected one on the route the router gave it in strict mode', async () => {
    const strict: Map<string, Point[]>[] = [], lenient: Map<string, Point[]>[] = [], requests: string[][] = [];
    await expect(run(recording(strict), true)).rejects.toThrow(REASON);
    await run(recording(lenient, requests));
    // A discarded route leaves no cover behind, so a batch after the rejected link's may route differently, and only those.
    const own = (id: string): boolean => id === REJECTED || id.startsWith(`${REJECTED}#`);
    const last = strict.findIndex(batch => [...batch.keys()].some(own));
    expect(last).toBeGreaterThanOrEqual(0);
    for (const [index, batch] of strict.slice(0, last + 1).entries()) {
      for (const [id, points] of batch) if (!own(id)) expect(lenient[index]!.get(id), id).toEqual(points);
    }
    // And the discarded route is no obstacle to any later request: no cover of the rejected link was pushed.
    const later = requests.slice(last + 1).flat().filter(id => id.startsWith(`routed:${REJECTED}#`));
    expect(requests.length).toBeGreaterThan(last + 1);
    expect(later).toEqual([]);
  }, 120000);
});
