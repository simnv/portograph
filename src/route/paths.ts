import type { Point } from '../model/geometry.js';
import type { Lane, LayoutLink, LayoutModel, LayoutPath, PathSegment } from '../model/layout.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { endPort } from '../layout/approach.js';
import { findPort } from '../layout/row-paths.js';
import { sharedBlockers, overlayPath, publishedOverlayPath } from '../layout/overlay-paths.js';
import { stemReach } from '../layout/bands.js';
import { equal } from '../model/json-equality.js';
import { outward } from '../score/model.js';
import { MIN_STEM, reservations, shrink, TOLERANCE } from './reservations.js';
import { bottom, EPS, horizontal, length, retracingRuns, samePoint, segmentRect, vertical } from '../geometry/planar.js';
import { effectiveLayer, type LinkPlan, type RoutePlan } from './plan.js';
import type { RouteCheckpoint } from './types.js';
import { nodeTierIfAny } from '../layout/read/tier.js';

export interface RoutedLinkPath { link: string; path: LayoutPath }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Arc length from the polyline's start to `point`, or -1 when the route misses it. Measuring the
 * distance along the route, not the segment it falls on, is what makes the order check strict: two
 * checkpoints on one long segment are still ordered.
 */
export function polylineDistance(points: Point[], point: Point, after = -1): number {
  let travelled = 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index]!, to = points[index + 1]!;
    const segment = { from, to, owner: { kind: 'link' as const, id: '' } };
    if (segmentRect(segment, { x: point.x, y: point.y, width: 0, height: 0 })) {
      const at = travelled + Math.hypot(point.x - from.x, point.y - from.y);
      if (at >= after - EPS) return at;
    }
    travelled += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return -1;
}

/**
 * libavoid may omit a checkpoint it cannot reach, so every required one is verified against the
 * returned polyline, in the order it was requested and by distance along the route. This proves
 * the route passes through each point in sequence; the direction masks it also asked for are
 * judged by the stem and reservation checks on the stitched path.
 */
export function checkpointsHonoured(points: Point[], checkpoints: RouteCheckpoint[]): boolean {
  return firstSkippedCheckpoint(points, checkpoints) < 0;
}

/** The index of the first checkpoint the route does not pass in order, or -1 when it passes them all. */
export function firstSkippedCheckpoint(points: Point[], checkpoints: RouteCheckpoint[]): number {
  let cursor = -1;
  for (const [index, checkpoint] of checkpoints.entries()) {
    const at = polylineDistance(points, checkpoint, cursor);
    if (at < 0) return index;
    cursor = at;
  }
  return -1;
}

/**
 * Why stage 8 discarded a link's route (ticket 24). `ROUTE_CHECKPOINT_SKIPPED` names the checkpoint the router
 * missed and the rule that asked for it; `ROUTE_GAP_REJECTED` carries the reason stitching refused the route
 * (an end not met, a diagonal, a zero-length run, no answer). Either way the link is removed.
 */
export interface RouteRejection {
  link: string;
  code: 'ROUTE_CHECKPOINT_SKIPPED' | 'ROUTE_GAP_REJECTED';
  reason: string;
  connector?: string;
  checkpoint?: Point;
  producer?: string;
  /** The router answer judged, per routed gap of the link that has one, in plan order; stage 8 stores it as `LayoutLink.rejectedRoute` (DR-14). */
  answer: { connector: string; points: Point[] }[];
}

/**
 * The first required checkpoint any routed gap of this link skips, or undefined when the link's routes
 * honour them all. A connector with no route yet is not judged.
 */
