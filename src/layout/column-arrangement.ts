/**
 * The column arrangement (architecture-2 ticket 52): a group whose members all link laterally to the group beside it stands as one
 * column, one member on each line. Stage 5 of the first placement run decides it from stage-1 and stage-4 facts (which links are
 * lateral, which group stands beside which) once the port sides are final, and before the nodes are re-sized and the rows repacked:
 * the facing node's face takes the column's pitch (`sizeNodes` grows it), and the repack seats the column. The port sort that follows
 * orders the facing face by the members' y, so the links keep the order of their ports and cannot cross, and stage 7b levels every
 * pair with one translation. `groupArrangements` records the decision; every later placement run seats the recorded columns again.
 */
import type { Side } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { groupShape, authoredSide } from './grid.js';
import { findPort } from './row-paths.js';
import { portKey } from './sides-one.js';
import { nodeGap } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { PlacementRefusal } from './placement-refusal.js';
import { columnOf } from './read/arrangement.js';

/** One column: the group, the one node it faces, that node's face toward the group, and the members top to bottom. */
export interface ColumnPlan { group: string; peer: string; face: Side; order: string[] }

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const opposite = (side: 'left' | 'right'): 'left' | 'right' => side === 'left' ? 'right' : 'left';


/** Every link that touches node `id` of `group`, also a link that names the group as an end. */
function linksAt(model: LayoutModel, group: string, id: string): LayoutLink[] {
  return model.links.filter(link => link.attachments === undefined
    ? [link.from, link.to].some(end => 'group' in end && end.group === group)
    : link.attachments.from.node === id || link.attachments.to.node === id);
}
const groupOfNode = (model: LayoutModel, node: string): string => model.document.nodes[node]!.group;

/**
 * The facing group of `group` and the face of a member toward it, or undefined when the group is not a column candidate at all (a tier
 * group none of whose members links to a flank beside it: the stagger rule answers for it).
 */
function facing(model: LayoutModel, group: LayoutGroup): { facing: string[]; memberFace: 'left' | 'right' } | undefined {
  if (group.flank !== undefined) return { facing: [group.flank.of], memberFace: opposite(group.flank.align) };
  const flanks = Object.values(model.groups).filter(other => other.flank?.of === group.id).sort((a, b) => compareId(a.id, b.id));
  const lateral = group.nodes.some(id => model.links.some(link => link.attachments !== undefined
    && [link.attachments.from, link.attachments.to].some(end => end.node === id)
    && [link.attachments.from, link.attachments.to].some(end => flanks.some(flank => flank.id === groupOfNode(model, end.node)))));
  if (!lateral) return undefined;
  return { facing: flanks.map(flank => flank.id), memberFace: flanks[0]!.flank!.align };
}

/** The first rule that keeps `group` a row, or the column plan (the admission rule of ticket 52). */
function admit(model: LayoutModel, group: LayoutGroup, face: { facing: string[]; memberFace: 'left' | 'right' }): ColumnPlan | string {
  if (model.document.groups[group.id]?.shapeAuthored) return 'the author set the shape';
  if (group.frame !== undefined) return 'a rank cell of a ranked frame';
  if (groupShape(model, group.id) !== 'row') return `a ${groupShape(model, group.id)} group`;
  if (group.nodes.length < 2) return 'one member only';
  if (face.facing.length !== 1) return `a flank stands on each side (${face.facing.join(', ')})`;
  const other = face.facing[0]!;
  if (group.flank !== undefined) {
    const shared = Object.values(model.groups).filter(item => item.id !== group.id && item.flank?.of === other
      && item.flank.primaryPeer !== undefined && item.flank.primaryPeer === group.flank!.primaryPeer).map(item => item.id).sort(compareId);
    if (shared.length) return `flank ${shared[0]!} shares the primary peer ${group.flank.primaryPeer!}`;
  }
  const order = group.rowOrder ?? group.nodes;
  const fars: PortRef[] = [];
  for (const id of order) {
    const all = linksAt(model, group.id, id);
    if (all.length === 0) return `member ${id} has no link to ${other}`;
    // A bundle has two links or more at each end, so this also keeps a member with a bundle in the row.
    if (all.length !== 1) return `member ${id} has ${all.length} links, not one`;
    const link = all[0]!;
    if (link.attachments === undefined || link.layer !== 'routed' || ['stub', 'mesh-bus', 'merge', 'overlay'].includes(link.technique ?? '')) return `the link of member ${id} is not a plain routed link`;
    const own = link.attachments.from.node === id ? link.attachments.from : link.attachments.to;
    const far = own === link.attachments.from ? link.attachments.to : link.attachments.from;
    const farGroup = groupOfNode(model, far.node);
    if (farGroup === group.id) return `member ${id} links inside the group`;
    if (farGroup !== other) return `member ${id} links to ${farGroup}, not laterally to ${other}`;
    const ownPort = findPort(model, own), farPort = findPort(model, far);
    if (ownPort === undefined || farPort === undefined) return `a port of the link of member ${id} is not seated`;
    if (ownPort.side !== face.memberFace || farPort.side !== opposite(face.memberFace)) return `the link of member ${id} does not leave through the facing faces`;
    if ([own, far].some(ref => authoredSide(model, ref) !== undefined) || [ownPort, farPort].some(port => port.authorOrder !== undefined)) return `the author set the side or order of a port of member ${id}`;
    fars.push(far);
  }
  const peers = [...new Set(fars.map(ref => ref.node))].sort(compareId);
  if (peers.length !== 1) return `the members link to ${peers.length} nodes of ${other}, not one`;
  if (new Set(fars.map(portKey)).size !== fars.length) return `members share a port of ${peers[0]!}`;
  const peerFace = opposite(face.memberFace), keys = new Set(fars.map(portKey));
  if (model.nodes[peers[0]!]!.ports.some(port => port.side === peerFace && !port.unused && !keys.has(portKey(port.ref)))) return `${peers[0]!} has other ports on its ${peerFace} face`;
  return { group: group.id, peer: peers[0]!, face: peerFace, order: [...order] };
}

