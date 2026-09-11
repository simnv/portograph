import type { Point, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { GROUP_LABEL_GEOMETRY, stemReach } from '../layout/bands.js';
import { findPort } from '../layout/row-paths.js';
import { portId } from '../layout/skeleton-graph.js';
import { samePoint } from '../score/geometry.js';
import { disjointShapes } from './containment.js';
export { disjointShapes } from './containment.js';
import { routeObstacles, type RouteObstacle } from './obstacles.js';
import { ALL_DIRECTIONS, DIRECTION_BITS, type RouteBatch, type RouteCheckpoint, type RouteConnector, type RouteEndpoint, type RoutePin, type RouteShape } from './types.js';

/** Shape buffer stays at zero; every obstacle already carries its exact clearance. */
export const SHAPE_BUFFER_DISTANCE = 0;
/** Prefer fewer bends; libavoid stays deterministic for any fixed parameter set. */
export const ROUTE_PARAMETERS: Record<string, number> = { segmentPenalty: 50 };

const OUTWARD: Record<Side, Point> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** One piece of a stitched path: reserved geometry kept exactly, or a gap the router fills. */
export type RoutePiece =
  | { kind: 'reserved'; segments: PathSegment[] }
  | { kind: 'gap'; connector: string; from: Point; to: Point };

export interface LinkPlan {
  link: string;
  pieces: RoutePiece[];
  connectors: RouteConnector[];
  /** Obstacle IDs this link already owns; two links may share a batch only when these agree. */
  exclusions: string[];
}
export interface RoutePlan {
  /** Routed links with no path after stage 7f, in model order. These need libavoid. */
  remainders: string[];
  /** Overlay links that receive a straight unrouted segment; they never reach the router. */
  overlay: string[];
  links: LinkPlan[];
  batches: { id: string; links: string[] }[];
  obstacles: RouteObstacle[];
}

export const effectiveLayer = (link: LayoutLink): 'routed' | 'overlay' => link.layer ?? link.family ?? 'routed';
const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.attachments !== undefined;

/** Ports carrying more than one link end cannot hold an exclusive pin, fixed ends included. */
function portUsage(model: LayoutModel): Map<string, number> {
  const usage = new Map<string, number>();
  for (const link of model.links) {
    if (!drawn(link) || effectiveLayer(link) !== 'routed') continue;
    for (const end of ['from', 'to'] as const) {
      const key = portId(link.attachments![end]);
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }
  return usage;
}

/** The point a route must reach outside every obstacle before it may turn. */
export function stemCheckpoint(model: LayoutModel, port: LayoutPort): Point {
  const reach = stemReach(model, model.nodes[port.ref.node]!), delta = OUTWARD[port.side!];
  return { x: port.anchor!.x + reach * delta.x, y: port.anchor!.y + reach * delta.y };
}

function endpointFor(model: LayoutModel, link: LayoutLink, end: 'from' | 'to',
  pins: Map<string, RoutePin[]>, usage: Map<string, number>): { endpoint: RouteEndpoint; point: Point; checkpoint?: Point; port?: LayoutPort } {
  const runs = link.sharedRuns?.[end];
  if (runs?.length) {
    const terminal = runs.at(-1)!.to;
    return { endpoint: { kind: 'point', x: terminal.x, y: terminal.y }, point: { ...terminal } };
  }
  const ref = link.attachments![end], port = findPort(model, ref)!;
  const node = model.nodes[ref.node]!;
  const classId = node.ports.indexOf(port) + 1;
  const list = pins.get(ref.node) ?? [];
  if (!list.some(pin => pin.classId === classId)) {
    list.push({ classId, x: port.anchor!.x, y: port.anchor!.y,
      directions: DIRECTION_BITS[port.side!], exclusive: (usage.get(portId(ref)) ?? 0) <= 1 });
    pins.set(ref.node, list);
  }
  return { endpoint: { kind: 'pin', shape: `node:${ref.node}`, classId }, point: { ...port.anchor! },
    checkpoint: stemCheckpoint(model, port), port };
}

/**
 * Plan stage 8 without touching the model: which links the router owns, which reserved runs it
 * must stitch around, which obstacles each link already owns, and the ownership batches that
 * follow from those exclusions.
 */
export function planRoute(model: LayoutModel): RoutePlan {
  const obstacles = routeObstacles(model);
  const owned = new Map<string, string[]>();
  for (const item of obstacles) for (const consumer of item.consumers) {
    owned.set(consumer, [...(owned.get(consumer) ?? []), item.id]);
  }
  const usage = portUsage(model), pins = new Map<string, RoutePin[]>();
  const remainders: string[] = [], overlay: string[] = [], links: LinkPlan[] = [];
  for (const link of model.links) {
    if (link.path || !drawn(link)) continue;
    if (effectiveLayer(link) === 'overlay') { overlay.push(link.id); continue; }
    remainders.push(link.id);
    const from = endpointFor(model, link, 'from', pins, usage);
    const to = endpointFor(model, link, 'to', pins, usage);
    const fixed = link.fixedSegments ?? [];
    const stops: { endpoint: RouteEndpoint; point: Point }[] = [
      { endpoint: from.endpoint, point: from.point },
      ...fixed.flatMap(segment => [{ endpoint: asPoint(segment.from), point: segment.from },
        { endpoint: asPoint(segment.to), point: segment.to }]),
      { endpoint: to.endpoint, point: to.point },
    ];
    const pieces: RoutePiece[] = [], connectors: RouteConnector[] = [];
    if (link.sharedRuns?.from?.length) pieces.push({ kind: 'reserved', segments: link.sharedRuns.from });
    for (let index = 0; index * 2 < stops.length - 1; index++) {
      const start = stops[index * 2]!, end = stops[index * 2 + 1]!;
      const first = index === 0, last = index * 2 + 2 === stops.length;
      if (!(start.endpoint.kind === 'point' && end.endpoint.kind === 'point' && samePoint(start.point, end.point))) {
        const id = `${link.id}#${index}`;
        // A reserved corridor admits only its owner's collinear run, so the gap beside it joins
        // head-on: one approach checkpoint the standard stem away, outside the reservation.
        const checkpoints = [
          ...(first && from.checkpoint ? [{ ...from.checkpoint, arrival: DIRECTION_BITS[OPPOSITE[from.port!.side!]], departure: ALL_DIRECTIONS }] : []),
          ...(first ? [] : [approachCheckpoint(fixed[index - 1]!, 'to')]),
          ...(last ? [] : [approachCheckpoint(fixed[index]!, 'from')]),
          ...(last && to.checkpoint ? [{ ...to.checkpoint, arrival: ALL_DIRECTIONS, departure: DIRECTION_BITS[OPPOSITE[to.port!.side!]] }] : []),
        ];
        connectors.push({ id, from: start.endpoint, to: end.endpoint, checkpoints });
        pieces.push({ kind: 'gap', connector: id, from: start.point, to: end.point });
      }
      if (!last) pieces.push({ kind: 'reserved', segments: [fixed[index]!] });
    }
    if (link.sharedRuns?.to?.length) pieces.push({ kind: 'reserved', segments: reversedRuns(link.sharedRuns.to) });
    const exclusions = [...(owned.get(link.id) ?? [])].sort();
    links.push({ link: link.id, pieces, connectors, exclusions });
  }
  for (const [node, list] of pins) {
    const shape = obstacles.find(item => item.id === `node:${node}`);
    if (shape) shape.pins = [...list].sort((a, b) => a.classId - b.classId);
  }
  const batches = new Map<string, string[]>();
  for (const plan of links) {
    const key = JSON.stringify(plan.exclusions);
    batches.set(key, [...(batches.get(key) ?? []), plan.link]);
  }
  return { remainders, overlay, links, obstacles,
    batches: [...batches.values()].map((ids, index) => ({ id: `batch-${index}`, links: ids })) };
}

const asPoint = (point: Point): RouteEndpoint => ({ kind: 'point', x: point.x, y: point.y });
const OPPOSITE_BIT: Record<number, number> = { 1: 2, 2: 1, 4: 8, 8: 4 };
/**
 * Where a routed gap joins a reserved run head-on: one checkpoint on the run's own line, the
 * standard stem outside the reservation, entered and left along that line. libavoid skips a
 * checkpoint it cannot reach, and stage 8 then rejects the route rather than let it occupy the
 * corridor sideways.
 */
function approachCheckpoint(run: PathSegment, end: 'from' | 'to'): RouteCheckpoint {
  const dx = run.to.x - run.from.x, dy = run.to.y - run.from.y;
  const span = Math.hypot(dx, dy) || 1;
  const travel = dy > 1e-9 ? DIRECTION_BITS.bottom : dy < -1e-9 ? DIRECTION_BITS.top
    : dx > 0 ? DIRECTION_BITS.right : DIRECTION_BITS.left;
  // Leaving `run.to` continues the run's direction; reaching `run.from` heads back into it. Only
  // the side facing the corridor is constrained, so the gap stays free to turn away afterwards.
  const sign = end === 'to' ? 1 : -1, reach = GROUP_LABEL_GEOMETRY.routerStem;
  return { x: run[end].x + sign * reach * dx / span, y: run[end].y + sign * reach * dy / span,
    arrival: end === 'to' ? OPPOSITE_BIT[travel]! : ALL_DIRECTIONS,
    departure: end === 'to' ? ALL_DIRECTIONS : travel };
}
/** An outward target prefix traverses backwards in the final source-to-target path. */
export const reversedRuns = (segments: PathSegment[]): PathSegment[] =>
  [...segments].reverse().map(segment => ({ ...segment, from: { ...segment.to }, to: { ...segment.from } }));

/** The serializable batch: every obstacle except the ones this batch's links already own. */
export function batchRequest(plan: RoutePlan, batch: { id: string; links: string[] }, extra: RouteObstacle[]): RouteBatch {
  const owner = plan.links.find(item => item.link === batch.links[0]!)!;
  const excluded = new Set(owner.exclusions);
  const shapes: RouteShape[] = [...plan.obstacles, ...extra].filter(item => !excluded.has(item.id))
    .map(item => item.pins?.length ? { id: item.id, bounds: item.bounds, pins: item.pins } : { id: item.id, bounds: item.bounds });
  const connectors = batch.links.flatMap(id => plan.links.find(item => item.link === id)!.connectors);
  return { id: batch.id, shapeBufferDistance: SHAPE_BUFFER_DISTANCE, parameters: ROUTE_PARAMETERS,
    shapes: disjointShapes(shapes), connectors };
}
