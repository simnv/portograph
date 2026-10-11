import type { PortRef } from '../model/document.js';
import type { Point, Side } from '../model/geometry.js';
import type { Diagnostic, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { portId } from './skeleton-graph.js';
import { COURSE_STEM, endMode } from './course-rows.js';
import { laneSource } from './lanes.js';
import { farCoordinate } from './peers.js';
import { busOfPort } from './bus.js';
import { groupShape } from './grid.js';

/**
 * The order of the ports of one face from the planned first turn of their links (architecture ticket 24, `docs/design/turn-order.md`).
 *
 * `turn` is the direction of the first turn of a planned route, read from a reservation that exists before routing: `low` (up on a lateral face, left on a
 * horizontal one), `high`, or `none`. `shape` is `return` when the second turn goes back toward the node's side of the face line, else `onward`.
 * `reach` is the coordinate, along the face, of the second turn.
 */
export type Turn = 'low' | 'high' | 'none';
export interface TurnPort {
  /** The coordinate along the face that the run goes to, the key of today's order. */
  far: number;
  turn?: Turn | undefined;
  shape?: 'return' | 'onward' | undefined;
  reach?: number | undefined;
}

/** The five groups from the low end (spec, Section 3). */
export function turnGroup(port: TurnPort): 1 | 2 | 3 | 4 | 5 {
  if (port.turn === undefined || port.turn === 'none' || port.reach === undefined) return 3;
  if (port.turn === 'low') return port.shape === 'return' ? 1 : 2;
  return port.shape === 'return' ? 5 : 4;
}

/**
 * One comparator on one scale. Low-turn `return` (reach descending), low-turn `onward` (reach ascending), no turn (far end), high-turn `onward` (reach
 * ascending), high-turn `return` (reach descending). A port with no turn that stands next to low-turn returns (overlay brackets) keeps the place ticket 15
 * gives it: above them when its far end lies before their least reach, else in group 3. Total: group, then one number.
 */
export function turnOrder(ports: readonly TurnPort[]): (a: TurnPort, b: TurnPort) => number {
  const reaches = ports.flatMap(port => (turnGroup(port) === 1 ? [port.reach!] : []));
  const edge = reaches.length === 0 ? Infinity : Math.min(...reaches);
  const rank = (port: TurnPort): number => {
    const g = turnGroup(port);
    return g === 3 && reaches.length > 0 && port.far < edge ? 0 : g;
  };
  const key = (port: TurnPort): number => {
    const g = turnGroup(port);
    return g === 1 || g === 5 ? -port.reach! : g === 3 ? port.far : port.reach!;
  };
  return (a, b) => rank(a) - rank(b) || (key(a) === key(b) ? 0 : key(a) - key(b));
}

/** What a reservation says about the first turn at one end of a link. */
export interface PlannedTurn { turn: Turn; shape: 'return' | 'onward'; reach: number }

const findPort = (model: LayoutModel, ref: PortRef): LayoutPort | undefined => model.nodes[ref.node]?.ports.find(port => portId(port.ref) === portId(ref));
const horizontalFace = (side: Side): boolean => side === 'top' || side === 'bottom';

/**
 * The overlay brackets (ticket 15): a bracket leaves a lateral face, turns toward its margin and returns to the far end's row, beyond it by a padding row,
 * short of it by a drop. Phase 1 of ticket 24 read these only; they stay as they were.
 */
function overlayTurns(model: LayoutModel, planned: Map<string, PlannedTurn>): void {
  const anchor = (ref: PortRef): Point | undefined => findPort(model, ref)?.anchor;
  for (const course of model.courses ?? []) {
    const link = course.kind === 'overlay' ? model.links.find(item => item.id === course.link) : undefined;
    if (link?.attachments === undefined) continue;
    for (const [mine, other, which] of [[link.attachments.from, link.attachments.to, 'to'], [link.attachments.to, link.attachments.from, 'from']] as const) {
      const mode = endMode(course, which);
      const bias = mode === 'padding' ? COURSE_STEM : mode === 'natural' ? -2 * COURSE_STEM : 0;
      const here = anchor(mine), there = anchor(other);
      if (here === undefined || there === undefined) continue;
      planned.set(portId(mine), { turn: 'low', shape: 'return', reach: there.y + Math.sign(there.y - here.y) * bias });
    }
  }
}

/**
 * The first turn of a routed link end that a reservation fixes, read from the geometry of the two ends only: the turn goes toward the far end along the face
 * (a skirt course leaves the face and runs to the lane beside the far node; a side lane runs from the port toward the far end), and the second turn goes back
 * to the node's side of the face line when the far end stands there (`return`), else on (`onward`). The reach is the far end's coordinate along the face.
 * No reservation, a far end in line with the node, or a port in no position yet: no turn.
 */
function reservedTurn(model: LayoutModel, link: LayoutLink, which: 'from' | 'to', transit: boolean): PlannedTurn | undefined {
  const mine = link.attachments?.[which], other = link.attachments?.[which === 'from' ? 'to' : 'from'];
  if (mine === undefined || other === undefined) return undefined;
  const own = findPort(model, mine), far = findPort(model, other), box = model.nodes[mine.node]?.bounds;
  if (own?.side === undefined || far?.anchor === undefined || box === undefined) return undefined;
  const course = (model.courses ?? []).find(item => item.link === link.id);
  if (course === undefined && own.laneHint !== true) return transit ? transitTurn(model, link, mine, own) : undefined;
  const reserved = course !== undefined ? course.kind === 'skirt' : own.laneHint === true;
  if (!reserved) return undefined;
  const side = course?.[which].face ?? own.side;
  const across = horizontalFace(side);
  const centre = across ? box.x + box.width / 2 : box.y + box.height / 2;
  const along = across ? far.anchor.x : far.anchor.y;
  if (Math.abs(along - centre) <= 1e-6) return undefined;
  const line = side === 'top' ? box.y : side === 'bottom' ? box.y + box.height : side === 'left' ? box.x : box.x + box.width;
  const there = across ? far.anchor.y : far.anchor.x;
  const inward = side === 'top' || side === 'left' ? there > line : there < line;
  return { turn: along < centre ? 'low' : 'high', shape: inward ? 'return' : 'onward', reach: along };
}

/**
 * The turn of the source end of a link that owns a transit lane (stage 7a, Section 4): the run leaves the port along its horizontal face toward the lane and goes on
 * down it. It is known only when the lane stands outside the span of the ports of the face, so that every permutation of the face turns the same way; a lane
 * between two ports of the face fixes no turn. `reach` is the lane x.
 */
function transitTurn(model: LayoutModel, link: LayoutLink, mine: PortRef, own: LayoutPort): PlannedTurn | undefined {
  if (own.side !== 'top' && own.side !== 'bottom') return undefined;
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === link.id && (item.kind === undefined || item.kind === 'transit'));
  if (lane === undefined || link.spanHint === true || portId(laneSource(model, link)) !== portId(mine)) return undefined;
  const xs = (model.nodes[mine.node]?.ports ?? []).filter(port => port.side === own.side && port.anchor !== undefined).map(port => port.anchor!.x);
  if (lane.x < Math.min(...xs) - 1e-6) return { turn: 'low', shape: 'onward', reach: lane.x };
  if (lane.x > Math.max(...xs) + 1e-6) return { turn: 'high', shape: 'onward', reach: lane.x };
  return undefined;
}

