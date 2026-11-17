import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { farEndOwner } from './far-end-order.js';
import { groupShape } from './grid.js';
import { placeFaceFromSlots, rebuildNodeGeometry, standsOnSlots } from './node-geometry.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { faceKeyReads, faceSortOf, orderFace } from './sides-two.js';
import { portId } from './skeleton-graph.js';

/**
 * The faces a closed slot sorts again (dense-16x9 ticket 36, slice 3). An open member that the seat set seats in another slot of its row moves the
 * far ends of the faces that read it: stage 5 sorted those faces by the provisional slot. The faces are found by the stage-5 sorter's own key reader
 * (`faceKeyReads`: every face whose key reads the position of a moved member) and sorted again by the one stage-5 sorter (`orderFace`), on the slots
 * of stage 5 (`placeFaceFromSlots`). A face that another owner holds (a turn record or the planned turns, a far-end order, a bar, a bundle, a bus, a
 * stagger row, a flank, a grid), or that stands off its slots, is not sorted here: the slot is declined by name (R6).
 */
export interface Resorted {
  /** The faces whose order changed, in node and side order, with their port keys before and after. */
  faces: { node: string; side: Side; before: string[]; after: string[] }[];
  /** Gives back the engine order and the anchors of every changed face (and its pills, when they were rebuilt). */
  undo: () => void;
}

/** Why the `side` face of `node` is no face the seat set may sort again, or undefined. */
function faceOwner(model: LayoutModel, node: string, side: Side, turned: boolean): string | undefined {
  const owner = farEndOwner(model, node, side);
  if (owner !== undefined && owner !== 'block') return `a ${owner === 'turn' ? 'turn record' : owner}`;
  if ((model.farEndOrder ?? []).some(face => face.node === node && face.side === side)) return 'a far-end order';
  if (turned) return 'the planned first turns';
  const group = model.groups[model.document.nodes[node]!.group]!;
  if (group.flank !== undefined) return 'a flank';
  if (model.staggerRows?.some(row => row.group === group.id)) return 'a stagger row';
  if (groupShape(model, group.id) !== 'row') return `a ${groupShape(model, group.id)}`;
  return undefined;
}

/**
 * Sorts again every face whose stage-5 key reads one of `moved`, after the members stand in their new slots: the engine order and the anchors on
 * the slots, the pills rebuilt with `pills`. Gives back what it changed, or why a face cannot be sorted (nothing changed then).
 */
export function resortFaces(model: LayoutModel, moved: ReadonlySet<string>, pills: boolean): Resorted | string {
  if (!moved.size) return { faces: [], undo: () => {} };
  const sort = faceSortOf(model), plan: { node: string; side: Side; ordered: ReturnType<typeof orderFace>['ordered'] }[] = [];
  for (const id of orderedNodeIds(model.document)) for (const side of SIDE_TIE_ORDER) {
    const node = model.nodes[id]!;
    if (!node.ports.some(port => port.side === side) || ![...faceKeyReads(model, sort, id, side)].some(read => moved.has(read))) continue;
    const face = orderFace(model, sort, id, side), owner = faceOwner(model, id, side, face.turned);
    const now = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    if (face.ordered.every((port, index) => port === now[index])) continue;
    if (owner !== undefined) return `the ${side} face of ${id} reads a moved member and belongs to ${owner}`;
    if (!standsOnSlots(node, side)) return `the ${side} face of ${id} reads a moved member and stands off its slots`;
    plan.push({ node: id, side, ordered: face.ordered });
  }
  const saved = plan.map(item => ({ item, ports: model.nodes[item.node]!.ports.filter(port => port.side === item.side).map(port => ({ port, order: port.engineOrder, anchor: port.anchor && { ...port.anchor } })) }));
  const faces: Resorted['faces'] = [];
  for (const item of plan) {
    const node = model.nodes[item.node]!, before = node.ports.filter(port => port.side === item.side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => portId(port.ref));
    item.ordered.forEach((port, index) => { port.engineOrder = index; });
    placeFaceFromSlots(node, item.side);
    faces.push({ node: item.node, side: item.side, before, after: item.ordered.map(port => portId(port.ref)) });
  }
  const nodes = [...new Set(plan.map(item => item.node))];
  if (pills && nodes.length) rebuildNodeGeometry(model, nodes, 'current');
  return {
    faces,
    undo: () => {
      for (const { ports } of saved) for (const { port, order, anchor } of ports) { if (order !== undefined) port.engineOrder = order; if (anchor) port.anchor = anchor; }
      if (pills && nodes.length) rebuildNodeGeometry(model, nodes, 'current');
    },
  };
}

/** The open members that stand in another slot under `order` than under `base`: those the faces below read again. */
export function movedOpen(open: ReadonlySet<string>, base: readonly string[], order: readonly string[]): Set<string> {
  if (base.length === order.length && base.every((id, i) => id === order[i])) return new Set();
  return new Set([...open].filter(id => order.includes(id)));
}
