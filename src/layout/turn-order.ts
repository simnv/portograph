import type { PortRef } from '../model/document.js';
import type { Point, Side } from '../model/geometry.js';
import type { Course, Diagnostic, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { portId } from './skeleton-graph.js';
import { COURSE_STEM, endMode } from './course-rows.js';
import { laneSource } from './lanes.js';
import { farCoordinate } from './peers.js';
import { pairedFaceKey } from './parallel-sets.js';
import { bypassRowY } from './course-bypass.js';
import { busOfPort } from './bus.js';
import { groupShape } from './grid.js';
import { orderedNodeIds } from '../model/model.js';
import { nodeTier } from './read/tier.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { facePairPitches } from './pair-pitch.js';

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
 * The rank of a port on its face, the one function that the comparator and the turn offer share. Low-turn `return` (1), low-turn `onward` (2), no turn (3), high-turn `onward` (4),
 * high-turn `return` (5). A port with no turn that stands next to low-turn returns (overlay brackets) keeps the place ticket 15 gives it: above them (rank 0) when its far
 * end lies before their least reach, else in group 3.
 */
export function turnRanker(ports: readonly TurnPort[]): (port: TurnPort) => number {
  const reaches = ports.flatMap(port => (turnGroup(port) === 1 ? [port.reach!] : []));
  const edge = reaches.length === 0 ? Infinity : Math.min(...reaches);
  return port => {
    const g = turnGroup(port);
    return g === 3 && reaches.length > 0 && port.far < edge ? 0 : g;
  };
}

/** One comparator on one scale: the rank, then reach descending for the returns, the far end for the unturned, reach ascending for the onward. Total. */
export function turnOrder(ports: readonly TurnPort[]): (a: TurnPort, b: TurnPort) => number {
  const rank = turnRanker(ports);
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

/** The face line of a node on `side`, and the y or x of its edge, from its box. */
const faceLine = (box: { x: number; y: number; width: number; height: number }, side: Side): number =>
  side === 'top' ? box.y : side === 'bottom' ? box.y + box.height : side === 'left' ? box.x : box.x + box.width;

/**
 * The first turn of a skirt end, read from the reserved runs of its course and not from where the ends happen to stand (ticket 24, Section 4).
 * - A column-gap skirt (`gap` and `u` runs): the lane stands in the column beside the lateral end, on the side its face looks at, and the end that leaves by the tier gap
 *   (`u`) turns toward it: right of a left face, left of a right face; it comes back up the gap (`return`), and its reach is the face line of the lateral end. The lateral end
 *   runs its side run into the lane and on along it toward the band edge the U part faces: down for a bottom face (`high`), up for a top face (`low`), `onward`.
 * - A perimeter skirt (`perimeter` run, margin `side`): an end that leaves by a padding row turns toward its margin; an end that meets the lane by a side run turns along it
 *   toward the other end by tier. The natural end of a perimeter course has no plan here.
 */
function skirtTurn(model: LayoutModel, link: LayoutLink, course: Course, which: 'from' | 'to'): PlannedTurn | undefined {
  const otherWhich = which === 'from' ? 'to' : 'from', mine = link.attachments![which], other = link.attachments![otherWhich];
  const box = model.nodes[mine.node]?.bounds, otherBox = model.nodes[other.node]?.bounds;
  if (box === undefined || otherBox === undefined) return undefined;
  const mode = endMode(course, which);
  if (course.runs.includes('gap')) {
    if (mode === 'u') {
      const lateral = course[otherWhich].face;
      if (lateral !== 'left' && lateral !== 'right') return undefined;
      return { turn: lateral === 'left' ? 'high' : 'low', shape: 'return', reach: faceLine(otherBox, lateral) };
    }
    if (mode === 'hold') {
      const face = course[otherWhich].face;
      if (face !== 'top' && face !== 'bottom') return undefined;
      return { turn: face === 'bottom' ? 'high' : 'low', shape: 'onward', reach: faceLine(otherBox, face) };
    }
    return undefined;
  }
  if (course.runs.includes('perimeter') && course.side !== undefined) {
    if (mode === 'padding') {
      const face = course[which].face;
      const lower = nodeTier(model, other.node) > nodeTier(model, mine.node);
      const back = face === 'top' ? lower : !lower;
      return { turn: course.side === 'left' ? 'low' : 'high', shape: back ? 'return' : 'onward', reach: course.side === 'left' ? -Infinity : Infinity };
    }
    if (mode === 'side') {
      const tiers = [nodeTier(model, mine.node), nodeTier(model, other.node)];
      if (tiers[0] === tiers[1]) return undefined;
      return { turn: tiers[1]! < tiers[0]! ? 'low' : 'high', shape: 'onward', reach: otherBox.y + otherBox.height / 2 };
    }
  }
  return undefined;
}

/**
 * The first turn of a `u-turn` end (dense-16x9 ticket 06): the stem leaves its horizontal face and turns toward the other end, along the row of the U part (or the padding row), and
 * the second turn there goes back toward the node, so the shape is `return` and the reach is the centre of the other node. The end that stands left of the other turns `high`, the
 * other `low`. Two ends in one column have no turn. Two U parts that leave one face and nest take the order of their reaches (the wider one stands farther out), so no leg stands inside another.
 */
function uTurnTurn(model: LayoutModel, link: LayoutLink, which: 'from' | 'to'): PlannedTurn | undefined {
  const box = model.nodes[link.attachments![which].node]?.bounds, other = model.nodes[link.attachments![which === 'from' ? 'to' : 'from'].node]?.bounds;
  if (box === undefined || other === undefined) return undefined;
  const here = box.x + box.width / 2, there = other.x + other.width / 2;
  if (Math.abs(there - here) <= PLACEMENT_EPS) return undefined;
  return { turn: there > here ? 'high' : 'low', shape: 'return', reach: there };
}

/**
 * The first turn of a side lane port (Q109): the lane runs from the band edge that faces the far end to the lateral port, so the end turns up when the far end stands
 * in a higher sub-tier and down when in a lower one. Read from the tiers, which no centring moves (7c moves x only), and not from the y of the far port.
 */
function sideLaneTurn(model: LayoutModel, mine: PortRef, other: PortRef): PlannedTurn | undefined {
  const far = findPort(model, other)?.anchor, tiers = [nodeTier(model, mine.node), nodeTier(model, other.node)];
  if (far === undefined || tiers[0] === tiers[1]) return undefined;
  return { turn: tiers[1]! < tiers[0]! ? 'low' : 'high', shape: 'onward', reach: far.y };
}

/**
 * The first turn of a routed link end that a reservation fixes: a bypass, a skirt course, a side lane or (from 7a) a transit lane. Every turn is read from the
 * reservation itself (the runs of the course, the margin side, the tier of the far end), never from where two ports happen to stand.
 */
function reservedTurn(model: LayoutModel, link: LayoutLink, which: 'from' | 'to', transit: boolean): PlannedTurn | undefined {
  const mine = link.attachments?.[which], other = link.attachments?.[which === 'from' ? 'to' : 'from'];
  if (mine === undefined || other === undefined) return undefined;
  const own = findPort(model, mine);
  if (own?.side === undefined) return undefined;
  const course = (model.courses ?? []).find(item => item.link === link.id);
  // A row bypass turns toward its padding row at both ends, and goes on along it (Section 6).
  if (course?.kind === 'bypass') {
    const row = bypassRowY(model, link, course);
    return row === undefined ? undefined : { turn: course.edge === 'top' ? 'low' : 'high', shape: 'onward', reach: row };
  }
  if (course !== undefined) return course.kind === 'skirt' ? skirtTurn(model, link, course, which) : course.kind === 'u-turn' ? uTurnTurn(model, link, which) : undefined;
  if (own.laneHint === true) return sideLaneTurn(model, mine, other);
  return transit ? transitTurn(model, link, mine, own) : undefined;
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
  if (lane.x < Math.min(...xs) - PLACEMENT_EPS) return { turn: 'low', shape: 'onward', reach: lane.x };
  if (lane.x > Math.max(...xs) + PLACEMENT_EPS) return { turn: 'high', shape: 'onward', reach: lane.x };
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
 * The first turn of a published path at one end (Section 8, `PORT_TURN_MISSED`): the first run along the face, its direction, the direction of the run after it (back to the node's
 * side of the face line, or on), and the coordinate where it ends. A path with no run along the face, or a diagonal, has no turn.
 */
export function publishedTurn(link: LayoutLink, which: 'from' | 'to', side: Side): PlannedTurn | undefined {
  const segments = link.path?.segments;
  if (segments === undefined || segments.length === 0 || segments.some(segment => segment.straight === true)) return undefined;
  const points: Point[] = [];
  const walked = which === 'from' ? [segments[0]!.from, ...segments.map(segment => segment.to)] : [segments[segments.length - 1]!.to, ...[...segments].reverse().map(segment => segment.from)];
  for (const point of walked) {
    const last = points[points.length - 1];
    if (last === undefined || Math.abs(last.x - point.x) > PLACEMENT_EPS || Math.abs(last.y - point.y) > PLACEMENT_EPS) points.push(point);
  }
  const across = horizontalFace(side), at = (point: Point): number => (across ? point.x : point.y), normal = (point: Point): number => (across ? point.y : point.x);
  const index = points.findIndex((point, i) => i > 0 && Math.abs(at(point) - at(points[i - 1]!)) > PLACEMENT_EPS);
  if (index < 0) return undefined;
  const turn = at(points[index]!) < at(points[index - 1]!) ? 'low' : 'high', reach = at(points[index]!), next = points[index + 1];
  const outward = side === 'bottom' || side === 'right' ? 1 : -1;
  const shape = next !== undefined && Math.sign(normal(next) - normal(points[index]!)) === -outward ? 'return' : 'onward';
  return { turn, shape, reach };
}

/** The key of a face in `freeze.turnOrder`. */
export const faceKey = (node: string, side: Side): string => `${node}|${side}`;

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
 * Whether a link is held straight: a held routed chord (`frozenChords`, decided at the start of 7f) or a level straight link that the rows rule pinned
 * (`expectedLevelPath`: one fixed segment, no `straight` flag). Both stand as one segment from their port, so neither has a first turn.
 */
export function heldStraight(model: LayoutModel, link: LayoutLink): boolean {
  if ((model.frozenChords ?? []).includes(link.id)) return true;
  return link.layer === 'routed' && link.technique === 'straight' && link.path?.fixed === true && link.path.segments.length === 1;
}

/**
 * The faces that hold a held straight link, by `faceKey` (docs/design/turn-order.md, Section 3), less the faces that the model's turn record already holds: a face that the
 * turn order took keeps its recorded order, whatever it holds. The turn round reads it on its baseline to leave those faces out of its offer and to reserve them for far-end
 * order. Reads stored decisions only (`frozenChords`, the pinned paths); nothing here derives a chord again (R1).
 */
export function straightFaces(model: LayoutModel): Set<string> {
  const faces = new Set<string>();
  for (const link of model.links) {
    if (link.attachments === undefined || !heldStraight(model, link)) continue;
    for (const ref of [link.attachments.from, link.attachments.to]) {
      const side = findPort(model, ref)?.side;
      if (side !== undefined) faces.add(faceKey(ref.node, side));
    }
  }
  for (const face of model.freeze?.turnOrder ?? []) faces.delete(faceKey(face.node, face.side));
  return faces;
}

/** The ports of a face in the order they stand: by anchor along the face (`anchor`, what G5 reads at publication) or by engine order, with a total order on ties. */
export function faceSequence(model: LayoutModel, node: string, side: Side, by: 'anchor' | 'engine'): PortRef[] | undefined {
  const ports = model.nodes[node]?.ports.filter(port => port.side === side);
  if (ports === undefined) return undefined;
  const along = (port: LayoutPort): number | undefined => (by === 'anchor' && port.anchor !== undefined ? (horizontalFace(side) ? port.anchor.x : port.anchor.y) : undefined);
  return [...ports].sort((a, b) => (along(a) ?? 0) - (along(b) ?? 0) || (a.engineOrder ?? 0) - (b.engineOrder ?? 0)).map(port => ({ ...port.ref }));
}

/** The record of one face of the turn round: the ports of the face in the order the round left them. */
export function turnRecord(model: LayoutModel, node: string, side: Side): { node: string; side: Side; ports: PortRef[] } {
  return { node, side, ports: faceSequence(model, node, side, 'engine') ?? [] };
}

/** One thing that the record of the turn round cannot back: a face, or the record as a whole (`node` and `side` absent). */
export interface TurnRecordFault { node?: string; side?: Side; why: string }

/**
 * What the record of the turn round (`freeze.turnOrder`, `freeze.turnExcept`) cannot back (R5: a validator trusts the stored record and the geometry, nothing a
 * diagnostic says). The record as a whole needs a model that carries the turn order whenever it holds a face, a scope or an empty list (the pipeline writes the list
 * only with a face in it), and a scope equal to the scope of the model (`turnExcept`), a face list or none. A recorded face needs a node and a side that exist, a place
 * in the scope of the run (not a face reserved for far-end order, and a face of a `turnLinks` run), the ports the model holds on it, and those ports in the recorded
 * order: by anchor along the face when `by` is `anchor`, else by engine order. A fault of the whole record carries no node.
 */
export function turnRecordFaults(model: LayoutModel, by: 'anchor' | 'engine'): TurnRecordFault[] {
  const freeze = model.freeze, faults: TurnRecordFault[] = [];
  if (freeze === undefined) return faults;
  const record = freeze.turnOrder;
  // The scope is the scope of the model whatever the record holds, also when no face was recorded.
  if (JSON.stringify(freeze.turnExcept ?? []) !== JSON.stringify(model.turnExcept ?? [])) faults.push({ why: 'the recorded scope differs from the scope of the model' });
  if ((record !== undefined || freeze.turnExcept !== undefined || model.turnExcept !== undefined) && model.turnOrder !== true) faults.push({ why: 'the model does not carry the turn order' });
  if (record !== undefined && record.length === 0) faults.push({ why: 'the record holds no face' });
  const seen = new Set<string>();
  for (const face of record ?? []) {
    const fault = (why: string): void => { faults.push({ node: face.node, side: face.side, why }); };
    const key = faceKey(face.node, face.side);
    if (!['top', 'right', 'bottom', 'left'].includes(face.side) || model.nodes[face.node] === undefined) { fault('the face does not exist'); continue; }
    if (seen.has(key)) { fault('the face is recorded twice'); continue; }
    seen.add(key);
    if (!turnScope(model, face.node, face.side)) { fault('the face is outside the scope of the turn order'); continue; }
    const now = faceSequence(model, face.node, face.side, by)!.map(ref => portId(ref));
    if (!Array.isArray(face.ports) || JSON.stringify(face.ports.map(ref => portId(ref))) !== JSON.stringify(now)) fault('the ports do not stand in the recorded order');
  }
  return faults;
}

/**
 * Whether a face takes the turn order in this run: every face but the ones reserved for far-end order (`turnExcept`: a face that holds a held routed chord), or with
 * `turnLinks` only the faces that carry one of those links.
 */
export function turnScope(model: LayoutModel, node: string, side: Side): boolean {
  if (model.turnExcept?.includes(faceKey(node, side))) return false;
  // A face with a far-end order from final positions (ticket 07) keeps it: no turn pass re-orders it.
  if (model.farEndOrder?.some(face => face.node === node && face.side === side)) return false;
  if (model.turnLinks === undefined) return true;
  const wanted = new Set(model.turnLinks);
  return model.links.some(link => wanted.has(link.id) && [link.attachments?.from, link.attachments?.to].some(ref => ref !== undefined && ref.node === node && findPort(model, ref)?.side === side));
}

/** The links that end on a port, by its key. */
const linksAtPort = (model: LayoutModel, ref: PortRef): LayoutLink[] => model.links.filter(link => [link.attachments?.from, link.attachments?.to].some(end => end !== undefined && portId(end) === portId(ref)));

/**
 * The order the turn order gives one face of the model (Section 4): the same sort as stage 5 (a facing pair by its shared key, `pairedFaceKey`), over the planned turns that stand now (courses, side lanes and, once 7a has
 * reserved them, transit lanes). Authored order wins, the bus port stands last. `undefined` when the face is not the turn order's to place in 7a: it is out of the run's
 * scope, a bundle member, a bar or an unplaced port is on it, no transit lane fixes a turn on it, or the position of one of its ports is reserved by something else (a
 * course of any kind, a side or gap lane, a span chord): stage 5 placed those, and 7a leaves the face as it is.
 */
export function laneFaceOrder(model: LayoutModel, node: string, side: Side): LayoutPort[] | undefined {
  const ports = model.nodes[node]!.ports.filter(port => port.side === side);
  if (ports.length < 2 || ports.some(port => port.anchor === undefined) || !turnScope(model, node, side)) return undefined;
  const group = model.document.nodes[node]?.group;
  if (group !== undefined && groupShape(model, group) === 'bar') return undefined;
  // A face with a neighbour-pair pitch (dense-16x9 ticket 04) keeps the order its pitches were reserved for: a new order would stand the ports
  // in slots of other pairs.
  if (facePairPitches(model.nodes[node]!, side).length) return undefined;
  if (model.links.some(link => link.bundle !== undefined && [link.attachments?.from, link.attachments?.to].some(ref => ref !== undefined && ref.node === node))) return undefined;
  const reserved = (port: LayoutPort): boolean => port.laneHint === true || port.sideHint === true || port.courseHint === true || linksAtPort(model, port.ref).some(link => link.spanHint === true
    || (model.courses ?? []).some(course => course.link === link.id) || model.lanes.some(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && lane.kind !== undefined && lane.kind !== 'transit'));
  const planned = plannedTurns(model);
  if (ports.some(reserved) || !ports.some(port => planned.has(portId(port.ref)))) return undefined;
  const isBus = (port: LayoutPort): number => (busOfPort(model, port.ref) !== undefined ? 1 : 0);
  // Stage 5's face key: a facing pair's shared key, else the far coordinate (`pairedFaceKey`, R1).
  const faceKey = pairedFaceKey(model, (ref, at) => farCoordinate(model, ref, at), ref => findPort(model, ref)?.side);
  const slots = new Map(ports.map(port => [port, { far: faceKey(port.ref, side), ...(planned.get(portId(port.ref)) ?? {}) } as TurnPort] as const));
  const by = turnOrder([...slots.values()]);
  const current = [...ports].sort((a, b) => a.engineOrder! - b.engineOrder!);
  const sorted = [...current].sort((a, b) => isBus(a) - isBus(b) || by(slots.get(a)!, slots.get(b)!));
  const authored = sorted.filter(port => port.authorOrder !== undefined).sort((a, b) => a.authorOrder! - b.authorOrder!);
  let next = 0;
  return sorted.map(port => (port.authorOrder === undefined ? port : authored[next++]!));
}

/** The most rounds the 7a pass takes to reach an order that no face would change again. */
export const LANE_PASS_ROUNDS = 6;

/**
 * Stage 7a, once the lanes stand (Section 4): reorders the faces on which a transit lane fixes the planned first turn of a port, to the order `laneFaceOrder` gives. The
 * ports exchange the slots of the face, so no anchor leaves the face. A face reads the far ends of its links, and a far end may stand on a face that moves in the same pass,
 * so the pass repeats until no face changes, at most `rounds` times; an order that has not settled by then is dropped altogether and every face keeps the order stage 5 gave it.
 * What it keeps is thus a fixed point of `laneFaceOrder`, which is what the mutation check reads. The faces it changed are recorded in `freeze.turnOrder`. A run without the
 * turn order never calls it.
 */
export function orderPortsByLanes(model: LayoutModel, rounds: number = LANE_PASS_ROUNDS, orderOf: typeof laneFaceOrder = laneFaceOrder): void {
  const state = (): { port: LayoutPort; order: number; anchor: Point }[] => Object.values(model.nodes).flatMap(node => node.ports.map(port => ({ port, order: port.engineOrder!, anchor: { ...port.anchor! } })));
  const original = state();
  for (let round = 0; round <= rounds; round++) {
    let moved = false;
    for (const node of Object.keys(model.nodes)) for (const side of ['bottom', 'right', 'top', 'left'] as const) {
      const order = orderOf(model, node, side);
      if (order === undefined) continue;
      const current = model.nodes[node]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      if (order.every((port, index) => port === current[index])) continue;
      if (round === rounds) { moved = true; break; }
      const seats = current.map(port => ({ ...port.anchor! }));
      order.forEach((port, index) => { port.engineOrder = index; port.anchor = seats[index]!; });
      moved = true;
    }
    if (!moved) break;
    if (round === rounds) {
      for (const item of original) { item.port.engineOrder = item.order; item.port.anchor = item.anchor; }
      return;
    }
  }
  // The faces whose order now differs from the one stage 5 gave, in the order the mutation check reads them.
  const before = new Map(original.map(item => [item.port, item.order]));
  const faces: { node: string; side: Side }[] = [];
  for (const node of orderedNodeIds(model.document)) for (const side of ['bottom', 'right', 'top', 'left'] as const) {
    if (model.nodes[node]!.ports.some(port => port.side === side && port.engineOrder !== before.get(port))) faces.push({ node, side });
  }
  if (faces.length > 0) model.freeze!.turnOrder = [...(model.freeze!.turnOrder ?? []), ...faces.map(face => turnRecord(model, face.node, face.side))];
}