/**
 * The planned first turn of every port that a reservation fixes before routing, by port key (ticket 24, Section 4). The overlay brackets always; in a
 * turn-ordered run (`model.turnOrder`) also the skirt courses and the side lanes. A shared port is one slot and takes a turn only when every link on it
 * plans the same turn and shape; its reach is their mean.
 */
export function plannedTurns(model: LayoutModel, reservations: boolean = model.turnOrder === true, transit: boolean = reservations): Map<string, PlannedTurn> {
  const planned = new Map<string, PlannedTurn>();
  overlayTurns(model, planned);
  if (!reservations) return planned;
  const ends = new Map<string, (PlannedTurn | undefined)[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.attachments === undefined || link.bundle !== undefined) continue;
    for (const which of ['from', 'to'] as const) {
      const key = portId(link.attachments[which]), list = ends.get(key) ?? [];
      list.push(reservedTurn(model, link, which, transit));
      ends.set(key, list);
    }
  }
  for (const [key, list] of ends) {
    const first = list[0];
    if (first === undefined || planned.has(key) || list.some(item => item?.turn !== first.turn || item.shape !== first.shape)) continue;
    planned.set(key, { turn: first.turn, shape: first.shape, reach: list.reduce((sum, item) => sum + item!.reach, 0) / list.length });
  }
  return planned;
}

