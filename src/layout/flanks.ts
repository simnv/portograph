import type { LayoutGroup, LayoutLink, LayoutModel, LayoutPath, LayoutPort } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { pathStrokeWidth } from '../theme/geometry.js';
import { findPort, straightCorridorClear } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { moveGroup, validateSkeletonBands } from './skeleton-geometry.js';
import { withLayoutMutation } from './mutation.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { fitRegionGroup, placementWarning, rebuildRegions } from './regions.js';

export interface FlankPair { link: LayoutLink; group: LayoutGroup; own: LayoutPort; peer: LayoutPort }
/** Consume the stored primary only; geometry never reselects it. */
export function flankPair(model: LayoutModel, link: LayoutLink): FlankPair | undefined {
  if (link.layer !== 'routed' || !link.attachments || link.technique === 'stub') return undefined;
  const from = findPort(model, link.attachments.from)!, to = findPort(model, link.attachments.to)!;
  for (const [own, peer] of [[from, to], [to, from]] as const) {
    const group = model.groups[model.document.nodes[own.ref.node]!.group]!;
    if (group.flank?.primaryPeer !== peer.ref.node) continue;
    if (own.side === (group.flank.align === 'left' ? 'right' : 'left') && peer.side === group.flank.align) return { link, group, own, peer };
  }
  return undefined;
}
export function flankPathCandidate(model: LayoutModel, link: LayoutLink): boolean {
  const route = model.document.links[link.sourceIndex]?.route;
  return !link.bundle && !link.groupLink && (route === undefined || route === 'straight' || route === 'orthogonal') && flankPair(model, link) !== undefined;
}
export function expectedFlankPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!flankPathCandidate(model, link)) return undefined;
  const pair = flankPair(model, link)!, from = findPort(model, link.attachments!.from)!, to = findPort(model, link.attachments!.to)!;
  const dx = pair.peer.anchor!.x - pair.own.anchor!.x;
  if ((pair.own.side === 'right' ? dx : -dx) < 15 || Math.abs(from.anchor!.y - to.anchor!.y) > 1e-6) return undefined;
  const segment = { from: { ...from.anchor! }, to: { ...to.anchor! }, owner: { ...link.owner } };
  if (!straightCorridorClear(model, link, segment)) return undefined;
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}
/** Remove every old flank claim before testing final corridors. */
export function rebuildFlankPaths(model: LayoutModel): void {
  const candidates = model.links.filter(link => flankPathCandidate(model, link));
  for (const link of candidates) delete link.path;
  for (const link of candidates) {
    const path = expectedFlankPath(model, link);
    if (path) link.path = path;
    if (model.document.links[link.sourceIndex]?.route === undefined) link.technique = path ? 'straight' : 'orthogonal';
  }
}
/**
 * Put primary bundle members in one compatible order on both facing sides. Only this block may
 * move around other ports; their relative sequence and every authored precedence remain intact.
 */
