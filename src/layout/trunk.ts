import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutModel, MeshBus } from '../model/layout.js';
import { BUS_STUB, trunkKey } from './bus-room.js';
import { authoredBusSide, busExtent, busLegCounts, busTitleEdge, meshBuses, trunkHead, type Edge } from './bus.js';
import { EDGE_MARGIN, RING_PITCH } from './course-rows.js';
import { laneSource } from './lanes.js';
import { findPort } from './row-paths.js';
import { TrunkBlocked } from './side-hints.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The trunk of a mesh over three rows or more, in placement (docs/design/mesh-bus.md, section 12; architecture ticket 21). Stage 5 reads the side
 * (`planTrunks`), stage 7a reserves the perimeter lane (`lanes.ts`), and every replay derives its geometry again (`trunkGeometry`). Nothing here is
 * discovered in routing.
 */

/** The trunk joins of the model: the head bus of each. */
export const trunkHeads = (model: LayoutModel): MeshBus[] => meshBuses(model).filter(bus => bus.trunk !== undefined);
/** The buses of a trunk join, top row first. */
export const trunkBuses = (model: LayoutModel, head: MeshBus): MeshBus[] =>
  head.trunk!.buses.map(id => meshBuses(model).find(bus => bus.id === id)).filter((bus): bus is MeshBus => bus !== undefined);

const centreX = (model: LayoutModel, node: string): number => { const box = model.nodes[node]!.bounds!; return box.x + box.width / 2; };
const rowGroups = (model: LayoutModel, bus: MeshBus): LayoutGroup[] =>
  Object.values(model.groups).filter(group => group.tier === bus.row && group.nodes.length > 0 && group.bounds !== undefined);

/** The units of the row that hold none of the bus's nodes and stand beside its outer member on `side`: what blocks the extension (section 12.4). */
function foreignBeside(model: LayoutModel, bus: MeshBus, side: 'left' | 'right'): LayoutGroup[] {
  const xs = bus.nodes.map(node => centreX(model, node));
  const outer = side === 'right' ? Math.max(...xs) : Math.min(...xs);
  return rowGroups(model, bus).filter(group => !group.nodes.some(node => bus.nodes.includes(node))
    && (side === 'right' ? group.bounds!.x + group.bounds!.width / 2 > outer : group.bounds!.x + group.bounds!.width / 2 < outer));
}

/** The frames that hold the outermost member of the bus: the edges the extension crosses at the side of the row (section 12.4, key 2). */
function framesAround(model: LayoutModel, bus: MeshBus, side: 'left' | 'right'): number {
  const xs = bus.nodes.map(node => centreX(model, node));
  const outer = bus.nodes[xs.indexOf(side === 'right' ? Math.max(...xs) : Math.min(...xs))]!;
  let count = 0;
  const frames = model.document.frames ?? {};
  for (let id: string | undefined = model.groups[model.document.nodes[outer]!.group]?.frame; id !== undefined; id = frames[id]?.parent) count++;
  return count;
}

/** The distance from the outer stub of the bar to the outer box of its row on `side`, at skeleton x (section 12.4, key 3). */
function extensionOf(model: LayoutModel, bus: MeshBus, side: 'left' | 'right'): number {
  const xs = bus.nodes.map(node => centreX(model, node)), boxes = rowGroups(model, bus).map(group => group.bounds!);
  return side === 'right' ? Math.max(...boxes.map(box => box.x + box.width)) - Math.max(...xs) : Math.min(...xs) - Math.min(...boxes.map(box => box.x));
}

/**
 * The routed links that pass the whole row of the bar (one end in a tier above, one below) with their corridor beyond the outer stub on `side`, or inside the span:
 * the corridor stands at the x of its source port, which the direct plan of 7a keeps (mesh-bus.md, section 12.4). Such a link crosses the extended bar on either edge.
 */