/**
 * The first turn of a published path at one end (Section 7): the first run along the face, its direction, the direction of the run after it (back to the node's
 * side of the face line, or on), and the coordinate where it ends. A path with no run along the face, or a diagonal, has no turn.
 */
export function publishedTurn(link: LayoutLink, which: 'from' | 'to', side: Side): PlannedTurn | undefined {
  const segments = link.path?.segments;
  if (segments === undefined || segments.length === 0 || segments.some(segment => segment.straight === true)) return undefined;
  const points: Point[] = [];
  const walked = which === 'from' ? [segments[0]!.from, ...segments.map(segment => segment.to)] : [segments[segments.length - 1]!.to, ...[...segments].reverse().map(segment => segment.from)];
  for (const point of walked) {
    const last = points[points.length - 1];
    if (last === undefined || Math.abs(last.x - point.x) > 1e-6 || Math.abs(last.y - point.y) > 1e-6) points.push(point);
  }
  const across = horizontalFace(side), at = (point: Point): number => (across ? point.x : point.y), normal = (point: Point): number => (across ? point.y : point.x);
  const index = points.findIndex((point, i) => i > 0 && Math.abs(at(point) - at(points[i - 1]!)) > 1e-6);
  if (index < 0) return undefined;
  const turn = at(points[index]!) < at(points[index - 1]!) ? 'low' : 'high', reach = at(points[index]!), next = points[index + 1];
  const outward = side === 'bottom' || side === 'right' ? 1 : -1;
  const shape = next !== undefined && Math.sign(normal(next) - normal(points[index]!)) === -outward ? 'return' : 'onward';
  return { turn, shape, reach };
}

/** The key of a face in `freeze.turnOrder`. */
export const faceKey = (node: string, side: Side): string => `${node}|${side}`;

/**
 * The turn of one port as G5 and placement read it (Section 7): the published first turn of each link on it when the link has a path, else the planned turn of
 * the port. A shared port has a turn only when its links agree; a link that goes straight is no turn.
 */
export function portTurn(side: Side, ends: readonly { link: LayoutLink; which: 'from' | 'to' }[], planned: PlannedTurn | undefined): PlannedTurn | undefined {
  if (ends.length === 0 || ends.some(end => end.link.path === undefined)) return planned;
  const turns = ends.map(end => publishedTurn(end.link, end.which, side)), first = turns[0];
  if (first === undefined || turns.some(item => item?.turn !== first.turn || item.shape !== first.shape)) return undefined;
  return { turn: first.turn, shape: first.shape, reach: turns.reduce((sum, item) => sum + item!.reach, 0) / turns.length };
}

/**
 * Whether the port at `own` (the lower slot) may stand before the port at `other` on a face the turn order placed. Two ports with no turn, or two onward ports of
 * one class, answer by their far-end ranges as before (`ranges`); any other pair by the groups, and two returns of one class by their reach.
 */
export function turnOrderViolated(a: TurnPort, b: TurnPort, ranges: boolean): boolean {
  const ga = turnGroup(a), gb = turnGroup(b);
  if (ga === gb && (ga === 3 || ga === 2 || ga === 4)) return ranges;
  if (ga === gb) return a.reach! < b.reach! - 1e-6;
  return ga > gb;
}

/**
 * `PORT_TURN_MISSED` (warning): a published path whose first turn differs from the planned one at a port of a face the turn order placed. A defect of a
 * planner, not of the rule (Section 8).
 */
