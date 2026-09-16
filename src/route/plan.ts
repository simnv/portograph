import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { GROUP_LABEL_GEOMETRY, nudgingDistance, routedStroke } from '../layout/bands.js';
import { legReservation, stemPlan, type GapPlan } from '../layout/sides-two.js';
import { allocateGapRuns } from '../layout/gap-runs.js';
import { findPort, straightCorridorClear } from '../layout/row-paths.js';
import { portId } from '../layout/skeleton-graph.js';
import { EPS, samePoint, segmentRect } from '../score/geometry.js';
import { disjointShapes } from './containment.js';
export { disjointShapes } from './containment.js';
import { completedRouteObstacles, reservedRunObstacles, routeObstacles, type RouteObstacle } from './obstacles.js';
import { ALL_DIRECTIONS, DIRECTION_BITS, type RouteBatch, type RouteCheckpoint, type RouteConnector, type RouteEndpoint, type RoutePin, type RouteShape } from './types.js';

/** Shape buffer stays at zero; every obstacle already carries its exact clearance. */
export const SHAPE_BUFFER_DISTANCE = 0;
const OUTWARD: Record<Side, Point> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * One piece of a stitched path: reserved geometry kept exactly, a tier-gap run this pass allocated,
 * a straight run this pass claimed, or a gap the router fills. An allocated or claimed run is
 * reserved the same way, but it is not a claim the lanes rule wrote on the model, so the stitcher
 * annotates it against the lanes it meets exactly as it annotates a routed gap.
 */
export type RoutePiece =
  | { kind: 'reserved'; segments: PathSegment[] }
  | { kind: 'allocated'; segments: PathSegment[] }
  | { kind: 'straight'; segments: PathSegment[] }
  | { kind: 'gap'; connector: string; from: Point; to: Point };

export interface LinkPlan {
  link: string;
  pieces: RoutePiece[];
  connectors: RouteConnector[];
  /** The two nodes this link attaches to, shared-run ends included. */
  nodes: string[];
  /** The node sides it attaches to, as `node|side`, a shared-run end included. */
  sides: string[];
  /** Obstacle IDs this link already owns; two links may share a batch only when these agree. */
  exclusions: string[];
}
/** One link's reserved outward stem at one attachment, with the clearance a reserved run carries. */
export interface StemReservation { link: string; node: string; side: Side; bounds: Rect }

export interface RoutePlan {
  /** Routed links with no path after stage 7f, in model order. These need libavoid. */
  remainders: string[];
  /** Overlay links that receive a straight unrouted segment; they never reach the router. */
  overlay: string[];
  links: LinkPlan[];
  batches: { id: string; links: string[] }[];
  obstacles: RouteObstacle[];
  /** Reserved outward stems, in plan order; a batch avoids those of the links still to be routed. */
  stems: StemReservation[];
  /** libavoid parameters for this diagram (`routeParameters`). */
  parameters: Record<string, number>;
}

/** Prefer fewer bends; libavoid stays deterministic for any fixed parameter set. */
export const ROUTE_PARAMETERS: Record<string, number> = { segmentPenalty: 50 };

/**
 * libavoid parameters for one diagram. Two remainders routed in one batch that turn side by side are
 * nudged apart by `idealNudgingDistance`; its default of 4 px is below G6's 10 px, so the distance is
 * the gate clearance plus the widest routed stroke (ADR-0015 rule 2). That is the clearance the gate
 * demands, not rule 1's wider nested-stem pitch, which placement reserves in the row gap. Placement
 * reads the same figure through `nudgingDistance`.
 */
