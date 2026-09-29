import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, layout, lanes, parse, render, rows } from '../../src/index.js';
import type { Point } from '../../src/model/geometry.js';
import { planRoute } from '../../src/route/plan.js';
import { tryStitch } from '../../src/route/paths.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import type { CreateRouteAttempt, RouteWorker } from '../../src/route/worker.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

/**
 * Ticket 46. A router answer that walks back along a run it already drew is unusable like any other: stitching
 * rejects it (`ROUTE_GAP_REJECTED`) and stage 8 removes the one link. `validateRoutedPaths` keeps its throw as an
 * assertion that no router answer can reach. Ticket 50: the router is asked for residual parts only, so both tests
 * forge the answer on a fixture whose plan still leaves links to it (`a-claim-lies-on-a-cover-edge`: three links are
 * `leg-blocked`, a leg under a group label).
 */
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8');

describe('a retracing route removes its link and not the sheet (ticket 46)', () => {
  it('publishes the sheet with the retracing link removed, every other link drawn and the validator passing', async () => {
    // On main `a-retracing-route-removes-its-link.yaml` fails with `PIPELINE_FAILED: Routed path on link-6 retraces itself`. Ticket 50
    // reserves every part of that fixture, so the router is never asked and cannot retrace. The mechanism is the same for any routed
    // link: the real router answers everything here, and the answer for `link-8` is forged to walk back down the column it has
    // drawn (A-B-A-C).
    const forge = (points: Point[]): Point[] => {
      const [start, tip, ...rest] = points;
      return [start!, tip!, { x: tip!.x, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 20 },
        { x: tip!.x, y: tip!.y + 20 }, { x: tip!.x, y: tip!.y }, ...rest];
    };
    const forging: CreateRouteAttempt = () => {
      const worker = spawnAvoidWorker(avoidAssets.workerUrl);
      const wrapped: RouteWorker = {
        postMessage: message => worker.postMessage(message),
        terminate: () => worker.terminate(),
        addEventListener: (type, listener) => {
          if (type !== 'message') return worker.addEventListener(type, listener);
          worker.addEventListener(type, event => {
            const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
            const routes = data?.routes?.map(item => item.connector.startsWith('link-8#') ? { ...item, points: forge(item.points) } : item);
            listener(routes ? { ...event, data: { ...data, routes } } : event);
          });
        },
        removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
      };
      return { worker: wrapped, assets: avoidAssets };
    };
    const model = await layout(parse(text('a-title-no-position-clears-leaves-the-leg-to-the-router.yaml')), { createElkAttempt: createAttempt, createRouteAttempt: forging });
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.removedLinks).toEqual(['link-8']);
    const warning = model.diagnostics.find(item => item.code === 'ROUTE_GAP_REJECTED')!;
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('link-8 was removed');
    expect(warning.message).toContain('Routed path on link-8 retraces itself');
    for (const link of model.links) if (link.id !== 'link-8' && link.technique !== 'stub') expect(link.path, link.id).toBeDefined();
    expect(model.links.find(link => link.id === 'link-8')!.path).toBeUndefined();
    expect(() => validateRoutedPaths(model, true)).not.toThrow();
    expect(render(model)).toContain('<svg');
  }, 120000);

  it('rejects a forged A-B-A-C answer in tryStitch', async () => {
    // The model as stage 8 receives it: every link a rule left to the router still has no path.
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(text('a-title-no-position-clears-leaves-the-leg-to-the-router.yaml')))))))));
    const plan = planRoute(model);
    const item = plan.links.find(candidate => candidate.pieces.some(piece => piece.kind === 'gap'))!;
    const gap = item.pieces.find(piece => piece.kind === 'gap')!;
    if (gap.kind !== 'gap') throw new Error('unreachable');
    const { from, to } = gap;
    // Pass both checkpoints in order, but loop below the jog's row and come back up the column already drawn: A-B, a
    // detour, then A again and on to C. (A bare out-and-back would be collapsed by `simplify`, so the loop keeps its corners.)
    const [first, second] = item.connectors.find(connector => connector.id === gap.connector)!.checkpoints as unknown as [Point, Point];
    const row = (first.y + second.y) / 2;
    const points: Point[] = [from, first, { x: first.x, y: row + 40 }, { x: first.x + 30, y: row + 40 }, { x: first.x + 30, y: row + 20 },
      { x: first.x, y: row + 20 }, { x: first.x, y: row }, { x: second.x, y: row }, second, to];
    const done = tryStitch(model, item, new Map([[gap.connector, points]]));
    expect(done).toEqual({ rejection: { link: item.link, code: 'ROUTE_GAP_REJECTED', reason: `Routed path on ${item.link} retraces itself` } });
  }, 120000);
});