export function skippedCheckpoint(plan: LinkPlan, routes: Map<string, Point[]>): Omit<RouteRejection, 'answer'> | undefined {
  for (const piece of plan.pieces) {
    if (piece.kind !== 'gap') continue;
    const points = routes.get(piece.connector);
    if (!points) continue;
    const connector = plan.connectors.find(item => item.id === piece.connector)!;
    const index = firstSkippedCheckpoint(points, connector.checkpoints);
    if (index >= 0) {
      const { x, y } = connector.checkpoints[index]!;
      return { link: plan.link, code: 'ROUTE_CHECKPOINT_SKIPPED', reason: `Router skipped a required checkpoint on ${piece.connector}`,
        connector: piece.connector, checkpoint: { x, y }, producer: piece.producers[index] ?? 'unknown' };
    }
  }
  return undefined;
}

/** Drop repeated and collinear vertices inside one gap; ownership boundaries are never merged. */
export function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && samePoint(last, point)) continue;
    const previous = result.at(-2);
    if (last && previous && ((Math.abs(previous.x - last.x) <= EPS && Math.abs(last.x - point.x) <= EPS)
      || (Math.abs(previous.y - last.y) <= EPS && Math.abs(last.y - point.y) <= EPS))) result.pop();
    result.push({ x: point.x, y: point.y });
  }
  return result;
}

/** The reserved lanes one link owns, directly or as a verified member of the owning bundle. */
export function ownedLanes(model: LayoutModel, link: LayoutLink): Lane[] {
  return model.lanes.filter(lane => {
    const owner = lane.owner;
    if (lane.layer === 'overlay' || lane.kind === 'span') return false;
    if (owner.kind === 'link') return owner.id === link.id;
    return owner.kind === 'bundle' && model.bundles.some(bundle => bundle.id === owner.id && bundle.members.includes(link.id));
  });
}

/**
 * A judgement on the router's answer for one gap: the points it returned cannot be drawn as this link's route.
 * Only these are rejections (ticket 24); any other throw in stitching is a defect and stays fatal.
 */
export class GapRejected extends Error {}

/**
 * Split and annotate a routed gap where it meets its own reserved lanes. A lane admits only its
 * owner's collinear run carrying the lane's own id, so each piece names exactly the one lane it
 * touches — the same shape the region rules produce for a lane they own.
 */
export function laneRuns(model: LayoutModel, link: LayoutLink, segment: PathSegment): PathSegment[] {
  const lanes = ownedLanes(model, link).filter(lane => segmentRect(segment, lane.bounds))
    .sort((a, b) => a.bounds.y - b.bounds.y);
  if (!lanes.length) return [segment];
  if (!vertical(segment)) throw new GapRejected(`Routed gap on ${link.id} crosses reserved lane ${lanes[0]!.id} sideways`);
  if (lanes.some(lane => Math.abs(segment.from.x - lane.x) > EPS)) {
    throw new GapRejected(`Routed gap on ${link.id} enters reserved lane ${lanes[0]!.id} off its centre`);
  }
  const low = Math.min(segment.from.y, segment.to.y), high = Math.max(segment.from.y, segment.to.y);
  const cuts = new Set<number>();
  for (const [index, lane] of lanes.entries()) {
    for (const edge of [lane.bounds.y, bottom(lane.bounds)]) if (edge > low + EPS && edge < high - EPS) cuts.add(edge);
    // One cut between two consecutive corridors, so no piece has to name both.
    const next = lanes[index + 1];
    if (next) cuts.add((bottom(lane.bounds) + next.bounds.y) / 2);
  }
  const ordered = [...cuts].filter(value => value > low + EPS && value < high - EPS).sort((a, b) => a - b);
  const downward = segment.to.y > segment.from.y;
  const stops = downward ? [low, ...ordered, high] : [high, ...[...ordered].reverse(), low];
  const result: PathSegment[] = [];
  for (let index = 0; index + 1 < stops.length; index++) {
    const piece: PathSegment = { ...segment, from: { x: segment.from.x, y: stops[index]! }, to: { x: segment.from.x, y: stops[index + 1]! } };
    const touched = lanes.filter(lane => segmentRect(piece, lane.bounds));
    if (touched.length > 1) throw new Error(`Routed gap on ${link.id} cannot name both ${touched[0]!.id} and ${touched[1]!.id}`);
    result.push(touched.length ? { ...piece, lane: touched[0]!.id } : piece);
  }
  return result;
}