export function routeParameters(model: LayoutModel): Record<string, number> {
  return { ...ROUTE_PARAMETERS, idealNudgingDistance: nudgingDistance(model) };
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

/**
 * The point a route must reach outside every obstacle before it may turn. A port whose link is a
 * leg in a row gap reaches its own reserved slot (ADR-0015 rule 1); every other port keeps the
 * plain reach.
 */
export function stemCheckpoint(model: LayoutModel, port: LayoutPort, cache?: Map<string, GapPlan | undefined>): Point {
  const reach = stemPlan(model, port, cache).depth, delta = OUTWARD[port.side!];
  return { x: port.anchor!.x + reach * delta.x, y: port.anchor!.y + reach * delta.y };
}

function endpointFor(model: LayoutModel, link: LayoutLink, end: 'from' | 'to',
  pins: Map<string, RoutePin[]>, usage: Map<string, number>,
  cache: Map<string, GapPlan | undefined>): { endpoint: RouteEndpoint; point: Point; directions: number; checkpoint?: Point; port?: LayoutPort } {
  const runs = link.sharedRuns?.[end];
  if (runs?.length) {
    const terminal = runs.at(-1)!.to;
    return { endpoint: { kind: 'point', x: terminal.x, y: terminal.y }, point: { ...terminal }, directions: ALL_DIRECTIONS };
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
    directions: DIRECTION_BITS[port.side!], checkpoint: stemCheckpoint(model, port, cache), port };
}

/**
 * Plan stage 8 without touching the model: which links the router owns, which reserved runs it
 * must stitch around, which obstacles each link already owns, and the ownership batches that
 * follow from those exclusions.
 */
export function planRoute(model: LayoutModel): RoutePlan {
  const obstacles = routeObstacles(model);
  // One gap plan per row gap for the whole pass: placement is frozen here, and recomputing it per
  // link end is cubic in the size of a turning cohort.
  const gaps = new Map<string, GapPlan | undefined>();
  // A leg's run is derived here rather than stored on the link, because `fixedSegments` belongs to
  // the lanes rule, which runs long before this geometry exists. It is still a reserved run, so it
  // is an obstacle to every link but its own from the start — a batch that ran earlier, or one this
  // link shares, would otherwise be free to cross geometry the stitcher inserts verbatim.
  const legs = new Map<string, PathSegment>();
  // Every reserved run a claim must keep out of: the ones the model already holds — a pinned path,
  // a lane run, an outward shared prefix — and the ones this pass adds as it goes, a leg, a tier-gap
  // allocation and an earlier claim. `straightCorridorClear` reads a link's `path` and
  // `fixedSegments` only, so a shared run is invisible to it although the router is walled by one;
  // this is the set with the margins the router is given, and the claim is judged by both.
  const reserved: RouteObstacle[] = reservedRunObstacles(model);
  const reserve = (items: RouteObstacle[]): void => { obstacles.push(...items); reserved.push(...items); };
  for (const link of model.links) {
    const leg = drawn(link) && !link.path ? legReservation(model, link, gaps) : undefined;
    if (!leg) continue;
    legs.set(link.id, leg);
    reserve(completedRouteObstacles(model, link, `leg:${link.id}`, [leg.from, leg.to]));
  }
  // The tier gaps a transit link crosses are allocated the same way and for the same reason
  // (ADR-0015 rule 1): the room is reserved before the first batch runs, so no batch can consume
  // the corridor another link's own lane opens into.
  const gapRuns = new Map<string, Map<number, PathSegment[]>>();
  for (const run of allocateGapRuns(model)) {
    // A link that turns in a row gap holds one reserved run, and its leg is that one. `gapPlan`
    // declines a gap whose legs own a lane, so the two never meet; this keeps the obstacle set and
    // the stitched pieces agreed if they ever do.
    if (legs.has(run.link)) continue;
    const link = model.links.find(item => item.id === run.link)!;
    const runs = gapRuns.get(run.link) ?? new Map<number, PathSegment[]>();
    runs.set(run.index, run.segments);
    gapRuns.set(run.link, runs);
    const points = [run.segments[0]!.from, ...run.segments.map(segment => segment.to)];
    // `completedRouteObstacles` covers one rectangle per segment, in order, and trims only an end
    // that is the link's own port anchor — an allocated run has neither. A link that must cross the
    // gap is given the row and nothing else; a rectangle whose segment cannot be identified keeps
    // the full protection.
    const covers = completedRouteObstacles(model, link, `gap:${run.link}:${run.index}`, points);
    const paired = covers.length === run.segments.length;
    for (const [index, item] of covers.entries()) {
      const segment = run.segments[index]!;
      const across = paired && Math.abs(segment.from.y - segment.to.y) < 1e-9;
      // The owner's own route reaches this run at its two terminals and nowhere else. The end
      // rectangles therefore keep it as a consumer, so the gap beside the run can start inside one
      // of them; the rectangles between do not, or the owner's other gaps could run along the run
      // the stitcher inserts verbatim.
      const terminal = index === 0 || index === covers.length - 1;
      reserve([{ ...item, consumers: [...(terminal ? item.consumers : []), ...(across ? run.crossers : [])] }]);
    }
  }
  const usage = portUsage(model), pins = new Map<string, RoutePin[]>();
  const remainders: string[] = [], overlay: string[] = [], links: LinkPlan[] = [], stems: StemReservation[] = [];
  for (const link of model.links) {
    if (link.path || !drawn(link)) continue;
    if (effectiveLayer(link) === 'overlay') { overlay.push(link.id); continue; }
    remainders.push(link.id);
    const from = endpointFor(model, link, 'from', pins, usage, gaps);
    const to = endpointFor(model, link, 'to', pins, usage, gaps);
    // A leg turning in a row gap reserves its run, exactly as a lane does, and stage 8 stitches the
    // gaps around it (ADR-0015 rule 1). `gapPlan` declines a gap whose legs already own a lane, so
    // the two reservations never meet and the traversal order stays the one the lanes rule wrote.
    const leg = legs.get(link.id);
    const woven = leg ? { segments: [...(link.fixedSegments ?? []), leg], allocated: new Set<number>() }
      : interleave(link.fixedSegments ?? [], gapRuns.get(link.id));
    const fixed = woven.segments;
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
        // head-on: one approach checkpoint the standard stem away, outside the reservation. Each
        // checkpoint carries the reach placement reserved for it, from the terminal it belongs to.
        const asked: { checkpoint: RouteCheckpoint; terminal: Point; node?: string; side?: Side }[] = [
          ...(first && from.checkpoint ? [{ checkpoint: { ...from.checkpoint, arrival: DIRECTION_BITS[OPPOSITE[from.port!.side!]], departure: ALL_DIRECTIONS },
            terminal: from.point, node: from.port!.ref.node, side: from.port!.side! }] : []),
          // Only a lane is a corridor that admits its owner's run alone, so only a lane asks the gap
          // beside it to join head-on. A leg's run is entered from the side by construction — the
          // stem reaches its slot and turns into it — and an approach point on the leg's own line
          // is one the router cannot reach (ADR-0015 rule 1).
          ...(first || fixed[index - 1]!.lane === undefined ? [] : [{ checkpoint: approachCheckpoint(fixed[index - 1]!, 'to'), terminal: fixed[index - 1]!.to }]),
          ...(last || fixed[index]!.lane === undefined ? [] : [{ checkpoint: approachCheckpoint(fixed[index]!, 'from'), terminal: fixed[index]!.from }]),
          ...(last && to.checkpoint ? [{ checkpoint: { ...to.checkpoint, arrival: ALL_DIRECTIONS, departure: DIRECTION_BITS[OPPOSITE[to.port!.side!]] },
            terminal: to.point, node: to.port!.ref.node, side: to.port!.side! }] : []),
          // A checkpoint the adjacent reserved run already passes through, head-on and strictly
          // inside a segment, is consumed by that run: a junction leaf that reaches deeper than a
          // lane's approach point has honoured it, and the gap starting at the leaf could only
          // reach it by turning back (ticket 20).
        ].filter(item => !reservedPasses(first ? link.sharedRuns?.from : last ? link.sharedRuns?.to : undefined, item.checkpoint));
        // A piece the router has nothing to choose about is claimed here instead of asked for: its
        // two ends and every checkpoint stand on one line, and the run between them is clear of
        // everything placement froze. See `straightRun`.
        const run = straightRun(start.point, end.point, first ? from.directions : ALL_DIRECTIONS,
          last ? to.directions : ALL_DIRECTIONS, asked.map(item => item.checkpoint));
        // Only the pin ends of this piece are its own. A piece that begins or ends at a reserved
        // terminal has no attachment there, and the node behind that end is foreign geometry it
        // must keep out of — it can stand between the two ends of the piece.
        const pins = [...(first && from.port ? [from.port] : []), ...(last && to.port ? [to.port] : [])];
        const attached = { nodes: pins.map(port => port.ref.node), ports: pins.map(port => portId(port.ref)) };
        if (run && corridorFree(model, link, run, attached, reserved)) {
          pieces.push({ kind: 'straight', segments: [{ ...run, owner: { kind: 'link' as const, id: link.id } }] });
          reserve(completedRouteObstacles(model, link, id, [run.from, run.to])
            .map((cover, at) => ({ ...cover, id: `straight:${id}:${at}` })));
        } else {
          // Only an attachment stem is reserved against the batches still to run. Reserving the lane
          // approach as well was measured and left out; see `.scratch/stress/issues/02`.
          for (const item of asked) {
            if (item.node === undefined || item.side === undefined) continue;
            stems.push({ link: link.id, node: item.node, side: item.side,
              bounds: stemBounds(model, link, item.terminal, item.checkpoint) });
          }
          connectors.push({ id, from: start.endpoint, to: end.endpoint, checkpoints: asked.map(item => item.checkpoint) });
          pieces.push({ kind: 'gap', connector: id, from: start.point, to: end.point });
        }
      }
      if (!last) pieces.push({ kind: woven.allocated.has(index) ? 'allocated' : 'reserved', segments: [fixed[index]!] });
    }
    if (link.sharedRuns?.to?.length) pieces.push({ kind: 'reserved', segments: reversedRuns(link.sharedRuns.to) });
    links.push({ link: link.id, pieces, connectors, exclusions: [],
      nodes: [link.attachments!.from.node, link.attachments!.to.node],
      // Read from the link, not from the endpoints: an end that consumes a shared run reserves no
      // stem of its own, and its node side is still shared space its batch may use.
      sides: (['from', 'to'] as const).flatMap(end => {
        const side = findPort(model, link.attachments![end])?.side;
        return side === undefined ? [] : [`${link.attachments![end].node}|${side}`];
      }) });
  }
  for (const [node, list] of pins) {
    const shape = obstacles.find(item => item.id === `node:${node}`);
    if (shape) shape.pins = [...list].sort((a, b) => a.classId - b.classId);
  }
  // The exclusions are read after the link loop, because a straight piece claimed inside it adds a
  // cover its own link must pass through: the gap beyond such a piece starts at the piece's own
  // terminal, which lies inside that cover wherever the terminal is not a port anchor.
  const owned = new Map<string, string[]>();
  for (const item of obstacles) for (const consumer of item.consumers) {
    owned.set(consumer, [...(owned.get(consumer) ?? []), item.id]);
  }
  for (const plan of links) plan.exclusions = [...(owned.get(plan.link) ?? [])].sort();
  const batches = new Map<string, string[]>();
  // A link whose every piece is reserved asks the router for nothing, so it joins no batch and a
  // diagram made only of such links never loads the WASM.
  for (const plan of links) {
    if (!plan.connectors.length) continue;
    const key = JSON.stringify(plan.exclusions);
    batches.set(key, [...(batches.get(key) ?? []), plan.link]);
  }
  return { remainders, overlay, links, obstacles, stems, parameters: routeParameters(model),
    batches: [...batches.values()].map((ids, index) => ({ id: `batch-${index}`, links: ids })) };
}

