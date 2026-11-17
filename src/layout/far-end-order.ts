import type { PortRef } from '../model/document.js';
import type { Point, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { EPS } from '../score/geometry.js';
import { endpoints, port as portOf, refKey, routed as isRoutedLink } from '../score/model.js';
import { busOfPort } from './bus.js';
import { farCoordinate } from './peers.js';
import { groupShape } from './grid.js';
import { facingPairs } from './parallel-sets.js';
import { findPort } from './row-paths.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { portId } from './skeleton-graph.js';
import { faceKey } from './turn-order.js';

/**
 * Far-end order taken from final positions (dense-16x9 ticket 07, `docs/design/pipeline.md` Stage 5 and 7f).
 *
 * Stage 5 orders the ports of a face by the far ends of their links as they stand at that moment. 7c, 7e and 7f then move the far nodes, so the order can be stale at
 * publication, and G5 (`port-order`) fails it. This module is the one reader of G5's predicate: the gate reads the same ranges and the same comparison (`facePositions`,
 * `standsWrong`), and the far-end round reads them on the published geometry of a placement, proposes a new order for the faces that fail, and reserves it for a fresh
 * placement run (`farEndOrder` in the ledger). It decides nothing about geometry and moves no port: stage 5 installs the sequence, and every later stage validates it.
 */

/** The ports of one face in the order a placement run must give them: the whole face, free and authored ports together, in engine order. */
export interface FarEndFace { node: string; side: Side; ports: PortRef[] }

/** One free port of a face as G5 reads it: where it stands along the face, and the range of its far ends along the same axis. */
export interface PortPosition { port: LayoutPort; own: number; min: number; max: number }

const alongOf = (side: Side): 'x' | 'y' => (side === 'top' || side === 'bottom' ? 'x' : 'y');

/** Every port's far anchors by port key, over the routed links, a link seen from both ends (G5's index; a link whose far port is missing contributes nothing). */
export function farAnchorIndex(model: LayoutModel, routedLinks: ReadonlySet<LayoutLink>): Map<string, Point[]> {
  const farAnchors = new Map<string, Point[]>();
  for (const link of model.links) {
    if (!routedLinks.has(link)) continue;
    const ends = endpoints(link);
    for (const [near, far] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      const target = portOf(model, far);
      if (!target) continue;
      const at = refKey(near), list = farAnchors.get(at);
      if (list) list.push(target.anchor!); else farAnchors.set(at, [target.anchor!]);
    }
  }
  return farAnchors;
}

/** The ports of one face that G5 judges by far-end ranges: not authored, with at least one routed far end. */
export function facePositions(node: LayoutNode, side: Side, farAnchors: ReadonlyMap<string, readonly Point[]>): PortPosition[] {
  const along = alongOf(side);
  return node.ports.filter(port => port.side === side && port.authorOrder === undefined).flatMap(port => {
    const peers = farAnchors.get(refKey(port.ref));
    if (!peers?.length) return [];
    let min = Infinity, max = -Infinity;
    for (const anchor of peers) {
      if (anchor[along] < min) min = anchor[along];
      if (anchor[along] > max) max = anchor[along];
    }
    return [{ port, own: port.anchor![along], min, max }];
  });
}

/** G5's comparison: `x` stands before `y` on the face while its far ends lie strictly after the far ends of `y`. */
export const standsWrong = (x: { own: number; min: number }, y: { own: number; max: number }): boolean => x.own < y.own - EPS && x.min > y.max + EPS;

/** Whether any two free ports of a face stand the wrong way round (G5 `port-order` on this face). */
export function faceIsStale(positions: readonly PortPosition[]): boolean {
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    if (standsWrong(positions[i]!, positions[j]!) || standsWrong(positions[j]!, positions[i]!)) return true;
  }
  return false;
}

/** The links that G5 reads as routed on a placement model: a routed link with a path. */
export const routedLinksOf = (model: LayoutModel): Set<LayoutLink> =>
  new Set(model.links.filter(link => isRoutedLink(link) && link.path !== undefined && link.path.segments.length > 0));

