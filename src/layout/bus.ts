import type { PortRef } from '../model/document.js';
import type { BusBand, LayoutGroup, LayoutModel, LayoutNode, LayoutPort, MeshBus } from '../model/layout.js';
import { rawBandSide, rawFrameSide } from './bands.js';
import { overlayEndpoint } from './overlay-paths.js';
import { portId } from './skeleton-graph.js';

/**
 * The mesh bus in placement (docs/design/mesh-bus.md, section 4; Q105, Q106). Stage 1 decides the
 * bus; this module knows where it stands (the side), how much room it asks for (the band) and where
 * its bar and stubs run. Nothing here is discovered in routing.
 */

import { BUS_STUB, busBandHeight, busLabelSize } from './bus-room.js';
export { BUS_STUB, BUS_LABEL_FONT, BUS_LABEL_GAP, busBandHeight, busLabelSize, busLabelText, busRoom, heldBusRoom, inFrameBusOf } from './bus-room.js';

export type Edge = 'top' | 'bottom';

export const meshBuses = (model: LayoutModel): MeshBus[] => model.meshBuses ?? [];

/** The bus whose bus port `ref` is, if any. */
export function busOfPort(model: LayoutModel, ref: PortRef): MeshBus | undefined {
  const id = portId(ref);
  return meshBuses(model).find(bus => bus.ports.some(port => portId(port) === id));
}

/** The layout group (the rank cell of a ranked group) that holds each node. */
function holders(model: LayoutModel): Map<string, LayoutGroup> {
  const result = new Map<string, LayoutGroup>();
  for (const group of Object.values(model.groups)) for (const node of group.nodes) result.set(node, group);
  return result;
}

/** Every node that stands on the bus's sub-tier, member or not, in declaration order of the groups. */
export function busRowNodes(model: LayoutModel, bus: MeshBus): LayoutNode[] {
  return Object.values(model.groups).filter(group => group.tier === bus.row).flatMap(group => group.nodes).map(id => model.nodes[id]!);
}

/** The ports that carry at least one routed, non-stub link. */
function routedPorts(model: LayoutModel): Set<string> {
  const result = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    result.add(portId(link.attachments.from));
    result.add(portId(link.attachments.to));
  }
  return result;
}

const sideOf = (port: LayoutPort): string | undefined => port.side ?? port.sizingSide;
const centreX = (node: LayoutNode): number | undefined => node.bounds === undefined ? undefined : node.bounds.x + node.bounds.width / 2;
const portX = (node: LayoutNode, port: LayoutPort): number | undefined => port.anchor?.x ?? centreX(node);

/** The edge whose title the bus takes on a tie (mesh-bus.md, section 4, *Side*). */
export function busTitleEdge(model: LayoutModel, bus: MeshBus): Edge {
  const own = (entry: string): Edge | undefined => {
    if (model.document.frames?.[entry] !== undefined) return rawFrameSide(model, entry);
    const group = model.groups[entry];
    return group === undefined ? undefined : rawBandSide(model, group);
  };
  if (bus.placement === 'in-frame') return own(bus.frames[0]!) ?? 'bottom';
  const counts = { top: 0, bottom: 0 };
  for (const frame of bus.frames) { const side = own(frame); if (side !== undefined) counts[side]++; }
  return counts.top > counts.bottom ? 'top' : 'bottom';
}

/**
 * The horizontal edge of the row that fewer legs cross (maintainer, 2026-09-30: *"whichever has
 * fewer legs"*), within the bar's span.
 *
 * `provisional` is stage 2: the stage-2 sides (`side`, or the sizing estimate) of every node of the
 * row, because the row's order, and so the span, are not known before the skeleton. Otherwise it is
 * stage 5, after the skeleton: term 1 is exact within the span read off the skeleton order, and term 2
 * (no plan exists before 7a) is read as the routed ports of the tier across the gap that face it and
 * the routed ports of the row's nodes outside the span whose other end stands over it, at skeleton x.
 * Term 3, the lanes, is equal on both edges and decides nothing. A tie takes the title edge.
 */