/**
 * The straight run a planned gap can only be, or `undefined` when the router still has a choice.
 *
 * A gap qualifies when its two ends stand on one axis-aligned line, both ends may travel along it,
 * and every checkpoint it would have asked for stands on that same line, between the ends, in the
 * order asked and with masks that line allows. There is then exactly one route, and stage 8 reads
 * it rather than discovering it: placement fixed both ends, so the run is a reservation, and the
 * pipeline's load-bearing rule keeps a reservation out of the router. Stage 7f already reserves the
 * corridor of a collinear top/bottom feed against its group labels for this very reason.
 *
 * This is the host's own form of `directRoute` in `runtime/avoid-worker.mjs`, which asks the same
 * question of the same numbers. The worker asks it to omit redundant hints; the host asks it to
 * keep the piece out of the batch, because an earlier ownership batch is otherwise free to lay its
 * own route across the corridor. libavoid then cannot reach the checkpoint, drops it without a
 * word, and answers with the two port anchors and a diagonal between them.
 */
function straightRun(from: Point, to: Point, fromDirections: number, toDirections: number,
  checkpoints: RouteCheckpoint[]): PathSegment | undefined {
  const alongY = Math.abs(from.x - to.x) <= EPS, alongX = Math.abs(from.y - to.y) <= EPS;
  // Both true is a zero-length gap and neither is a gap that has to turn; only one line qualifies.
  if (alongY === alongX) return undefined;
  const axis = alongY ? 'y' : 'x', cross = alongY ? 'x' : 'y';
  const travel = alongY ? (to.y > from.y ? DIRECTION_BITS.bottom : DIRECTION_BITS.top)
    : (to.x > from.x ? DIRECTION_BITS.right : DIRECTION_BITS.left);
  const back = OPPOSITE_BIT[travel]!;
  if (!(fromDirections & travel) || !(toDirections & back)) return undefined;
  const sign = Math.sign(to[axis] - from[axis]), span = Math.abs(to[axis] - from[axis]);
  let cursor = 0;
  for (const checkpoint of checkpoints) {
    const reached = (checkpoint[axis] - from[axis]) * sign;
    if (Math.abs(checkpoint[cross] - from[cross]) > EPS || reached < cursor - EPS || reached > span + EPS
      || !(checkpoint.arrival & back) || !(checkpoint.departure & travel)) return undefined;
    cursor = reached;
  }
  return { from: { ...from }, to: { ...to }, owner: { kind: 'link' as const, id: '' } };
}