function gapSegments(model: LayoutModel, link: LayoutLink, points: Point[], from: Point, to: Point): PathSegment[] {
  const simplified = simplify(points);
  if (simplified.length < 2) throw new GapRejected(`Router returned no usable route for ${link.id}`);
  if (!samePoint(simplified[0]!, from) || !samePoint(simplified.at(-1)!, to)) {
    throw new GapRejected(`Routed gap on ${link.id} does not meet its reserved endpoints`);
  }
  const owner = { kind: 'link' as const, id: link.id };
  return simplified.slice(1).flatMap((point, index) => {
    const segment = { from: { ...simplified[index]! }, to: { ...point }, owner: { ...owner } };
    if (!Number.isFinite(segment.to.x) || !Number.isFinite(segment.to.y)) throw new GapRejected(`Routed gap on ${link.id} is not finite`);
    if (!horizontal(segment) && !vertical(segment)) throw new GapRejected(`Routed gap on ${link.id} is not orthogonal`);
    if (length(segment) <= EPS) throw new GapRejected(`Routed gap on ${link.id} has a zero-length segment`);
    return laneRuns(model, link, segment);
  });
}

/**
 * Stitch one link's final source-to-target path: every reserved run exactly as a rule left it, and
 * the routed gaps between them. A reserved run keeps its owner, lane and barCross annotations.
 */
export function stitchPath(model: LayoutModel, plan: LinkPlan, routes: Map<string, Point[]>): LayoutPath {
  const link = model.links.find(item => item.id === plan.link)!;
  const segments: PathSegment[] = [];
  // Which of the assembled segments a rule wrote on the model. Those are reproduced exactly; an
  // allocated run and a routed gap are this pass's own geometry and may be joined where they meet.
  const claimed: boolean[] = [];
  const add = (list: PathSegment[], fixed: boolean): void => {
    for (const segment of list) { segments.push(segment); claimed.push(fixed); }
  };
  for (const piece of plan.pieces) {
    if (piece.kind === 'reserved') { add(clone(piece.segments), true); continue; }
    // An allocated tier-gap run leaves a lane terminal, and a claimed straight run stands where the
    // routed gap would have, so each names the corridors it meets exactly as that gap would have.
    if (piece.kind === 'allocated' || piece.kind === 'straight') {
      add(clone(piece.segments).flatMap(segment => laneRuns(model, link, segment)), false);
      continue;
    }
    const points = routes.get(piece.connector);
    if (!points) throw new Error(`Router returned no route for ${piece.connector}`);
    const connector = plan.connectors.find(item => item.id === piece.connector)!;
    if (!checkpointsHonoured(points, connector.checkpoints)) {
      throw new Error(`Router skipped a required checkpoint on ${piece.connector}`);
    }
    add(gapSegments(model, link, points, piece.from, piece.to), false);
  }
  const joined = joinSeams(segments, claimed);
  // The router's answer joined to the rules' runs may walk back along a run already drawn. That is the same
  // judgement `validateRoutedPaths` asserts (same sweep), made here first so the one link goes, not the sheet.
  // A retrace among the rules' own runs is a rule defect, not a router answer, and stays fatal (ticket 24's boundary).
  const ruled = segments.filter((_, index) => claimed[index]);
  if (retracingRuns(ruled)) throw new Error(`Reserved runs on ${link.id} retrace themselves`);
  if (retracingRuns(joined)) throw new GapRejected(`Routed path on ${link.id} retraces itself`);
  foreignJudgement(model, link, joined, ruled);
  return { owner: { ...link.owner }, layer: 'routed', fixed: false, segments: joined, ...pathStrokeWidth(link) };
}

/**
 * The rest of what `validateRoutedPaths` throws on for a stitched path, judged here first so a router answer that breaks it
 * removes its link and not the sheet (ticket 47): a segment that is not one of the rules' own reserved runs may not enter a reservation it does
 * not own, and the first and last run must leave the port perpendicular and be as long as the reserved stem. From a router
 * this makes the validator's throws assertions. A rule's leg is a reserved piece and so exempt here, but the validator does not
 * exempt it and still asserts on it; a leg that crosses a foreign box is a rule defect and stays fatal.
 */