/** Whether G5 fails this face on the model: not a face the turn round recorded (G5 judges that one by its record), and two of its free ports standing the wrong way round. */
function faceFails(model: LayoutModel, node: string, side: Side, index: ReadonlyMap<string, readonly Point[]>): boolean {
  if ((model.freeze?.turnOrder ?? []).some(face => face.node === node && face.side === side)) return false;
  return faceIsStale(facePositions(model.nodes[node]!, side, index));
}

/**
 * The faces that fail G5 on this model through a port whose far ends stand on one of `moved` (dense-16x9 ticket 36, slice 3): every face of a node
 * linked to them, judged by the G5 predicate (`facePositions`, `standsWrong`) on the pairs of ports one of which reads a moved node, on the anchors
 * of every routed-layer link (a placement model has no paths yet). In node and side order.
 */
export function staleThrough(model: LayoutModel, moved: ReadonlySet<string>): { node: string; side: Side }[] {
  // Read on the anchors from the rows rule on, before the route rule gives the links their paths: every link of the routed layer.
  const routedLinks = new Set(model.links.filter(isRoutedLink)), index = farAnchorIndex(model, routedLinks), near = new Set<string>(), reads = new Set<string>();
  for (const link of routedLinks) {
    const { from, to } = endpoints(link);
    for (const [a, b] of [[from, to], [to, from]] as const) if (moved.has(b.node)) { near.add(a.node); reads.add(refKey(a)); }
  }
  const found: { node: string; side: Side }[] = [];
  for (const id of orderedNodeIds(model.document)) for (const side of SIDE_TIE_ORDER) {
    if (!near.has(id) || (model.freeze?.turnOrder ?? []).some(face => face.node === id && face.side === side)) continue;
    const positions = facePositions(model.nodes[id]!, side, index);
    const wrong = positions.some((a, i) => positions.some((b, j) => j !== i && (reads.has(refKey(a.port.ref)) || reads.has(refKey(b.port.ref))) && standsWrong(a, b)));
    if (wrong) found.push({ node: id, side });
  }
  return found;
}

/** The faces that fail G5 on this model, in node and side order. */
export function staleFaces(model: LayoutModel, routedLinks: ReadonlySet<LayoutLink> = routedLinksOf(model)): { node: string; side: Side }[] {
  const index = farAnchorIndex(model, routedLinks), found: { node: string; side: Side }[] = [];
  for (const id of orderedNodeIds(model.document)) for (const side of SIDE_TIE_ORDER) {
    if (faceFails(model, id, side, index)) found.push({ node: id, side });
  }
  return found;
}

/** Who owns a face that the far-end round must leave alone, or `undefined` when the round may re-order it. */
export type FarEndOwner = 'turn' | 'bar' | 'bundle' | 'bus' | 'block' | 'order';

/**
 * The owner of a face. A recorded first-turn face keeps ticket 05's order; a bar, a bundle member and a mesh-bus port have an order of their own; a port of a solid block
 * stands where the block put it (ticket 83, and ticket 04 for the whole block face); a port with an authored `order:` is seated by its author (the free ports of its face
 * are re-ordered around it, so that alone is no owner).
 */
export function farEndOwner(model: LayoutModel, node: string, side: Side): FarEndOwner | undefined {
  if ((model.freeze?.turnOrder ?? []).some(face => face.node === node && face.side === side)) return 'turn';
  const group = model.document.nodes[node]?.group;
  if (group !== undefined && groupShape(model, group) === 'bar') return 'bar';
  const ports = model.nodes[node]!.ports.filter(port => port.side === side);
  const solid = new Set((model.fanFamilies ?? []).filter(family => family.kind === 'solid').map(family => family.id));
  const onFace = (ref: PortRef | undefined): boolean => ref !== undefined && ref.node === node && ports.some(port => portId(port.ref) === portId(ref));
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || !(onFace(ends.from) || onFace(ends.to))) continue;
    if (link.bundle !== undefined) return 'bundle';
    if (link.fanFamily !== undefined && solid.has(link.fanFamily)) return 'block';
  }
  if (ports.some(port => busOfPort(model, port.ref) !== undefined)) return 'bus';
  return undefined;
}