/**
 * Whether a candidate straight run holds every clearance the final gates measure. Frozen placement
 * is judged by `straightCorridorClear`, the same predicate the rows rule and stage 7f's feed
 * corridor use, so a corridor 7f reserved against its labels is the corridor claimed here. The runs
 * this pass has already reserved are judged by their own covers: a leg, a tier-gap allocation and
 * an earlier claim each carry the clearance a reserved run carries, and a run allowed to cross one
 * of them stands among its consumers (ADR-0015 rule 3).
 */
function corridorFree(model: LayoutModel, link: LayoutLink, run: PathSegment,
  attached: { nodes: string[]; ports: string[] }, reserved: RouteObstacle[]): boolean {
  const segment: PathSegment = { ...run, owner: { kind: 'link', id: link.id } };
  // The cover scan first: it is a rectangle test per reservation, where the predicate below measures
  // every node, pill, label, lane, group box and reserved run in the diagram.
  if (reserved.some(item => !item.consumers.includes(link.id) && segmentRect(segment, item.bounds))) return false;
  // Measured at the widest routed stroke, not this link's own. `routeObstacles` and
  // `reservationConflicts` expand every reservation by that width, so a thin link measured at its
  // own could be claimed inside the band the router would have kept clear and then be refused by
  // `Routed path on ... enters reserved ...` after the fact.
  return straightCorridorClear(model, link, segment, { attached, stroke: Math.max(linkStrokeWidth(link), routedStroke(model)) });
}

