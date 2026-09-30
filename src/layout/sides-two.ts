import type { PortRef } from '../model/document.js';
import type { Rect, Side, Size } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { SIDE_TIE_ORDER, portKey, tiedPortComponents } from './sides-one.js';
import { measurePortPill } from '../text/index.js';
import { EPS } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { sizeNodes } from './size.js';
import { bandGap, nodeGap, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { moveGroup, stackBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { carriesTitle, nodeObstacleReach, nudgingDistance, routedStroke, stemReach } from './bands.js';
import { MEMBER_GAP, fanEnd } from './bundle-geometry.js';
import { laneSource, laneWidth, transitTiers } from './lanes.js';
import { fitRegionGroup } from './regions.js';
import { findPort, STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { gridCells, gridRowGap, groupShape, isGridGroup, packGridRows } from './grid.js';
import { freezePortTopology } from './mutation.js';
import { busOfPort, busSide, meshBuses } from './bus.js';
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
 * The node beside `node` on `side` in its group's row order, or undefined when there is none whose
 * gap the rows rule set. Only a plain row group has its gaps sized by `rowGap`; a flank or a bar is
 * packed by its own rule, so a pair there has no reservation to read back and is left alone.
 */
function rowNeighbour(model: LayoutModel, node: string, side: 'left' | 'right'): string | undefined {
  const id = model.document.nodes[node]!.group, group = model.groups[id];
  // `groupShape`, not the authored shape: a group that declined the grid is packed by the rows rule
  // and so does have gaps `rowGap` sized, and reading it as a non-row would break that read-back.
  if (!group || group.flank || groupShape(model, id) !== 'row') return undefined;
  const order = group.rowOrder ?? group.nodes;
  const at = order.indexOf(node);
  if (at < 0) return undefined;
  const next = order[at + (side === 'right' ? 1 : -1)];
  return next !== undefined && model.nodes[next]?.bounds ? next : undefined;
}

/**
 * How far, and which way, each of `port`'s accepted legs travels along its own node side after it
 * turns: to its far anchor when it jogs into the neighbour's facing side, and past the nearer end
 * of the neighbour's obstacle when it passes the neighbour by. Signed towards growing y.
 */
function legRuns(model: LayoutModel, port: LayoutPort, side: 'left' | 'right', neighbour: string,
  accepted: ReadonlySet<string>): { link: string; run: number }[] {
  const other = model.nodes[neighbour]!, facing: Side = side === 'left' ? 'right' : 'left';
  const span = Math.max(sideReach(model, neighbour, 'top'), sideReach(model, neighbour, 'bottom'));
  const top = other.bounds!.y - span, bottom = other.bounds!.y + other.bounds!.height + span;
  return (unreservedPeers(model).get(key(port.ref)) ?? [])
    .filter(item => accepted.has(item.link))
    .map(({ peer, link }) => {
      const far = findPort(model, peer);
      if (peer.node === neighbour && far?.side === facing && far.anchor !== undefined) {
        return { link, run: far.anchor.y - port.anchor!.y };
      }
      // Which way it wraps is decided by where it is going, not by which end of the neighbour is
      // nearer: a link whose far end lies below the neighbour approaches from below, and a leg
      // pointed the other way would be a run the route has to double back along.
      const up = port.anchor!.y - top, down = bottom - port.anchor!.y;
      const beyond = far?.anchor ? far.anchor.y < top + EPS ? -1 : far.anchor.y > bottom - EPS ? 1 : 0 : 0;
      return { link, run: beyond < 0 ? -up : beyond > 0 ? down : up <= down ? -up : down };
    });
}

/**
 * Where every leg turning in one row gap turns (ADR-0015 rule 1). The unit is the **leg**, not the
 * port: a link that jogs from one node into the other is one leg seen twice, and `rowGap` reserves
 * it once, so both of its ends must name the same x or a gap that reserved one pitch could have two
 * demanded. Leg `i` turns at `right(a) + base.a + i * pitch`, which is exactly the room reserved —
 * the last leg still stands `base.b` off `b`.
 *
 * The order is forced wherever a leg reaches over another leg's row: it would cross that leg's
 * approach run, and which side of it the leg must pass depends on which node that run comes from.
 * Where nothing is forced, a leg belonging to one node's side alone stays beside that node and a
 * jogging leg goes between. Contradictory constraints mean no order is clean, and the gap keeps the
 * flat stems it had.
 */
export interface GapPlan {
  /** Absolute x each leg turns at, by link id. */
  slot: Map<string, number>;
  /** The stem each side stands off its own node; `rowGap` reserves these plus one pitch per leg. */
  base: { a: number; b: number };
}
export function gapPlan(model: LayoutModel, a: string, b: string): GapPlan | undefined {
  const left = model.nodes[a], right = model.nodes[b];
  if (!left?.bounds || !right?.bounds) return undefined;
  const legsAt = { a: gapLegs(model, a, 'right', b), b: gapLegs(model, b, 'left', a) };
  const links = [...new Set([...legsAt.a.links, ...legsAt.b.links])];
  if (links.length < 2) return undefined;
  // A leg is modelled only as far as the neighbour it turns beside. A link leaving the tier keeps
  // going long after that — up to its band entry, then along it — and where that run lies decides
  // the order just as much as the rows beside the node do. One such leg and the gap is not
  // understood here, so none of it is nested and every stem stays flat.
  const tier = (node: string): number | undefined => model.groups[model.document.nodes[node]!.group]?.tier;
  const sameTier = (['a', 'b'] as const).every(end => legsAt[end].ports.every(port =>
    (unreservedPeers(model).get(key(port.ref)) ?? []).every(item => !legsAt[end].links.has(item.link)
      || tier(item.peer.node) === tier(port.ref.node))));
  if (!sameTier) return undefined;
  // A link with a lane already has a reserved run of its own, and stage 8 stitches its gaps around
  // it in traversal order. Adding a second reservation to the same link is a question about how the
  // two compose that no fixture asks, so a gap holding one keeps its flat stems.
  if (links.some(id => model.links.find(link => link.id === id)?.fixedSegments?.length)) return undefined;
  // A link can be a leg in the gap on either side of a node, and one link holds one reserved run.
  // Which of the two slots it should take is a question about both gaps at once, so a link seen in
  // two of them declines this one and, by the same test, the other.
  if (links.some(id => legGapCount(model, model.links.find(link => link.id === id)!) > 1)) return undefined;
  // A leg is reserved only where placement knows its whole shape. That holds when it jogs into the
  // neighbour's facing side, and when it wraps the neighbour to reach a port on the neighbour
  // itself: either way the neighbour bounds it. A link heading past the neighbour to somewhere else
  // may wrap either way, for reasons — the other legs competing for the corridor above it — that
  // placement cannot see, and a run reserved against the side the router picks is one it has to
  // double back along. One such leg and the gap keeps its flat stems.
  const bounded = (['a', 'b'] as const).every(end => {
    const neighbour = end === 'a' ? b : a, facing: Side = end === 'a' ? 'left' : 'right';
    const far: Side = end === 'a' ? 'right' : 'left';
    return legsAt[end].ports.every(port => (unreservedPeers(model).get(key(port.ref)) ?? [])
      .every(item => {
        if (!legsAt[end].links.has(item.link)) return true;
        if (item.peer.node !== neighbour) return false;
        // A peer on the neighbour's own top or bottom is reached from either end of it, and which
        // one the router picks is the same global question a link heading past it raises.
        const side = findPort(model, item.peer)?.side;
        return side === facing || side === far;
      }));
  });
  if (!bounded) return undefined;
  const base = { a: gapStem(model, a, legsAt.a.ports, legsAt.b, 'right'), b: gapStem(model, b, legsAt.b.ports, legsAt.a, 'left') };
  const pitch = MEMBER_GAP + routedStroke(model);
  // Every row a leg occupies, and every row from which it is approached, by link.
  const rows = new Map(links.map(id => [id, [] as { at: number; from: 'a' | 'b' }[]]));
  const reach = new Map(links.map(id => [id, [] as number[]]));
  for (const end of ['a', 'b'] as const) {
    const side = end === 'a' ? 'right' : 'left', neighbour = end === 'a' ? b : a;
    for (const port of legsAt[end].ports) {
      for (const item of legRuns(model, port, side, neighbour, legsAt[end].links)) {
        if (!rows.has(item.link)) continue;
        rows.get(item.link)!.push({ at: port.anchor!.y, from: end });
        reach.get(item.link)!.push(port.anchor!.y, port.anchor!.y + item.run);
      }
    }
  }
  const span = (id: string): [number, number] => [Math.min(...reach.get(id)!), Math.max(...reach.get(id)!)];
  const sides = (id: string): number => {
    const own = rows.get(id)!;
    return own.every(item => item.from === 'a') ? 0 : own.every(item => item.from === 'b') ? 2 : 1;
  };
  const travel = (id: string): number => { const [low, high] = span(id); return high - low; };
  // `after.get(i)` holds the legs `i` must turn beyond; `before` is its mirror.
  const after = new Map(links.map(id => [id, new Set<string>()]));
  for (const leg of links) {
    const [low, high] = span(leg);
    for (const other of links) {
      if (other === leg) continue;
      for (const row of rows.get(other)!) {
        if (row.at < low - EPS || row.at > high + EPS) continue;
        // An approach run from `a` runs out to its leg, so a leg crossing that row passes outside
        // it; a run from `b` runs inward from its leg, so the crossing leg passes inside it.
        if (row.from === 'a') after.get(leg)!.add(other); else after.get(other)!.add(leg);
      }
    }
  }
  // Kahn's order over the constraint, counting predecessors rather than rescanning the set: a
  // turning cohort can be large, and this runs once per gap for a whole routing pass.
  const waiting = new Map(links.map(id => [id, after.get(id)!.size]));
  const feeds = new Map(links.map(id => [id, [] as string[]]));
  for (const id of links) for (const other of after.get(id)!) feeds.get(other)!.push(id);
  const order: string[] = [];
  const ready = links.filter(id => waiting.get(id) === 0);
  while (ready.length) {
    ready.sort((x, y) => sides(x) - sides(y) || travel(y) - travel(x) || (x < y ? -1 : 1));
    const next = ready.shift()!;
    order.push(next);
    for (const id of feeds.get(next)!) {
      waiting.set(id, waiting.get(id)! - 1);
      if (waiting.get(id) === 0) ready.push(id);
    }
  }
  // Legs that must each turn beyond the other: no order is clean, so the gap keeps its flat stems.
  if (order.length !== links.length) return undefined;
  // Legs that belong to `b`'s side alone pack from `b`, not from `a`: a gap made wide by a label or
  // a pill is wider than the turning reservation, and packing everything from `a` would leave those
  // stems running the whole gap before they turn. The order decides which end each leg packs from
  // only when it already puts them last; otherwise every leg packs from `a`, as the reservation is
  // measured. Both ends together still leave a pitch between the two runs, since the gap holds
  // `base.a + (n - 1) * pitch + base.b`.
  const tail = order.findIndex(id => sides(id) === 2);
  const split = tail >= 0 && order.slice(tail).every(id => sides(id) === 2) ? tail : order.length;
  const start = left.bounds.x + left.bounds.width + base.a, end = right.bounds.x - base.b;
  const slot = new Map(order.map((id, index) => [id,
    index < split ? start + index * pitch : end - (order.length - 1 - index) * pitch]));
  // A slot is only worth having where the leg can take it. A blocked one is not a reason to move
  // that leg alone, since its neighbours are spaced against it, so the whole gap keeps the flat
  // stems it had. Checked here rather than per port, so `legReservation` never hands stage 8 a run
  // the router cannot honour.
  for (const end of ['a', 'b'] as const) {
    const side = end === 'a' ? 'right' : 'left', neighbour = end === 'a' ? b : a, node = end === 'a' ? a : b;
    for (const port of legsAt[end].ports) {
      for (const item of legRuns(model, port, side, neighbour, legsAt[end].links)) {
        const at = slot.get(item.link);
        if (at !== undefined && !legClear(model, node, at, port.anchor!.y, port.anchor!.y + item.run)) return undefined;
      }
    }
  }
  return { slot, base };
}

/**
 * Nothing stage 8 must respect stands in the leg's way between its own row and the far end of its
 * travel: a foreign node with its obstacle reach, a foreign group box, a group title, a lane, a
 * bundle's envelope or any other reserved obstacle. The pin is only worth making where the leg can
 * take it; anywhere else the checkpoint stays the minimum it always was.
 */
function legClear(model: LayoutModel, owner: string, at: number, from: number, to: number): boolean {
  const low = Math.min(from, to), high = Math.max(from, to);
  // Each kind is expanded by exactly what `routeObstacles` expands it by, and by nothing else. A
  // node's reach already carries the routed half stroke — `nodeObstacleReach` and the router's own
  // `clearanceOf` are the same figure — so adding it again would refuse room the reservation
  // supplies. The raw boxes carry no stroke, so those take the half themselves. A node's obstacle
  // also swallows its outward pills, and a pill reaches past the body on a side that carries one.
  const half = routedStroke(model) / 2, pillGap = half + DEFAULT_STROKE_WIDTHS.pill / 2;
  const hits = (box: Rect, margin: number): boolean => at > box.x - margin + EPS && at < box.x + box.width + margin - EPS
    && high > box.y - margin + EPS && low < box.y + box.height + margin - EPS;
  // `nodeBox` gives the router the *enclosing* rectangle of the expanded body and every expanded
  // pill, not their union, so it also owns the corners between them. Testing the parts separately
  // would approve a leg the router treats as inside the node.
  const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
  const obstacleOf = (node: LayoutModel['nodes'][string]): Rect => {
    const boxes = [grow(node.bounds!, nodeObstacleReach(model, node)),
      ...node.ports.filter(port => port.pill && port.pill.layer !== 'overlay').map(port => grow(port.pill!.bounds, pillGap))];
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
  };
  const group = model.document.nodes[owner]!.group;
  return !Object.values(model.nodes).some(node => node.id !== owner && node.bounds && node.layer !== 'overlay'
      && hits(obstacleOf(node), 0))
    && !Object.entries(model.groups).some(([id, item]) => id !== group && item.bounds && item.nodes.length
      && hits(item.bounds, GROUP_EDGE_LINK_CLEARANCE + half))
    && !model.labels.some(label => !label.omitted && label.bounds && label.layer !== 'overlay' && label.role === 'group'
      && hits(label.bounds, GROUP_LABEL_LINK_CLEARANCE + half))
    && !model.lanes.some(lane => lane.layer !== 'overlay' && hits(lane.bounds, half))
    && !model.bundles.some(bundle => (bundle.envelopeParts ?? (bundle.envelope ? [bundle.envelope] : [])).some(part => hits(part, half)))
    && !model.obstacles.some(item => hits(item.bounds, half))
    // Geometry another rule already fixed is an obstacle to stage 8 exactly as a node is: a pinned
    // row or flank path, a reserved run of a fan tree, a bar drop's traversal.
    && !model.links.some(other => other.layer !== 'overlay' && reservedRuns(other).some(run => hits({
      x: Math.min(run.from.x, run.to.x), y: Math.min(run.from.y, run.to.y),
      width: Math.abs(run.to.x - run.from.x), height: Math.abs(run.to.y - run.from.y),
    }, linkStrokeWidth(other) / 2 + half + STRAIGHT_PATH_CLEARANCE.path)));
}

/** Every run of `link` that a rule has already fixed, and that stage 8 must therefore route around. */
function reservedRuns(link: LayoutLink): PathSegment[] {
  return [...(link.path?.fixed === true ? link.path.segments : []), ...(link.fixedSegments ?? []),
    ...(link.sharedRuns?.from ?? []), ...(link.sharedRuns?.to ?? [])];
}

/** The stem a side stands off its node in a row gap: one full stem when it takes part, else its reach. */
function gapStem(model: LayoutModel, id: string, own: LayoutPort[],
  incoming: { ports: LayoutPort[]; links: Set<string> }, side: Side): number {
  const enters = incoming.ports.some(port => (unreservedPeers(model).get(key(port.ref)) ?? [])
    .some(item => incoming.links.has(item.link) && item.peer.node === id && findPort(model, item.peer)?.side === side));
  return own.length || enters ? stemReach(model, model.nodes[id]!) : sideReach(model, id, side);
}

/**
 * Where every stem of one node side that feeds another tier turns (ADR-0015 rule 1, twelfth
 * amendment). The unit is the **port**: a side carries one stem per port, and a port that carries
 * two links carries one stem for both.
 *
 * A leg travels along its own side after it turns. Where that travel reaches a second port of the
 * same side, the two turns cannot stand at one depth: the first route laid covers the second port's
 * stem, and the second link is left with a checkpoint no route can reach. The order is forced there
 * — the leg that reaches another port turns beyond it — so port `p` turns `stemReach + rank(p) *
 * pitch` out, `rank` being the longest chain of ports it must turn beyond. The travel is read to
 * the near edge of the other port's **strip**, not to its column, because a leg that stops between
 * the two still ends in a cover its own batch is no longer exempt from.
 *
 * A side nests nothing and keeps the flat stems it had where no order is forced, where no order is
 * clean, where a leg's shape is not wholly known here, where the side carries its group's title, or
 * where a nested turn would stand in frozen geometry or where G6 refuses to let its leg travel away
 * from it. Each decline below says which it is. A leg whose geometry a rule has fixed, and a bundle
 * member, are passed over rather than declined: both are already obstacles this pass reads.
 */
export interface SidePlan { depth: Map<string, number> }
/** The plans one pass reads: one per row gap, one per node side. Placement does not move while it runs. */
export interface StemCache { gaps: Map<string, GapPlan | undefined>; sides: Map<string, SidePlan | undefined> }
export const stemCache = (): StemCache => ({ gaps: new Map(), sides: new Map() });

const FACING: Record<'top' | 'bottom', Side> = { top: 'bottom', bottom: 'top' };

export function sidePlan(model: LayoutModel, node: string, side: 'top' | 'bottom'): SidePlan | undefined {
  const owner = model.nodes[node];
  if (!owner?.bounds) return undefined;
  // The side that carries its group's title nests nothing. Stage 7f places that title after the
  // depth is chosen, in the room the deeper stem would turn in, and it is then an obstacle the turn
  // is not clear of: measured over 1 103 corpus inputs, admitting it instead breaks 192 of them —
  // 188 because a group no longer retains the clearance beside its own label band.
  //
  // `bandSide` counts incident routed link ports over frozen port topology. Never read this from
  // `model.labelBands`: it does not exist before 7f, `syncBands` rewrites it inside 7f and
  // `reserveInitialSpace` rewrites it again after moving tiers, so the decline would answer nothing
  // before 7f, one thing during it and another on the re-derivation `validateGroupLabelBands` makes
  // at every stage from `bands` on. That is the `link.path` trap below, one layer up.
  const owning = model.groups[model.document.nodes[node]!.group];
  if (owning && carriesTitle(model, owning, side)) return undefined;
  const peers = unreservedPeers(model), tier = (id: string): number | undefined =>
    model.groups[model.document.nodes[id]!.group]?.tier;
  // One entry per port: its anchor along the side, and how far its legs travel along it.
  const legs = new Map<string, { at: number; low: number; high: number }>();
  for (const port of owner.ports) {
    if (port.side !== side || port.anchor === undefined) continue;
    for (const item of peers.get(key(port.ref)) ?? []) {
      const link = model.links.find(entry => entry.id === item.link)!;
      // A link a rule has already given geometry to reserves no stem here and is already an
      // obstacle `legClear` reads; it is passed over, so it neither takes a slot nor stops the side
      // from nesting. Read from `path.fixed`, never from the presence of a `path`: after stage 8
      // every link carries one, and a guard on that would make this plan answer differently on the
      // re-derivation `checkedLayoutMutation` compares against — which is `validateGroupLabelBands`
      // at every stage from `bands` on, and the bands it re-derives would then contradict the model.
      if (link.path?.fixed === true || link.fixedSegments?.length
        || link.sharedRuns?.from?.length || link.sharedRuns?.to?.length) continue;
      const far = findPort(model, item.peer);
      // A leg is reserved only where placement knows its whole shape: it leaves this side and
      // arrives on the facing side of a node in another tier — any other tier, either way, adjacent
      // or not; what it crosses on the way is not read here. Anything else may travel along this
      // side for reasons placement cannot see, so the whole side keeps flat stems.
      if (!far?.anchor || far.side !== FACING[side] || tier(node) === tier(item.peer.node)) return undefined;
      const seen = legs.get(key(port.ref)) ?? { at: port.anchor.x, low: port.anchor.x, high: port.anchor.x };
      legs.set(key(port.ref), { at: seen.at, low: Math.min(seen.low, far.anchor.x), high: Math.max(seen.high, far.anchor.x) });
    }
  }
  if (legs.size < 2) return undefined;
  // `beyond.get(p)` holds the ports `p` must turn beyond: those its own travel reaches. A leg that
  // stops short of another port's column still reaches that port's strip, which is half a strip
  // wide on each side of the column — the cover `stemBounds` gives it, at the widest routed stroke.
  // A leg that stops inside it is a leg the batch's own exemption would have to answer for, so the
  // travel is read out to the strip's near edge and not to the column.
  const strip = nudgingDistance(model);
  const beyond = new Map([...legs.keys()].map(id => [id, [] as string[]]));
  for (const [id, leg] of legs) for (const [other, peer] of legs) {
    const low = leg.low < leg.at - EPS ? leg.low - strip : leg.low;
    const high = leg.high > leg.at + EPS ? leg.high + strip : leg.high;
    if (other !== id && peer.at > low + EPS && peer.at < high - EPS) beyond.get(id)!.push(other);
  }
  // Longest chain below each port. Two ports that must each turn beyond the other have no clean
  // order, and the side keeps its flat stems, exactly as a row gap does.
  const rank = new Map<string, number>(), open = new Set<string>();
  const depthOf = (id: string): number | undefined => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (open.has(id)) return undefined;
    open.add(id);
    let best = 0;
    for (const other of beyond.get(id)!) {
      const below = depthOf(other);
      if (below === undefined) return undefined;
      best = Math.max(best, below + 1);
    }
    open.delete(id);
    rank.set(id, best);
    return best;
  };
  for (const id of legs.keys()) if (depthOf(id) === undefined) return undefined;
  if (![...rank.values()].some(value => value > 0)) return undefined;
  const base = stemReach(model, owner), pitch = MEMBER_GAP + routedStroke(model);
  const outward = side === 'top' ? -1 : 1, depth = new Map<string, number>();
  for (const [id, steps] of rank) {
    const reach = base + steps * pitch;
    depth.set(id, reach);
    // Only a nested stem is measured: one at the plain reach is the stem every port already has.
    // `legClear` reads the same obstacles stage 8 does, so a nested slot is one the router can take.
    const anchor = legs.get(id)!.at, from = side === 'top' ? owner.bounds.y : owner.bounds.y + owner.bounds.height;
    if (steps > 0 && !legClear(model, node, anchor, from, from + outward * reach)) return undefined;
    // The turn must also stand where G6 `segment-group-edge` lets the leg travel away from it, which
    // `legClear` passes over: it excludes the owner's own group so that a leg may cross its own box.
    // G6's own reading, on the run this turn starts: strictly inside the box a link turns in the
    // group's padding and owes nothing; on or outside the edge it owes the edge margin. The
    // ordinary padding is 20 px beyond the body and its pills, so the first pitch of nesting lands a
    // turn on the edge of a group that holds its node tightly.
    const edge = owning?.bounds ? side === 'top' ? owning.bounds.y : owning.bounds.y + owning.bounds.height : undefined;
    const turn = from + outward * reach;
    if (steps > 0 && edge !== undefined && outward * (turn - edge) > -EPS
      && Math.abs(turn - edge) < GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2 - EPS) return undefined;
  }
  return { depth };
}

/**
 * How far out of its node `port`'s stem reaches before stage 8 turns it. A port whose link is a leg
 * in a row gap reaches that leg's slot (`gapPlan`); every other port keeps the plain reach. Derived,
 * never stored, so the figure stage 7f reserves and the figure stage 8 receives are the same one.
 */
/** One gap plan per row gap for a whole pass; placement does not move while any pass runs. */
function cachedPlan(model: LayoutModel, a: string, b: string, cache?: StemCache): GapPlan | undefined {
  const at = `${a}|${b}`;
  if (cache?.gaps.has(at)) return cache.gaps.get(at);
  const plan = gapPlan(model, a, b);
  cache?.gaps.set(at, plan);
  return plan;
}

/** One side plan per node side for a whole pass; see `cachedPlan`. */
function cachedSide(model: LayoutModel, node: string, side: 'top' | 'bottom', cache?: StemCache): SidePlan | undefined {
  const at = `${node}|${side}`;
  if (cache?.sides.has(at)) return cache.sides.get(at);
  const plan = sidePlan(model, node, side);
  cache?.sides.set(at, plan);
  return plan;
}

/** Whether placement nested the stems of one node side, so each of them stands in a corridor of its own. */
export function sideNested(model: LayoutModel, node: string, side: Side, cache?: StemCache): boolean {
  return (side === 'top' || side === 'bottom') && cachedSide(model, node, side, cache) !== undefined;
}

export function stemPlan(model: LayoutModel, port: LayoutPort, cache?: StemCache): { depth: number; turn?: 'top' | 'bottom' } {
  const node = model.nodes[port.ref.node]!, base = stemReach(model, node);
  const side = port.side;
  if ((side === 'top' || side === 'bottom') && node.bounds && port.anchor) {
    const reach = cachedSide(model, port.ref.node, side, cache)?.depth.get(key(port.ref));
    return { depth: reach === undefined ? base : Math.max(base, reach) };
  }
  if (side !== 'left' && side !== 'right' || !node.bounds || !port.anchor) return { depth: base };
  const neighbour = rowNeighbour(model, port.ref.node, side);
  if (neighbour === undefined) return { depth: base };
  const pair: [string, string] = side === 'right' ? [port.ref.node, neighbour] : [neighbour, port.ref.node];
  const plan = cachedPlan(model, pair[0], pair[1], cache);
  if (!plan) return { depth: base };
  const legs = gapLegs(model, port.ref.node, side, neighbour);
  if (!legs.ports.includes(port)) return { depth: base };
  const runs = legRuns(model, port, side, neighbour, legs.links).filter(item => plan!.slot.has(item.link));
  if (!runs.length) return { depth: base };
  const edge = side === 'right' ? node.bounds.x + node.bounds.width : node.bounds.x;
  const depths = runs.map(item => Math.abs(plan!.slot.get(item.link)! - edge));
  const depth = Math.min(...depths);
  const own = runs.filter(item => Math.abs(Math.abs(plan!.slot.get(item.link)! - edge) - depth) < EPS);
  // Two legs leaving one port the same way share the stem; turning apart, neither may be pinned.
  const turn = own.every(item => item.run < -EPS) ? 'top' as const
    : own.every(item => item.run > EPS) ? 'bottom' as const : undefined;
  void turn;
  return { depth: Math.max(base, depth) };
}

/**
 * The row gaps `link` is a leg in, one entry per end, with the row it turns at and how far it runs.
 * Both entries name the same gap when the link jogs from one node into the other; two different
 * gaps mean the link turns on both sides of its own node, which `gapPlan` declines.
 */
interface LegGap { pair: [string, string]; at: number; run: number }
function legGaps(model: LayoutModel, link: LayoutLink): (LegGap | undefined)[] {
  if (!link.attachments || link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined) return [];
  return (['from', 'to'] as const).map(end => {
    const port = findPort(model, link.attachments![end]);
    const side = port?.side;
    if (!port?.anchor || side !== 'left' && side !== 'right') return undefined;
    const neighbour = rowNeighbour(model, port.ref.node, side);
    if (neighbour === undefined) return undefined;
    const legs = gapLegs(model, port.ref.node, side, neighbour);
    if (!legs.ports.includes(port) || !legs.links.has(link.id)) return undefined;
    const run = legRuns(model, port, side, neighbour, legs.links).find(item => item.link === link.id);
    if (!run) return undefined;
    const pair: [string, string] = side === 'right' ? [port.ref.node, neighbour] : [neighbour, port.ref.node];
    return { pair, at: port.anchor.y, run: run.run };
  });
}

/** How many distinct gaps `link` is a leg in; one link holds one reserved run. */
function legGapCount(model: LayoutModel, link: LayoutLink): number {
  return new Set(legGaps(model, link).flatMap(item => item ? [item.pair.join('|')] : [])).size;
}

/**
 * The run a leg reserves in its row gap, in this link's own traversal order, or undefined when the
 * link is not a leg (ADR-0015 rule 1). Stage 8 routes *through* a reserved run and stitches the gaps
 * around it, so the leg lands where placement put it rather than wherever the router's nudging left
 * it -- which is what a checkpoint could only ask for and never require.
 *
 * `gapPlan` has already declined the gap when any leg's corridor is blocked, so a run returned here
 * is one the router can take.
 */
export function legReservation(model: LayoutModel, link: LayoutLink,
  cache?: StemCache): PathSegment | undefined {
  const seen = legGaps(model, link).map(item => {
    if (!item) return undefined;
    const slot = cachedPlan(model, item.pair[0], item.pair[1], cache)?.slot.get(link.id);
    return slot === undefined ? undefined : { slot, at: item.at, run: item.run };
  });
  const [from, to] = seen;
  if (!from && !to) return undefined;
  const slot = (from ?? to)!.slot;
  // Seen from both of its ports it is one leg between their two rows; seen from one, it runs that
  // port's own travel, towards the row it turns at.
  const full = from && to ? { start: from.at, end: to.at }
    : from ? { start: from.at, end: from.at + from.run }
      : { start: to!.at + to!.run, end: to!.at };
  // What this reserves is *where* the leg turns, not how far it goes. A link that only passes the
  // neighbour by carries on well past it — up to a band entry, into a node's top side — and how far
  // is routing's business, not placement's. So the run is cut to one pitch from the row it turns
  // at, enough to fix the turn and no more; `legClear` has already checked the whole travel, and a
  // prefix of a clear corridor is clear.
  const pitch = MEMBER_GAP + routedStroke(model);
  const span = full.end - full.start;
  const cut = Math.sign(span) * Math.min(Math.abs(span), pitch);
  // Keep the end that touches the row the leg turns at: that is where the turn happens and what the
  // reservation exists to fix. A leg seen only at its target turns at the far end of its traversal,
  // so its stub is the suffix, not the prefix.
  const line = from && to ? full
    : from ? { start: full.start, end: full.start + cut }
      : { start: full.end - cut, end: full.end };
  if (Math.abs(line.end - line.start) <= EPS) return undefined;
  return { from: { x: slot, y: line.start }, to: { x: slot, y: line.end }, owner: { kind: 'link', id: link.id } };
}

/** The outward reach of `port`'s stem alone; see `stemPlan`. */
export function stemDepth(model: LayoutModel, port: LayoutPort, cache?: StemCache): number {
  return stemPlan(model, port, cache).depth;
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
  // straight across and asks for no stem. `gapStem` is the one rule, shared with `gapPlan`, so the
  // room reserved here and the slot each leg turns at cannot be measured differently.
  const turning = legs === 0 ? 0
    : gapStem(model, a, legsAt.a.ports, legsAt.b, 'right') + gapStem(model, b, legsAt.b.ports, legsAt.a, 'left')
      + (legs - 1) * (MEMBER_GAP + routedStroke(model));
  // A fan on a left or right side draws its rows into this gap, and its side allocates them as one
  // sequence, so the fan that starts last starts beyond every row before it (ADR-0018 rule 1).
  // `fanEnd` is where that fan's leaves actually finish; the far side still needs its own stem past
  // them. Reserved here because two nodes in one row are separated here and nowhere else — moving
  // their group moves both. Read back by `edgeAwareRows`, never discovered.
  const fanPorts = (id: string, side: 'left' | 'right'): Map<string, number> => {
    const result = new Map<string, number>(), node = model.nodes[id];
    if (!node) return result;
    for (const port of node.ports) {
      if (port.side !== side || !port.anchor) continue;
      const links = model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments
        && [link.attachments.from, link.attachments.to].some(ref => key(ref) === key(port.ref)));
      if (links.length >= 2) result.set(key(port.ref), fanEnd(model, port, links));
    }
    return result;
  };
  const fansA = fanPorts(a, 'right'), fansB = fanPorts(b, 'left');
  const reachA = Math.max(0, ...fansA.values()), reachB = Math.max(0, ...fansB.values());
  // A link between two fan ports across this gap is the straight-through leaf of *both* trees
  // (ticket 37): each end splits its own continuation out of the one path, from its own side. The
  // gap has to hold the two continuations, not one of them and the far side's stem, or the second
  // split re-owns the stems the first wrote.
  let shared = 0;
  for (const link of fansA.size && fansB.size ? model.links : []) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [one, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      const here = fansA.get(key(one)), there = fansB.get(key(other));
      if (here !== undefined && there !== undefined) shared = Math.max(shared, here + there);
    }
  }
  const fans = Math.max(reachA ? reachA + stemReach(model, model.nodes[b]!) : 0,
    reachB ? reachB + stemReach(model, model.nodes[a]!) : 0, shared);
  return Math.max(nodeGap(model, a, b), left + right + (left > 0 && right > 0 ? PILL_WIRE_GAP : 0),
    passByStem(b, 'left', a), passByStem(a, 'right', b), turning, fans);
}