/**
 * The column candidates of the current model (stage 5, final sides): the plans that pass the admission rule, and the named reason of every
 * flank group and every tier group with a lateral link that keeps its row. A row of two or more members beside its one facing node hides
 * every member but the nearest behind the nearest body (the structural test; the row's routes are not read at stage 5), and the column
 * predicts 0 crossings, 0 removed links and straight links, so an admitted column is never worse than its row. In group id order.
 */
export function columnCandidates(model: LayoutModel): { plans: ColumnPlan[]; reasons: Map<string, string> } {
  const plans: ColumnPlan[] = [], reasons = new Map<string, string>();
  for (const id of Object.keys(model.groups).sort(compareId)) {
    const group = model.groups[id]!, face = facing(model, group);
    if (face === undefined) continue;
    const result = admit(model, group, face);
    if (typeof result === 'string') reasons.set(id, result); else plans.push(result);
  }
  return { plans, reasons };
}

/** The centre pitch of a column: the tallest member and the node gap of every consecutive pair. */
export function columnPitch(model: LayoutModel, order: readonly string[]): number {
  const gap = Math.max(...order.slice(1).map((id, i) => nodeGap(model, order[i]!, id)));
  return Math.max(...order.map(id => model.nodes[id]!.size!.height)) + gap;
}

/**
 * The plans this placement run seats: decided here in the first run, or read from the record in every later run (an admission the
 * later run no longer passes refuses the run by name, R6). The facing face of each peer takes the column's pitch before the caller
 * re-sizes the nodes, so its ports stand one member apart.
 */
export function reserveColumns(model: LayoutModel, mode: 'decide' | 'keep'): { plans: ColumnPlan[]; reasons: Map<string, string> } {
  if (model.document.layout?.autoArrange === false) return { plans: [], reasons: new Map() };
  const found = columnCandidates(model);
  if (mode === 'keep') {
    const recorded = Object.keys(model.groupArrangements ?? {}).filter(id => columnOf(model, id)).sort(compareId);
    for (const id of recorded) {
      if (!found.plans.some(plan => plan.group === id)) {
        throw new PlacementRefusal('stagger', `The recorded column of ${id} is refused: ${found.reasons.get(id) ?? 'it is no longer a column candidate'}`, { owners: [{ kind: 'group', id }] });
      }
    }
    found.plans = found.plans.filter(plan => recorded.includes(plan.group));
  }
  for (const plan of found.plans) {
    const node = model.nodes[plan.peer]!;
    node.sidePitch = { ...node.sidePitch, [plan.face]: Math.max(node.sidePitch?.[plan.face] ?? 0, columnPitch(model, plan.order)) };
  }
  return found;
}

/** Seat one column inside its group box: members centred on one x, from the row's top, their centres one pitch apart. */
export function seatColumn(model: LayoutModel, group: LayoutGroup, plan: ColumnPlan, padding: number): void {
  const pitch = columnPitch(model, plan.order), widest = Math.max(...plan.order.map(id => model.nodes[id]!.size!.width));
  const tallest = Math.max(...plan.order.map(id => model.nodes[id]!.size!.height));
  const top = Math.min(...plan.order.map(id => model.nodes[id]!.bounds!.y)), centreX = group.bounds!.x + padding + widest / 2;
  for (const [i, id] of plan.order.entries()) {
    const node = model.nodes[id]!, size = node.size!;
    const x = centreX - size.width / 2, y = top + tallest / 2 + i * pitch - size.height / 2;
    const dx = x - node.bounds!.x, dy = y - node.bounds!.y;
    for (const port of node.ports) if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
    node.bounds = { x, y, ...size };
  }
  group.rowOrder = [...plan.order];
  const bottom = Math.max(...plan.order.map(id => model.nodes[id]!.bounds!.y + model.nodes[id]!.size!.height));
  group.bounds = { x: group.bounds!.x, y: group.bounds!.y, width: widest + 2 * padding, height: bottom - group.bounds!.y + padding };
}

/**
 * A recorded column stands as one (R5: geometry and the record, not a diagnostic): the members of `rowOrder` share one centre x, stand
 * top to bottom in that order, and their centres stand one equal pitch apart, at least the tallest member plus the node gap.
 */
export function validateColumns(model: LayoutModel): void {
  for (const id of Object.keys(model.groups).sort(compareId)) {
    if (!columnOf(model, id)) continue;
    const order = model.groups[id]!.rowOrder ?? model.groups[id]!.nodes;
    const boxes = order.map(node => model.nodes[node]!.bounds!);
    const centre = (i: number): { x: number; y: number } => ({ x: boxes[i]!.x + boxes[i]!.width / 2, y: boxes[i]!.y + boxes[i]!.height / 2 });
    const need = columnPitch(model, order), pitch = boxes.length > 1 ? centre(1).y - centre(0).y : need;
    for (let i = 1; i < boxes.length; i++) {
      if (Math.abs(centre(i).x - centre(0).x) > PLACEMENT_EPS || Math.abs(centre(i).y - centre(i - 1).y - pitch) > PLACEMENT_EPS || pitch < need - PLACEMENT_EPS) {
        throw new PlacementRefusal('stagger', `Column ${id} lost its line or pitch`, { owners: [{ kind: 'group', id }] });
      }
    }
  }
}
