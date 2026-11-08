import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { GROUP_LABEL_GEOMETRY, nudgingDistance, routedStroke } from '../layout/bands.js';
import { legReservation, sideNested, stemCache, stemPlan, type StemCache } from '../layout/sides-two.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { edgeMargin } from '../layout/bundle-geometry.js';
import { allocateGapRuns } from '../layout/gap-runs.js';
import { endPort, hasApproach } from '../layout/approach.js';
import { findPort, straightCorridorClear } from '../layout/row-paths.js';
import { portId } from '../layout/skeleton-graph.js';
import { EPS, samePoint, segmentRect } from '../geometry/planar.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { disjointShapes } from './containment.js';
export { disjointShapes } from './containment.js';
import { completedRouteObstacles, reservedRunObstacles, routeObstacles, type RouteObstacle } from './obstacles.js';
import { ALL_DIRECTIONS, DIRECTION_BITS, type RouteBatch, type RouteCheckpoint, type RouteConnector, type RouteEndpoint, type RoutePin, type RouteShape } from './types.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { linkLayer } from '../layout/link-layer.js';
import { exitSide } from '../layout/group-exits.js';

/** Shape buffer stays at zero; every obstacle already carries its exact clearance. */
export const SHAPE_BUFFER_DISTANCE = 0;
/**
 * How far inside a reservation's cover a claim has to reach before the cover refuses it, as the
 * amount `corridorFree` shrinks the cover by before it scans.
 *
 * `segmentRect` grows the rectangle it is given by `EPS` on every side, so shrinking by `EPS` would
 * scan the cover unchanged and a run lying exactly on its edge would still read as inside it. Two
 * `EPS` is the tightest bound that admits the edge itself: the cover refuses a centreline `EPS`
 * (1e-7 px) or more inside it, and admits one within `EPS` of its edge — the coincidence tolerance
 * `same` and the gates use everywhere else. Nothing that bound admits can fail the gate it stands
 * for: a cover is its run grown by `10 + (the two strokes) / 2`, so a centreline less than `EPS`
 * inside it leaves more than `10 − EPS` of visible clearance, and G6 fails at `distance < 10 − EPS`.
 */
const TOUCH = 2 * EPS;
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
  /**
   * `via` is the connector's checkpoints, in order: the points the router must pass between the two ends.
   * `producers` names, for each one, the rule that asked for it (`stem:<port>`, `lane:<lane>`,
   * `entry:<port>`), so a checkpoint the router skips can be reported by what reserved it.
   */
  | { kind: 'gap'; connector: string; from: Point; to: Point; via: Point[]; producers: string[] };

export interface LinkPlan {
  link: string;
  pieces: RoutePiece[];
  connectors: RouteConnector[];
  /** The two nodes this link attaches to, shared-run ends included. */
  nodes: string[];
  /** The node sides it attaches to, as `node|side`, a shared-run end included. */
  sides: string[];
  /** The ports it attaches to, a shared-run end included; the unit a nested side's strip belongs to. */
  ports: string[];
  /** Obstacle IDs this link already owns; two links may share a batch only when these agree. */
  exclusions: string[];
}
/**
 * One link's reserved outward stem at one attachment, with the clearance a reserved run carries.
 * `nested` marks a stem on a node side where placement gave every port a turn depth of its own
 * (ADR-0015 rule 1), so the strip is a corridor one port owns rather than one the side shares.
 */
export interface StemReservation {
  link: string; node: string; side: Side; port: string; nested: boolean;
  /** The stem's cover, with the reach beyond its checkpoint (`reachBeyondCheckpoints`). */
  bounds: Rect;
  /** The stem's centreline, from the port anchor to its checkpoint. */
  segment: Pick<PathSegment, 'from' | 'to'>;
}

/**
 * One routed gap's head-on approach to a lane: the run from the lane terminal to the approach
 * checkpoint, with the clearance a reserved run carries. Placement fixed both points, so it is a
 * reservation like a stem, and the batches before its owner leave it alone (ticket 18).
 */
