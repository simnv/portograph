import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { tierGapPlans } from '../layout/gap-plan.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { chainPoints, turnPoints } from '../geometry/planar.js';
import { unfitGaps, unfitMessage } from '../layout/gap-room.js';
import { bodiesPassedOver } from '../layout/overlay-paths.js';
import { withLayoutMutation } from '../layout/mutation.js';
import { completedRouteCovers, type RouteObstacle } from './obstacles.js';
import { batchRequest, completedCrossingObstacles, pendingStemObstacles, planRoute, type RoutePlan } from './plan.js';
import { stitchPaths, stubCandidate, tryStitch, type RouteRejection, type Stitched } from './paths.js';
import { cellRetryEligible, groupReservations } from './reservations.js';
import type { RouteBatch, RoutedConnector } from './types.js';
import { ROUTE_BUDGET_MS, RouteDeadlineError, systemRouteClock, withRouteSession, type CreateRouteAttempt, type RouteClock } from './worker.js';

export type { RouteObstacle } from './obstacles.js';
export type { LinkPlan, PlacementRuns, PlannedRun, RoutePiece, RoutePlan, StemReservation } from './plan.js';
export { batchRequest, pendingStemObstacles, placementRuns, plannedRunsOf, planRoute, effectiveLayer, stemCheckpoint, ROUTE_PARAMETERS, SHAPE_BUFFER_DISTANCE } from './plan.js';
export { nodeClearance, routeObstacles, trimChain, TERMINAL_TRIM } from './obstacles.js';
export { checkpointsHonoured, crossedTiers, firstSkippedCheckpoint, simplify, skippedCheckpoint, stitchPath, stitchPaths, stubCandidate, tryStitch } from './paths.js';
export type { RoutedLinkPath, RouteRejection, Stitched } from './paths.js';
export { lostPlannedRun, preRoute, reservationConflicts, reservedRuns, validateRoutedPaths } from './validate.js';
export type { ReservationConflict } from './validate.js';
export { createBrowserRouteFactory, createRouteFactory, createWarmRouteFactory, RouteDeadlineError, RouteSession, ROUTE_BUDGET_MS, ROUTE_REQUEST, ROUTE_RESPONSE, systemRouteClock, withRouteSession } from './worker.js';
export type { CreateRouteAttempt, RouteAssets, RouteAttempt, RouteClock, RouteWorker, WarmRouteFactory } from './worker.js';
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
  /**
   * The command's own deadline has passed. A route-session deadline during the cell retry keeps the batch routes (`routeBatches`) unless
   * this answers true; then the deadline ends the command, a hard stop. Without it (a direct `route` call) the session limit is the only one.
   */
  commandOver?: () => boolean;
}

/**
 * The links stage 7 left for stage 8, in model order. Not every one of them reaches the router:
 * stage 8 claims a piece whose route placement already fixed, and a link every piece of which is
 * claimed joins no ownership batch.
 */
export function routeRemainders(model: LayoutModel): string[] { return planRoute(model).remainders; }

/** The router's answer for one plan: the routes per connector and, in tolerant mode, the judgement of each routed link. */
export interface RouterAnswer { routes: Map<string, Point[]>; stitched?: Map<string, Stitched> }

/**
 * The ownership batches and the cell retry after them, in one route session: the one loop of stage 8 (`route`) and of the course
 * preflight (`routeAt7e` in `pipeline/rounds.ts`; R1, field-2026-11 ticket 05, re-check of 05b). Every exit terminates the session.
 *
 * A route-session deadline during the batches ends the call (`RouteDeadlineError`). During the cell retry it does not: the batch
 * routes and the retries that finished stand, and each retry still to run keeps its batch rejection, marked as cut (`retryCut`), so the
 * link stays removed with its warning. When the command's own deadline has passed (`RouteOptions.commandOver`), the error ends the
 * command as before (a hard stop).
 */
