import type { PortRef } from '../model/document.js';
import type { Point } from '../model/geometry.js';
import type { BusBand, LayoutGroup, LayoutModel, LayoutNode, LayoutPort, MeshBus } from '../model/layout.js';
import { rawBandSide, rawFrameSide } from './bands.js';
import { overlayEndpoint } from './overlay-paths.js';
import { portId } from './skeleton-graph.js';

/**
 * The mesh bus in placement (docs/design/mesh-bus.md, section 4; Q105, Q106). Stage 1 decides the
 * bus; this module knows where it stands (the side), how much room it asks for (the band) and where
 * its bar and stubs run. Nothing here is discovered in routing.
 */

import { BUS_STUB, busBandHeight, busCarriesLabel, busLabelSize } from './bus-room.js';
export { isCrossLink, BUS_STUB, BUS_RUN_CLEARANCE, busCarriesLabel, BUS_LABEL_FONT, BUS_LABEL_GAP, busBandHeight, busLabelSize, busLabelText, busRoom, heldBusRoom, inFrameBusOf } from './bus-room.js';

export type Edge = 'top' | 'bottom';

export const meshBuses = (model: LayoutModel): MeshBus[] => model.meshBuses ?? [];

/** The upper bus of the join `bus` belongs to (the bus itself when it is the upper one), or `undefined` when it is joined to none. */
export function joinUpper(model: LayoutModel, bus: MeshBus): MeshBus | undefined {
  if (bus.joined === undefined) return undefined;
  return bus.cross !== undefined ? bus : meshBuses(model).find(item => item.id === bus.joined);
}

/** The riser of the join `bus` belongs to, once stage 7a has fixed it. */
export const riserOf = (model: LayoutModel, bus: MeshBus): NonNullable<MeshBus['riser']> | undefined => joinUpper(model, bus)?.riser;

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

/** The horizontal edge an author fixed on a bus port (`side: top|bottom`); stage 1 declines a bus whose ports state `left`, `right` or both edges. */
export function authoredBusSide(model: LayoutModel, bus: MeshBus): Edge | undefined {
  for (const ref of bus.ports) {
    if (ref.anonymous === true) continue;
    const side = model.document.nodes[ref.node]?.ports.find(port => port.name === ref.name && port.ordinal === ref.ordinal)?.side;
    if (side === 'top' || side === 'bottom') return side;
  }
  return undefined;
}

/**
 * The horizontal edge of the row that fewer legs cross (maintainer, 2026-09-30: *"whichever has
 * fewer legs"*), within the bar's span.
 *
 * An authored `side: top|bottom` on a bus port fixes the edge (`authoredBusSide`), before any count.
 *
 * `provisional` is stage 2: the stage-2 sides (`side`, or the sizing estimate) of every node of the
 * row, because the row's order, and so the span, are not known before the skeleton. Otherwise it is
 * stage 5, after the skeleton: term 1 is exact within the span read off the skeleton order. Term 2
 * (no plan exists before 7a) is read only across frames, and on an edge that faces a rank gap for a bus in a rank cell (`edgeFacesGap`, per edge), as the
 * ports, in the tier across the gap and on the side that faces it, of the routed links that pass the whole row, at skeleton x:
 * such a link's vertical over the span stands in the gap of its own end, and its lane stands beside the row at the lane's x, outside the
 * span, so it is counted on that edge only. A link between the row and the tier across the gap ends in a port term 1 counts. Term 3, the
 * lanes over the span, is equal on both edges and decides nothing. A tie takes the title edge.
 */
export function busSide(model: LayoutModel, bus: MeshBus, provisional = false): Edge {
  // A joined pair stands on the facing edges, fixed at stage 1 before any count (mesh-bus.md, section 11.4).
  if (bus.joined !== undefined) return bus.cross !== undefined ? 'bottom' : 'top';
  const fixed = authoredBusSide(model, bus);
  if (fixed !== undefined) return fixed;
  const counts = busLegCounts(model, bus, provisional);
  if (counts.top !== counts.bottom) return counts.top < counts.bottom ? 'top' : 'bottom';
  return busTitleEdge(model, bus);
}

