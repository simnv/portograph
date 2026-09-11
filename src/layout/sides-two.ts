import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { sizeNodes } from './size.js';
import { bandGap, nodeGap, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { moveGroup, stackBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { nodeObstacleReach, routedStroke, stemReach } from './bands.js';
import { freezePortTopology } from './mutation.js';
const key = portId;

/**
 * Visible wire between two facing named pills. Without it the two pills' outer edges meet and the
 * link between them is drawn entirely behind them, which is a connection a reader cannot see.
 */
export const PILL_WIRE_GAP = 8;

/**
 * Peer nodes of every routed attachment that no rule has already promised geometry to, keyed by
 * port. A bundle member is left out: stage 7e reserves its envelope, its pitch and its path, so it
 * never asks stage 8 for a stem. Everything else may still reach stage 8, which always gives it one.
 *
 * The index is derived from the link array and cached against it. Membership and attachments are
 * fixed in stage 1, and every checked transaction clones the array, so a new array is a new index.
 */
const peerCache = new WeakMap<LayoutModel['links'], Map<string, Set<string>>>();
function unreservedPeers(model: LayoutModel): Map<string, Set<string>> {
  const cached = peerCache.get(model.links);
  if (cached) return cached;
  const index = new Map<string, Set<string>>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [near, far] of [[from, to], [to, from]] as const) {
      const set = index.get(key(near)) ?? new Set<string>();
      set.add(far.node);
      index.set(key(near), set);
    }
  }
  peerCache.set(model.links, index);
  return index;
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
  /** How far a node's routing obstacle reaches beyond one side: its clearance, or an outward pill. */
  const reach = (id: string, side: Side): number => {
    const pill = protrusion(id, side);
    return Math.max(nodeObstacleReach(model, model.nodes[id]!), pill > 0 ? pill + routedStroke(model) / 2 : 0);
  };
  /**
   * Room a port on `side` of `node` needs beside `neighbour` when its link does not end there.
   *
   * Such a port still leaves its node the way every routed attachment does: stage 8 gives it a
   * perpendicular stem and may turn only at the far end of it. When the neighbour's routing
   * obstacle covers the port's own row, that stem has nowhere to go, so the room is reserved here
   * instead of being discovered during routing. A port whose link ends at the neighbour is pinned
   * to that shape and may cross it, and a port beside the neighbour rather than in front of it is
   * already clear; neither reserves anything.
   */
  const passByStem = (node: string, side: 'left' | 'right', neighbour: string): number => {
    const owner = model.nodes[node]!, other = model.nodes[neighbour]!, peers = unreservedPeers(model);
    // Before the skeleton there is no row to be in front of, so there is nothing to reserve yet;
    // the row rule asks again once the nodes and their anchors have coordinates.
    if (!other.bounds) return 0;
    const span = Math.max(reach(neighbour, 'top'), reach(neighbour, 'bottom'));
    const top = other.bounds.y - span, bottom = other.bounds.y + other.bounds.height + span;
    const blocked = owner.ports.some(port => port.side === side && port.anchor !== undefined
      && port.anchor.y >= top && port.anchor.y <= bottom
      && [...(peers.get(key(port.ref)) ?? [])].some(peer => peer !== neighbour));
    return blocked ? stemReach(model, owner) + reach(neighbour, side === 'left' ? 'right' : 'left') : 0;
  };
  const left = protrusion(a, 'right'), right = protrusion(b, 'left');
  // Only a facing *pair* of pills needs the wire. One pill opposite a bare side has nothing to be
  // separated from, so it keeps the ordinary stroke-aware node clearance.
  return Math.max(nodeGap(model, a, b), left + right + (left > 0 && right > 0 ? PILL_WIRE_GAP : 0),
    passByStem(b, 'left', a), passByStem(a, 'right', b));
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
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!, group = model.groups[model.document.nodes[id]!.group]!;
    for (const port of node.ports) {
      if (port.side === undefined) {
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
        port.side = SIDE_TIE_ORDER.reduce((best, side) => votes[side] > votes[best] ? side : best, 'bottom');
      }
      delete port.sizingSide;
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
  model.stage = 'sides-two';
  return freezePortTopology(model);
}