export async function routeBatches(model: LayoutModel, plan: RoutePlan, options: RouteOptions): Promise<RouterAnswer> {
  const routes = new Map<string, Point[]>();
  // Tolerant mode judges each link's route as its batch returns, before its cover can bind a later batch.
  const stitched = options.strictCheckpoints ? undefined : new Map<string, Stitched>();
  const createAttempt = options.createAttempt;
  const asked = plan.links.reduce((sum, item) => sum + item.connectors.length, 0);
  if (!createAttempt) throw new Error(`Routing ${asked} remaining gap(s) requires a libavoid worker factory`);
  // The retries still to run, once the batches are done; undefined while a batch runs.
  let outstanding: Set<string> | undefined;
  try {
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
        if (!stitched) return;
        outstanding = new Set(plan.links.filter(linkPlan => cellRetryEligible(model, rejectionOf(stitched.get(linkPlan.link)))).map(item => item.link));
        await retryCellRejections(model, plan, route, routes, stitched, protectedRuns, outstanding);
      });
  } catch (error) {
    // Each retry updates the maps in one synchronous step after its answer, so they hold no half retry here.
    if (!(error instanceof RouteDeadlineError) || outstanding === undefined || options.commandOver?.() === true) throw error;
    for (const id of outstanding) {
      const done = stitched!.get(id)!;
      if ('rejection' in done) stitched!.set(id, { rejection: { ...done.rejection, retryCut: true } });
    }
  }
  return { routes, ...(stitched ? { stitched } : {}) };
}

const rejectionOf = (done: Stitched | undefined): RouteRejection | undefined => done !== undefined && 'rejection' in done ? done.rejection : undefined;

/**
 * The cell retry of stage 8 (field-2026-11 ticket 05). A rank cell is no router obstacle in the ownership batches: the frame stands for it,
 * and the frame lets through every link that ends in it, so a cell never splits a batch and no reservation of the batches changes. The
 * stitch reads the cell (`reservations`), and a route that enters a foreign cell of its own frame is rejected (`GapRejected.entered`;
 * `cellRetryEligible`, which restore reads too). Such a link is routed once more, alone, after every batch: with every rank cell as an
 * obstacle with the consumers the stitch reads (`groupReservations`) and every completed route protected, then judged by the same stitch.
 * Only a link the batches removed is asked again, and nothing routes after it but a later retry, so no route of the call that the batches
 * kept changes. Order: plan order (the link order of the model); a retried route protects the retries after it, and the stems and lane
 * approaches of the later retries protect it (as `pendingStemObstacles` does between the batches). A retry that is rejected again keeps the
 * link removed with both answers: the first (`firstAnswer`, it entered the cell) and the retry's (`answer`, its rejection); restore judges
 * both (DR-14). The retries run in the route session, so they count against its budget (R4); `outstanding` loses each one as it finishes.
 */
async function retryCellRejections(model: LayoutModel, plan: RoutePlan, route: (batch: RouteBatch) => Promise<RoutedConnector[]>,
  routes: Map<string, Point[]>, stitched: Map<string, Stitched>, protectedRuns: { obstacle: RouteObstacle; segment: { from: Point; to: Point } }[],
  outstanding: Set<string>): Promise<void> {
  const retries = plan.links.filter(linkPlan => outstanding.has(linkPlan.link));
  const walls: RouteObstacle[] = groupReservations(model).filter(item => item.kind === 'cell')
    .map(cell => ({ id: `group:${cell.id}`, bounds: cell.bounds, consumers: [...cell.consumers] }));
  for (const [index, linkPlan] of retries.entries()) {
    const batch = { id: `cell-retry:${linkPlan.link}`, links: [linkPlan.link] };
    // As between the batches: the stems and lane approaches of the retries after this one are reserved before they have a route.
    const later = new Set(retries.slice(index + 1).map(item => item.link));
    const routed = await route(batchRequest(plan, batch, [...walls, ...completedCrossingObstacles(plan, batch, protectedRuns),
      ...pendingStemObstacles(plan, batch, later)]));
    const answer = new Map(routed.map(item => [item.connector, item.points] as const));
    const first = rejectionOf(stitched.get(linkPlan.link))!;
    const again = tryStitch(model, linkPlan, answer);
    outstanding.delete(linkPlan.link);
    if ('rejection' in again) {
      stitched.set(linkPlan.link, { rejection: { ...again.rejection, firstAnswer: first.answer } });
      continue;
    }
    stitched.set(linkPlan.link, again);
    const link = model.links.find(item => item.id === linkPlan.link)!;
    for (const [connector, points] of answer) {
      routes.set(connector, points);
      protectedRuns.push(...completedRouteCovers(model, link, connector, points));
    }
  }
}

/**
 * Write one removal on a link of a draft: the flag, the answer judged (`rejectedRoute`) and, after the cell retry, the first answer
 * (`cellRejectedRoute`) or the mark that the retry was cut (`cellRetryCut`). Stage 8 and the course preflight write removals with it (R1).
 */