export function normalizePrimaryBundlePorts(model: LayoutModel): void {
  const byBundle = new Map<string, FlankPair[]>();
  for (const link of model.links) {
    const pair = flankPair(model, link);
    if (!pair || !link.bundle) continue;
    const list = byBundle.get(link.bundle) ?? []; list.push(pair); byBundle.set(link.bundle, list);
  }
  for (const list of byBundle.values()) {
    if (new Set(list.map(pair => portId(pair.own.ref))).size !== list.length
      || new Set(list.map(pair => portId(pair.peer.ref))).size !== list.length) continue;
    const remaining = [...list], ordered: FlankPair[] = [];
    while (remaining.length) {
      const candidates = remaining.filter(pair => !remaining.some(other => other !== pair &&
        (['own', 'peer'] as const).some(end => other[end].authorOrder !== undefined && pair[end].authorOrder !== undefined
          && other[end].authorOrder! < pair[end].authorOrder!)));
      candidates.sort((a, b) => a.peer.engineOrder! - b.peer.engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
      if (!candidates.length) break;
      const next = candidates[0]!; ordered.push(next); remaining.splice(remaining.indexOf(next), 1);
    }
    if (remaining.length) {
      placementWarning(model, 'FLANK_PAIR_INCOMPATIBLE', `Primary bundle ${list[0]!.link.bundle!} has incompatible authored precedence.`, list.map(pair => pair.link.id));
      continue;
    }
    const proposals: LayoutPort[][] = [];
    for (const end of ['own', 'peer'] as const) {
      const first = list[0]![end], node = model.nodes[first.ref.node]!;
      const side = node.ports.filter(port => port.side === first.side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      const members = new Set(list.map(pair => portId(pair[end].ref)));
      const start = side.findIndex(port => members.has(portId(port.ref)));
      const others = side.filter(port => !members.has(portId(port.ref)));
      // The block sits where its far ends sit (G5), by choosing one place in the remaining ports to
      // insert it: everything before that place keeps its slot ahead of the block and everything
      // from it keeps its slot behind. A per-port test would answer the same question but could
      // swap two unrelated ports around the block, and only this block may reorder anything
      // (ADR-0010). Placing the block at the first member's old slot instead pushed a port past far
      // ends it precedes (ticket 21).
      const range = ordered.map(pair => farCoordinate(model, pair[end])).filter(Number.isFinite);
      const low = Math.min(...range), high = Math.max(...range);
      // Only unauthored ports answer the far-end question; G5 judges no other kind, and an authored
      // sentinel with no routed peer reads as `Infinity`, which would otherwise decide the place.
      const free = others.filter(port => port.authorOrder === undefined);
      const target = free.find(port => farCoordinate(model, port) >= low - 1e-6);
      const found = target ? others.indexOf(target) : -1;
      // An authored port is a wall. G5 judges only unauthored ports, and ADR-0010 keeps every
      // authored key in place, so the block may not cross one however its far ends read: it stays
      // on the side of each authored port it started on.
      const origin = others.filter(port => side.indexOf(port) < start).length;
      let lowWall = 0, highWall = others.length;
      others.forEach((port, index) => {
        if (port.authorOrder === undefined) return;
        if (index < origin) lowWall = Math.max(lowWall, index + 1);
        else highWall = Math.min(highWall, index);
      });
      const at = Math.min(Math.max(found < 0 ? others.length : found, lowWall), highWall);
      const proposal = [...others.slice(0, at), ...ordered.map(pair => pair[end]), ...others.slice(at)];
      proposals.push(proposal);
    }
    const valid = proposals.every(ports => {
      let last = -Infinity;
      for (const port of ports) if (port.authorOrder !== undefined) { if (port.authorOrder < last) return false; last = port.authorOrder; }
      return true;
    });
    if (!valid) {
      placementWarning(model, 'FLANK_PAIR_INCOMPATIBLE', `Primary bundle ${list[0]!.link.bundle!} cannot form a block without reversing authored precedence.`, list.map(pair => pair.link.id));
      continue;
    }
    for (const proposal of proposals) proposal.forEach((port, index) => { port.engineOrder = index; });
  }
}

/**
 * Where a port's links go, on the axis its side is ordered along: the mean tangent coordinate of
 * its routed peers' anchors, `Infinity` for an unlinked port, so it sorts last like in stage 5.
 */
function farCoordinate(model: LayoutModel, port: LayoutPort): number {
  const vertical = port.side === 'left' || port.side === 'right';
  const values: number[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [near, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      if (portId(near) !== portId(port.ref)) continue;
      const peer = findPort(model, far);
      const node = model.nodes[far.node]!, box = node.bounds!;
      values.push(peer?.anchor ? (vertical ? peer.anchor.y : peer.anchor.x) : vertical ? box.y + box.height / 2 : box.x + box.width / 2);
    }
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
}

/** Equalise complete facing sides, grow capacity, then translate each flank as one group. */
export function alignFlanks(model: LayoutModel): void {
  normalizePrimaryBundlePorts(model);
  const pairs = model.links.map(link => flankPair(model, link)).filter((pair): pair is FlankPair => pair !== undefined);
  const sides = new Map<string, Map<Side, number>>();
  for (const pair of pairs) {
    const pitch = Math.max(model.nodes[pair.own.ref.node]!.sidePitch![pair.own.side!]!, model.nodes[pair.peer.ref.node]!.sidePitch![pair.peer.side!]!);
    for (const port of [pair.own, pair.peer]) {
      const map = sides.get(port.ref.node) ?? new Map<Side, number>();
      map.set(port.side!, Math.max(map.get(port.side!) ?? 0, pitch)); sides.set(port.ref.node, map);
    }
  }
  // Propagate through shared facing sides so several flank nodes use the same larger pitch.
  for (let pass = 0; pass < pairs.length; pass++) for (const pair of pairs) {
    const own = sides.get(pair.own.ref.node)!, peer = sides.get(pair.peer.ref.node)!;
    const pitch = Math.max(own.get(pair.own.side!)!, peer.get(pair.peer.side!)!);
    own.set(pair.own.side!, pitch); peer.set(pair.peer.side!, pitch);
  }
  for (const [id, pitches] of sides) {
    const node = model.nodes[id]!, box = node.bounds!;
    for (const [side, pitch] of pitches) {
      node.sidePitch![side] = pitch;
      box.height = Math.max(box.height, node.ports.filter(port => port.side === side).length * pitch + 20);
    }
    node.size = { width: box.width, height: box.height };
    for (const port of node.ports) if (port.side === 'bottom') port.anchor!.y = box.y + box.height;
    for (const [side, pitch] of pitches) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      ports.forEach((port, index) => { port.anchor = portAnchor(box, side, (box.height - (ports.length - 1) * pitch) / 2 + index * pitch); });
    }
  }
  for (const group of Object.values(model.groups).filter(group => group.flank)) {
    const distinct = new Map<string, FlankPair>();
    for (const pair of pairs.filter(pair => pair.group.id === group.id)) distinct.set(JSON.stringify([portId(pair.own.ref), portId(pair.peer.ref)]), pair);
    const list = [...distinct.values()].sort((a, b) => a.own.anchor!.y - b.own.anchor!.y || portId(a.own.ref).localeCompare(portId(b.own.ref)));
    const first = list[0];
    if (!first) continue;
    const demand = new Set(list.map(pair => portId(pair.own.ref))).size, capacity = new Set(list.map(pair => portId(pair.peer.ref))).size;
    if (demand > capacity) placementWarning(model, 'FLANK_CAPACITY', `Flank ${group.id} needs ${demand} distinct facing ports; its stored primary offers ${capacity} paired anchors.`, [group.id], 'group');
    moveGroup(model, group, 0, first.peer.anchor!.y - first.own.anchor!.y);
    for (const pair of list) if (Math.abs(pair.own.anchor!.y - pair.peer.anchor!.y) > 0.5) placementWarning(model, 'FLANK_PAIR_INCOMPATIBLE',
      `${pair.link.id} cannot level with the stored primary without changing port order.`, [pair.link.id]);
  }
  for (const group of Object.values(model.groups)) if (group.nodes.some(id => sides.has(id))) fitRegionGroup(model, group);
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  if (validateSkeletonBands(model).length) placementWarning(model, 'PLACEMENT_NON_CONVERGENCE',
    'Flank growth exceeds the available tier band; later placement must retain this conflict for final gates.', Object.keys(model.groups), 'group');
}
export function flanks(model: LayoutModel): LayoutModel { return withLayoutMutation(model, 'flanks', alignFlanks); }