function foreignJudgement(model: LayoutModel, link: LayoutLink, segments: PathSegment[], ruled: PathSegment[]): void {
  const isReserved = (segment: PathSegment): boolean => ruled.some(run => equal(run, segment));
  const boxes = reservations(model, link).filter(box => box.bounds.width > 2 * TOLERANCE && box.bounds.height > 2 * TOLERANCE);
  for (const segment of segments) {
    if (isReserved(segment)) continue;
    const box = boxes.find(item => segmentRect(segment, shrink(item.bounds, TOLERANCE)));
    if (box) throw new GapRejected(`Routed path on ${link.id} enters reserved ${box.id}`);
  }
  for (const [end, segment, first] of [['from', segments[0]!, true], ['to', segments.at(-1)!, false]] as const) {
    const port = endPort(model, link, end);
    if (!port?.anchor) continue;
    if (!outward(port, segment, first)) throw new GapRejected(`Port stem on ${link.id} does not leave its side perpendicular`);
    const required = isReserved(segment) ? MIN_STEM : Math.max(MIN_STEM, stemReach(model, model.nodes[port.ref.node]!));
    if (length(segment) < required - EPS) throw new GapRejected(`Port stem on ${link.id} is shorter than its reserved entry`);
  }
}

/**
 * Join two consecutive pieces of this pass's own geometry where they are one straight run. The seam
 * between an allocated tier-gap run and the gap beyond it is such a place: left in two, the pair
 * reads as a staircase the clearance gate then measures against itself. A run a rule wrote on the
 * model is reproduced exactly and is never joined.
 */
function joinSeams(segments: PathSegment[], claimed: readonly boolean[]): PathSegment[] {
  const result: PathSegment[] = [], owned: boolean[] = [];
  for (const [index, segment] of segments.entries()) {
    const last = result.at(-1);
    // One straight run means one line and one direction of travel. A pair that turns back on itself
    // is a retrace, and joining it would delete the length the gates must see.
    const along = (one: PathSegment, axis: 'x' | 'y'): number => Math.sign(one.to[axis] - one.from[axis]);
    const straight = last !== undefined && !claimed[index] && owned.at(-1) === false
      && ((Math.abs(last.from.x - last.to.x) <= EPS && Math.abs(segment.from.x - segment.to.x) <= EPS
        && Math.abs(last.to.x - segment.from.x) <= EPS && along(last, 'y') === along(segment, 'y'))
        || (Math.abs(last.from.y - last.to.y) <= EPS && Math.abs(segment.from.y - segment.to.y) <= EPS
          && Math.abs(last.to.y - segment.from.y) <= EPS && along(last, 'x') === along(segment, 'x')))
      && samePoint(last.to, segment.from) && last.lane === segment.lane && last.barCross === segment.barCross;
    if (straight) { result[result.length - 1] = { ...last, to: { ...segment.to } }; continue; }
    result.push(segment);
    owned.push(claimed[index] === true);
  }
  return result;
}

export type Stitched = { path: LayoutPath } | { rejection: RouteRejection };

/**
 * One link's final path, or the reason its route is unusable. A route that skips a required checkpoint, and a
 * route that stitching refuses for any other reason, are the same class: the link cannot be drawn, and the
 * sheet can (ticket 24). Nothing else about the link is judged here.
 */
export function tryStitch(model: LayoutModel, plan: LinkPlan, routes: Map<string, Point[]>): Stitched {
  const skipped = skippedCheckpoint(plan, routes);
  if (skipped) return { rejection: { ...skipped, answer: answerOf(plan, routes) } };
  try { return { path: stitchPath(model, plan, routes) }; }
  catch (error) {
    if (!(error instanceof GapRejected)) throw error;
    return { rejection: { link: plan.link, code: 'ROUTE_GAP_REJECTED', reason: error.message, answer: answerOf(plan, routes) } };
  }
}

