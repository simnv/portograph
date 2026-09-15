import type { Point } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { withLayoutMutation } from '../layout/mutation.js';
import { completedRouteObstacles, type RouteObstacle } from './obstacles.js';
import { batchRequest, pendingStemObstacles, planRoute, type RoutePlan } from './plan.js';
import { stitchPaths, stubCandidate } from './paths.js';
import { ROUTE_BUDGET_MS, systemRouteClock, withRouteSession, type CreateRouteAttempt, type RouteClock } from './worker.js';

export type { RouteObstacle } from './obstacles.js';
export type { LinkPlan, RoutePiece, RoutePlan, StemReservation } from './plan.js';
export { batchRequest, pendingStemObstacles, planRoute, effectiveLayer, stemCheckpoint, ROUTE_PARAMETERS, SHAPE_BUFFER_DISTANCE } from './plan.js';
export { nodeClearance, routeObstacles, trimChain, TERMINAL_TRIM } from './obstacles.js';
export { checkpointsHonoured, crossedTiers, simplify, stitchPath, stitchPaths, stubCandidate } from './paths.js';
export type { RoutedLinkPath } from './paths.js';
export { reservationConflicts, reservedRuns, validateRoutedPaths } from './validate.js';
export type { ReservationConflict } from './validate.js';
export { createBrowserRouteFactory, createRouteFactory, RouteDeadlineError, RouteSession, ROUTE_BUDGET_MS, ROUTE_REQUEST, ROUTE_RESPONSE, systemRouteClock, withRouteSession } from './worker.js';
export type { CreateRouteAttempt, RouteAssets, RouteAttempt, RouteClock, RouteWorker } from './worker.js';
export { ALL_DIRECTIONS, DIRECTION_BITS } from './types.js';
export type { RouteBatch, RouteCheckpoint, RouteConnector, RouteEndpoint, RoutePin, RouteShape, RoutedConnector } from './types.js';

export interface RouteOptions {
  /** Required only when the diagram actually has a routed remainder. */
  createAttempt?: CreateRouteAttempt;
  /** Whole-stage budget; stage 17 injects the remaining pipeline budget. */
  routeBudgetMs?: number;
  clock?: RouteClock;
}

/** The links stage 7 left for the router, in model order. */
export function routeRemainders(model: LayoutModel): string[] { return planRoute(model).remainders; }

async function runRouter(model: LayoutModel, plan: RoutePlan, options: RouteOptions): Promise<Map<string, Point[]>> {
  const routes = new Map<string, Point[]>();
  const createAttempt = options.createAttempt;
  if (!createAttempt) throw new Error(`Routing ${plan.remainders.length} remaining link(s) requires a libavoid worker factory`);
  await withRouteSession(createAttempt, options.routeBudgetMs ?? ROUTE_BUDGET_MS, options.clock ?? systemRouteClock,
    async route => {
      const protectedRuns: RouteObstacle[] = [];
      // Ownership batches run in a fixed order and every completed route protects the next batch.
      for (const [index, batch] of plan.batches.entries()) {
        // A later batch's reserved stems protect it the same way, before it has a route of its own.
        const pending = new Set(plan.batches.slice(index + 1).flatMap(item => item.links));
        const routed = await route(batchRequest(plan, batch, [...protectedRuns, ...pendingStemObstacles(plan, batch, pending)]));
        for (const item of routed) {
          if (routes.has(item.connector)) throw new Error(`Router returned ${item.connector} twice`);
          routes.set(item.connector, item.points);
        }
        for (const id of batch.links) {
          const link = model.links.find(item => item.id === id)!;
          for (const piece of plan.links.find(item => item.link === id)!.pieces) {
            if (piece.kind !== 'gap') continue;
            protectedRuns.push(...completedRouteObstacles(model, link, piece.connector, routes.get(piece.connector) ?? []));
          }
        }
      }
    });
  return routes;
}

/**
 * Stage 8. libavoid routes only what the region rules did not claim; every reserved run is kept
 * exactly and stitched into a complete source-to-target path. The router runs asynchronously in a
 * real worker, outside the checked transaction, and only validated geometry is published.
 */
export async function route(model: LayoutModel, options: RouteOptions = {}): Promise<LayoutModel> {
  const plan = planRoute(model);
  // Overlay links need no WASM, so a diagram without a routed remainder never initializes it.
  const routes = plan.remainders.length ? await runRouter(model, plan, options) : new Map<string, Point[]>();
  const paths = stitchPaths(model, plan, routes);
  return withLayoutMutation(model, 'route', draft => {
    for (const { link, path } of paths) draft.links.find(item => item.id === link)!.path = path;
    for (const link of draft.links) {
      if (!stubCandidate(draft, link)) continue;
      link.stubCandidate = true;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_STUB_CANDIDATE',
        message: `${link.id} crosses more than two tiers or detours more than three times its direct distance; M1 keeps the routed path.`,
        owners: [{ ...link.owner }] });
    }
  });
}
