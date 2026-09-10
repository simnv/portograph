import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { sizeNodes } from './size.js';
import { bandGap, nodeGap, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { moveGroup, stackBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { freezePortTopology } from './mutation.js';
const key = portId;

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
  sizeNodes(model);
  const protrusion = (id: string, side: Side): number => Math.max(0, ...model.nodes[id]!.ports
    .filter(port => port.side === side && port.ref.anonymous !== true)
    .map(port => measurePortPill(port.ref.name!).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2));
  const rowGap = (a: string, b: string): number => Math.max(nodeGap(model, a, b), protrusion(a, 'right') + protrusion(b, 'left'));
  for (const groupId of orderedGroupIds(model.document)) {
    const group = model.groups[groupId]!, order = group.rowOrder ?? group.nodes;
    let x = group.bounds!.x + spacing.padding;
    for (const [index, id] of order.entries()) {
      if (index) x += rowGap(order[index - 1]!, id);
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