/**
 * Whether the `edge` of the bus's row faces a gap that term 2 reads: across frames, the sub-tier gap; for a bus in a rank cell, the rank gap
 * above a cell that is not the first rank of its frame and below one that is not the last. An in-frame bus against a frame padding has term 1
 * alone there: a lane runs beside the cells, and a drop of another tier stays outside the group box (mesh-bus.md, section 4).
 */
function edgeFacesGap(model: LayoutModel, bus: MeshBus, edge: Edge): boolean {
  if (bus.placement === 'across-frames') return true;
  const group = Object.values(model.groups).find(item => item.nodes.includes(bus.nodes[0]!));
  if (group?.frame === undefined) return false;
  const cells = model.document.frames?.[group.frame]?.cells, at = cells?.indexOf(group.id) ?? -1;
  return cells !== undefined && at >= 0 && (edge === 'top' ? at > 0 : at < cells.length - 1);
}

/** The legs each horizontal edge of the row carries within the bar's span (see `busSide`): what the choice of edge compares. */
export function busLegCounts(model: LayoutModel, bus: MeshBus, provisional = false): { top: number; bottom: number } {
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
        const edge = tier < bus.row ? 'top' : 'bottom';
        if (edgeFacesGap(model, bus, edge)) counts[edge]++;
      }
    }
  }
  return counts;
}

/**
 * The verticals that cross a bar's line in the published layout, per edge of the row: the routed segments (a frame-straight chord included)
 * that pass the line `BUS_STUB` beyond that edge within the bar's span (docs/design/mesh-bus.md, section 4). On the bus's own edge the line
 * is the bar; on the other edge it is where a bar would stand. No gate reads them; the overlay report counts them beside the stage-5 leg
 * counts (`busLegCounts`), which are what the choice of edge compared.
 */
export function busVerticalCounts(model: LayoutModel, bus: MeshBus): { top: number; bottom: number } {
  const counts = { top: 0, bottom: 0 };
  if (bus.bar === undefined || bus.side === undefined) return counts;
  const lo = Math.min(bus.bar.from.x, bus.bar.to.x), hi = Math.max(bus.bar.from.x, bus.bar.to.x);
  for (const edge of ['top', 'bottom'] as const) {
    const extent = edge === bus.side ? undefined : busExtent(model, { ...bus, side: edge });
    const y = edge === bus.side ? bus.bar.from.y : extent === undefined ? undefined : edge === 'bottom' ? extent.edge + BUS_STUB : extent.edge - BUS_STUB;
    if (y === undefined) continue;
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || link.path === undefined) continue;
      for (const segment of link.path.segments) {
        if (!(Math.min(segment.from.y, segment.to.y) < y - 1e-6 && Math.max(segment.from.y, segment.to.y) > y + 1e-6)) continue;
        const x = segment.from.x + (segment.to.x - segment.from.x) * (y - segment.from.y) / (segment.to.y - segment.from.y);
        if (x >= lo - 1e-6 && x <= hi + 1e-6) counts[edge]++;
      }
    }
  }
  return counts;
}

