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
 * Ticket 47. A router answer that crosses a reservation its link does not own, or leaves its port badly, is unusable like any
 * other: stitching rejects it (`ROUTE_GAP_REJECTED`) and stage 8 removes the one link. `validateRoutedPaths` keeps its throws
 * as assertions no router answer reaches. No real input reaches this, so both tests forge the answer for `link-8` of the
 * fixture ticket 46 uses: it detours through the box of the group label of tier 3, which link-8 does not own.
 */
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8');
const fixture = 'a-title-no-position-clears-leaves-the-leg-to-the-router.yaml';

/** start, first checkpoint, a jog left across the label of tier 3 (y 606..638), the second checkpoint, end. */
const through = (start: Point, first: Point, second: Point, end: Point): Point[] =>
  [start, first, { x: first.x, y: 622 }, { x: 150, y: 622 }, { x: 150, y: second.y }, second, end];

describe('a route through a foreign reservation removes its link and not the sheet (ticket 47)', () => {
  it('publishes the sheet with the offending link removed, every other link drawn and the validator passing', async () => {
    const forge = (points: Point[]): Point[] => through(points[0]!, points[1]!, points.at(-2)!, points.at(-1)!);
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
    const model = await layout(parse(text(fixture)), { createElkAttempt: createAttempt, createRouteAttempt: forging });
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.removedLinks).toEqual(['link-8']);
    const warning = model.diagnostics.find(item => item.code === 'ROUTE_GAP_REJECTED')!;
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('link-8 was removed');
    expect(warning.message).toContain('Routed path on link-8 enters reserved label:group:t3');
    for (const link of model.links) if (link.id !== 'link-8' && link.technique !== 'stub') expect(link.path, link.id).toBeDefined();
    expect(model.links.find(link => link.id === 'link-8')!.path).toBeUndefined();
    expect(() => validateRoutedPaths(model, true)).not.toThrow();
    expect(render(model)).toContain('<svg');
  }, 120000);

  it('rejects the forged answer, and one that leaves its port sideways, in tryStitch', async () => {
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(text(fixture)))))))));
    const item = planRoute(model).links.find(candidate => candidate.pieces.some(piece => piece.kind === 'gap'))!;
    const gap = item.pieces.find(piece => piece.kind === 'gap')!;
    if (gap.kind !== 'gap') throw new Error('unreachable');
    const [first, second] = item.connectors.find(connector => connector.id === gap.connector)!.checkpoints as unknown as [Point, Point];
    const { from, to } = gap;
    const routed = (points: Point[]) => tryStitch(model, item, new Map([[gap.connector, points]]));
    expect(routed(through(from, first, second, to))).toEqual({
      rejection: { link: item.link, code: 'ROUTE_GAP_REJECTED', reason: `Routed path on ${item.link} enters reserved label:group:t3` },
    });
    // Out of the port along its side instead of away from it: the stem is not perpendicular.
    const sideways = routed([from, { x: first.x + 20, y: from.y }, { x: first.x + 20, y: first.y }, first, second, to]);
    expect(sideways).toMatchObject({ rejection: { code: 'ROUTE_GAP_REJECTED' } });
  }, 120000);
});