export interface FarEndProposal {
  /** The faces to re-order, in node and side order; empty: nothing to propose. */
  faces: FarEndFace[];
  /** The stale faces that another owner holds, with the owner: the round names them and leaves them alone. */
  owned: { node: string; side: Side; owner: FarEndOwner }[];
}

/**
 * The order of one face from the final positions of its far ends. Strictly separated far-end ranges are a partial order (an interval order, so acyclic): `a` comes before
 * `b` when the far ends of `a` all lie before the far ends of `b`, which is exactly what G5 fails. Overlapping ranges impose nothing, and neither does a port with no routed far end.
 * Among the ports that are ready (all their predecessors placed) the one with the lowest key goes first; the key is the mean of the routed far ends, or the ordinary key of stage 5
 * for a port with no routed far end. A port of `follows` (a port of a facing pair on its following face) reads one point, where its leader's port will stand, as range and as key.
 * A tie keeps the order the ports stand in, then the port identity (R3). An authored port keeps its slot: the free ports take the other slots in the order found.
 */
function faceSequence(model: LayoutModel, node: string, side: Side, farAnchors: ReadonlyMap<string, readonly Point[]>, follows: ReadonlyMap<string, number>): PortRef[] | undefined {
  const along = alongOf(side), ports = [...model.nodes[node]!.ports.filter(port => port.side === side)].sort((a, b) => a.engineOrder! - b.engineOrder!);
  const free = ports.filter(port => port.authorOrder === undefined);
  const standing = new Map(free.map((port, index) => [port, index] as const));
  const range = new Map<LayoutPort, { min: number; max: number }>(), mean = new Map<LayoutPort, number>();
  for (const port of free) {
    const point = follows.get(portId(port.ref)), anchors = farAnchors.get(refKey(port.ref));
    if (point !== undefined) { range.set(port, { min: point, max: point }); mean.set(port, point); continue; }
    if (anchors === undefined || anchors.length === 0) { mean.set(port, farCoordinate(model, port.ref, side)); continue; }
    const at = anchors.map(anchor => anchor[along]);
    range.set(port, { min: Math.min(...at), max: Math.max(...at) });
    mean.set(port, at.reduce((sum, value) => sum + value, 0) / at.length);
  }
  const before = new Map<LayoutPort, Set<LayoutPort>>(free.map(port => [port, new Set<LayoutPort>()] as const));
  for (const a of free) for (const b of free) {
    const ra = range.get(a), rb = range.get(b);
    if (a !== b && ra !== undefined && rb !== undefined && ra.max < rb.min - EPS) before.get(b)!.add(a);
  }
  const placed: LayoutPort[] = [], left = new Set(free);
  while (left.size > 0) {
    const ready = [...left].filter(port => [...before.get(port)!].every(other => !left.has(other)));
    // An interval order has no cycle; an empty ready set is a defect of the input, and the face is left as it stands.
    if (ready.length === 0) return undefined;
    ready.sort((a, b) => {
      const ka = mean.get(a)!, kb = mean.get(b)!;
      return (ka === kb ? 0 : ka < kb ? -1 : 1) || standing.get(a)! - standing.get(b)! || portId(a.ref).localeCompare(portId(b.ref));
    });
    const next = ready[0]!;
    placed.push(next); left.delete(next);
  }
  // The free ports take the free slots in the order found; an authored port stays on its slot.
  const slots = ports.map(port => (port.authorOrder === undefined ? placed.shift()! : port));
  // The sequence that is proposed holds G5's own predicate before any placement is paid for.
  const at = new Map(slots.map((port, index) => [port, index] as const));
  for (const a of free) for (const b of free) {
    const ra = range.get(a), rb = range.get(b);
    if (a !== b && ra !== undefined && rb !== undefined && at.get(a)! < at.get(b)! && ra.min > rb.max + EPS) return undefined;
  }
  return slots.map(port => ({ ...port.ref }));
}

