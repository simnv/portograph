import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { SIDE_TIE_ORDER, portKey, tiedPortComponents } from './sides-one.js';
import { measurePortPill } from '../text/index.js';
import { EPS } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { sizeNodes } from './size.js';
import { bandGap, nodeGap, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { moveGroup, stackBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { nodeObstacleReach, routedStroke, stemReach } from './bands.js';
import { MEMBER_GAP } from './bundle-geometry.js';
import { laneSource, laneWidth, transitTiers } from './lanes.js';
import { fitRegionGroup } from './regions.js';
import { findPort } from './row-paths.js';
import { freezePortTopology } from './mutation.js';
const key = portId;

/**
 * Visible wire between two facing named pills. Without it the two pills' outer edges meet and the
 * link between them is drawn entirely behind them, which is a connection a reader cannot see.
 */
export const PILL_WIRE_GAP = 8;

/**
 * Peer ports of every routed attachment that no rule has already promised geometry to, keyed by
 * port. A bundle member is left out: stage 7e reserves its envelope, its pitch and its path, so it
 * never asks stage 8 for a stem. Everything else may still reach stage 8, which always gives it one.
 *
 * The index is derived from the link array and cached against it. Membership and attachments are
 * fixed in stage 1, and every checked transaction clones the array, so a new array is a new index.
 */
interface Peer { peer: PortRef; link: string }
const peerCache = new WeakMap<LayoutModel['links'], Map<string, Peer[]>>();
function unreservedPeers(model: LayoutModel): Map<string, Peer[]> {
  const cached = peerCache.get(model.links);
  if (cached) return cached;
  const index = new Map<string, Peer[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [near, far] of [[from, to], [to, from]] as const) {
      const list = index.get(key(near)) ?? [];
      list.push({ peer: far, link: link.id });
      index.set(key(near), list);
    }
  }
  peerCache.set(model.links, index);
  return index;
}

/** How far a node's routing obstacle reaches beyond one side: its clearance, or an outward pill. */
function sideReach(model: LayoutModel, id: string, side: Side): number {
  const pill = Math.max(0, ...model.nodes[id]!.ports
    .filter(port => port.side === side && port.ref.anonymous !== true)
    .map(port => measurePortPill(port.ref.name!).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2));
  return Math.max(nodeObstacleReach(model, model.nodes[id]!), pill > 0 ? pill + routedStroke(model) / 2 : 0);
}

/**
 * The ports on `side` of `node` whose links turn inside the gap towards `neighbour` (ADR-0015
 * rule 1): a link that passes the neighbour by, or enters its facing side at another height and so
 * jogs in the gap. Each puts one vertical leg into the gap.
 */
export function gapLegs(model: LayoutModel, node: string, side: 'left' | 'right', neighbour: string): { ports: LayoutPort[]; links: Set<string> } {
  const owner = model.nodes[node]!, other = model.nodes[neighbour]!, peers = unreservedPeers(model);
  const empty = { ports: [] as LayoutPort[], links: new Set<string>() };
  if (!other.bounds) return empty;
  const facing: Side = side === 'left' ? 'right' : 'left';
  const span = Math.max(sideReach(model, neighbour, 'top'), sideReach(model, neighbour, 'bottom'));
  const top = other.bounds.y - span, bottom = other.bounds.y + other.bounds.height + span;
  const ports: LayoutPort[] = [], links = new Set<string>();
  for (const port of owner.ports) {
    if (port.side !== side || port.anchor === undefined || port.anchor.y < top || port.anchor.y > bottom) continue;
    // The qualifying links are kept, not just the port: a port may also carry a link that crosses
    // the gap straight and turns nowhere, which reserves nothing.
    const turning = (peers.get(key(port.ref)) ?? []).filter(({ peer }) => {
      const far = findPort(model, peer);
      const enters = peer.node === neighbour && far?.side === facing;
      // The same tolerance `expectedRowPath` uses to pin a straight row path: anything it would not
      // pin jogs, and a jog that placement did not reserve is what ADR-0015 forbids.
      return !enters || (far.anchor !== undefined && Math.abs(far.anchor.y - port.anchor!.y) > EPS);
    });
    if (!turning.length) continue;
    ports.push(port);
    for (const item of turning) links.add(item.link);
  }
  return { ports, links };
}

/**
 * Row gap between horizontal neighbours: the largest of the stroke-aware node clearance, the two
 * facing named pills with their visible wire, and the stem a port that passes its neighbour by
 * needs in order to leave its node at all.
 */
export function rowGap(model: LayoutModel, a: string, b: string): number {
  const protrusion = (id: string, side: Side): number => Math.max(0, ...model.nodes[id]!.ports
    .filter(port => port.side === side && port.ref.anonymous !== true)
    .map(port => measurePortPill(port.ref.name!).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2));
  // One rule for the obstacle reach, shared with the leg classifier, so the room reserved here and
  // the ports it is reserved for can never be measured differently.
  const reach = (id: string, side: Side): number => sideReach(model, id, side);
  /**
   * Room a port on `side` of `node` needs beside `neighbour` when its link does not end on the
   * neighbour's facing side.
   *
   * Such a port still leaves its node the way every routed attachment does: stage 8 gives it a
   * perpendicular stem and may turn only at the far end of it. When the neighbour's routing
   * obstacle covers the port's own row, that stem has nowhere to go, so the room is reserved here
   * instead of being discovered during routing. A port whose link ends on the neighbour's facing
   * side is pinned to that shape and enters it straight across the gap; one whose link ends on any
   * other side of the neighbour — its far side, its top or its bottom — has to pass the neighbour
   * by like a link to a third node, and reserves the same stem. A port beside the neighbour rather
   * than in front of it is already clear and reserves nothing.
   */
  const passByStem = (node: string, side: 'left' | 'right', neighbour: string): number => {
    const owner = model.nodes[node]!, other = model.nodes[neighbour]!, peers = unreservedPeers(model);
    // Before the skeleton there is no row to be in front of, so there is nothing to reserve yet;
    // the row rule asks again once the nodes and their anchors have coordinates.
    if (!other.bounds) return 0;
    const facing: Side = side === 'left' ? 'right' : 'left';
    const span = Math.max(reach(neighbour, 'top'), reach(neighbour, 'bottom'));
    const top = other.bounds.y - span, bottom = other.bounds.y + other.bounds.height + span;
    const entersNeighbour = (peer: PortRef): boolean => peer.node === neighbour && findPort(model, peer)?.side === facing;
    const blocked = owner.ports.some(port => port.side === side && port.anchor !== undefined
      && port.anchor.y >= top && port.anchor.y <= bottom
      && (peers.get(key(port.ref)) ?? []).some(({ peer }) => !entersNeighbour(peer)));
    return blocked ? stemReach(model, owner) + reach(neighbour, facing) : 0;
  };
  const left = protrusion(a, 'right'), right = protrusion(b, 'left');
  // Only a facing *pair* of pills needs the wire. One pill opposite a bare side has nothing to be
  // separated from, so it keeps the ordinary stroke-aware node clearance.
  // Every leg turning in the gap needs the gate clearance to the next; a side stands one stem off
  // its node when it contributes a leg or receives a jogging link (its approach stem lies in the
  // gap too), and only its plain obstacle reach otherwise.
  const legsAt = { a: gapLegs(model, a, 'right', b), b: gapLegs(model, b, 'left', a) };
  // A jogging link is seen from both of its ports; it is one leg. Legs are the links the classifier
  // itself accepted, by identity, so two links between the same pair of ports are two legs and a
  // link that crosses the gap straight beside one is none.
  // A jogging link enters the neighbour on its facing side; its approach stem lies in the gap.
  const legs = new Set([...legsAt.a.links, ...legsAt.b.links]).size;
  // Only a link the classifier accepted jogs into the facing side; an aligned link beside it enters
  // straight across and asks for no stem.
  const entersFacing = (from: { ports: LayoutPort[]; links: Set<string> }, neighbour: string, facing: Side): boolean =>
    from.ports.some(port => (unreservedPeers(model).get(key(port.ref)) ?? [])
      .some(({ peer, link }) => from.links.has(link) && peer.node === neighbour && findPort(model, peer)?.side === facing));
  const stemSide = (id: string, own: LayoutPort[], incoming: typeof legsAt.a, side: Side): number =>
    own.length || entersFacing(incoming, id, side) ? stemReach(model, model.nodes[id]!) : reach(id, side);
  const turning = legs === 0 ? 0
    : stemSide(a, legsAt.a.ports, legsAt.b, 'right') + stemSide(b, legsAt.b.ports, legsAt.a, 'left')
      + (legs - 1) * (MEMBER_GAP + routedStroke(model));
  return Math.max(nodeGap(model, a, b), left + right + (left > 0 && right > 0 ? PILL_WIRE_GAP : 0),
    passByStem(b, 'left', a), passByStem(a, 'right', b), turning);
}

/** Resolve all direction votes, resize and repack in skeleton order; retain the returned snapshot. */
export function sidesTwo(model: LayoutModel): LayoutModel {
  if (model.stage !== 'skeleton' || model.freeze) throw new Error('Phase-two sides require the skeleton stage');
  const peers = new Map<string, PortRef[]>();
  for (const link of model.links) {
    const { from, to } = link.attachments!;
    for (const [a, b] of key(from) === key(to) ? [[from, to]] : [[from, to], [to, from]]) {
      const list = peers.get(key(a!)) ?? []; list.push(b!); peers.set(key(a!), list);
    }
  }
  // The votes of one undecided port, from where its peers sit.
  const voteFor = (id: string, port: LayoutPort): Record<Side, number> => {
    const node = model.nodes[id]!, group = model.groups[model.document.nodes[id]!.group]!;
    const votes = { bottom: 0, right: 0, top: 0, left: 0 };
    for (const peer of peers.get(key(port.ref)) ?? []) {
      const other = model.nodes[peer.node]!, otherGroup = model.groups[model.document.nodes[peer.node]!.group]!;
      let side: Side;
      if (otherGroup.tier! > group.tier!) side = 'bottom';
      else if (otherGroup.tier! < group.tier!) side = 'top';
      else if (otherGroup.flank && !group.flank) side = otherGroup.flank.align;
      else if (group.flank && !otherGroup.flank) side = group.flank.align === 'left' ? 'right' : 'left';
      else if (otherGroup.id === group.id) side = group.rowOrder!.indexOf(peer.node) < group.rowOrder!.indexOf(id) ? 'left' : 'right';
      else side = other.bounds!.x + other.bounds!.width / 2 < node.bounds!.x + node.bounds!.width / 2 ? 'left' : 'right';
      votes[side]++;
    }
    return votes;
  };
  // Ports one bundle ties at a node vote as one component and take one side (ticket 35); a side a
  // tied port already carries — authored, or decided by stage 2 — binds the whole component.
  const components = tiedPortComponents(model);
  const membersByRoot = new Map<string, LayoutPort[]>();
  for (const [portRef, root] of components) {
    const [nodeId] = JSON.parse(portRef) as [string];
    const port = model.nodes[nodeId]!.ports.find(item => portKey(item.ref) === portRef)!;
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), port]);
  }
  const undecided = new Map<string, { id: string; port: LayoutPort }[]>();
  for (const id of orderedNodeIds(model.document)) {
    for (const port of model.nodes[id]!.ports) {
      if (port.side !== undefined) continue;
      const root = components.get(portKey(port.ref)) ?? portKey(port.ref);
      undecided.set(root, [...(undecided.get(root) ?? []), { id, port }]);
    }
  }
  for (const [root, members] of undecided) {
    const decided = new Set<Side>();
    for (const port of membersByRoot.get(root) ?? []) if (port.side !== undefined) decided.add(port.side);
    if (decided.size > 1) throw new Error(`Bundle members at ${members[0]!.id} leave on different decided sides`);
    const votes = { bottom: 0, right: 0, top: 0, left: 0 };
    for (const { id, port } of members) for (const side of SIDE_TIE_ORDER) votes[side] += voteFor(id, port)[side];
    const chosen: Side = decided.size ? [...decided][0]! : SIDE_TIE_ORDER.reduce((best, side) => votes[side] > votes[best] ? side : best, 'bottom');
    for (const { port } of members) port.side = chosen;
  }
  for (const id of orderedNodeIds(model.document)) for (const port of model.nodes[id]!.ports) delete port.sizingSide;
  // Transit corridors are wider than the ordinary port pitch. Reserve that capacity on the end the
  // lane aligns to (7a) before allocation, so consecutive feeds can retain their own x coordinates.
  for (const link of model.links) {
    if (!transitTiers(model, link).length) continue;
    const ref = laneSource(model, link), node = model.nodes[ref.node]!;
    const port = node.ports.find(port => key(port.ref) === key(ref))!;
    if (port.side === 'top' || port.side === 'bottom') {
      node.sidePitch![port.side] = Math.max(node.sidePitch![port.side]!, laneWidth(model, link));
    }
  }
  // Bundle membership and link widths are already known. Reserve their minimum side capacity
  // before lanes freeze, rather than discovering a larger row width in stage 7e.
  let pitchChanged = true;
  while (pitchChanged) {
    pitchChanged = false;
    for (const bundle of model.bundles) {
      const links = model.links.filter(link => link.bundle === bundle.id);
      const ports = links.flatMap(link => [link.attachments!.from, link.attachments!.to])
        .map(ref => model.nodes[ref.node]!.ports.find(port => key(port.ref) === key(ref))!);
      const pitch = Math.max(16 + Math.max(DEFAULT_STROKE_WIDTHS.path, ...links.map(linkStrokeWidth)),
        ...ports.map(port => model.nodes[port.ref.node]!.sidePitch![port.side!]!));
      for (const port of ports) {
        const node = model.nodes[port.ref.node]!;
        if (node.sidePitch![port.side!]! < pitch) { node.sidePitch![port.side!] = pitch; pitchChanged = true; }
      }
    }
  }
  sizeNodes(model);
  for (const groupId of orderedGroupIds(model.document)) {
    const group = model.groups[groupId]!, order = group.rowOrder ?? group.nodes;
    let x = group.bounds!.x + spacing.padding;
    for (const [index, id] of order.entries()) {
      if (index) x += rowGap(model, order[index - 1]!, id);
      const node = model.nodes[id]!;
      const dx = x - node.bounds!.x;
      for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
      node.bounds = { x, y: node.bounds!.y, ...node.size! };
      x += node.size!.width;
    }
    group.bounds = { x: group.bounds!.x, y: group.bounds!.y,
      width: Math.max(2 * spacing.padding, x - group.bounds!.x + spacing.padding),
      height: Math.max(group.bounds!.y + spacing.padding, ...order.map(id => model.nodes[id]!.bounds!.y + model.nodes[id]!.size!.height)) - group.bounds!.y + spacing.padding };
  }
  for (const tier of model.tierBands) {
    const groups = tier.groups.map(id => model.groups[id]!).sort((a, b) => a.bounds!.x - b.bounds!.x);
    let end = -Infinity;
    for (const group of groups) {
      if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
      end = group.bounds!.x + group.bounds!.width + bandGap(model);
    }
  }
  if (Object.keys(model.groups).length) stackBands(model, true);
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!;
    for (const side of SIDE_TIE_ORDER) {
      const coordinate = (ref: PortRef): number => {
        const peer = model.nodes[ref.node]!, box = peer.bounds!;
        const point = peer.ports.find(port => key(port.ref) === key(ref))?.anchor;
        return side === 'top' || side === 'bottom' ? (point?.x ?? box.x + box.width / 2) : (point?.y ?? box.y + box.height / 2);
      };
      const ports = node.ports.filter(port => port.side === side);
      const far = (ref: PortRef): number => {
        const list = peers.get(key(ref)) ?? [];
        return list.length ? list.reduce((sum, peer) => sum + coordinate(peer), 0) / list.length : Infinity;
      };
      ports.sort((a, b) => far(a.ref) - far(b.ref));
      const authored = ports.filter(port => port.authorOrder !== undefined).sort((a, b) => a.authorOrder! - b.authorOrder!);
      let next = 0;
      const ordered = ports.map(port => port.authorOrder === undefined ? port : authored[next++]!);
      ordered.forEach((port, index) => { port.engineOrder = index; });
    }
  }
  rebuildNodeGeometry(model, orderedNodeIds(model.document), 'from-slots');
  for (const group of Object.values(model.groups)) fitRegionGroup(model, group);
  for (const tier of model.tierBands) {
    let end = -Infinity;
    for (const group of tier.groups.map(id => model.groups[id]!).sort((a, b) => a.bounds!.x - b.bounds!.x)) {
      if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
      end = group.bounds!.x + group.bounds!.width + bandGap(model);
    }
  }
  if (Object.keys(model.groups).length) stackBands(model, true);
  rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  model.stage = 'sides-two';
  return freezePortTopology(model);
}