export function busSide(model: LayoutModel, bus: MeshBus, provisional = false): Edge {
  const row = busRowNodes(model, bus), used = routedPorts(model), members = new Set(bus.nodes);
  const counts = { top: 0, bottom: 0 };
  const xs = bus.nodes.map(id => centreX(model.nodes[id]!)).filter((x): x is number => x !== undefined);
  const spanned = !provisional && xs.length === bus.nodes.length;
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const inSpan = (node: LayoutNode): boolean => !spanned || members.has(node.id) || (centreX(node)! >= lo && centreX(node)! <= hi);
  for (const node of row) {
    if (!inSpan(node)) continue;
    for (const port of node.ports) {
      const side = sideOf(port);
      if ((side === 'top' || side === 'bottom') && used.has(portId(port.ref))) counts[side]++;
    }
  }
  if (spanned) {
    // Term 2, physically read. A link between a row and the tier across the gap ends at the row in a port that term 1 counts, and its
    // run in the gap lies below the band (the plan seats no row inside it), so it crosses the bar nowhere else. What does stand over
    // the span is a link that passes the whole row: one end in a tier above, the other in a tier below, which runs through the gap at
    // the port's own x before it turns to its lane. Its port in the tier across the gap counts, at its skeleton x.
    const holder = holders(model), tierOf = (id: string): number | undefined => holder.get(id)?.tier;
    const allTiers = Object.values(model.groups).map(group => group.tier!).filter(tier => tier !== undefined);
    const above = Math.max(...allTiers.filter(t => t < bus.row)), below = Math.min(...allTiers.filter(t => t > bus.row));
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
      const ends = [link.attachments.from, link.attachments.to], tiers = ends.map(ref => tierOf(ref.node));
      if (tiers.some(tier => tier === undefined) || Math.min(...(tiers as number[])) >= bus.row || Math.max(...(tiers as number[])) <= bus.row) continue;
      for (const ref of ends) {
        const node = model.nodes[ref.node]!, port = node.ports.find(item => portId(item.ref) === portId(ref)), x = port === undefined ? undefined : portX(node, port);
        const tier = tierOf(ref.node)!;
        if ((tier !== above && tier !== below) || x === undefined || x < lo || x > hi) continue;
        counts[tier < bus.row ? 'top' : 'bottom']++;
      }
    }
  }
  if (counts.top !== counts.bottom) return counts.top < counts.bottom ? 'top' : 'bottom';
  return busTitleEdge(model, bus);
}

const portOf = (model: LayoutModel, ref: PortRef): LayoutPort | undefined =>
  model.nodes[ref.node]?.ports.find(port => portId(port.ref) === portId(ref));

/** The geometry a bus stands on: the x of its first and last bus port, and the line `edge` it is measured from. */
export interface BusExtent { lo: number; hi: number; edge: number; side: Edge }

/**
 * The line `L` the bus band is measured from and the span of its bar. In-frame, `L` is the outermost
 * body or pill extent of the members' cell on the bus side; across frames it is the outermost edge on that
 * side of the groups of the row that stand in the span (the frame edge with its padding and label band, or
 * the cell's body extent where the row is a middle cell), foreign ones included. `undefined` until the
 * side is fixed and the geometry exists.
 */
export function busExtent(model: LayoutModel, bus: MeshBus): BusExtent | undefined {
  const side = bus.side;
  if (side === undefined) return undefined;
  const xs = bus.ports.map(ref => { const port = portOf(model, ref), node = model.nodes[ref.node]; return port?.anchor?.x ?? (node === undefined ? undefined : centreX(node)); });
  if (xs.some(x => x === undefined)) return undefined;
  const lo = Math.min(...(xs as number[])), hi = Math.max(...(xs as number[]));
  const pick = side === 'bottom' ? Math.max : Math.min;
  let edge: number;
  if (bus.placement === 'in-frame') {
    const group = Object.values(model.groups).find(item => item.nodes.includes(bus.nodes[0]!));
    if (group === undefined) return undefined;
    const reach: number[] = [];
    for (const id of group.nodes) {
      const node = model.nodes[id]!;
      if (node.bounds === undefined) return undefined;
      reach.push(side === 'bottom' ? node.bounds.y + node.bounds.height : node.bounds.y);
      for (const port of node.ports) if (port.pill?.bounds !== undefined && port.side === side) reach.push(side === 'bottom' ? port.pill.bounds.y + port.pill.bounds.height : port.pill.bounds.y);
    }
    edge = pick(...reach);
  } else {
    const boxes = Object.values(model.groups).filter(group => group.tier === bus.row && group.bounds !== undefined && group.nodes.length
      && group.bounds.x < hi && group.bounds.x + group.bounds.width > lo).map(group => group.bounds!);
    if (!boxes.length) return undefined;
    edge = pick(...boxes.map(box => side === 'bottom' ? box.y + box.height : box.y));
  }
  return { lo, hi, edge, side };
}