/** The points the router returned for each routed gap of one link, in plan order; a gap with no answer is left out. Only the plan's own gaps are read. */
function answerOf(plan: LinkPlan, routes: ReadonlyMap<string, Point[]>): { connector: string; points: Point[] }[] {
  return plan.pieces.flatMap(piece => {
    const points = piece.kind === 'gap' ? routes.get(piece.connector) : undefined;
    return piece.kind === 'gap' && points ? [{ connector: piece.connector, points: points.map(point => ({ x: point.x, y: point.y })) }] : [];
  });
}

/**
 * Every routed link's path, in plan order, then the overlay links. Without `stitched` the first unusable route
 * throws (strict). With it, an unusable route is a rejection instead: `stitched` holds the links stage 8
 * already judged after their batch, and any other link is judged here.
 */
export function stitchPaths(model: LayoutModel, plan: RoutePlan, routes: Map<string, Point[]>,
  stitched?: ReadonlyMap<string, Stitched>, ordinaryOverlay = false): { paths: RoutedLinkPath[]; rejections: RouteRejection[] } {
  const rejections: RouteRejection[] = [];
  const result: RoutedLinkPath[] = [];
  for (const item of plan.links) {
    if (!stitched) { result.push({ link: item.link, path: stitchPath(model, item, routes) }); continue; }
    const done = stitched.get(item.link) ?? tryStitch(model, item, routes);
    if ('rejection' in done) rejections.push(done.rejection); else result.push({ link: item.link, path: done.path });
  }
  // An overlay link never enters the router: its path is derived from the boxes placement reserved,
  // so stage 8 only publishes what `src/layout/overlay-paths.ts` states. One index serves them all.
  const blockers = plan.overlay.length ? sharedBlockers(model) : undefined;
  for (const id of plan.overlay) {
    result.push({ link: id, path: (ordinaryOverlay ? overlayPath : publishedOverlayPath)(model, model.links.find(link => link.id === id)!, blockers) });
  }
  return { paths: result, rejections };
}

/**
 * Distinct tier bands the polyline passes through, excluding the two endpoint tiers and repeated
 * visits. A transit is measured by the band's vertical extent, not its rectangle: a reserved lane
 * sits in the margin beside its tier, so the route crosses that tier without entering its box.
 */
export function crossedTiers(model: LayoutModel, link: LayoutLink): number {
  const ends = [nodeTierIfAny(model, link.attachments!.from.node), nodeTierIfAny(model, link.attachments!.to.node)];
  const crossed = new Set<number>();
  for (const band of model.tierBands) {
    if (!band.bounds || ends.includes(band.tier)) continue;
    const low = band.bounds.y, high = bottom(band.bounds);
    if (link.path!.segments.some(segment => Math.max(segment.from.y, segment.to.y) >= low - EPS
      && Math.min(segment.from.y, segment.to.y) <= high + EPS)) crossed.add(band.tier);
  }
  return crossed.size;
}

/**
 * A route that crosses more than two intermediate tiers or detours more than three times the
 * direct distance is a stub candidate. M1 only marks and warns: the technique and the full path
 * stay exactly as routed.
 */
export function stubCandidate(model: LayoutModel, link: LayoutLink): boolean {
  if (!link.path || !link.attachments || link.technique === 'stub' || effectiveLayer(link) !== 'routed') return false;
  if (crossedTiers(model, link) > 2) return true;
  const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
  if (!from?.anchor || !to?.anchor) return false;
  const direct = Math.hypot(to.anchor.x - from.anchor.x, to.anchor.y - from.anchor.y);
  const arc = link.path.segments.reduce((sum, segment) => sum + length(segment), 0);
  return direct <= EPS ? arc > EPS : arc > 3 * direct + EPS;
}

export const pathStroke = (link: LayoutLink): number => linkStrokeWidth(link);