function passing(model: LayoutModel, bus: MeshBus, side: 'left' | 'right'): number {
  const xs = bus.nodes.map(node => centreX(model, node));
  const lo = side === 'right' ? Math.min(...xs) : -Infinity, hi = side === 'left' ? Math.max(...xs) : Infinity;
  let count = 0;
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const tiers = [link.attachments.from, link.attachments.to].map(ref => model.groups[model.document.nodes[ref.node]?.group ?? '']?.tier);
    if (tiers.some(tier => tier === undefined) || Math.min(...tiers as number[]) >= bus.row || Math.max(...tiers as number[]) <= bus.row) continue;
    const source = laneSource(model, link), node = model.nodes[source.node]!;
    const x = findPort(model, source)?.anchor?.x ?? (node.bounds!.x + node.bounds!.width / 2);
    // Inside the member span the corridor crosses the bar whatever the side; beyond the outer member it crosses the extension on this side only.
    if (x >= lo && x <= hi) count++;
  }
  return count;
}

/** The edge a bar of a trunk join takes for `side`: an authored side, else the edge fewer legs cross over the extended span, else the title edge. */
function edgeFor(model: LayoutModel, bus: MeshBus, side: 'left' | 'right'): { edge: Edge; legs: number } {
  const counts = busLegCounts(model, bus, false, side), fixed = authoredBusSide(model, bus);
  const through = passing(model, bus, side);
  counts.top += through; counts.bottom += through;
  const edge: Edge = fixed ?? (counts.top !== counts.bottom ? (counts.top < counts.bottom ? 'top' : 'bottom') : busTitleEdge(model, bus));
  return { edge, legs: counts[edge] };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Stage 5, in `sidesTwo` after the sides of the routed ports settle and before the resize: the side of each trunk and the edge of each of its bars
 * (mesh-bus.md, section 12.4). A side is admissible when no foreign unit stands beside any member row on it. Among the admissible: the fewest legs over the
 * extended spans, then the fewest frame edges crossed, then the least total extension, then left. None admissible: `TrunkBlocked`.
 */
export function planTrunks(model: LayoutModel): void {
  for (const head of trunkHeads(model)) {
    const buses = trunkBuses(model, head);
    const options = (['left', 'right'] as const).map(side => {
      const foreign = buses.flatMap(bus => foreignBeside(model, bus, side).map(group => ({ bus, group })));
      const edges = buses.map(bus => edgeFor(model, bus, side));
      return { side, foreign, edges, legs: edges.reduce((sum, item) => sum + item.legs, 0),
        frames: buses.reduce((sum, bus) => sum + framesAround(model, bus, side), 0), extension: buses.reduce((sum, bus) => sum + extensionOf(model, bus, side), 0) };
    });
    const open = options.filter(option => option.foreign.length === 0);
    if (open.length === 0) {
      throw new TrunkBlocked(trunkKey(buses), options.map(option => `${option.side}: ${option.foreign.slice(0, 3).map(item => `${item.group.id} stands beside the row ${item.bus.row}`).join(', ')}`).join('; '));
    }
    const best = [...open].sort((a, b) => a.legs - b.legs || a.frames - b.frames || a.extension - b.extension || (a.side === 'left' ? -1 : 1) - (b.side === 'left' ? -1 : 1))[0]!;
    head.trunk!.side = best.side;
    buses.forEach((bus, index) => { bus.side = best.edges[index]!.edge; });
    model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'MESH_BUS_TRUNK', owners: [{ kind: 'mesh-bus', id: head.id }],
      message: `The trunk of ${head.id} stands on the ${best.side}: ${buses.length} buses, ${best.legs} legs crossed, ${best.frames} frame edges crossed, extension ${round(best.extension)} px`
        + `; the other side ${open.length > 1 ? `crosses ${options.find(option => option.side !== best.side)!.legs} legs` : 'is blocked'}` });
  }
}

/** The y of the bar of a bus of a trunk join as the geometry stands now, or `undefined` before its edge and members stand. */
export function barY(model: LayoutModel, bus: MeshBus): number | undefined {
  const extent = busExtent(model, bus);
  return extent === undefined ? undefined : extent.side === 'bottom' ? extent.edge + BUS_STUB : extent.edge - BUS_STUB;
}

/** The lane a trunk reserves: its x beyond every box on its extent, and the extent from the uppermost bar to the lowermost. */
export interface TrunkGeometry { x: number; yTop: number; yBottom: number; bounds: Rect }