/** The bus bands the current geometry calls for, one per bus whose side is fixed and whose members stand. */
export function expectedBusBands(model: LayoutModel): BusBand[] {
  const result: BusBand[] = [];
  for (const bus of meshBuses(model)) {
    const extent = busExtent(model, bus);
    if (extent === undefined) continue;
    const height = busBandHeight(bus);
    const group = bus.placement === 'in-frame' ? Object.values(model.groups).find(item => item.nodes.includes(bus.nodes[0]!))?.id : undefined;
    result.push({ id: `bus-band:${bus.id}`, bus: bus.id, ...(group !== undefined ? { group } : {}), owner: { kind: 'mesh-bus', id: bus.id }, layer: 'overlay',
      side: extent.side, bounds: { x: extent.lo, y: extent.side === 'bottom' ? extent.edge : extent.edge - height, width: extent.hi - extent.lo, height } });
  }
  return result;
}

/** The x of every vertical that crosses the bus band inside the span: the routed legs of the row's nodes on the bus side, and lanes. */
function bandVerticals(model: LayoutModel, bus: MeshBus, extent: BusExtent): number[] {
  const used = routedPorts(model), xs: number[] = [];
  const members = new Set(bus.nodes);
  for (const node of busRowNodes(model, bus)) for (const port of node.ports) {
    if (port.side !== extent.side || !used.has(portId(port.ref)) || port.anchor === undefined) continue;
    if (members.has(node.id) || (centreX(node) ?? 0) >= extent.lo && (centreX(node) ?? 0) <= extent.hi) xs.push(port.anchor.x);
  }
  const band = extent.side === 'bottom' ? { from: extent.edge, to: extent.edge + busBandHeight(bus) } : { from: extent.edge - busBandHeight(bus), to: extent.edge };
  for (const lane of model.lanes) {
    if (lane.bounds.y >= band.to || lane.bounds.y + lane.bounds.height <= band.from) continue;
    xs.push(lane.bounds.x + lane.bounds.width / 2);
  }
  return xs.filter(x => x >= extent.lo - 1e-6 && x <= extent.hi + 1e-6);
}

/**
 * The bar, the stubs and the label's room, read off the settled row (mesh-bus.md, section 4, *Where the bar stands*).
 * The bar runs at `L + BUS_STUB` from the first bus port to the last; a stub runs from its port's outward face
 * straight to the bar. The label takes the centre of the bar when the centre is clear of every vertical, else the
 * longest clear interval that holds it; `undefined` when none does.
 */
export function busGeometry(model: LayoutModel, bus: MeshBus): Pick<MeshBus, 'bar' | 'stubs' | 'labelRoom'> | undefined {
  const extent = busExtent(model, bus);
  if (extent === undefined) return undefined;
  const y = extent.side === 'bottom' ? extent.edge + BUS_STUB : extent.edge - BUS_STUB;
  const stubs: NonNullable<MeshBus['stubs']> = [];
  for (const ref of bus.ports) {
    const node = model.nodes[ref.node]!, port = portOf(model, ref);
    const face = overlayEndpoint(node, port);
    if (face === undefined) return undefined;
    stubs.push({ node: ref.node, from: { ...face }, to: { x: face.x, y } });
  }
  // A stub ends at the bar and the label stands beyond it, so a stub never touches the label; only a vertical that crosses the band does.
  const blockers = bandVerticals(model, bus, extent).sort((a, b) => a - b);
  const points = [extent.lo, ...blockers, extent.hi].sort((a, b) => a - b);
  const width = busLabelSize(bus).width, centre = (extent.lo + extent.hi) / 2;
  const gaps = points.slice(1).map((high, i) => ({ from: points[i]!, to: high })).filter(gap => gap.to - gap.from >= width);
  const around = gaps.find(gap => gap.from <= centre - width / 2 && gap.to >= centre + width / 2);
  const longest = [...gaps].sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)[0];
  const room = around !== undefined ? { from: centre - width / 2, to: centre + width / 2 }
    : longest === undefined ? undefined : { from: (longest.from + longest.to - width) / 2, to: (longest.from + longest.to + width) / 2 };
  return { bar: { from: { x: extent.lo, y }, to: { x: extent.hi, y } }, stubs, ...(room !== undefined ? { labelRoom: room } : {}) };
}

/** Publish the geometry of every bus whose side is fixed; a bus with no geometry yet keeps none. */
export function syncBusGeometry(model: LayoutModel): void {
  for (const bus of meshBuses(model)) {
    delete bus.bar; delete bus.stubs; delete bus.labelRoom;
    const geometry = busGeometry(model, bus);
    if (geometry !== undefined) Object.assign(bus, geometry);
  }
}
