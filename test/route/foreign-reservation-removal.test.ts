import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
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
 * as assertions no router answer reaches. No real input reaches this, so both tests forge the answer for `link-10` of the
 * fixture ticket 46 uses: it detours through the box of the group label of tier 3, which link-10 does not own.
 */
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8');
const fixture = 'three-lateral-legs-stay-with-the-router.yaml';

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
            const routes = data?.routes?.map(item => item.connector.startsWith('link-10#') ? { ...item, points: forge(item.points) } : item);
            listener(routes ? { ...event, data: { ...data, routes } } : event);
          });
        },
        removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
      };
      return { worker: wrapped, assets: avoidAssets };
    };
    const model = await layout(parse(text(fixture)), { createElkAttempt: createAttempt, createRouteAttempt: forging });
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.removedLinks).toEqual(['link-10']);
    const warning = model.diagnostics.find(item => item.code === 'ROUTE_GAP_REJECTED')!;
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('link-10 was removed');
    expect(warning.message).toContain('Routed path on link-10 enters reserved label:group:t3');
    for (const link of model.links) if (link.id !== 'link-10' && link.technique !== 'stub') expect(link.path, link.id).toBeDefined();
    expect(model.links.find(link => link.id === 'link-10')!.path).toBeUndefined();
    expect(() => validateRoutedPaths(model, true)).not.toThrow();
    expect(render(model)).toContain('<svg');
  }, 120000);

  it('rejects the forged answer, and one that leaves its port sideways, in tryStitch', async () => {
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(text(fixture)))))))));
    const item = planRoute(model).links.find(candidate => candidate.link === 'link-10' && candidate.pieces.some(piece => piece.kind === 'gap'))!;
    const gap = item.pieces.find(piece => piece.kind === 'gap')!;
    if (gap.kind !== 'gap') throw new Error('unreachable');
    const [first, second] = item.connectors.find(connector => connector.id === gap.connector)!.checkpoints as unknown as [Point, Point];
    const { from, to } = gap;
    const routed = (points: Point[]) => tryStitch(model, item, new Map([[gap.connector, points]]));
    expect(routed(through(from, first, second, to))).toMatchObject({
      rejection: { link: item.link, code: 'ROUTE_GAP_REJECTED', reason: `Routed path on ${item.link} enters reserved label:group:t3` },
    });
    // Orthogonal detours clear of every reservation, so only the stem checks can refuse them. The port of link-10 is lateral (`right`): the
    // detour runs down right of the title of t3 and under it, to the second checkpoint.
    const title = model.labels.find(label => label.id === 'label:group:t3')!.bounds!, clear = (title.y + title.height + 10 + second.y) / 2;
    const side = title.x - 20;
    const rest = (y: number): Point[] => [{ x: first.x, y }, first, { x: side, y: first.y }, { x: side, y: clear }, { x: second.x, y: clear }, second, to];
    // Out of the port along its side instead of away from it: the stem is not perpendicular.
    expect(routed([from, { x: from.x, y: from.y + 20 }, ...rest(from.y + 20)])).toMatchObject({
      rejection: { link: item.link, code: 'ROUTE_GAP_REJECTED', reason: `Port stem on ${item.link} does not leave its side perpendicular` },
    });
    // Away from the port, but 5 px before the jog: shorter than the reserved entry.
    const below = [{ x: first.x, y: from.y + 30 }, { x: side, y: from.y + 30 }, { x: side, y: clear }, { x: second.x, y: clear }, second, to];
    expect(routed([from, { x: from.x + 5, y: from.y }, { x: from.x + 5, y: from.y - 20 }, { x: first.x, y: from.y - 20 }, first, ...below])).toMatchObject({
      rejection: { link: item.link, code: 'ROUTE_GAP_REJECTED', reason: `Port stem on ${item.link} is shorter than its reserved entry` },
    });
  }, 120000);
});