/** The reader of a trunk lane's geometry: 7a, every replay and `validateLanes` read it (the one reader, as `courseGeometry` is for a course). */
export function trunkGeometry(model: LayoutModel, head: MeshBus, lane: { side: 'left' | 'right'; ring: number }, occ: (group: LayoutGroup) => Rect, peers: readonly Lane[]): TrunkGeometry | undefined {
  const ys = trunkBuses(model, head).map(bus => barY(model, bus));
  if (ys.length === 0 || ys.some(y => y === undefined)) return undefined;
  const yTop = Math.min(...ys as number[]), yBottom = Math.max(...ys as number[]);
  const dir = lane.side === 'right' ? 1 : -1;
  const meets = (box: Rect): boolean => box.y < yBottom - PLACEMENT_EPS && box.y + box.height > yTop + PLACEMENT_EPS;
  const boxes: Rect[] = [];
  for (const group of Object.values(model.groups)) {
    if (group.bounds === undefined || group.nodes.length === 0) continue;
    const box = occ(group);
    if (meets(box)) boxes.push(box);
  }
  for (const frame of model.frames ?? []) if (meets(frame.box)) boxes.push(frame.box);
  for (const other of model.lanes) if (other.kind !== 'perimeter' && other.kind !== 'gap' && meets(other.bounds)) boxes.push(other.bounds);
  const xs = trunkBuses(model, head).flatMap(bus => bus.nodes.map(node => centreX(model, node)));
  const outer = boxes.length === 0 ? (dir > 0 ? Math.max(...xs) : Math.min(...xs)) : dir > 0 ? Math.max(...boxes.map(box => box.x + box.width)) : Math.min(...boxes.map(box => box.x));
  let x = outer + dir * (EDGE_MARGIN + lane.ring * RING_PITCH);
  // The lanes of one side stand as one stack: a lane stands a pitch beyond every inner lane of its side whose extent it meets.
  for (const other of peers) {
    if (other.side !== lane.side || (other.ring ?? 0) >= lane.ring || !(other.bounds.y < yBottom - PLACEMENT_EPS && other.bounds.y + other.bounds.height > yTop + PLACEMENT_EPS)) continue;
    const wanted = other.x + dir * RING_PITCH;
    x = dir > 0 ? Math.max(x, wanted) : Math.min(x, wanted);
  }
  return { x, yTop, yBottom, bounds: { x: x - RING_PITCH / 2, y: yTop, width: RING_PITCH, height: yBottom - yTop } };
}

/** The extension of each bar of a trunk join from its outer stub to the trunk x, as a horizontal segment at the bar's y: what a foreign unit may not stand across. */
export function extensions(model: LayoutModel, head: MeshBus, at?: number): { bus: MeshBus; y: number; from: number; to: number }[] {
  const trunk = head.trunk, lane = model.lanes.find(item => item.id === trunk?.lane);
  if (trunk?.side === undefined || lane === undefined) return [];
  const trunkX = at ?? lane.x;
  const result: { bus: MeshBus; y: number; from: number; to: number }[] = [];
  for (const bus of trunkBuses(model, head)) {
    const y = barY(model, bus), xs = bus.nodes.map(node => centreX(model, node));
    if (y === undefined) continue;
    const outer = trunk.side === 'right' ? Math.max(...xs) : Math.min(...xs);
    result.push({ bus, y, from: Math.min(outer, trunkX), to: Math.max(outer, trunkX) });
  }
  return result;
}

/** The foreign units that stand across a bar extension now, as `[unit, bus]` pairs: what a forced move reports (`MESH_BUS_TRUNK_CROSSED`). */
export function foreignOverExtensions(model: LayoutModel, head: MeshBus, groups: readonly { group: LayoutGroup; bounds: Rect }[] = Object.values(model.groups).filter(group => group.bounds !== undefined).map(group => ({ group, bounds: group.bounds! })), trunkX?: number): { group: string; bus: string }[] {
  const found: { group: string; bus: string }[] = [];
  for (const { bus, y, from, to } of extensions(model, head, trunkX)) {
    for (const { group, bounds } of groups) {
      if (group.nodes.length === 0 || group.nodes.some(node => bus.nodes.includes(node))) continue;
      const crosses = bounds.y < y - PLACEMENT_EPS && bounds.y + bounds.height > y + PLACEMENT_EPS && bounds.x < to - PLACEMENT_EPS && bounds.x + bounds.width > from + PLACEMENT_EPS;
      if (crosses && !found.some(item => item.group === group.id && item.bus === bus.id)) found.push({ group: group.id, bus: bus.id });
    }
  }
  return found;
}

