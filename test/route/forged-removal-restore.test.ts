import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreFinalLayout } from '../../src/internal.js';
import type { Point } from '../../src/model/geometry.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { planRoute } from '../../src/route/plan.js';
import { skippedCheckpoint, tryStitch } from '../../src/route/paths.js';
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

/** The one routed gap of `LINK` on the published placement. */
function gapOf(model: LayoutModel): { connector: string; from: Point; to: Point } {
  const pieces = planRoute(preRoute(model)).links.find(item => item.link === LINK)!.pieces.flatMap(piece => piece.kind === 'gap' ? [piece] : []);
  expect(pieces.length).toBe(1);
  return pieces[0]!;
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
    expect(() => restore(forged(model))).toThrow(`Removed link ${LINK} carries no rejected router answer (a layout written before decision-review ticket 14 stores none`);
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

  it('refuses the forgeries the floor can tell from a router answer, by name', async () => {
    const model = await drawn(), gap = gapOf(model), [good] = usable(model, seen), points = good!.points;
    const item = planRoute(preRoute(model)).links.find(candidate => candidate.link === LINK)!;
    const floor = `Removed link ${LINK} stores an answer for ${gap.connector} that no router gives`;
    const orthogonal = `${floor}: it meets both ends of its gap, honours its checkpoints and is not orthogonal`;
    const answer = (list: Point[]) => [{ connector: gap.connector, points: list }];
    expect(() => restore(forged(model, answer([])))).toThrow(`${floor}: fewer than two finite points`);
    expect(() => restore(forged(model, answer([gap.from])))).toThrow(`${floor}: fewer than two finite points`);
    // An inner corner moved 1 px across, and an inner corner dropped. The first such change that still honours the checkpoints
    // (`skippedCheckpoint`) meets both ends, so the answer must be orthogonal.
    const honours = (list: Point[]): boolean => skippedCheckpoint(item, new Map([[gap.connector, list]])) === undefined;
    const inner = points.slice(1, -1).map((_, index) => index + 1);
    const moved = inner.map(at => points.map((point, index) => index === at ? { x: point.x + 1, y: point.y + 1 } : { ...point })).find(honours);
    const dropped = inner.map(at => points.filter((_, index) => index !== at)).find(list => honours(list) && list.some((point, index) => index > 0
      && point.x !== list[index - 1]!.x && point.y !== list[index - 1]!.y));
    expect(moved).toBeDefined();
    expect(dropped).toBeDefined();
    expect(() => restore(forged(model, answer(moved!)))).toThrow(orthogonal);
    expect(() => restore(forged(model, answer(dropped!)))).toThrow(orthogonal);
  }, 120000);

  it('restores the answer libavoid gives when it drops a checkpoint: the two ends of the gap and a diagonal', async () => {
    // `straightRun` (plan.ts): libavoid answers with the two port anchors and a diagonal between them. The judgement removes the
    // link (`ROUTE_CHECKPOINT_SKIPPED`); the floor must not refuse it. The same answer as a forgery is part of the stated limit.
    const model = await drawn(), gap = gapOf(model), item = planRoute(preRoute(model)).links.find(candidate => candidate.link === LINK)!;
    expect(gap.from.x !== gap.to.x && gap.from.y !== gap.to.y).toBe(true);
    const diagonal = [{ ...gap.from }, { ...gap.to }];
    const done = tryStitch(preRoute(model), item, new Map([[gap.connector, diagonal]]));
    expect('rejection' in done && done.rejection.code).toBe('ROUTE_CHECKPOINT_SKIPPED');
    expect(restore(forged(model, [{ connector: gap.connector, points: diagonal }])).removedLinks).toEqual([LINK]);
  }, 120000);

  it('accepts a well-formed answer that misses an end: libavoid gives such answers, and only routing again could refuse it', async () => {
    // The limit of the proof (measured, `routerAnswerFloor`): an end moved 1 px, and an end point dropped.
    const model = await drawn(), [good] = usable(model, seen), points = clone(good!.points);
    const shifted = clone(points); shifted[0]!.x += 1;
    expect(restore(forged(model, [{ connector: good!.connector, points: shifted }])).removedLinks).toEqual([LINK]);
    expect(restore(forged(model, [{ connector: good!.connector, points: points.slice(0, -1) }])).removedLinks).toEqual([LINK]);
  }, 120000);

  it('plans the removed link without the labels stage 9 adds after routing', async () => {
    // A link label owned by another link, laid over the corridor of LINK: it did not exist when stage 8 planned.
    const model = await drawn(), along = model.links.find(item => item.id === LINK)!.path!.segments[1]!;
    const label = { id: 'label:link:forged', text: 'x', role: 'link' as const, owner: { kind: 'link' as const, id: 'link-11' }, layer: 'routed' as const,
      bounds: { x: Math.min(along.from.x, along.to.x) - 4, y: Math.min(along.from.y, along.to.y) - 4, width: Math.abs(along.to.x - along.from.x) + 8, height: Math.abs(along.to.y - along.from.y) + 8 } };
    const labelled = clone(model);
    labelled.labels.push(label);
    expect(preRoute(labelled).labels).toEqual(preRoute(model).labels);
    expect(planRoute(preRoute(labelled))).toEqual(planRoute(preRoute(model)));
    // Kept, the label changes the plan: without the filter in `preRoute` the restored plan would not be stage 8's.
    const kept = preRoute(model);
    expect(planRoute({ ...kept, labels: [...kept.labels, label] })).not.toEqual(planRoute(kept));
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
