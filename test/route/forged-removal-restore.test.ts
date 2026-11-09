import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreFinalLayout } from '../../src/internal.js';
import type { Point } from '../../src/model/geometry.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { planRoute } from '../../src/route/plan.js';
import { tryStitch } from '../../src/route/paths.js';
import { preRoute } from '../../src/route/validate.js';
import type { CreateRouteAttempt, RouteWorker } from '../../src/route/worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { avoidAssets, spawnAvoidWorker } from './fixture.js';

/**
 * Decision-review ticket 14. A removed link stores the router answer stage 8 judged (`rejectedRoute`), and publication and restore
 * judge it again (`tryStitch` on `preRoute`). A removal forged on a finished layout (path dropped, `removed`, `removedLinks`, a
 * `ROUTE_GAP_REJECTED` warning) is refused by name, with or without a stored answer; a removal stage 8 made restores.
 * The corpus sheet `three-lateral-legs-stay-with-the-router` leaves `link-10` to the router.
 */
const text = readFileSync(new URL('../../goldens/synthetic/three-lateral-legs-stay-with-the-router.yaml', import.meta.url), 'utf8');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const restore = (model: LayoutModel): LayoutModel => restoreFinalLayout(JSON.stringify(model));
const LINK = 'link-10';

/**
 * A real worker; every answer it sends is recorded as sent, and the answers for `LINK` are rewritten by `rewrite`. One layout routes
 * more than once (trial rounds on other placements), so a connector collects every answer it was given.
 */
function router(seen: Map<string, Point[][]>, rewrite: (points: Point[]) => Point[] = points => points): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    const wrapped: RouteWorker = {
      postMessage: message => worker.postMessage(message),
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => {
        if (type !== 'message') return worker.addEventListener(type, listener);
        worker.addEventListener(type, event => {
          const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
          for (const item of data?.routes ?? []) seen.set(item.connector, [...seen.get(item.connector) ?? [], clone(item.points)]);
          const routes = data?.routes?.map(item => item.connector.startsWith(`${LINK}#`) ? { ...item, points: rewrite(item.points) } : item);
          listener(routes ? { ...event, data: { ...data, routes } } : event);
        });
      },
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
    return { worker: wrapped, assets: avoidAssets };
  };
}

/** Walk back down the column already drawn (A-B-A-C, ticket 46): the stitch rejects it. */
const retrace = (points: Point[]): Point[] => {
  const [start, tip, ...rest] = points;
  return [start!, tip!, { x: tip!.x, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 40 }, { x: tip!.x + 30, y: tip!.y + 20 },
    { x: tip!.x, y: tip!.y + 20 }, { x: tip!.x, y: tip!.y }, ...rest];
};

/** `model` with `LINK` removed as a forger writes it: no path, the flag, the list and the warning; `answer` is the stored record. */
function forged(model: LayoutModel, answer?: { connector: string; points: Point[] }[]): LayoutModel {
  const copy = clone(model), link = copy.links.find(item => item.id === LINK)!;
  delete link.path; delete link.stubCandidate;
  link.removed = true;
  if (answer !== undefined) link.rejectedRoute = answer;
  copy.removedLinks = [LINK];
  copy.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_GAP_REJECTED',
    message: `${LINK} was removed: its route was rejected (Routed path on ${LINK} retraces itself).`, owners: [{ ...link.owner }] });
  return copy;
}

/** The answer the router gave on the published placement: of every answer recorded, the one that stitches `LINK` into a path there. */
function usable(model: LayoutModel, seen: Map<string, Point[][]>): { connector: string; points: Point[] }[] {
  const view = preRoute(model), item = planRoute(view).links.find(candidate => candidate.link === LINK)!;
  const gaps = item.pieces.flatMap(piece => piece.kind === 'gap' ? [piece.connector] : []);
  // One routed gap on this sheet; each recorded answer is tried alone.
  expect(gaps.length).toBe(1);
  const found = seen.get(gaps[0]!)!.find(points => 'path' in tryStitch(view, item, new Map([[gaps[0]!, points]])));
  expect(found).toBeDefined();
  return [{ connector: gaps[0]!, points: found! }];
}

describe('restore refuses a forged link removal (decision-review ticket 14)', () => {
  const seen = new Map<string, Point[][]>();
  let memo: Promise<LayoutModel> | undefined;
  const drawn = (): Promise<LayoutModel> => memo ??= layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: router(seen) });
  const gaps = async (): Promise<string[]> => planRoute(preRoute(await drawn())).links.find(item => item.link === LINK)!
    .pieces.flatMap(piece => piece.kind === 'gap' ? [piece.connector] : []);

  it('restores the drawn sheet, and the link has a routed gap the router answered', async () => {
    const model = await drawn();
    expect(model.removedLinks).toBeUndefined();
    expect(() => restore(model)).not.toThrow();
    expect((await gaps()).length).toBeGreaterThan(0);
    for (const id of await gaps()) expect(seen.has(id), id).toBe(true);
  }, 120000);

  it('refuses a removal with no stored answer, though the warning names it (R5)', async () => {
    const model = await drawn();
    expect(() => restore(forged(model))).toThrow(`Removed link ${LINK} carries no rejected router answer`);
  }, 120000);

  it('refuses a removal whose stored answer is the usable one the router gave', async () => {
    const model = await drawn();
    expect(() => restore(forged(model, usable(model, seen)))).toThrow(`Removed link ${LINK} has a usable stored route; its removal is not reproduced`);
  }, 120000);

  it('refuses an empty answer for a link with a routed gap, and an answer for a gap that is not the link\'s', async () => {
    const model = await drawn();
    expect(() => restore(forged(model, []))).toThrow(`Removed link ${LINK} cannot be judged again: Router returned no route for`);
    const foreign = [{ connector: 'link-11#0', points: [{ x: 0, y: 0 }, { x: 0, y: 10 }] }];
    expect(() => restore(forged(model, foreign))).toThrow(`Removed link ${LINK} stores a router answer that is not one for its planned gaps`);
  }, 120000);

  it('restores a removal stage 8 made, and refuses the same record moved or swapped for a usable answer', async () => {
    const genuine = new Map<string, Point[][]>();
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: router(genuine, retrace) });
    expect(model.removedLinks).toEqual([LINK]);
    const link = model.links.find(item => item.id === LINK)!;
    expect(link.rejectedRoute!.map(item => item.connector)).toEqual(await gaps());
    for (const item of link.rejectedRoute!) expect(genuine.get(item.connector)!.map(retrace)).toContainEqual(item.points);
    expect(restore(model).removedLinks).toEqual([LINK]);
    // The record on a link that is drawn, and the removed link's record swapped for the answer the router really gave.
    const moved = clone(model);
    moved.links.find(item => item.id === 'link-11')!.rejectedRoute = clone(link.rejectedRoute!);
    expect(() => restore(moved)).toThrow('Link link-11 stores a rejected router answer but is not removed');
    const swapped = clone(model);
    swapped.links.find(item => item.id === LINK)!.rejectedRoute = usable(model, genuine);
    expect(() => restore(swapped)).toThrow(`Removed link ${LINK} has a usable stored route; its removal is not reproduced`);
  }, 120000);
});