/**
 * The x the trunk would stand at after a move that proposes these group boxes: it is derived beyond every box on its extent, so a unit that moves outward
 * carries it (section 12.5). Read as `trunkGeometry` reads it for the boxes that meet the extent, plus the ring offset of the lane.
 */
export function trunkXAfter(model: LayoutModel, head: MeshBus, proposed: readonly { group: LayoutGroup; bounds: Rect }[]): number | undefined {
  const lane = model.lanes.find(item => item.id === head.trunk?.lane);
  if (lane === undefined) return undefined;
  const dir = lane.side === 'right' ? 1 : -1, reach = (lane.ring ?? 0) * RING_PITCH + EDGE_MARGIN;
  let x = lane.x;
  for (const { group, bounds } of proposed) {
    if (group.nodes.length === 0 || bounds.y >= lane.bounds.y + lane.bounds.height - PLACEMENT_EPS || bounds.y + bounds.height <= lane.bounds.y + PLACEMENT_EPS) continue;
    const wanted = (dir > 0 ? bounds.x + bounds.width : bounds.x) + dir * reach;
    x = dir > 0 ? Math.max(x, wanted) : Math.min(x, wanted);
  }
  return x;
}

/** The head bus of the trunk join a bus belongs to (re-exported for the readers of lanes). */
export { trunkHead };

/**
 * The routed segments that cross the trunk or a bar extension of a join in the published layout (mesh-bus.md, section 12.7): no gate reads them (the trunk is
 * overlay), so the report counts them. Zero before 7f has set the joins.
 */
export function routedTrunkCrossings(model: LayoutModel, head: MeshBus): number {
  const joins = head.trunk?.joins;
  if (joins === undefined || joins.length === 0) return 0;
  const x = head.trunk!.x!, y0 = Math.min(...joins.map(point => point.y)), y1 = Math.max(...joins.map(point => point.y));
  const bars = extensions(model, head);
  let count = 0;
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.path === undefined) continue;
    for (const { from, to } of link.path.segments) {
      const lo = Math.min(from.x, to.x), hi = Math.max(from.x, to.x), top = Math.min(from.y, to.y), bottom = Math.max(from.y, to.y);
      // A horizontal run of the link across the trunk, within its extent.
      if (lo < x - PLACEMENT_EPS && hi > x + PLACEMENT_EPS && top >= y0 - PLACEMENT_EPS && top <= y1 + PLACEMENT_EPS && bottom - top < PLACEMENT_EPS) count++;
      // A vertical run of the link across a bar extension.
      else if (hi - lo < PLACEMENT_EPS) for (const bar of bars) if (lo > bar.from + PLACEMENT_EPS && lo < bar.to - PLACEMENT_EPS && top < bar.y - PLACEMENT_EPS && bottom > bar.y + PLACEMENT_EPS) count++;
    }
  }
  return count;
}

/**
 * The ring of a trunk: one beyond the highest ring of the perimeter lanes of its side whose extent it meets, so it stands outside every one of them. A count
 * would collide with a lane on a higher ring when an inner ring is free (mesh-bus.md, section 12.5).
 */
export function trunkRing(lanes: readonly Lane[], side: 'left' | 'right', bounds: Rect): number {
  const met = lanes.filter(lane => lane.kind === 'perimeter' && lane.side === side && lane.bounds.y < bounds.y + bounds.height - PLACEMENT_EPS && lane.bounds.y + lane.bounds.height > bounds.y + PLACEMENT_EPS);
  return met.length === 0 ? 0 : Math.max(...met.map(lane => lane.ring ?? 0)) + 1;
}

/** Replace the `MESH_BUS_TRUNK_CROSSED` warnings with the ones the geometry now calls for: a forced move left a foreign unit across a bar extension (section 12.5). */
export function reportTrunkCrossings(model: LayoutModel): void {
  model.diagnostics = model.diagnostics.filter(item => item.code !== 'MESH_BUS_TRUNK_CROSSED');
  for (const head of trunkHeads(model)) for (const crossing of foreignOverExtensions(model, head)) {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'MESH_BUS_TRUNK_CROSSED', owners: [{ kind: 'mesh-bus', id: head.id }, { kind: 'group', id: crossing.group }],
      message: `${crossing.group} stands across the extension of ${crossing.bus} to the trunk of ${head.id}.` });
  }
}
