import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { laneRunKind } from './lane-kind.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { faceKey } from './turn-order.js';

/**
 * The growths the centre rule gives back (architecture-2 ticket 71, `LayoutModel.givenBack`). One producer, the end of the centre rule
 * (`strandedGrowth` judges, `centre` re-runs the passes with the record); the centring step reads it (a step that grows a given-back body
 * and keeps none of its targets is declined); the publication check refuses a malformed record (`givenBackFault`).
 */

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

/** Whether the link stands vertical: its two ports face each other, one on a bottom face and one on a top face, within half a pixel in x. */
export function standsVertical(model: LayoutModel, id: string): boolean {
  const link = model.links.find(item => item.id === id);
  if (!link?.attachments) return false;
  const one = findPort(model, link.attachments.from), two = findPort(model, link.attachments.to);
  if (!one?.anchor || !two?.anchor || ![one.side, two.side].includes('top') || ![one.side, two.side].includes('bottom')) return false;
  return Math.abs(one.anchor.x - two.anchor.x) <= 0.5;
}

/**
 * The growths the passes of the centre rule left stranded, read at the rule's end on the record of the alignment targets (ticket 66). A node
 * gives its growth back when the passes widened its body (wider than at the rule's input, `input`), its faces hold a `grown` target and no
 * `kept` one, none of its links stands vertical (a kept chord the width may serve), and no parent spread grew it. The result names the node
 * and its `grown` ports.
 *
 * A node at one end of a transit link (a link that owns a transit corridor) gives its growth back only when the port at the other end is given
 * back too. 7f moves a corridor to the child's port when the child cannot stand under it (`reseatLanes`), and refuses the move when the parent
 * could then align to the moved corridor (a centring violation, `chooseReseat`). A narrow child with a parent that still chases the corridor
 * loses the follow, and its link goes the long way. When both ends are given back, the follow opens no alignment and the corridor follows the
 * given-back child. The filter repeats until no node drops out: each round removes a node, so it ends (R4: a finite traversal).
 *
 * Keys and ports in code-unit order (R3).
 */
export function strandedGrowth(model: LayoutModel, input: LayoutModel): Record<string, string[]> {
  const record = model.alignmentTargets ?? {}, result: Record<string, string[]> = {};
  const vertical = new Set(model.links.filter(link => standsVertical(model, link.id)).map(link => link.id));
  const linksOf = (node: string): string[] => model.links.filter(link => link.attachments && (link.attachments.from.node === node || link.attachments.to.node === node)).map(link => link.id);
  for (const id of Object.keys(model.nodes).sort()) {
    const was = input.nodes[id]?.bounds, now = model.nodes[id]!.bounds;
    if (was === undefined || now === undefined || now.width <= was.width + EPS || model.parentSpreads?.[id] !== undefined) continue;
    const entries = SIDES.flatMap(side => record[faceKey(id, side)] ?? []);
    if (entries.some(entry => entry.state === 'kept') || linksOf(id).some(link => vertical.has(link))) continue;
    const ports = entries.filter(entry => entry.state === 'grown').map(entry => entry.port).sort();
    if (ports.length) result[id] = ports;
  }
  const transit = new Set(model.lanes.filter(lane => lane.owner.kind === 'link' && laneRunKind(lane) === 'transit').map(lane => (lane.owner as { id: string }).id));
  const transitLinks = model.links.filter(link => link.attachments !== undefined && transit.has(link.id));
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const id of Object.keys(result)) {
      const open = transitLinks.some(link => {
        const { from, to } = link.attachments!;
        if (from.node !== id && to.node !== id) return false;
        const far = from.node === id ? to : from;
        return !(Object.hasOwn(result, far.node) && result[far.node]!.includes(portId(far)));
      });
      if (open) { delete result[id]; dropped = true; }
    }
  }
  return result;
}

/**
 * The first fault of a stored record, or undefined (R5): an empty record, a key that is no node, a port list that is empty, out of code-unit
 * order, repeated, or names a port the node does not have; any record on a model before the centre rule's output (`beforeCentre`).
 */
export function givenBackFault(model: LayoutModel, beforeCentre = false): string | undefined {
  const record = model.givenBack;
  if (record === undefined) return undefined;
  if (beforeCentre) return 'a record before the centre rule';
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'the record is not an object';
  if (!Object.keys(record).length) return 'the record names no node';
  for (const [node, ports] of Object.entries(record)) {
    const item = Object.hasOwn(model.nodes, node) ? model.nodes[node] : undefined;
    if (item === undefined) return `${node} is no node`;
    if (!Array.isArray(ports) || !ports.length) return `${node} gives back no port`;
    const own = new Set(item.ports.map(port => portId(port.ref)));
    for (const [index, port] of ports.entries()) {
      if (typeof port !== 'string' || !own.has(port)) return `${node}: ${String(port)} is no port of the node`;
      if (index > 0 && !(ports[index - 1]! < port)) return `${node}: ${port} is out of code-unit order or repeated`;
    }
  }
  return undefined;
}
