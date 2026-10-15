import type { Point } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { tierGapPlans } from '../layout/gap-plan.js';
import { unfitGaps, unfitMessage } from '../layout/gap-room.js';
import { bodiesPassedOver } from '../layout/overlay-paths.js';
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
  /**
   * Publish every overlay path by the ordinary rule even when `layout.overlayOverBodies` is on, and state no `OVERLAY_OVER_BODY` (ticket 152).
   * The pipeline routes its judged models this way, so the side rounds decide exactly as they do with the setting off; only the model it
   * publishes is routed without this.
   */
  ordinaryOverlay?: boolean;
}

/**
 * The links stage 7 left for stage 8, in model order. Not every one of them reaches the router:
 * stage 8 claims a piece whose route placement already fixed, and a link every piece of which is
 * claimed joins no ownership batch.
 */
export function routeRemainders(model: LayoutModel): string[] { return planRoute(model).remainders; }

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
        const later = new Set(plan.batches.slice(index + 1).flatMap(item => item.links));
        const routed = await route(batchRequest(plan, batch, [
          ...completedCrossingObstacles(plan, batch, protectedRuns),
          ...pendingStemObstacles(plan, batch, later),
        ]));
        for (const item of routed) {
          if (routes.has(item.connector)) throw new Error(`Router returned ${item.connector} twice`);
          routes.set(item.connector, item.points);
        }
        for (const id of batch.links) {
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
  // The tier-gap plans are read once for the whole pass: `planRoute` consumes them and the unfit gaps are named from the same list.
  const plans = tierGapPlans(model);
  const plan = planRoute(model, plans);
  // Overlay links need no WASM, and neither does a remainder every piece of which stage 8 claimed,
  // so a diagram with no batch never initializes it.
  const answer: RouterAnswer = plan.batches.length ? await runRouter(model, plan, options)
    : { routes: new Map<string, Point[]>(), ...(options.strictCheckpoints ? {} : { stitched: new Map<string, Stitched>() }) };
  const { paths, rejections } = stitchPaths(model, plan, answer.routes, answer.stitched, options.ordinaryOverlay === true);
  return withLayoutMutation(model, 'route', draft => {
    for (const { link, path } of paths) draft.links.find(item => item.id === link)!.path = path;
    // A removed link keeps no path and is listed; one warning names the link and why its route was unusable.
    for (const item of rejections) {
      const link = draft.links.find(candidate => candidate.id === item.link)!;
      link.removed = true;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: item.code,
        message: rejectionMessage(link.id, item), owners: [{ ...link.owner }] });
    }
    // A gap that stopped fitting after 7f sized it (the corridor move, a later stage) is planned by nobody: its parts are the router's,
    // and the diagnostic says so, unless 7f already named the gap (`TIER_GAP_PART_UNFIT` from the round cap).
    for (const item of unfitGaps(plans)) {
      const named = draft.diagnostics.some(entry => entry.code === 'TIER_GAP_PART_UNFIT' && entry.message.startsWith(`the tier gap above tier ${item.below} `));
      if (!named) draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'TIER_GAP_PART_UNFIT',
        message: unfitMessage(item.below, item.growth), owners: [] });
    }
    // Opt-in `layout.overlayOverBodies` (ticket 152): one info line per overlay link whose published path passes over node bodies.
    if (model.document.layout?.overlayOverBodies === true && options.ordinaryOverlay !== true) {
      for (const id of plan.overlay) {
        const link = draft.links.find(item => item.id === id)!;
        const bodies = link.path ? bodiesPassedOver(draft, link, link.path) : [];
        if (bodies.length) draft.diagnostics.push({ stage: 'final-geometry', severity: 'info', code: 'OVERLAY_OVER_BODY',
          message: `${id} is drawn as a straight chord over the body of ${bodies.join(', ')} (layout.overlayOverBodies).`, owners: [{ ...link.owner }] });
      }
    }
    if (rejections.length) draft.removedLinks = draft.links.filter(link => link.removed === true).map(link => link.id);
    for (const link of draft.links) {
      if (!stubCandidate(draft, link)) continue;
      link.stubCandidate = true;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_STUB_CANDIDATE',
        message: `${link.id} crosses more than two tiers or detours more than three times its direct distance; the routed path is kept.`,
        owners: [{ ...link.owner }] });
    }
  });
}