/** One facing pair read as leader and follower: the face that leads is sorted first, the face that follows reads where the leader's ports will stand. */
interface Following { leader: { node: string; side: Side }; follower: { node: string; side: Side }; links: readonly LayoutLink[] }

/**
 * The proposal of the far-end round, from one snapshot of a routed placement model: the order of every face that fails G5 and that no other owner holds, and of every face that
 * follows a face that changes. A facing pair is ordered once, from the end that leads (`facingPairs`, as stage 5 does): the held node, unless the face of the other node cannot follow
 * (it has an owner, or the author ordered a port of the pair on it: G5 judges the free ports against such a face and never the other way). A leader sorts by the far ends as they
 * stand; a follower sorts by the place its leader's ports will stand (the slots of the leader's face, in the leader's new order), so no end sorts against slots the other changed
 * without knowing it. Faces are taken in the order of that dependency; a cycle is cut at the face first in node order. `held` is the sequence an earlier trial of this command found for a
 * face that it settled (a face stale on the baseline and settled on the trial): it stays proposed while it stands.
 */
export function proposeFarEndOrder(model: LayoutModel, held: readonly FarEndFace[] = []): FarEndProposal {
  const index = farAnchorIndex(model, routedLinksOf(model));
  const sideOf = (ref: PortRef): Side | undefined => findPort(model, ref)?.side;
  const owner = (node: string, side: Side): FarEndOwner | undefined => farEndOwner(model, node, side);
  const followings: Following[] = [];
  for (const { links, held: heldNode } of facingPairs(model, sideOf)) {
    const ends = links.map(link => link.attachments!);
    const fixed = (node: string): boolean => {
      const mine = ends.map(item => (item.from.node === node ? item.from : item.to)), side = sideOf(mine[0]!);
      return side !== undefined && (owner(node, side) !== undefined || mine.some(ref => findPort(model, ref)?.authorOrder !== undefined));
    };
    const [a, b] = [ends[0]!.from.node, ends[0]!.to.node];
    const lead = fixed(a) !== fixed(b) ? (fixed(a) ? a : b) : heldNode, follow = lead === a ? b : a;
    const faceOf = (node: string): { node: string; side: Side } => ({ node, side: sideOf(ends[0]!.from.node === node ? ends[0]!.from : ends[0]!.to)! });
    followings.push({ leader: faceOf(lead), follower: faceOf(follow), links });
  }
  const heldBy = new Map(held.map(face => [faceKey(face.node, face.side), face] as const));
  const proposal: FarEndProposal = { faces: [], owned: [] };
  const sequences = new Map<string, PortRef[]>();
  // The slots of a face as they stand: the anchors along the face, low to high.
  const slotsOf = (node: string, side: Side): number[] => model.nodes[node]!.ports.filter(port => port.side === side).map(port => port.anchor![alongOf(side)]).sort((x, y) => x - y);
  const order: { node: string; side: Side }[] = [];
  for (const node of orderedNodeIds(model.document)) for (const side of SIDE_TIE_ORDER) order.push({ node, side });
  const leads = (face: { node: string; side: Side }): Following[] => followings.filter(item => item.follower.node === face.node && item.follower.side === face.side);
  const done = new Set<string>();
  const pending = [...order];
  while (pending.length > 0) {
    // The next face whose leaders are all done; a cycle is cut at the first face left.
    const at = pending.findIndex(face => leads(face).every(item => done.has(faceKey(item.leader.node, item.leader.side)) || !pending.some(other => other.node === item.leader.node && other.side === item.leader.side)));
    const face = pending.splice(at < 0 ? 0 : at, 1)[0]!, name = faceKey(face.node, face.side);
    done.add(name);
    const owned = owner(face.node, face.side), stale = faceFails(model, face.node, face.side, index), settled = heldBy.get(name);
    const followed = leads(face), moved = followed.filter(item => sequences.has(faceKey(item.leader.node, item.leader.side)));
    if (!stale && moved.length === 0) { if (settled !== undefined && owned === undefined) { proposal.faces.push({ ...face, ports: settled.ports }); sequences.set(name, settled.ports); } continue; }
    if (owned !== undefined) { if (stale) proposal.owned.push({ ...face, owner: owned }); continue; }
    // A follower reads where its leader's ports will stand: the slot of the leader's new order, or the anchor the leader's port has now.
    const follows = new Map<string, number>();
    for (const item of followed) {
      const lead = item.leader, sequence = sequences.get(faceKey(lead.node, lead.side)), slots = slotsOf(lead.node, lead.side);
      for (const link of item.links) {
        const ends = link.attachments!, mine = ends.from.node === lead.node ? ends.from : ends.to, other = mine === ends.from ? ends.to : ends.from;
        const place = sequence === undefined ? findPort(model, mine)?.anchor?.[alongOf(lead.side)] : slots[sequence.findIndex(ref => portId(ref) === portId(mine))];
        if (place !== undefined) follows.set(portId(other), place);
      }
    }
    const sequence = faceSequence(model, face.node, face.side, index, follows);
    if (sequence === undefined) continue;
    const current = engineSequence(model, face.node, face.side)!.map(portId);
    if (sequence.map(portId).join() === current.join() && !stale) continue;
    proposal.faces.push({ ...face, ports: sequence });
    sequences.set(name, sequence);
  }
  proposal.faces.sort((x, y) => (x.node < y.node ? -1 : x.node > y.node ? 1 : 0) || SIDE_TIE_ORDER.indexOf(x.side) - SIDE_TIE_ORDER.indexOf(y.side));
  return proposal;
}

