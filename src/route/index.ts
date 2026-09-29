import type { Point } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { withLayoutMutation } from '../layout/mutation.js';
import { completedRouteCovers, type RouteObstacle } from './obstacles.js';
import { batchRequest, completedCrossingObstacles, pendingStemObstacles, planRoute, type RoutePlan } from './plan.js';
import { stitchPaths, stubCandidate, tryStitch, type RouteRejection, type Stitched } from './paths.js';
import { ROUTE_BUDGET_MS, systemRouteClock, withRouteSession, type CreateRouteAttempt, type RouteClock } from './worker.js';

export type { RouteObstacle } from './obstacles.js';
export type { LinkPlan, RoutePiece, RoutePlan, StemReservation } from './plan.js';
export { batchRequest, pendingStemObstacles, planRoute, effectiveLayer, stemCheckpoint, ROUTE_PARAMETERS, SHAPE_BUFFER_DISTANCE } from './plan.js';
export { nodeClearance, routeObstacles, trimChain, TERMINAL_TRIM } from './obstacles.js';
export { checkpointsHonoured, crossedTiers, firstSkippedCheckpoint, simplify, skippedCheckpoint, stitchPath, stitchPaths, stubCandidate, tryStitch } from './paths.js';
export type { RoutedLinkPath, RouteRejection, Stitched } from './paths.js';
export { reservationConflicts, reservedRuns, validateRoutedPaths } from './validate.js';
export type { ReservationConflict } from './validate.js';
export { createBrowserRouteFactory, createRouteFactory, RouteDeadlineError, RouteSession, ROUTE_BUDGET_MS, ROUTE_REQUEST, ROUTE_RESPONSE, systemRouteClock, withRouteSession } from './worker.js';
export type { CreateRouteAttempt, RouteAssets, RouteAttempt, RouteClock, RouteWorker } from './worker.js';
export { ALL_DIRECTIONS, DIRECTION_BITS } from './types.js';
export type { RouteBatch, RouteCheckpoint, RouteConnector, RouteEndpoint, RoutePin, RouteShape, RoutedConnector } from './types.js';

export interface RouteOptions {
  /**
   * Required only when an ownership batch remains. A remainder every piece of which stage 8 claims
   * asks the router for nothing, so a diagram can have remainders and no batch: the approved golden
   * is one.
   */
  createAttempt?: CreateRouteAttempt;
  /** Whole-stage budget; stage 17 injects the remaining pipeline budget. */
  routeBudgetMs?: number;
  clock?: RouteClock;
  /**
   * Throw when the router skips a required checkpoint, as stage 8 first did, instead of removing the
   * link (ticket 24). Tests that assert the router's reservations set it; a pipeline run does not.
   */
  strictCheckpoints?: boolean;
}

/**
 * The links stage 7 left for stage 8, in model order. Not every one of them reaches the router:
 * stage 8 claims a piece whose route placement already fixed, and a link every piece of which is
 * claimed joins no ownership batch.
 */
export function routeRemainders(model: LayoutModel): string[] { return planRoute(model).remainders; }

/**
 * One ownership batch, split by which completed runs each of its links may cross.
 *
 * A request carries one obstacle set, and a completed run leaves it only when every link of the request
 * may cross it (`batchRequest`). Two links of one batch that must cross different completed runs cannot
 * share a request: the run one of them has to cross stays an obstacle for both, the pocket its far
 * checkpoint stands in closes, and libavoid drops the checkpoint and answers with a diagonal. Links that
 * may cross the same runs, which is every batch on the golden sheets, stay together in plan order.
 */
function crossingParts(plan: RoutePlan, batch: { links: string[] },
  covers: Parameters<typeof completedCrossingObstacles>[2]): string[][] {
  const granted = completedCrossingObstacles(plan, batch, covers);
  const parts = new Map<string, string[]>();
  for (const id of batch.links) {
    const key = granted.filter(item => item.consumers.includes(id)).map(item => item.id).sort().join('|');
    parts.set(key, [...parts.get(key) ?? [], id]);
  }
  return [...parts.values()];
}

interface RouterAnswer { routes: Map<string, Point[]>; stitched?: Map<string, Stitched> }