/** Resolve all direction votes, resize and repack in skeleton order; retain the returned snapshot. */
export function sidesTwo(model: LayoutModel, nodeFloors?: ReadonlyMap<string, Size>): LayoutModel {
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
      // Inside a grid a peer may stand above or below as well as beside, so the vote reads the
      // packed geometry: a peer that shares this node's row votes left or right, one that does not
      // votes top or bottom. A `row` group has only one row and keeps the row-order answer.
      else if (otherGroup.id === group.id && isGridGroup(model, group.id)) {
        const own = node.bounds!, box = other.bounds!;
        side = Math.min(own.y + own.height, box.y + box.height) > Math.max(own.y, box.y)
          ? (box.x < own.x ? 'left' : 'right') : (box.y < own.y ? 'top' : 'bottom');
      }
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
    // A bus port takes the bus edge once every routed port has settled (below), never a side from the row order.
    if (members.every(({ port }) => busOfPort(model, port.ref) !== undefined)) continue;
    const decided = new Set<Side>();
    for (const port of membersByRoot.get(root) ?? []) if (port.side !== undefined) decided.add(port.side);
    if (decided.size > 1) throw new Error(`Bundle members at ${members[0]!.id} leave on different decided sides`);
    const votes = { bottom: 0, right: 0, top: 0, left: 0 };
    for (const { id, port } of members) for (const side of SIDE_TIE_ORDER) votes[side] += voteFor(id, port)[side];
    const chosen: Side = decided.size ? [...decided][0]! : SIDE_TIE_ORDER.reduce((best, side) => votes[side] > votes[best] ? side : best, 'bottom');
    for (const { port } of members) port.side = chosen;
  }
  // A hinted port whose natural side stage 2 could only estimate takes the side its vote gives now, before the bus edge reads it (side-faces.md, Section 7).
  for (const id of orderedNodeIds(model.document)) for (const port of model.nodes[id]!.ports) {
    if (port.sideHint !== true || port.sizingSide === undefined) continue;
    const votes = voteFor(id, port);
    const natural = SIDE_TIE_ORDER.reduce((best, side) => votes[side] > votes[best] ? side : best, 'bottom' as Side);
    if (natural !== 'top' && natural !== 'bottom') throw new Error(`Side hint on ${id}.${port.ref.name ?? '#'}${port.ref.ordinal} refused: its natural side is ${natural}`);
    port.naturalSide = natural;
  }
  // The bus edge is read after the routed sides are settled (a shared port recomputes its majority), within the span
  // the skeleton order gives, and before stage 5 resizes the nodes and repacks the rows.
  for (const bus of meshBuses(model)) {
    bus.side = busSide(model, bus);
    for (const ref of bus.ports) {
      const port = model.nodes[ref.node]!.ports.find(item => key(item.ref) === key(ref))!;
      if (port.side === undefined) port.side = bus.side;
    }
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
    // A grid repacks as a grid. The nodes have just been resized to their final port capacity, so
    // both the columns and the rows are laid out again from the new sizes at the gaps the rows rule
    // reserves — rather than pushed onto one line, which is what the loop below would do.
    if (isGridGroup(model, groupId) && group.nodes.length) {
      packGridRows(model, group, gridCells(model, group), (a, b) => rowGap(model, a, b), gridRowGap(model));
      continue;
    }
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
      // The bus port is the last port in engine order on its side, after a peerless port too (an authored `order:` still wins below).
      const isBus = (ref: PortRef): number => busOfPort(model, ref) !== undefined ? 1 : 0;
      ports.sort((a, b) => isBus(a.ref) - isBus(b.ref) || (far(a.ref) === far(b.ref) ? 0 : far(a.ref) - far(b.ref)));
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
  return freezePortTopology(model, nodeFloors);
}