/**
 * The rectangle one reserved outward stem occupies, with the clearance every reserved run carries.
 * Placement reserves that stem; the router must keep a foreign centreline out of it, or a later
 * batch finds its own reservation already taken and has no route left to ask for.
 */
function stemBounds(model: LayoutModel, link: LayoutLink, terminal: Point, checkpoint: Point): Rect {
  const clearance = GROUP_LABEL_GEOMETRY.nodeClearance + (linkStrokeWidth(link) + routedStroke(model)) / 2;
  const x = Math.min(terminal.x, checkpoint.x) - clearance, y = Math.min(terminal.y, checkpoint.y) - clearance;
  return { x, y, width: Math.abs(checkpoint.x - terminal.x) + 2 * clearance,
    height: Math.abs(checkpoint.y - terminal.y) + 2 * clearance };
}

/**
 * The reserved stems a batch must leave alone: those of the links no batch has routed yet. An
 * earlier batch is otherwise free to run through the outward stem of a link it has never seen, and
 * that link then has no route to its own port.
 *
 * A stem on a node **side** this batch also attaches to is left out, because two ports of one node
 * side share that strip and a rectangle over one of them blocks the other. A port on another side
 * of the same node stands in its own strip and keeps its reservation. The attachment is read from
 * the link, not from the stems, because an end that consumes a shared run starts at the run's
 * terminal and reserves no stem of its own.
 */
