import type { Point } from '../model/geometry.js';
import type { Lane, LayoutLink, LayoutModel, LayoutPath, PathSegment } from '../model/layout.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { findPort } from '../layout/row-paths.js';
import { overlayBlockers, overlayPath } from '../layout/overlay-paths.js';
import { bottom, EPS, horizontal, length, samePoint, segmentRect, vertical } from '../score/geometry.js';
import { effectiveLayer, type LinkPlan, type RoutePlan } from './plan.js';
import type { RouteCheckpoint } from './types.js';

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
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const at = polylineDistance(points, checkpoint, cursor);
    if (at < 0) return false;
    cursor = at;
  }
  return true;
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
    if (lane.layer === 'overlay') return false;
    if (owner.kind === 'link') return owner.id === link.id;
    return owner.kind === 'bundle' && model.bundles.some(bundle => bundle.id === owner.id && bundle.members.includes(link.id));
  });
}

/**
 * Split and annotate a routed gap where it meets its own reserved lanes. A lane admits only its
 * owner's collinear run carrying the lane's own id, so each piece names exactly the one lane it
 * touches — the same shape the region rules produce for a lane they own.
 */
export function laneRuns(model: LayoutModel, link: LayoutLink, segment: PathSegment): PathSegment[] {
  const lanes = ownedLanes(model, link).filter(lane => segmentRect(segment, lane.bounds))
    .sort((a, b) => a.bounds.y - b.bounds.y);
  if (!lanes.length) return [segment];
  if (!vertical(segment)) throw new Error(`Routed gap on ${link.id} crosses reserved lane ${lanes[0]!.id} sideways`);
  if (lanes.some(lane => Math.abs(segment.from.x - lane.x) > EPS)) {
    throw new Error(`Routed gap on ${link.id} enters reserved lane ${lanes[0]!.id} off its centre`);
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
  if (simplified.length < 2) throw new Error(`Router returned no usable route for ${link.id}`);
  if (!samePoint(simplified[0]!, from) || !samePoint(simplified.at(-1)!, to)) {
    throw new Error(`Routed gap on ${link.id} does not meet its reserved endpoints`);
  }
  const owner = { kind: 'link' as const, id: link.id };
  return simplified.slice(1).flatMap((point, index) => {
    const segment = { from: { ...simplified[index]! }, to: { ...point }, owner: { ...owner } };
    if (!Number.isFinite(segment.to.x) || !Number.isFinite(segment.to.y)) throw new Error(`Routed gap on ${link.id} is not finite`);
    if (!horizontal(segment) && !vertical(segment)) throw new Error(`Routed gap on ${link.id} is not orthogonal`);
    if (length(segment) <= EPS) throw new Error(`Routed gap on ${link.id} has a zero-length segment`);
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
    // An allocated tier-gap run leaves a lane terminal, so it names the corridor it starts in
    // exactly as the routed gap it replaces did.
    if (piece.kind === 'allocated') { add(clone(piece.segments).flatMap(segment => laneRuns(model, link, segment)), false); continue; }
    const points = routes.get(piece.connector);
    if (!points) throw new Error(`Router returned no route for ${piece.connector}`);
    const connector = plan.connectors.find(item => item.id === piece.connector)!;
    if (!checkpointsHonoured(points, connector.checkpoints)) {
      throw new Error(`Router skipped a required checkpoint on ${piece.connector}`);
    }
    add(gapSegments(model, link, points, piece.from, piece.to), false);
  }
  return { owner: { ...link.owner }, layer: 'routed', fixed: false, segments: joinSeams(segments, claimed),
    ...pathStrokeWidth(link) };
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

export function stitchPaths(model: LayoutModel, plan: RoutePlan, routes: Map<string, Point[]>): RoutedLinkPath[] {
  const result: RoutedLinkPath[] = plan.links.map(item => ({ link: item.link, path: stitchPath(model, item, routes) }));
  // An overlay link never enters the router: its path is derived from the boxes placement reserved,
  // so stage 8 only publishes what `src/layout/overlay-paths.ts` states. One index serves them all.
  const blockers = plan.overlay.length ? overlayBlockers(model) : undefined;
  for (const id of plan.overlay) {
    result.push({ link: id, path: overlayPath(model, model.links.find(link => link.id === id)!, blockers) });
  }
  return result;
}

/**
 * Distinct tier bands the polyline passes through, excluding the two endpoint tiers and repeated
 * visits. A transit is measured by the band's vertical extent, not its rectangle: a reserved lane
 * sits in the margin beside its tier, so the route crosses that tier without entering its box.
 */
export function crossedTiers(model: LayoutModel, link: LayoutLink): number {
  const tierOf = (node: string): number | undefined => model.groups[model.document.nodes[node]!.group]?.tier;
  const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
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