export function turnMissed(model: LayoutModel): Diagnostic[] {
  const faces = new Set((model.freeze?.turnOrder ?? []).map(face => faceKey(face.node, face.side)));
  if (!faces.size) return [];
  const planned = plannedTurns(model), found: Diagnostic[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.attachments === undefined || link.path === undefined) continue;
    for (const which of ['from', 'to'] as const) {
      const ref = link.attachments[which], port = findPort(model, ref), turn = planned.get(portId(ref));
      if (port?.side === undefined || turn === undefined || !faces.has(faceKey(ref.node, port.side))) continue;
      const got = publishedTurn(link, which, port.side);
      if (got?.turn === turn.turn) continue;
      found.push({ stage: 'placement', severity: 'warning', code: 'PORT_TURN_MISSED', owners: [{ kind: 'link', id: link.id }],
        message: `The link ${link.id} leaves ${ref.node} on the ${port.side} face and turns ${got?.turn ?? 'nowhere'}, the plan turned ${turn.turn}.` });
    }
  }
  return found;
}

/**
 * The order the turn order gives one face of the model (Section 4): the same sort as stage 5, over the planned turns that stand now (courses, side lanes and, once 7a has
 * reserved them, transit lanes). Authored order wins, the bus port stands last. `undefined` when the face is not the turn order's to place: a bundle member, a bar or an
 * unplaced port is on it, or no transit lane fixes a turn on it, or another reservation (a course, a side lane) already planned one of its ports, which stage 5 placed.
 */
export function laneFaceOrder(model: LayoutModel, node: string, side: Side): LayoutPort[] | undefined {
  const ports = model.nodes[node]!.ports.filter(port => port.side === side);
  if (ports.length < 2 || ports.some(port => port.anchor === undefined)) return undefined;
  const group = model.document.nodes[node]?.group;
  if (group !== undefined && groupShape(model, group) === 'bar') return undefined;
  if (model.links.some(link => link.bundle !== undefined && [link.attachments?.from, link.attachments?.to].some(ref => ref !== undefined && ref.node === node))) return undefined;
  const early = plannedTurns(model, true, false), planned = plannedTurns(model);
  if (ports.some(port => early.has(portId(port.ref))) || !ports.some(port => planned.has(portId(port.ref)))) return undefined;
  const isBus = (port: LayoutPort): number => (busOfPort(model, port.ref) !== undefined ? 1 : 0);
  const slots = new Map(ports.map(port => [port, { far: farCoordinate(model, port.ref, side), ...(planned.get(portId(port.ref)) ?? {}) } as TurnPort] as const));
  const by = turnOrder([...slots.values()]);
  const current = [...ports].sort((a, b) => a.engineOrder! - b.engineOrder!);
  const sorted = [...current].sort((a, b) => isBus(a) - isBus(b) || by(slots.get(a)!, slots.get(b)!));
  const authored = sorted.filter(port => port.authorOrder !== undefined).sort((a, b) => a.authorOrder! - b.authorOrder!);
  let next = 0;
  return sorted.map(port => (port.authorOrder === undefined ? port : authored[next++]!));
}

/**
 * Stage 7a, once the lanes stand (Section 4): reorders the faces on which a transit lane fixes the planned first turn of a port, to the order `laneFaceOrder` gives. The
 * ports exchange the slots of the face, so no anchor leaves the face; the faces are recorded in `freeze.turnOrder`. A run without the turn order never calls it.
 */
export function orderPortsByLanes(model: LayoutModel): void {
  const faces: { node: string; side: Side }[] = [];
  for (const node of Object.keys(model.nodes)) for (const side of ['bottom', 'right', 'top', 'left'] as const) {
    const order = laneFaceOrder(model, node, side);
    if (order === undefined) continue;
    const current = model.nodes[node]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    if (order.every((port, index) => port === current[index])) continue;
    const seats = current.map(port => ({ ...port.anchor! }));
    order.forEach((port, index) => { port.engineOrder = index; port.anchor = seats[index]!; });
    faces.push({ node, side });
  }
  if (faces.length > 0) model.freeze!.turnOrder = [...(model.freeze!.turnOrder ?? []), ...faces];
}