export function markRemoved(link: LayoutLink, item: RouteRejection): void {
  link.removed = true;
  link.rejectedRoute = item.answer;
  if (item.firstAnswer !== undefined) link.cellRejectedRoute = item.firstAnswer;
  if (item.retryCut === true) link.cellRetryCut = true;
}

/** One end of a link as an author writes it: `node.port#ordinal`, `node.#ordinal` for an anonymous port, `group <id>` for a group end. */
function endText(end: LayoutLink['from']): string {
  if (end.node === undefined) return `group ${end.group}`;
  return `${end.node}.${end.anonymous === true ? '' : end.name}#${end.ordinal}`;
}

/** The warning of one removed link: its id, its two ends (the concrete ports when a group link was expanded) and the document link it came from, then the reason. */
function rejectionMessage(link: LayoutLink, item: RouteRejection): string {
  const named = `${link.id} was removed (${endText(link.attachments?.from ?? link.from)} to ${endText(link.attachments?.to ?? link.to)}, document link ${link.sourceIndex})`;
  return item.code === 'ROUTE_CHECKPOINT_SKIPPED'
    ? `${named}: the router skipped the required checkpoint (${item.checkpoint!.x}, ${item.checkpoint!.y}) of ${item.connector}, reserved by ${item.producer}.`
    : `${named}: its route was rejected (${item.reason}).`;
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
  const answer: RouterAnswer = plan.batches.length ? await routeBatches(model, plan, options)
    : { routes: new Map<string, Point[]>(), ...(options.strictCheckpoints ? {} : { stitched: new Map<string, Stitched>() }) };
  const { paths, rejections } = stitchPaths(model, plan, answer.routes, answer.stitched, options.ordinaryOverlay === true);
  return withLayoutMutation(model, 'route', draft => {
    for (const { link, path } of paths) draft.links.find(item => item.id === link)!.path = path;
    // A removed link keeps no path and is listed; one warning names the link and why its route was unusable. The answer judged
    // is stored (`rejectedRoute`), so publication and restore judge it again and refuse a removal they do not reproduce (DR-14).
    for (const item of rejections) {
      const link = draft.links.find(candidate => candidate.id === item.link)!;
      markRemoved(link, item);
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: item.code,
        message: rejectionMessage(link, item), owners: [{ ...link.owner }] });
      if (item.retryCut === true) draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_CELL_RETRY_CUT',
        message: `${link.id} was not routed again around the rank cells: the route session ended first.`, owners: [{ ...link.owner }] });
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
    // A group title stays a router obstacle to every link it does not yield to (architecture-2 ticket 54, slice 1): a routed link that turns
    // beside a title it does not cross is named, so the detour is visible; a later slice lets a vertical residual cross with the halo. A turn
    // of a tier-gap run is placement's, not the router's, and is never named (ticket 56).
    for (const { link: id } of paths) {
      const link = draft.links.find(item => item.id === id)!;
      for (const title of titlesDetoured(draft, link, plan.plannedTurns.get(id) ?? [])) draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_TITLE_DETOUR',
        message: `${id} turns beside the title ${title}, which is a router obstacle to it (it is not in the title's crossedBy).`, owners: [{ ...link.owner }] });
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

/**
 * The group titles a routed link turns beside without crossing them (`ROUTE_TITLE_DETOUR`): a bend of its path within twice the title's
 * link-free margin of the title, the title not naming the link in `crossedBy`. A bend at one of `planned` (the turns of its tier-gap runs,
 * `RoutePlan.plannedTurns`) is no detour: the plan put it there, before any title stood (ticket 56). In label order.
 */
function titlesDetoured(model: LayoutModel, link: LayoutLink, planned: readonly Point[]): string[] {
  const segments = link.path?.segments ?? [], reach = 2 * GROUP_LABEL_LINK_CLEARANCE;
  // A turn only (`turnPoints`, the predicate `pathBends` counts with): a seam between two collinear pieces, or a piece with no length, is no bend.
  const bends = turnPoints(chainPoints(segments)).filter(point => !planned.some(turn => Math.abs(turn.x - point.x) <= PLACEMENT_EPS && Math.abs(turn.y - point.y) <= PLACEMENT_EPS));
  return model.labels.filter(label => label.role === 'group' && !label.omitted && label.bounds !== undefined && label.crossedBy?.includes(link.id) !== true
    && bends.some(point => point.x >= label.bounds!.x - reach && point.x <= label.bounds!.x + label.bounds!.width + reach
      && point.y >= label.bounds!.y - reach && point.y <= label.bounds!.y + label.bounds!.height + reach)).map(label => label.id);
}