/** The verticals across the bar itself (the bus's own edge of `busVerticalCounts`). */
export function busVerticals(model: LayoutModel, bus: MeshBus): number {
  return bus.side === undefined ? 0 : busVerticalCounts(model, bus)[bus.side];
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
  // A joined bar runs to the riser (mesh-bus.md, section 11.5): the riser x fixed in 7a is part of the interval.
  const riser = riserOf(model, bus);
  const lo = Math.min(...(xs as number[]), ...(riser ? [riser.x] : [])), hi = Math.max(...(xs as number[]), ...(riser ? [riser.x] : []));
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

/** The x of every vertical that crosses the bus band inside the span: the routed legs of the row's nodes on the bus side, lanes, and frame and group side edges. */
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
  // A frame or group side edge that crosses the band is a blocker too: a label stood across it would sit on the box's edge.
  const boxes = [...(model.frames ?? []).map(frame => frame.box), ...Object.values(model.groups).filter(group => group.frame === undefined && group.nodes.length && group.bounds !== undefined).map(group => group.bounds!)];
  for (const box of boxes) {
    if (box.y >= band.to || box.y + box.height <= band.from) continue;
    xs.push(box.x, box.x + box.width);
  }
  // The riser leaves the bar: one more vertical across the band of a bar that carries the label (and across the band of another bus it crosses).
  const riser = riserOf(model, bus);
  if (riser !== undefined) xs.push(riser.x);
  return xs.filter(x => x >= extent.lo - 1e-6 && x <= extent.hi + 1e-6);
}

/**
 * The x intervals a diagonal routed segment (a frame-straight chord) covers inside the bus band: a label may not stand over one. A chord is
 * decided before 7f (the freeze) and its path follows its ports, so it is known here.
 */
function bandChordSpans(model: LayoutModel, bus: MeshBus, extent: BusExtent): [number, number][] {
  const height = busBandHeight(bus);
  const band = extent.side === 'bottom' ? { from: extent.edge, to: extent.edge + height } : { from: extent.edge - height, to: extent.edge };
  const spans: [number, number][] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.path === undefined) continue;
    for (const { from, to } of link.path.segments) {
      const dx = to.x - from.x, dy = to.y - from.y;
      if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) continue;
      const low = Math.max(band.from, Math.min(from.y, to.y)), high = Math.min(band.to, Math.max(from.y, to.y));
      if (low >= high) continue;
      const a = from.x + dx * (low - from.y) / dy, b = from.x + dx * (high - from.y) / dy;
      spans.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return spans;
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
  const width = busLabelSize(bus).width, centre = (extent.lo + extent.hi) / 2;
  const blocked: [number, number][] = [...bandVerticals(model, bus, extent).map((x): [number, number] => [x, x]), ...bandChordSpans(model, bus, extent)]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: { from: number; to: number }[] = [];
  let cursor = extent.lo;
  for (const [start, end] of blocked) {
    // Every blocker is clipped to the bar's span, so no gap reaches past the bar's ends.
    if (end < extent.lo || start > extent.hi) continue;
    const from = Math.min(start, extent.hi), to = Math.min(end, extent.hi);
    if (from - cursor >= width) gaps.push({ from: cursor, to: from });
    cursor = Math.max(cursor, to);
  }
  if (extent.hi - cursor >= width) gaps.push({ from: cursor, to: extent.hi });
  const around = !busCarriesLabel(bus) ? undefined : gaps.find(gap => gap.from <= centre - width / 2 && gap.to >= centre + width / 2);
  const longest = !busCarriesLabel(bus) ? undefined : [...gaps].sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)[0];
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
  for (const bus of meshBuses(model)) if (bus.riser !== undefined) {
    const ends = riserEnds(model, bus);
    delete bus.riser.from; delete bus.riser.to;
    if (ends !== undefined) Object.assign(bus.riser, ends);
  }
}

/** The ends of the riser on the two bars, once both bars stand (7f): `undefined` before. */
export function riserEnds(model: LayoutModel, upper: MeshBus): { from: Point; to: Point } | undefined {
  const lower = meshBuses(model).find(item => item.id === upper.joined);
  const upperGeometry = busGeometry(model, upper), lowerGeometry = lower === undefined ? undefined : busGeometry(model, lower);
  if (upper.riser === undefined || upperGeometry === undefined || lowerGeometry === undefined) return undefined;
  return { from: { x: upper.riser.x, y: upperGeometry.bar!.from.y }, to: { x: upper.riser.x, y: lowerGeometry.bar!.from.y } };
}