export function pendingStemObstacles(plan: RoutePlan, batch: { links: string[] }, pending: Set<string>): RouteObstacle[] {
  const sides = new Set(plan.links.filter(item => batch.links.includes(item.link)).flatMap(item => item.sides));
  return plan.stems.flatMap((stem, index) => pending.has(stem.link) && !sides.has(`${stem.node}|${stem.side}`)
    ? [{ id: `stem:${index}:${stem.link}`, bounds: stem.bounds, consumers: [] }] : []);
}

const asPoint = (point: Point): RouteEndpoint => ({ kind: 'point', x: point.x, y: point.y });

/**
 * One link's reserved runs in traversal order: the lane runs the lanes rule fixed, each preceded by
 * the tier-gap run allocated for the planned gap that leads into it, and the last allocation after
 * them all. A gap the allocation declined contributes nothing and the router still fills it.
 */
function interleave(fixed: PathSegment[], runs: Map<number, PathSegment[]> | undefined):
{ segments: PathSegment[]; allocated: Set<number> } {
  const allocated = new Set<number>();
  if (!runs?.size) return { segments: fixed, allocated };
  const segments: PathSegment[] = [];
  for (let index = 0; index <= fixed.length; index++) {
    for (const run of runs.get(index) ?? []) { allocated.add(segments.length); segments.push(run); }
    if (index < fixed.length) segments.push(fixed[index]!);
  }
  return { segments, allocated };
}

/**
 * Whether the reserved runs adjacent to a gap pass through a checkpoint strictly inside one of their
 * segments, travelling along the axis the checkpoint has to be arrived at on. Only such a
 * checkpoint is consumed: one at a run's endpoint, or crossed sideways, still binds the gap.
 */
function reservedPasses(runs: PathSegment[] | undefined, checkpoint: RouteCheckpoint): boolean {
  if (!runs) return false;
  // The axis the checkpoint pins: its departure when constrained (a lane approach departs into the
  // lane), else its arrival. A checkpoint free in every direction pins no axis and is never consumed.
  const pinned = checkpoint.departure !== ALL_DIRECTIONS ? checkpoint.departure : checkpoint.arrival;
  const vertical = (pinned & (DIRECTION_BITS.top | DIRECTION_BITS.bottom)) !== 0
    && (pinned & (DIRECTION_BITS.left | DIRECTION_BITS.right)) === 0;
  const horizontal = (pinned & (DIRECTION_BITS.left | DIRECTION_BITS.right)) !== 0
    && (pinned & (DIRECTION_BITS.top | DIRECTION_BITS.bottom)) === 0;
  return runs.some(segment => {
    const alongY = Math.abs(segment.from.x - segment.to.x) < 1e-6, alongX = Math.abs(segment.from.y - segment.to.y) < 1e-6;
    if (alongY && !vertical) return false;
    if (alongX && !horizontal) return false;
    if (alongY) {
      const low = Math.min(segment.from.y, segment.to.y), high = Math.max(segment.from.y, segment.to.y);
      return Math.abs(checkpoint.x - segment.from.x) < 1e-6 && checkpoint.y > low + 1e-6 && checkpoint.y < high - 1e-6;
    }
    if (alongX) {
      const low = Math.min(segment.from.x, segment.to.x), high = Math.max(segment.from.x, segment.to.x);
      return Math.abs(checkpoint.y - segment.from.y) < 1e-6 && checkpoint.x > low + 1e-6 && checkpoint.x < high - 1e-6;
    }
    return false;
  });
}
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
  const connectors = batch.links.flatMap(id => plan.links.find(item => item.link === id)!.connectors);
  // A pin matters to this batch only when one of its connectors ends there; a pinned node that
  // another batch attaches to is a plain obstacle here, so a foreign group box may cover it.
  const targeted = new Set(connectors.flatMap(c => [c.from, c.to]).flatMap(e => e.kind === 'pin' ? [`${e.shape}#${e.classId}`] : []));
  const shapes: RouteShape[] = [...plan.obstacles, ...extra].filter(item => !excluded.has(item.id)).map(item => {
    const pins = item.pins?.filter(pin => targeted.has(`${item.id}#${pin.classId}`));
    return pins?.length ? { id: item.id, bounds: item.bounds, pins } : { id: item.id, bounds: item.bounds };
  });
  return { id: batch.id, shapeBufferDistance: SHAPE_BUFFER_DISTANCE, parameters: plan.parameters,
    shapes: disjointShapes(shapes), connectors };
}