/**
 * The faces of a proposal in groups that do not touch: two faces are one group when they stand on one node or a link joins a node of one to a node of the other. A trial that a guard refused
 * as a whole is tried again by group, so one face that breaks something does not hold back a face that does not depend on it. Groups are in node and side order.
 */
export function proposalGroups(model: LayoutModel, faces: readonly FarEndFace[]): FarEndFace[][] {
  const parent = faces.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const joined = (a: FarEndFace, b: FarEndFace): boolean => a.node === b.node || model.links.some(link => link.attachments !== undefined
    && ((link.attachments.from.node === a.node && link.attachments.to.node === b.node) || (link.attachments.from.node === b.node && link.attachments.to.node === a.node)));
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) if (joined(faces[i]!, faces[j]!)) parent[find(j)] = find(i);
  const groups = new Map<number, FarEndFace[]>();
  faces.forEach((face, i) => { const root = find(i); groups.set(root, [...(groups.get(root) ?? []), face]); });
  return [...groups.values()];
}

/** The identity of a proposal: the faces and their sequences, for the repeated-state check. */
export const proposalKey = (faces: readonly FarEndFace[]): string => JSON.stringify(faces.map(face => [face.node, face.side, face.ports.map(portId)]));

/** The ports of a face in engine order, as the record and the 7e check read them. */
export function engineSequence(model: LayoutModel, node: string, side: Side): PortRef[] | undefined {
  const ports = model.nodes[node]?.ports.filter(port => port.side === side);
  return ports === undefined ? undefined : [...ports].sort((a, b) => (a.engineOrder ?? 0) - (b.engineOrder ?? 0)).map(port => ({ ...port.ref }));
}

/** Why a recorded or reserved face cannot stand on the model, or `undefined`: the face exists, and its ports stand in engine order as recorded. */
export function farEndFaceFailure(model: LayoutModel, face: FarEndFace): string | undefined {
  if (!['top', 'right', 'bottom', 'left'].includes(face.side) || model.nodes[face.node] === undefined) return 'the face does not exist';
  if (!Array.isArray(face.ports)) return 'the record names no ports';
  const now = engineSequence(model, face.node, face.side)!.map(portId);
  return JSON.stringify(face.ports.map(portId)) === JSON.stringify(now) ? undefined : 'the ports do not stand in the reserved order';
}