export interface ApproachReservation {
  link: string; lane: string; bounds: Rect;
  /** The approach's centreline, from the lane terminal to its checkpoint. */
  segment: Pick<PathSegment, 'from' | 'to'>;
}

export interface RoutePlan {
  /**
   * Routed links with no path after stage 7f, in model order. Not every one reaches libavoid: a
   * link every piece of which this stage claims carries no connector and joins no batch.
   */
  remainders: string[];
  /** Overlay links that receive a straight unrouted segment; they never reach the router. */
  overlay: string[];
  links: LinkPlan[];
  batches: { id: string; links: string[] }[];
  obstacles: RouteObstacle[];
  /** Reserved outward stems, in plan order; a batch avoids those of the links still to be routed. */
  stems: StemReservation[];
  /** Reserved lane approaches, in plan order; a batch avoids those of the links still to be routed. */
  approaches: ApproachReservation[];
  /** libavoid parameters for this diagram (`routeParameters`). */
  parameters: Record<string, number>;
  /**
   * The turns inside each tier-gap run this stage stitches unchanged (a row's two ends, a jog, a Z part's middle drop), per link (a set:
   * the order is that of the allocation, by gap). Placement planned them, so none of them is a router detour (`ROUTE_TITLE_DETOUR`, architecture-2 ticket 56). A link with no
   * stitched run has no entry.
   */
  plannedTurns: Map<string, Point[]>;
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

export const effectiveLayer = linkLayer;
const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.removed !== true && link.attachments !== undefined;

/** Ports carrying more than one link end cannot hold an exclusive pin, fixed ends included. */
function portUsage(model: LayoutModel): Map<string, number> {
  const usage = new Map<string, number>();
  for (const link of model.links) {
    if (!drawn(link) || effectiveLayer(link) !== 'routed') continue;
    for (const end of ['from', 'to'] as const) {
      // An end on an approach has a pin of its own on the pill's edge and shares the port with no one (ticket 15, phase 6).
      if (hasApproach(link, end)) continue;
      const key = portId(link.attachments![end]);
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }
  return usage;
}

/**
 * The point a route must reach outside every obstacle before it may turn. A port whose link is a
 * leg in a row gap reaches its own reserved slot (ADR-0015 rule 1); every other port keeps the
 * plain reach, beyond the pill text of its side (`portStemReach`).
 */
export function stemCheckpoint(model: LayoutModel, port: LayoutPort, cache?: StemCache): Point {
  const reach = stemPlan(model, port, cache).depth, delta = OUTWARD[port.side!];
  return { x: port.anchor!.x + reach * delta.x, y: port.anchor!.y + reach * delta.y };
}

function endpointFor(model: LayoutModel, link: LayoutLink, end: 'from' | 'to',
  pins: Map<string, RoutePin[]>, usage: Map<string, number>,
  cache: StemCache): { endpoint: RouteEndpoint; point: Point; directions: number; checkpoint?: Point; port?: LayoutPort } {
  const runs = link.sharedRuns?.[end];
  if (runs?.length) {
    const terminal = runs.at(-1)!.to;
    // A terminal that is the end of a reserved group exit is a handoff: the route leaves it away from the group it left, never back into it.
    const exit = model.groupExits?.find(item => item.link === link.id && item.end === end);
    const directions = exit ? ALL_DIRECTIONS & ~DIRECTION_BITS[OPPOSITE[exitSide(exit)]] : ALL_DIRECTIONS;
    return { endpoint: { kind: 'point', x: terminal.x, y: terminal.y }, point: { ...terminal }, directions };
  }
  const ref = link.attachments![end], port = endPort(model, link, end)!;
  const node = model.nodes[ref.node]!;
  // An approach is a pin of its own on the pill's edge: its class stands beyond every port's.
  const classId = hasApproach(link, end) ? node.ports.length + 1 + link.sourceIndex * 2 + (end === 'to' ? 1 : 0) : node.ports.indexOf(findPort(model, ref)!) + 1;
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
export function planRoute(model: LayoutModel, plans?: Parameters<typeof allocateGapRuns>[1]): RoutePlan {
  const obstacles = routeObstacles(model);
  // One gap plan per row gap for the whole pass: placement is frozen here, and recomputing it per
  // link end is cubic in the size of a turning cohort.
  const gaps = stemCache();
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
  // Planned parts on one port share the leg from the tip to the higher row (tier-gap-rows.md, Section 4): the links of the
  // same port lie on each other's covers there. The plan names them; nothing is written to the model.
  const sharing = new Map<string, Set<string>>();
  for (const run of allocateGapRuns(model, plans)) {
    if (run.shares?.length) sharing.set(run.link, new Set([...sharing.get(run.link) ?? [], ...run.shares]));
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
    const covers = completedRouteObstacles(model, link, `plan:${run.link}:${run.index}`, points);
    const paired = covers.length === run.segments.length;
    for (const [index, item] of covers.entries()) {
      const segment = run.segments[index]!;
      const across = paired && Math.abs(segment.from.y - segment.to.y) < 1e-9;
      // The owner's own route reaches this run at its two terminals and nowhere else. The end
      // rectangles therefore keep it as a consumer, so the gap beside the run can start inside one
      // of them; the rectangles between do not, or the owner's other gaps could run along the run
      // the stitcher inserts verbatim.
      const terminal = index === 0 || index === covers.length - 1;
      reserve([{ ...item, consumers: [...(terminal ? item.consumers : []), ...(across ? run.crossers : []), ...(run.shares ?? []), ...(across ? [] : paired ? run.grants?.[index] ?? [] : [...new Set(run.grants?.flat())])] }]);
    }
  }
  const usage = portUsage(model), pins = new Map<string, RoutePin[]>(), boxes = groupBoxes(model);
  const remainders: string[] = [], overlay: string[] = [], links: LinkPlan[] = [], stems: StemReservation[] = [];
  const approaches: ApproachReservation[] = [];
  const claims: { segment: PathSegment; covers: RouteObstacle[] }[] = [];
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
      // A side run is the lateral port's own stem (side-faces.md, Section 10): it ends on the port's anchor, so the piece between that
      // end and the port is empty and asks for no approach and no stem checkpoint.
      const isSideRun = (segment: PathSegment | undefined): boolean => segment?.lane?.startsWith('side-lane:') === true || segment?.lane?.startsWith('perimeter:') === true || segment?.lane?.startsWith('gap-lane:') === true;
      const onSideRun = samePoint(start.point, end.point) && (isSideRun(fixed[index - 1]) || isSideRun(fixed[index]));
      if (!onSideRun && !(start.endpoint.kind === 'point' && end.endpoint.kind === 'point' && samePoint(start.point, end.point))) {
        const id = `${link.id}#${index}`;
        // A reserved corridor admits only its owner's collinear run, so the gap beside it joins
        // head-on: one approach checkpoint the standard stem away, outside the reservation. Each
        // checkpoint carries the reach placement reserved for it, from the terminal it belongs to.
        const asked: { checkpoint: RouteCheckpoint; terminal: Point; producer: string; node?: string; side?: Side; port?: string }[] = [
          ...(first && from.checkpoint ? [{ checkpoint: { ...from.checkpoint, arrival: DIRECTION_BITS[OPPOSITE[from.port!.side!]], departure: ALL_DIRECTIONS },
            terminal: from.point, producer: `stem:${portId(from.port!.ref)}`, node: from.port!.ref.node, side: from.port!.side!, port: portId(from.port!.ref) }] : []),
          // Only a lane is a corridor that admits its owner's run alone, so only a lane asks the gap
          // beside it to join head-on. A leg's run is entered from the side by construction — the
          // stem reaches its slot and turns into it — and an approach point on the leg's own line
          // is one the router cannot reach (ADR-0015 rule 1).
          ...(first || fixed[index - 1]!.lane === undefined ? [] : [{ checkpoint: approachCheckpoint(fixed[index - 1]!, 'to'), terminal: fixed[index - 1]!.to, producer: `lane:${fixed[index - 1]!.lane}` }]),
          ...(last || fixed[index]!.lane === undefined ? [] : [{ checkpoint: approachCheckpoint(fixed[index]!, 'from'), terminal: fixed[index]!.from, producer: `lane:${fixed[index]!.lane}` }]),
          ...(last && to.checkpoint ? [{ checkpoint: { ...to.checkpoint, arrival: ALL_DIRECTIONS, departure: DIRECTION_BITS[OPPOSITE[to.port!.side!]] },
            terminal: to.point, producer: `stem:${portId(to.port!.ref)}`, node: to.port!.ref.node, side: to.port!.side!, port: portId(to.port!.ref) }] : []),
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
          // `routed:` is `completedRouteObstacles`' own prefix for a chain it was handed, which the
          // leg and the tier-gap allocation carry for the same reason. It names the producer, not
          // the geometry: every cover this pass adds is under it, whoever fixed the run.
          const covers = completedRouteObstacles(model, link, `straight:${id}`, [run.from, run.to]);
          for (const cover of covers) cover.consumers.push(...sharing.get(link.id) ?? []);
          reserve(covers);
          claims.push({ segment: run, covers });
        } else {
          // The router has a choice here, so where a stem ends inside a group the entry across its
          // edge is reserved as well, in traversal order: after the source stem, before the target's.
          if (last && to.checkpoint && asked.at(-1)?.port === portId(to.port!.ref)) {
            asked.splice(asked.length - 1, 0, ...entryCheckpoint(model, link, 'to', to.port!, to.checkpoint, start.point, obstacles, boxes)
              .map(checkpoint => ({ checkpoint, terminal: to.point, producer: `entry:${portId(to.port!.ref)}` })));
          }
          if (first && from.checkpoint && asked[0]?.port === portId(from.port!.ref)) {
            asked.splice(1, 0, ...entryCheckpoint(model, link, 'from', from.port!, from.checkpoint, end.point, obstacles, boxes)
              .map(checkpoint => ({ checkpoint, terminal: from.point, producer: `entry:${portId(from.port!.ref)}` })));
          }
          // Every approach placement fixed is reserved against the batches still to run: the
          // attachment stem, and the head-on approach to a lane (ticket 18). Without the second, an
          // earlier batch may lay its row through the approach point, and libavoid then drops it.
          for (const item of asked) {
            if (item.producer.startsWith('lane:')) {
              approaches.push({ link: link.id, lane: item.producer.slice('lane:'.length),
                bounds: stemBounds(model, link, item.terminal, item.checkpoint),
                segment: { from: { ...item.terminal }, to: { x: item.checkpoint.x, y: item.checkpoint.y } } });
              continue;
            }
            if (item.node === undefined || item.side === undefined || item.port === undefined) continue;
            stems.push({ link: link.id, node: item.node, side: item.side, port: item.port,
              nested: sideNested(model, item.node, item.side, gaps),
              bounds: stemBounds(model, link, item.terminal, item.checkpoint),
              segment: { from: { ...item.terminal }, to: { x: item.checkpoint.x, y: item.checkpoint.y } } });
          }
          connectors.push({ id, from: start.endpoint, to: end.endpoint, checkpoints: asked.map(item => item.checkpoint) });
          pieces.push({ kind: 'gap', connector: id, from: start.point, to: end.point, via: asked.map(item => ({ x: item.checkpoint.x, y: item.checkpoint.y })),
            producers: asked.map(item => item.producer) });
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
        const side = endPort(model, link, end)?.side;
        return side === undefined ? [] : [`${link.attachments![end].node}|${side}`];
      }),
      ports: (['from', 'to'] as const).map(end => portId(link.attachments![end])) });
  }
  reachBeyondCheckpoints(model, stems, approaches);
  for (const [node, list] of pins) {
    const shape = obstacles.find(item => item.id === `node:${node}`);
    if (shape) shape.pins = [...list].sort((a, b) => a.classId - b.classId);
  }
  // Claiming an ordinary stage-8 run must not turn it into a wall for a transverse gap. As with
  // allocated tier-gap rows, only the crossed run grants passage; nodes, lanes and geometry that
  // placement fixed keep their original owners. Read the actual segment, not the aspect of its
  // trimmed clearance cover: a short vertical run can have a wider-than-tall cover.
  for (const { segment, covers } of claims) for (const link of links) {
    if (!link.pieces.some(piece => piece.kind === 'gap' && gapCrosses(piece, segment))) continue;
    for (const cover of covers) if (!cover.consumers.includes(link.link)) cover.consumers.push(link.link);
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
  // A run's inner points are its turns: it starts and ends on a tip or a mouth, where it continues its stem or its lane.
  const plannedTurns = new Map([...gapRuns].map(([link, runs]) => [link, [...runs.values()].flatMap(segments => segments.slice(1).map(segment => ({ ...segment.from })))]));
  return { remainders, overlay, links, obstacles, stems, approaches, parameters: routeParameters(model), plannedTurns,
    batches: [...batches.values()].map((ids, index) => ({ id: `batch-${index}`, links: ids })) };
}

/** The entry checkpoint stands this far beyond the edge margin, so the turn that reaches it still passes G6 after the router's nudging. */
const ENTRY_SLACK = 1;

/**
 * ADR-0013, reserved in the plan: where a link that comes from beside a group goes in. The group is
 * not an obstacle to the links attached inside it, so when a group title stands on the column of a
 * top or bottom port's stem, the link cannot go in through the group's top or bottom edge, and the
 * router may take a corridor beside a side edge, outside it and closer than the edge margin, and turn
 * into the group sideways from there (G6 `segment-group-edge`). Such a stem, whose checkpoint lies
 * inside a group the link is attached to, is preceded by one entry checkpoint on the row of the
 * stem, one edge margin beyond the side edge that faces the piece's other end: the link turns
 * outside the margin, then goes in sideways. Nothing is asked when no title stands on the column
 * (the link goes in square through the edge), when the piece starts over the group's span (it stays
 * clear of the side edges), or when the entry point is not free for this link.
 */
function entryCheckpoint(model: LayoutModel, link: LayoutLink, end: 'from' | 'to', port: LayoutPort, stem: Point, other: Point,
  obstacles: RouteObstacle[], boxes: { id: string; bounds: Rect }[]): RouteCheckpoint[] {
  const side = port.side!, out = OUTWARD[side], anchor = port.anchor!, vertical = out.x === 0;
  // Only a top or bottom stem has a side edge to turn beside.
  if (!vertical) return [];
  const margin = edgeMargin(routedStroke(model)) + ENTRY_SLACK;
  let depth: number | undefined, outer: Rect | undefined;
  for (const { id, bounds } of boxes) {
    const across = vertical ? anchor.x : anchor.y, along = vertical ? anchor.y : anchor.x;
    const low = vertical ? bounds.x : bounds.y, high = low + (vertical ? bounds.width : bounds.height);
    const start = vertical ? bounds.y : bounds.x, stop = start + (vertical ? bounds.height : bounds.width);
    if (across <= low + EPS || across >= high - EPS || along < start - EPS || along > stop + EPS
      || !groupConsumers(model, id).includes(link.id)) continue;
    // How far out from the port the box edge on the port's side lies; a stem that stops short of it
    // ends inside the group.
    const edge = vertical ? (out.y < 0 ? bounds.y : bounds.y + bounds.height) : (out.x < 0 ? bounds.x : bounds.x + bounds.width);
    const reach = vertical ? (edge - anchor.y) * out.y : (edge - anchor.x) * out.x;
    const stemReach = vertical ? Math.abs(stem.y - anchor.y) : Math.abs(stem.x - anchor.x);
    if (reach <= EPS || reach <= stemReach + EPS) continue;
    if (depth === undefined || reach + margin > depth) { depth = reach + margin; outer = bounds; }
  }
  if (depth === undefined || outer === undefined) return [];
  const free = (from: Point, to: Point, only = ''): boolean => !obstacles.some(item => item.id.startsWith(only) && !item.consumers.includes(link.id)
    && item.bounds.width > 0 && item.bounds.height > 0 && segmentRect({ from, to, owner: { kind: 'link', id: link.id } }, item.bounds));
  const checkpoint = (point: Point, inward: number): RouteCheckpoint =>
    end === 'to' ? { ...point, arrival: ALL_DIRECTIONS, departure: inward } : { ...point, arrival: inward, departure: ALL_DIRECTIONS };
  const point = { x: anchor.x + out.x * depth, y: anchor.y + out.y * depth };
  // No title stands on the port's own column: the link has every reason to go in square through the
  // edge, and the router is left to it.
  if (free(point, stem, 'label:')) return [];
  if (!vertical) return [];
  if (other.x >= outer.x && other.x <= outer.x + outer.width) return [];
  const left = other.x < outer.x, x = left ? outer.x - margin : outer.x + outer.width + margin;
  const row = { x, y: stem.y };
  return free(row, stem) ? [checkpoint(row, left ? DIRECTION_BITS.right : DIRECTION_BITS.left)] : [];
}

/**
 * Whether a gap must pass through a run: the polyline `[from, ...via, to]` or the endpoint chord crosses
 * it (ticket 14). The chord alone misses a run that stands between an end and a checkpoint the gap must
 * reach, so the run stayed an obstacle, the pocket the checkpoint stands in closed, and libavoid dropped
 * the checkpoint without a word. Every leg, like the chord, must pass strictly through the run.
 */
function gapCrosses(piece: { from: Point; to: Point; via: Point[] }, segment: Pick<PathSegment, 'from' | 'to'>): boolean {
  const points = [piece.from, ...piece.via, piece.to];
  return crossesInterior(piece.from, piece.to, segment)
    || points.slice(1).some((point, index) => crossesInterior(points[index]!, point, segment));
}

/**
 * Whether a gap has to pass a completed run: one of its legs, or one of the two L shapes of a leg, crosses the run's interior
 * (ticket 21). libavoid routes are orthogonal, so a slanted leg between two checkpoints is walked as an L. The straight leg
 * alone misses a run that stands right below a stem tip between two neighbouring stems: the tip's only way out is across that
 * run, whatever the slope of the leg. The endpoint chord does not count (tickets 30 and 37): no orthogonal route follows it, and
 * letting it grant a cover let the zigzags of earlier links close the pocket of a far stem tip.
 * Residual: only a link the plan left to the router has a gap to ask this of.
 */
function gapNeeds(piece: { from: Point; to: Point; via: Point[] }, segment: Pick<PathSegment, 'from' | 'to'>): boolean {
  const points = [piece.from, ...piece.via, piece.to];
  const legs = points.slice(1).map((to, index) => ({ from: points[index]!, to }));
  if (legs.some(leg => crossesInterior(leg.from, leg.to, segment))) return true;
  return legs.some(({ from, to }) => {
    if (Math.abs(from.x - to.x) <= EPS || Math.abs(from.y - to.y) <= EPS) return false;
    return [{ x: from.x, y: to.y }, { x: to.x, y: from.y }].some(corner =>
      crossesInterior(from, corner, segment) || crossesInterior(corner, to, segment));
  });
}

/** The endpoint chord must pass strictly through the run, rather than touch an end or its cover. */
function crossesInterior(from: Point, to: Point, segment: Pick<PathSegment, 'from' | 'to'>): boolean {
  const vertical = Math.abs(segment.from.x - segment.to.x) <= EPS;
  const horizontal = Math.abs(segment.from.y - segment.to.y) <= EPS;
  if (vertical === horizontal) return false;
  const axis = vertical ? 'x' : 'y', along = vertical ? 'y' : 'x';
  const at = segment.from[axis], a = from[axis] - at, b = to[axis] - at;
  if (!((a < -EPS && b > EPS) || (a > EPS && b < -EPS))) return false;
  const hit = from[along] + (to[along] - from[along]) * (at - from[axis]) / (to[axis] - from[axis]);
  return hit > Math.min(segment.from[along], segment.to[along]) + EPS
    && hit < Math.max(segment.from[along], segment.to[along]) - EPS;
}

/** A completed run remains protected except where every connector in this batch must cross it. */
export function completedCrossingObstacles(plan: RoutePlan, batch: { links: string[] },
  covers: { obstacle: RouteObstacle; segment: Pick<PathSegment, 'from' | 'to'> }[]): RouteObstacle[] {
  return covers.map(({ obstacle, segment }) => {
    const crossers = batch.links.filter(id => plan.links.find(link => link.link === id)?.pieces.some(piece =>
      piece.kind === 'gap' && gapNeeds(piece, segment)));
    return { ...obstacle, consumers: [...obstacle.consumers, ...crossers] };
  });
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
  //
  // A run that lies exactly on a cover's edge is **clear of it**, not inside it. A cover is its run
  // grown by `10 + (the two strokes) / 2`, so a centreline on that edge keeps the 10 px of visible
  // clearance G6 asks for and nothing more is owed. The case is not a rounding accident: a row
  // seated half a pitch inside a gap boundary puts its cover's edge on that boundary, and every run
  // that stands there touches it. `segmentRect` counts that zero-area touch as a hit, so the scan
  // shrinks each cover by `TOUCH` and asks for an overlap of area.
  // A cover too thin to shrink keeps its own bounds: an inverted rectangle blocks nothing at all,
  // and a cover exists to be a wall. Every reservation in `reserved` is grown by at least the run
  // clearance, so no cover is near this thin today; the guard is what makes that an invariant
  // rather than an assumption (`validate.ts` guards the same shrink).
  const inside = (box: Rect): Rect => box.width <= 2 * TOUCH || box.height <= 2 * TOUCH ? box
    : { x: box.x + TOUCH, y: box.y + TOUCH, width: box.width - 2 * TOUCH, height: box.height - 2 * TOUCH };
  // The stem of a planned part is claimed: its own rows and legs are reserved geometry it stands beside, and a row may stand on
  // the tip row of its own part (tier-gap-rows.md, O4), so the covers of the link's own plan are not walls to its own stem.
  const own = `routed:plan:${link.id}:`;
  if (reserved.some(item => !item.consumers.includes(link.id) && !item.id.startsWith(own) && segmentRect(segment, inside(item.bounds)))) return false;
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
 * A pending stem also reserves the room its checkpoint is reached through: one router stem beyond
 * the checkpoint, on the stem's own line (ticket 18). The stem's cover alone ends one clearance past
 * the checkpoint, so an earlier batch may run along that edge and close the pocket the later link
 * turns into, and libavoid then has no way to the checkpoint. The reach stops one clearance short of
 * every other link's reserved stem or lane approach, so it never covers a point another
 * reservation owns: two facing stems share the room between their checkpoints.
 */
function reachBeyondCheckpoints(model: LayoutModel, stems: StemReservation[], approaches: ApproachReservation[]): void {
  const others = [...stems, ...approaches];
  for (const stem of stems) {
    const link = model.links.find(item => item.id === stem.link)!;
    const clearance = GROUP_LABEL_GEOMETRY.nodeClearance + (linkStrokeWidth(link) + routedStroke(model)) / 2;
    const { from: terminal, to: checkpoint } = stem.segment;
    const dx = checkpoint.x - terminal.x, dy = checkpoint.y - terminal.y, span = Math.hypot(dx, dy) || 1;
    const ux = dx / span, uy = dy / span;
    let reach: number = GROUP_LABEL_GEOMETRY.routerStem;
    for (const other of others) {
      if (other.link === stem.link) continue;
      for (const point of [other.segment.from, other.segment.to]) {
        const ahead = (point.x - checkpoint.x) * ux + (point.y - checkpoint.y) * uy;
        const across = Math.abs((point.x - checkpoint.x) * uy - (point.y - checkpoint.y) * ux);
        if (ahead > 0 && across <= clearance + PLACEMENT_EPS) reach = Math.min(reach, Math.max(0, ahead - clearance - PLACEMENT_EPS));
      }
    }
    stem.bounds = stemBounds(model, link, terminal, { x: checkpoint.x + reach * ux, y: checkpoint.y + reach * uy });
  }
}

/**
 * The reserved stems and lane approaches a batch must leave alone: those of the links no batch has
 * routed yet. An earlier batch is otherwise free to run through the outward stem or the head-on
 * lane approach of a link it has never seen, and that link then has no route to its own port or
 * lane (ticket 18).
 *
 * A stem at a **port** this batch also attaches to is left out: one port carries one stem, and the
 * links that share it share the strip. Other ports on the same side still own their future stems;
 * omitting them lets the current batch occupy their required checkpoints. The attachment is read
 * from the link, not from the stems, because an end that consumes a shared run starts at the run's
 * terminal and reserves no stem of its own.
 */
export function pendingStemObstacles(plan: RoutePlan, batch: { links: string[] }, pending: Set<string>): RouteObstacle[] {
  const own = plan.links.filter(item => batch.links.includes(item.link));
  const ports = new Set(own.flatMap(item => item.ports));
  return [
    ...plan.stems.flatMap((stem, index) => {
      if (!pending.has(stem.link) || ports.has(stem.port)) return [];
      return [{ id: `stem:${index}:${stem.link}`, bounds: stem.bounds, consumers: [] }];
    }),
    // A lane approach is one link's alone: no port is shared there, so nothing exempts it.
    ...plan.approaches.flatMap((approach, index) => pending.has(approach.link)
      ? [{ id: `approach:${index}:${approach.link}`, bounds: approach.bounds, consumers: [] }] : []),
  ];
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
    const alongY = Math.abs(segment.from.x - segment.to.x) < PLACEMENT_EPS, alongX = Math.abs(segment.from.y - segment.to.y) < PLACEMENT_EPS;
    if (alongY && !vertical) return false;
    if (alongX && !horizontal) return false;
    if (alongY) {
      const low = Math.min(segment.from.y, segment.to.y), high = Math.max(segment.from.y, segment.to.y);
      return Math.abs(checkpoint.x - segment.from.x) < PLACEMENT_EPS && checkpoint.y > low + PLACEMENT_EPS && checkpoint.y < high - PLACEMENT_EPS;
    }
    if (alongX) {
      const low = Math.min(segment.from.x, segment.to.x), high = Math.max(segment.from.x, segment.to.x);
      return Math.abs(checkpoint.y - segment.from.y) < PLACEMENT_EPS && checkpoint.x > low + PLACEMENT_EPS && checkpoint.x < high - PLACEMENT_EPS;
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
  const shapes: RouteShape[] = [
    ...plan.obstacles.filter(item => !excluded.has(item.id)),
    ...extra.filter(item => !batch.links.every(id => item.consumers.includes(id))),
  ].map(item => {
    const pins = item.pins?.filter(pin => targeted.has(`${item.id}#${pin.classId}`));
    return pins?.length ? { id: item.id, bounds: item.bounds, pins } : { id: item.id, bounds: item.bounds };
  });
  return { id: batch.id, shapeBufferDistance: SHAPE_BUFFER_DISTANCE, parameters: plan.parameters,
    shapes: disjointShapes(shapes), connectors };
}