async function runRouter(model: LayoutModel, plan: RoutePlan, options: RouteOptions): Promise<RouterAnswer> {
  const routes = new Map<string, Point[]>();
  // Tolerant mode judges each link's route as its batch returns, before its cover can bind a later batch.
  const stitched = options.strictCheckpoints ? undefined : new Map<string, Stitched>();
  const createAttempt = options.createAttempt;
  const asked = plan.links.reduce((sum, item) => sum + item.connectors.length, 0);
  if (!createAttempt) throw new Error(`Routing ${asked} remaining gap(s) requires a libavoid worker factory`);
  await withRouteSession(createAttempt, options.routeBudgetMs ?? ROUTE_BUDGET_MS, options.clock ?? systemRouteClock,
    async route => {
      const protectedRuns: { obstacle: RouteObstacle; segment: { from: Point; to: Point } }[] = [];
      // Ownership batches run in a fixed order and every completed route protects the next batch.
      for (const [index, batch] of plan.batches.entries()) {
        // A later batch's reserved stems protect it the same way, before it has a route of its own.
        const later = plan.batches.slice(index + 1).flatMap(item => item.links);
        const parts = crossingParts(plan, batch, protectedRuns);
        // Only the later batches' stems protect a part: batchmates whose stems must cross stay in one batch
        // (ticket 22), and a part that read its batchmates' stems as obstacles would close that crossing.
        const pending = new Set(later);
        for (const [part, links] of parts.entries()) {
          const sub = parts.length === 1 ? batch : { id: `${batch.id}.${part}`, links };
          const routed = await route(batchRequest(plan, sub, [
            ...completedCrossingObstacles(plan, sub, protectedRuns),
            ...pendingStemObstacles(plan, sub, pending),
          ]));
          for (const item of routed) {
            if (routes.has(item.connector)) throw new Error(`Router returned ${item.connector} twice`);
            routes.set(item.connector, item.points);
          }
          for (const id of links) {
            const link = model.links.find(item => item.id === id)!;
            const linkPlan = plan.links.find(item => item.link === id)!;
            // A route stage 8 cannot use (a skipped checkpoint, an end not met) is discarded, so its cover is
            // no obstacle to the batches after it. Strict mode keeps the route and stitching throws.
            if (stitched) {
              const done = tryStitch(model, linkPlan, routes);
              stitched.set(id, done);
              if ('rejection' in done) {
                for (const piece of linkPlan.pieces) if (piece.kind === 'gap') routes.delete(piece.connector);
                continue;
              }
            }
            for (const piece of linkPlan.pieces) {
              if (piece.kind !== 'gap') continue;
              protectedRuns.push(...completedRouteCovers(model, link, piece.connector, routes.get(piece.connector) ?? []));
            }
          }
        }
      }
    });
  return { routes, ...(stitched ? { stitched } : {}) };
}

function rejectionMessage(link: string, item: RouteRejection): string {
  return item.code === 'ROUTE_CHECKPOINT_SKIPPED'
    ? `${link} was removed: the router skipped the required checkpoint (${item.checkpoint!.x}, ${item.checkpoint!.y}) of ${item.connector}, reserved by ${item.producer}.`
    : `${link} was removed: its route was rejected (${item.reason}).`;
}

/**
 * Stage 8. libavoid routes only what the region rules did not claim; every reserved run is kept
 * exactly and stitched into a complete source-to-target path. The router runs asynchronously in a
 * real worker, outside the checked transaction, and only validated geometry is published.
 */
export async function route(model: LayoutModel, options: RouteOptions = {}): Promise<LayoutModel> {
  const plan = planRoute(model);
  // Overlay links need no WASM, and neither does a remainder every piece of which stage 8 claimed,
  // so a diagram with no batch never initializes it.
  const answer: RouterAnswer = plan.batches.length ? await runRouter(model, plan, options)
    : { routes: new Map<string, Point[]>(), ...(options.strictCheckpoints ? {} : { stitched: new Map<string, Stitched>() }) };
  const { paths, rejections } = stitchPaths(model, plan, answer.routes, answer.stitched);
  return withLayoutMutation(model, 'route', draft => {
    for (const { link, path } of paths) draft.links.find(item => item.id === link)!.path = path;
    // A removed link keeps no path and is listed; one warning names the link and why its route was unusable.
    for (const item of rejections) {
      const link = draft.links.find(candidate => candidate.id === item.link)!;
      link.removed = true;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: item.code,
        message: rejectionMessage(link.id, item), owners: [{ ...link.owner }] });
    }
    if (rejections.length) draft.removedLinks = draft.links.filter(link => link.removed === true).map(link => link.id);
    for (const link of draft.links) {
      if (!stubCandidate(draft, link)) continue;
      link.stubCandidate = true;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_STUB_CANDIDATE',
        message: `${link.id} crosses more than two tiers or detours more than three times its direct distance; M1 keeps the routed path.`,
        owners: [{ ...link.owner }] });
    }
  });
}
