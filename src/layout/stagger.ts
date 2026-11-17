/** Two-line row reservations, made before stage 5 freezes port topology: the width-budget search (ticket 166) and stage 5's own choice (ticket 51, fan wrap D-Q4). */
import type { StaggerDeclineClause } from './reservations.js';
import type { GroupArrangement, LayoutLink, LayoutModel, LayoutGroup, PathSegment } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import type { StaggerRow } from '../model/layout.js';
import { groupShape } from './grid.js';
import { findPort } from './row-paths.js';
import { bandGap, nodeGap, portId } from './skeleton-graph.js';
import { moveGroup, stackBands, validateSkeletonBands } from './skeleton-geometry.js';
import { fitRegionGroup } from './regions.js';
import { nodeObstacleReach, routedStroke } from './bands.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { portEndInsets, portSideCapacity } from './port-insets.js';
import { faceOffsets, neighbourPitch } from './pair-pitch.js';
import { aspectAim, aspectGap } from './aspect.js';
import { plannedBends } from './side-measure.js';
import { ASPECT_EPS, CHORD_CORRIDOR_SLACK, PLACEMENT_EPS } from './tolerance.js';
import { PlacementRefusal } from './placement-refusal.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rowGap } from './sides-two.js';
import { laneWidth, occupied, selectAnchorTier } from './lanes.js';
import { nodeTier } from './read/tier.js';
import { STRAIGHT_PATH_CLEARANCE, straightCorridorClear } from './row-paths.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { segmentDistance, segmentRectDistance } from '../geometry/planar.js';
import { strictCrossing } from './read/crossings.js';
import { FAN_PITCH_CAP, FAN_SLACK } from './fan-spread.js';
import { validateColumns, type ColumnPlan } from './column-arrangement.js';
import { besideGap, documentTiers, packTier, tierUnitsOf, unitOf, type Unit } from './columns.js';
import { liftedGroups, seatLifts } from './lift.js';
import { deriveFrames } from './frames.js';
import { separationShortfalls, worseSeparations } from './constraints/separation.js';
import { straightOverlaysAsDrawn } from './read/overlay-straight.js';
import { isRoutedChord } from './frame-paths.js';
import { straightChord } from './overlay-paths.js';
import { columnUnitId } from './read/chain.js';
import { standsBySeatMove } from './alignment-targets.js';
import { lineOf } from './read/stagger.js';

export { lineOf };
export const staggerOf = (model: LayoutModel, group: string): StaggerRow | undefined => model.staggerRows?.find(row => row.group === group);

/** The horizontal extent of the router's node obstacle: body clearance and stroke-expanded routed pills. */
function obstacleX(model: LayoutModel, id: string): { low: number; high: number } {
  const node = model.nodes[id]!, box = node.bounds!, reach = nodeObstacleReach(model, node);
  const pillGap = (routedStroke(model) + DEFAULT_STROKE_WIDTHS.pill) / 2;
  const pills = node.ports.flatMap(port => port.pill !== undefined && port.pill.layer !== 'overlay' ? [port.pill.bounds] : []);
  return { low: Math.min(box.x - reach, ...pills.map(pill => pill.x - pillGap)),
    high: Math.max(box.x + box.width + reach, ...pills.map(pill => pill.x + pill.width + pillGap)) };
}

/** The links a stagger seats for a member: routed, not stubs, attached. Every reader of a member's links calls this one (R1). */
function memberLinks(model: LayoutModel, id: string): LayoutLink[] {
  return model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments
    && (link.attachments.from.node === id || link.attachments.to.node === id));
}
/** The member end and the far end of a member link. */
function endsOf(link: LayoutLink, id: string): { own: PortRef; far: PortRef } {
  const ends = link.attachments!;
  return ends.from.node === id ? { own: ends.from, far: ends.to } : { own: ends.to, far: ends.from };
}
const opposite = (side: 'top' | 'bottom'): 'top' | 'bottom' => side === 'top' ? 'bottom' : 'top';
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** A stage-5 refusal of one stagger row; the width-budget search and stage 5's own choice record its text. */
function refuse(plan: StaggerRow, message: string): never {
  throw new PlacementRefusal('stagger', `Stagger row ${plan.group}: ${message}`, { stage: 'sides-two', owners: [{ kind: 'group', id: plan.group }] });
}

/** All members have routed links, all exit through the same horizontal face, none stay inside the row. */
function exitSide(model: LayoutModel, group: LayoutGroup): 'top' | 'bottom' | undefined {
  if (group.flank || groupShape(model, group.id) !== 'row' || group.nodes.length < 3) return undefined;
  let side: 'top' | 'bottom' | undefined;
  for (const id of group.nodes) {
    const links = memberLinks(model, id);
    if (!links.length) return undefined;
    for (const link of links) {
      const { own, far } = endsOf(link, id);
      if (group.nodes.includes(far.node)) return undefined;
      const face = findPort(model, own)?.side;
      if (face !== 'top' && face !== 'bottom') return undefined;
      if (side !== undefined && side !== face) return undefined;
      const box = model.nodes[id]!.bounds!, other = model.nodes[far.node]!.bounds!;
      if (face === 'top' ? other.y + other.height > box.y : other.y < box.y + box.height) return undefined;
      side = face;
    }
  }
  return side;
}

/** Widest first, then group id. Width is measured on the published, normal row, not declaration order. */
export function staggerCandidates(model: LayoutModel): StaggerRow[] {
  return Object.values(model.groups).flatMap(group => {
    const side = exitSide(model, group);
    if (side === undefined || staggerOf(model, group.id) !== undefined) return [];
    const order = [...group.rowOrder!];
    return [{ group: group.id, order, far: [], side, pitches: [], step: 0 }];
  }).sort((a, b) => model.groups[b.group]!.bounds!.width - model.groups[a.group]!.bounds!.width || compareId(a.group, b.group));
}

/**
 * Reserve the least centre pitch that clears the bodies, their pills and every passing vertical. A gap between the members of two
 * parents is wider (ticket 51): it also holds both parents, each seated over its drops by `seatFeeds`, a row gap apart. `floors` are the
 * least pitches the chord corridors of a chord row need (`chordSteps`), one per gap; none for a row that spans its drops.
 */
function measure(model: LayoutModel, plan: StaggerRow, floors?: readonly number[]): void {
  const nodes = plan.order.map(id => model.nodes[id]!);
  let pitch = 0;
  const adjacent = new Map<number, number>();
  const last: Record<'near' | 'far', number | undefined> = { near: undefined, far: undefined };
  for (const [i, node] of nodes.entries()) {
    const line = lineOf(plan, node.id), prev = last[line];
    const box = node.bounds!, cx = box.x + box.width / 2;
    // Same-line neighbours are `i - prev` pitches apart. Bodies on different lines clear in y. Two neighbours on one line with no member between
    // (two members with several links, both on the near line) hold their gap alone (`adjacent`), so the other gaps keep the two-line pitch.
    if (prev !== undefined) {
      const need = nodes[prev]!.bounds!.width / 2 + box.width / 2 + rowGap(model, nodes[prev]!.id, node.id);
      if (i - prev === 1) adjacent.set(prev, need); else pitch = Math.max(pitch, need / (i - prev));
    }
    last[line] = i;
    const obstacle = obstacleX(model, node.id);
    // The ports of a far-line member must pass the adjacent near-line members on the way to their feeds.
    if (line === 'near') {
      for (const [index, next] of [[i - 1, nodes[i - 1]], [i + 1, nodes[i + 1]]] as const) {
        if (next === undefined || lineOf(plan, next.id) !== 'far') continue;
        const nextCx = next.bounds!.x + next.bounds!.width / 2;
        const offsets = next.ports.filter(port => port.side === plan.side && !port.unused).map(port => port.anchor!.x - nextCx);
        const need = index < i ? cx - obstacle.low + Math.max(0, ...offsets) : obstacle.high - cx - Math.min(0, ...offsets);
        pitch = Math.max(pitch, need);
      }
    }
  }
  const topReach = Math.max(0, ...nodes.flatMap(node => node.ports.filter(port => port.pill !== undefined).map(port => node.bounds!.y - port.pill!.bounds.y)));
  const bottomReach = Math.max(0, ...nodes.flatMap(node => node.ports.filter(port => port.pill !== undefined).map(port => port.pill!.bounds.y + port.pill!.bounds.height - node.bounds!.y - node.bounds!.height)));
  // A chord row (compact hubs) has no spanning parent to hold apart: every gap takes the one pitch, and the corridor floors of its chords.
  plan.pitches = plan.chordHubs?.length ? plan.order.slice(1).map(() => pitch) : parentGaps(model, plan, pitch);
  for (const [i, need] of adjacent) plan.pitches[i] = Math.max(plan.pitches[i]!, need);
  for (const [i, floor] of (floors ?? []).entries()) plan.pitches[i] = Math.max(plan.pitches[i]!, floor);
  plan.step = Math.max(...nodes.map(node => node.bounds!.height)) + Math.max(...nodes.map(node => nodeGap(model, node.id, node.id))) + topReach + bottomReach;
}

/** The far nodes of a member, sorted by id. */
const parentsOf = (model: LayoutModel, id: string): string[] => [...new Set(memberLinks(model, id).map(link => endsOf(link, id).far.node))].sort(compareId);

/**
 * The per-gap pitches: `pitch` between members of one parent, and between the last member of one parent and the first of the next as
 * much more as both parents need, seated over their drops, to stand a row gap apart. The members of each parent must be one run of the
 * order: interleaved feeds put a body of the parent tier in a drop corridor. One pass left to right; a gap only shifts the members right
 * of it, so a parent seen once keeps its extent.
 */
function parentGaps(model: LayoutModel, plan: StaggerRow, pitch: number): number[] {
  const parents = plan.order.map(id => parentsOf(model, id));
  const runs = new Map<string, { first: number; last: number }>();
  parents.forEach((list, i) => {
    for (const parent of list) {
      const run = runs.get(parent);
      if (run !== undefined && run.last < i - 1) refuse(plan, `the feeds of ${parent} interleave with another parent's in the row`);
      runs.set(parent, { first: run?.first ?? i, last: i });
    }
  });
  const pitches = plan.order.slice(1).map(() => pitch), face = opposite(plan.side);
  // The x a parent's body reaches, seated as `seatFeeds` seats it, on member centres that start at 0.
  const reach = (parent: string): { low: number; high: number } => {
    const run = runs.get(parent)!, node = model.nodes[parent]!, drops: number[] = [];
    let centre = 0;
    for (let i = 0; i <= run.last; i++) {
      if (i > 0) centre += pitches[i - 1]!;
      if (i < run.first) continue;
      const member = model.nodes[plan.order[i]!]!, box = member.bounds!;
      for (const link of memberLinks(model, member.id).filter(link => endsOf(link, member.id).far.node === parent)) {
        drops.push(centre + findPort(model, endsOf(link, member.id).own)!.anchor!.x - box.x - box.width / 2);
      }
    }
    const low = Math.min(...drops), high = Math.max(...drops), inset = portEndInsets(node, face);
    const extra = (Math.max(node.bounds!.width, high - low + 2 * Math.max(inset.low, inset.high)) - (high - low)) / 2;
    return { low: low - extra, high: high + extra };
  };
  for (let i = 0; i + 1 < plan.order.length; i++) {
    for (const left of parents[i]!) for (const right of parents[i + 1]!) {
      if (left === right || runs.get(left)!.last !== i || runs.get(right)!.first !== i + 1) continue;
      // `seatFeeds` seats ordinary parents only (7d spans a bar), and `rowGap` is the gap of one row: parents in two groups keep their own packing.
      const groupOf = (id: string): string => model.document.nodes[id]!.group;
      if (groupOf(left) !== groupOf(right) || [left, right].some(id => groupShape(model, groupOf(id)) === 'bar')) continue;
      const deficit = reach(left).high + rowGap(model, left, right) - reach(right).low;
      if (deficit > 0) pitches[i]! += deficit;
    }
  }
  return pitches;
}

/** Seat the feeding faces before lanes fix their x. An ordinary parent needs the same reservation a bar gets from its span. */
function seatFeeds(model: LayoutModel, fans: ReadonlyMap<string, number>): SeatedParent[] {
  const parents = new Map<string, 'top' | 'bottom'>();
  for (const plan of model.staggerRows ?? []) for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    for (const [own, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      if (!plan.order.includes(own.node)) continue;
      const side = findPort(model, far)!.side;
      if (side === 'top' || side === 'bottom') {
        if (parents.has(far.node) && parents.get(far.node) !== side) throw new PlacementRefusal('stagger', 'A feeding node faces staggered rows in both directions');
        parents.set(far.node, side);
      }
    }
  }
  // Closest parents first, so a parent reads a child parent at its new x. Node id is the last tie key.
  const ordered = [...parents].sort(([a, side], [b, otherSide]) => {
    const tier = (id: string): number => model.groups[model.document.nodes[id]!.group]!.tier!;
    if (side !== otherSide) return side === 'top' ? -1 : 1;
    return (side === 'bottom' ? tier(b) - tier(a) : tier(a) - tier(b)) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const members = new Set((model.staggerRows ?? []).flatMap(plan => plan.order));
  // Per seated parent: the links on its feeding face that end on no staggered member (they are seated over their far ends too).
  const seated: SeatedParent[] = [];
  // The compact hubs first (dense-16x9 ticket 03, slice C): each chord row seats its hubs (`seatChordHubs`), and no spanning parent is one of them.
  const compact = new Set<string>();
  for (const plan of model.staggerRows ?? []) {
    if (!plan.chordHubs?.length) continue;
    for (const id of plan.chordHubs) {
      if (compact.has(id)) refuse(plan, `its hub ${id} is a compact hub of another row`);
      compact.add(id);
    }
    seated.push(...seatChordHubs(model, plan, fans));
  }
  for (const [id, side] of ordered) {
    if (compact.has(id)) {
      // A compact hub reaches the members of every row it feeds by chords: a row that spans its drops cannot use it.
      const row = (model.staggerRows ?? []).find(plan => !plan.chordHubs?.length && plan.order.some(member => parentsOf(model, member).includes(id)));
      if (row !== undefined) refuse(row, `its parent ${id} is a compact hub of another row`);
      continue;
    }
    const node = model.nodes[id]!, group = model.groups[model.document.nodes[id]!.group]!;
    if (groupShape(model, group.id) === 'bar') continue; // 7d derives the bar's span from these same reserved drops.
    const targets = new Map<string, number>(), others: string[] = [];
    for (const link of model.links) {
      if (link.layer !== 'routed' || !link.attachments) continue;
      for (const [own, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
        if (own.node !== id || findPort(model, own)!.side !== side) continue;
        const key = portId(own), x = findPort(model, far)!.anchor!.x, prior = targets.get(key);
        if (prior !== undefined && Math.abs(prior - x) > PLACEMENT_EPS) throw new PlacementRefusal('stagger', 'A shared feeding port cannot hold distinct vertical drops');
        targets.set(key, x);
        if (!members.has(far.node)) others.push(link.id);
      }
    }
    seated.push({ id, side, others: others.sort(compareId) });
    const ports = node.ports.filter(port => port.side === side);
    const wanted = ports.filter(port => targets.has(portId(port.ref))).sort((a, b) => targets.get(portId(a.ref))! - targets.get(portId(b.ref))! || a.engineOrder! - b.engineOrder!);
    for (let i = 1; i < wanted.length; i++) {
      if (targets.get(portId(wanted[i]!.ref))! - targets.get(portId(wanted[i - 1]!.ref))! < neighbourPitch(node, side, wanted[i - 1]!.ref, wanted[i]!.ref) - PLACEMENT_EPS) {
        throw new PlacementRefusal('stagger', 'A feeding face cannot keep its pitch over the stagger');
      }
    }
    const authored = wanted.filter(port => port.authorOrder !== undefined);
    if (authored.some((port, i) => i > 0 && port.authorOrder! < authored[i - 1]!.authorOrder!)) {
      throw new PlacementRefusal('stagger', 'A feeding face cannot keep its authored order over the stagger');
    }
    const xs = [...targets.values()], low = Math.min(...xs), high = Math.max(...xs), old = node.bounds!;
    const inset = portEndInsets(node, side);
    const width = Math.max(old.width, high - low + 2 * Math.max(inset.low, inset.high));
    const x = (low + high - width) / 2, dx = x - old.x;
    node.bounds = { ...old, x, width }; node.size = { ...node.size!, width };
    // The far face keeps its ports' offsets from the centre (fan wrap, D-Q4): the hub's feed from the tier beyond stays over the drops it spans.
    for (const port of node.ports) if (port.anchor) port.anchor.x += dx + (port.side === 'right' ? width - old.width : port.side === opposite(side) ? (width - old.width) / 2 : 0);
    for (const port of wanted) port.anchor!.x = targets.get(portId(port.ref))!;
    ports.sort((a, b) => a.anchor!.x - b.anchor!.x || a.engineOrder! - b.engineOrder!).forEach((port, index) => { port.engineOrder = index; });
    rebuildNodeGeometry(model, [id], 'current');
    fitRegionGroup(model, group);
  }
  for (const parent of seated) seatedParentFits(model, parent);
  return seated;
}

/**
 * Seats the compact hubs of a chord row (dense-16x9 ticket 03, slice C; coordinator's ruling B of 2026-11-16). Each hub takes the width its ports
 * need at the face pitch its chords need (`fans`, from `chordPitches`; never narrower than it is) and stands at the midpoint of its targets (the
 * member ports of its links). Hubs that would then stand closer than a row gap stand as one packed run, a row gap apart, centred on the mean of
 * their midpoints; the run order is the order of the midpoints, a tie takes the hub's own centre before the seat, then the id (R3). A hub whose
 * centre then stands outside the span of its own targets refuses the row by name. The ports of each hub's feeding face stand at that pitch in
 * far-end order (a port with no far end keeps its place in the order by its own x), centred inside the face's insets. The other members of the
 * hubs' row step outward to keep their row gap. Hubs in two groups, a bar, hubs that are not side by side in their row, a face that cannot hold
 * its ports and a reversed authored order refuse the row by name.
 */
function seatChordHubs(model: LayoutModel, plan: StaggerRow, fans: ReadonlyMap<string, number>): SeatedParent[] {
  const side = opposite(plan.side), hubs = plan.chordHubs!;
  const groups = new Set(hubs.map(id => model.document.nodes[id]!.group));
  if (groups.size > 1) refuse(plan, `its compact hubs ${hubs.join(', ')} stand in more than one group`);
  const group = model.groups[[...groups][0]!]!;
  if (groupShape(model, group.id) === 'bar') refuse(plan, `its compact hubs stand in the bar ${group.id}`);
  // The far-end x of each port of a hub's feeding face: the anchor of the other end of each routed link there.
  const farEnds = (id: string): Map<string, number> => {
    const targets = new Map<string, number>();
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
      for (const [own, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
        if (own.node !== id || findPort(model, own)?.side !== side) continue;
        const x = findPort(model, far)?.anchor?.x;
        if (x === undefined) continue;
        const key = portId(own), prior = targets.get(key);
        if (prior !== undefined && Math.abs(prior - x) > PLACEMENT_EPS) refuse(plan, `a port of its compact hub ${id} feeds two far ends`);
        targets.set(key, x);
      }
    }
    return targets;
  };
  const members = new Set(plan.order);
  const run = hubs.map(id => {
    const node = model.nodes[id]!, box = node.bounds!, count = node.ports.filter(port => port.side === side).length;
    // The face pitch the hub's chords need (`chordPitches`), and the width that holds its ports at that pitch: the width its ports need.
    const pitch = Math.max(node.sidePitch![side]!, fans.get(id) ?? 0), width = Math.max(box.width, portSideCapacity(node, side, count, pitch));
    const own = memberLinks(model, id).filter(link => members.has(endsOf(link, id).far.node)).map(link => findPort(model, endsOf(link, id).far)!.anchor!.x);
    const low = Math.min(...own), high = Math.max(...own);
    return { id, node, low, high, middle: (low + high) / 2, centre: box.x + box.width / 2, targets: own, pitch, width };
  }).sort((a, b) => a.middle - b.middle || a.centre - b.centre || compareId(a.id, b.id));
  // Each hub stands at the midpoint of its targets; hubs that would then stand closer than a row gap join one packed run, centred on the mean of
  // their midpoints, and a run that reaches its neighbour run joins it (a finite merge: each step removes one run).
  const gapAfter = run.map((hub, i) => i + 1 < run.length ? rowGap(model, hub.id, run[i + 1]!.id) : 0);
  const clusters: { from: number; to: number; left: number }[] = [];
  const widthOf = (from: number, to: number): number => run.slice(from, to + 1).reduce((sum, hub, k) => sum + hub.width + (from + k < to ? gapAfter[from + k]! : 0), 0);
  const leftOf = (from: number, to: number): number => {
    const mean = run.slice(from, to + 1).reduce((sum, hub) => sum + hub.middle, 0) / (to - from + 1);
    return mean - widthOf(from, to) / 2;
  };
  for (let i = 0; i < run.length; i++) {
    clusters.push({ from: i, to: i, left: leftOf(i, i) });
    while (clusters.length > 1) {
      const b = clusters.at(-1)!, a = clusters.at(-2)!;
      if (a.left + widthOf(a.from, a.to) + gapAfter[a.to]! <= b.left + PLACEMENT_EPS) break;
      clusters.splice(-2, 2, { from: a.from, to: b.to, left: leftOf(a.from, b.to) });
    }
  }
  const seated: SeatedParent[] = [];
  for (const cluster of clusters) for (let i = cluster.from, x = cluster.left; i <= cluster.to; i++) {
    const hub = run[i]!;
    if (i > cluster.from) x += gapAfter[i - 1]!;
    const node = hub.node, old = node.bounds!, width = hub.width, pitch = hub.pitch, centre = x + width / 2;
    if (centre < hub.low - PLACEMENT_EPS || centre > hub.high + PLACEMENT_EPS) {
      refuse(plan, `its compact hub ${hub.id} cannot stand inside the span of its targets (${hub.low.toFixed(2)} to ${hub.high.toFixed(2)} px): the packed run puts its centre at ${centre.toFixed(2)} px`);
    }
    const dx = x - old.x;
    node.bounds = { ...old, x, width }; node.size = { ...node.size!, width };
    node.sidePitch = { ...node.sidePitch!, [side]: pitch };
    // A wider body keeps the far face's ports at their offsets from the centre, and its right face on its edge.
    for (const port of node.ports) if (port.anchor) port.anchor.x += dx + (port.side === 'right' ? width - old.width : port.side === plan.side ? (width - old.width) / 2 : 0);
    const targets = farEnds(hub.id), inset = portEndInsets(node, side);
    const ports = node.ports.filter(port => port.side === side)
      .sort((a, b) => (targets.get(portId(a.ref)) ?? a.anchor!.x) - (targets.get(portId(b.ref)) ?? b.anchor!.x) || a.engineOrder! - b.engineOrder!);
    // Each step of the face keeps its neighbour-pair pitch (`faceOffsets`, dense-16x9 ticket 04): the face pitch, or a stored pair floor above it.
    const room = width - inset.low - inset.high, offsets = faceOffsets(node, side, ports, pitch), span = offsets.at(-1) ?? 0;
    if (span > room + PLACEMENT_EPS) refuse(plan, `its compact hub ${hub.id} cannot hold its ${ports.length} ports at the pitch ${pitch.toFixed(2)} px and its pair pitches`);
    const first = x + inset.low + (room - span) / 2;
    ports.forEach((port, index) => { port.anchor!.x = first + offsets[index]!; port.engineOrder = index; });
    const authored = ports.filter(port => port.authorOrder !== undefined);
    if (authored.some((port, k) => k > 0 && port.authorOrder! < authored[k - 1]!.authorOrder!)) refuse(plan, `its compact hub ${hub.id} cannot keep its authored port order`);
    x += width;
    rebuildNodeGeometry(model, [hub.id], 'current');
    seated.push({ id: hub.id, side, others: memberLinks(model, hub.id)
      .filter(link => !members.has(endsOf(link, hub.id).far.node) && findPort(model, endsOf(link, hub.id).own)?.side === side).map(link => link.id).sort(compareId) });
  }
  // The other members of the hubs' row keep their order and a row gap from the run: those beside it step outward by what the run took.
  if (groupShape(model, group.id) === 'row') {
    const order = group.rowOrder ?? group.nodes, at = order.map(id => hubs.includes(id));
    const first = at.indexOf(true), last = at.lastIndexOf(true);
    if (order.slice(first, last + 1).some(id => !hubs.includes(id))) refuse(plan, `its compact hubs do not stand side by side in the row of ${group.id}`);
    const shift = (id: string, dx: number): void => {
      const node = model.nodes[id]!;
      node.bounds = { ...node.bounds!, x: node.bounds!.x + dx };
      for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
    };
    for (let i = last + 1; i < order.length; i++) {
      const left = model.nodes[order[i - 1]!]!.bounds!, need = left.x + left.width + rowGap(model, order[i - 1]!, order[i]!) - model.nodes[order[i]!]!.bounds!.x;
      if (need > PLACEMENT_EPS) shift(order[i]!, need);
    }
    for (let i = first - 1; i >= 0; i--) {
      const box = model.nodes[order[i]!]!.bounds!, need = box.x + box.width + rowGap(model, order[i]!, order[i + 1]!) - model.nodes[order[i + 1]!]!.bounds!.x;
      if (need > PLACEMENT_EPS) shift(order[i]!, -need);
    }
    rebuildNodeGeometry(model, order.filter(id => !hubs.includes(id)), 'current');
  }
  fitRegionGroup(model, group);
  return seated;
}

/** A parent `seatFeeds` seated: its feeding face, and the links there that end on no staggered member, sorted by id. */
interface SeatedParent { id: string; side: 'top' | 'bottom'; others: string[] }

/** The named stage-5 refusal of a seated parent: the rows it feeds, and what the seat over its drops and its other links broke. */
function refuseParent(model: LayoutModel, parent: SeatedParent, what: string): never {
  const fed = (model.staggerRows ?? []).filter(plan => plan.order.some(member => memberLinks(model, member).some(link => endsOf(link, member).far.node === parent.id)));
  const over = parent.others.length ? `its drops and its other links (${parent.others.join(', ')})` : 'its drops';
  throw new PlacementRefusal('stagger', `Stagger row ${fed.map(plan => plan.group).join(', ')}: the feeding face of ${parent.id}, seated over ${over}, ${what}`,
    { stage: 'sides-two', owners: fed.map(plan => ({ kind: 'group' as const, id: plan.group })) });
}

/**
 * A seated parent keeps the freeze's geometry (ticket 51, review finding 3b): `seatFeeds` widens it over every routed port of its feeding
 * face, the drops and any other link there, so it can reach a neighbour of its row, and the ports it does not seat (an overlay port, an
 * unused port) keep their old offset. The freeze would refuse each with a generic message; stage 5 refuses it here by name. The tests are
 * the freeze's own (`validateGeometry`): the node clearance and the physical row order of the group, and the pitch, capacity and authored
 * order of every port of the feeding face. The band test follows `stackBands` in `seatStaggerRows`.
 */
function seatedParentFits(model: LayoutModel, parent: SeatedParent): void {
  const { id, side } = parent, node = model.nodes[id]!, group = model.groups[model.document.nodes[id]!.group]!, box = node.bounds!;
  for (const other of [...group.nodes].filter(item => item !== id).sort(compareId)) {
    const b = model.nodes[other]!.bounds!;
    const dx = Math.max(box.x - b.x - b.width, b.x - box.x - box.width, 0), dy = Math.max(box.y - b.y - b.height, b.y - box.y - box.height, 0);
    if (Math.hypot(dx, dy) < nodeGap(model, id, other) - PLACEMENT_EPS) refuseParent(model, parent, `comes within clearance of ${other}`);
  }
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!), pitch = node.sidePitch![side]!;
  if (box.width + PLACEMENT_EPS < portSideCapacity(node, side, ports.length, pitch)) refuseParent(model, parent, `cannot hold its ${ports.length} ports`);
  // A port is named by its link (the lowest id; R3), or as unlinked.
  const named = (ref: PortRef): string => {
    const ids = model.links.filter(link => link.attachments && [link.attachments.from, link.attachments.to].some(end => portId(end) === portId(ref))).map(link => link.id).sort(compareId);
    return ids.length ? `the port of ${ids[0]!}` : 'an unlinked port';
  };
  let authored = -Infinity;
  for (const [i, port] of ports.entries()) {
    if (i > 0 && port.anchor!.x - ports[i - 1]!.anchor!.x < neighbourPitch(node, side, ports[i - 1]!.ref, port.ref, pitch) - PLACEMENT_EPS) {
      refuseParent(model, parent, `cannot keep its pitch between ${named(ports[i - 1]!.ref)} and ${named(port.ref)}`);
    }
    if (port.authorOrder !== undefined) {
      if (port.authorOrder < authored) refuseParent(model, parent, `reverses the authored order at ${named(port.ref)}`);
      authored = port.authorOrder;
    }
  }
  if (groupShape(model, group.id) !== 'row') return;
  // The freeze reads a staggered row by member centres and any other row by left edges.
  const centred = staggerOf(model, group.id) !== undefined;
  const position = (item: string): number => model.nodes[item]!.bounds!.x + (centred ? model.nodes[item]!.bounds!.width / 2 : 0);
  const order = group.rowOrder!;
  for (let i = 1; i < order.length; i++) {
    if (order[i - 1] !== id && order[i] !== id) continue;
    // A backstop: a parent that passes a neighbour mostly comes within its clearance first.
    if (position(order[i - 1]!) > position(order[i]!) + PLACEMENT_EPS) refuseParent(model, parent, `passes ${order[i - 1] === id ? order[i]! : order[i - 1]!} in the row order of ${group.id}`);
  }
}

/**
 * Stage 5 only: seat both lines, fit containing groups, close the space released in each affected tier. A wrapped rank cell also packs its
 * document tier again and stands its feeding chain over its block (fan wrap, D-Q4), before the feeding faces are seated.
 */
export function seatStaggerRows(model: LayoutModel): void {
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    if (group === undefined || exitSide(model, group) !== plan.side || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order)) {
      throw new PlacementRefusal('stagger', `Stagger row ${plan.group} no longer has its reserved feed order and exit face`, { stage: 'sides-two', owners: [{ kind: 'group', id: plan.group }] });
    }
    // First seat decides the far-line members and the compact hubs once (R1); later runs read `plan.far` through `lineOf`, and `plan.chordHubs`.
    if (!plan.far.length) plan.far = decideFar(model, plan.order);
    if (!plan.far.length) refuse(plan, 'every member has several links: no member stands on the far line');
    plan.chordHubs ??= decideChordHubs(model, plan);
  }
  const chordRows = (model.staggerRows ?? []).filter(plan => plan.chordHubs!.length);
  if (!chordRows.length) { seatOnce(model, { pitches: new Map(), fans: new Map() }, true); return; }
  // A chord row: the corridor of each chord reads the hub's x, which the seat sets from the member ports, so seat and measure repeat on a draft
  // until no pitch grows by more than `PLACEMENT_EPS` (at most `CHORD_SEAT_PASSES`); the model is then seated once with the settled floors.
  // Widening a corridor also moves the hub (it stands at the midpoint of its targets), so a step closes its shortfall at a rate below one; the
  // step reads that rate off the geometry (`chordSteps`). The same loop settles the port pitch each hub's chords need to stand apart
  // (`chordPitches`), so the fan round finds nothing to spread there. Floors only grow, so a pass never undoes another.
  const floors: SeatFloors = { pitches: new Map(), fans: new Map() };
  for (let pass = 0; pass < CHORD_SEAT_PASSES; pass++) {
    const draft = JSON.parse(JSON.stringify(model)) as LayoutModel;
    seatOnce(draft, floors, false);
    let grown = false;
    for (const plan of draft.staggerRows!.filter(row => row.chordHubs!.length)) {
      const steps = chordSteps(draft, plan);
      for (const [hub, pitch] of chordPitches(draft, plan)) { floors.fans.set(hub, pitch); grown = true; }
      if (!steps.some(step => step > PLACEMENT_EPS)) continue;
      grown = true;
      floors.pitches.set(plan.group, plan.pitches.map((pitch, i) => pitch + (steps[i]! > PLACEMENT_EPS ? steps[i]! + CHORD_CORRIDOR_SLACK : 0)));
    }
    if (!grown) { seatOnce(model, floors, true); return; }
  }
  refuse(chordRows[0]!, `its chord corridors did not settle in ${CHORD_SEAT_PASSES} seats`);
}

/** The most seats a chord row takes to settle its corridors (`seatStaggerRows`). A chord row that needs more refuses by name (R4). */
export const CHORD_SEAT_PASSES = 8;
/** The least rate at which a corridor step closes its shortfall, as a fraction of the step (`chordSteps`): a step is at most four times the shortfall. */
const CHORD_RATE_FLOOR = 0.25;

/**
 * The far-line members of a row, decided by its first seat: the first member and every member with several links stand on the near line; a member
 * with one link stands on the far line when the member before it stands on the near line (dense-16x9 ticket 03, slice C). A row of one-link
 * members alternates, as before.
 */
function decideFar(model: LayoutModel, order: readonly string[]): string[] {
  const far: string[] = [];
  let near = false;
  for (const id of order) {
    const stands: boolean = near && memberLinks(model, id).length === 1;
    if (stands) far.push(id);
    near = !stands;
  }
  return far;
}

/** The compact hubs of a row, decided by its first seat: every far node of a member link when some member has several links, sorted by id; else none. */
function decideChordHubs(model: LayoutModel, plan: StaggerRow): string[] {
  if (!plan.order.some(id => memberLinks(model, id).length > 1)) return [];
  return [...new Set(plan.order.flatMap(id => parentsOf(model, id)))].sort(compareId);
}

/**
 * How much wider each gap of a seated chord row must be for its chords to pass the members on their way (dense-16x9 ticket 03, slice C), one
 * value per gap, 0 or less where the gap suffices. A chord leaves its member's port toward its hub's port; it must keep the body clearance a
 * routed chord keeps (`STRAIGHT_PATH_CLEARANCE`, both strokes) from every other member's body, and clear its pills, of the members it passes on
 * the side of its hub. The inner corner of each such shape (nearest the member in x, nearest the hub in y) must lie beyond the chord; the
 * shortfall is charged to the gap next to the chord's member toward its hub, its **chord corridor**: widening it moves every member past it,
 * and the hub by `m` of the step (half for each end of its targets that lies past the gap), so the chord at the corner (a fraction `t` of the
 * way to the hub) moves too. The step is the shortfall over the rate at which the step closes it, never below `CHORD_RATE_FLOOR`.
 */
function chordSteps(model: LayoutModel, plan: StaggerRow): number[] {
  const steps = plan.pitches.map(() => 0), hubs = new Set(plan.chordHubs);
  // The first and last member index of each hub's targets.
  const span = new Map<string, { low: number; high: number }>();
  for (const [i, id] of plan.order.entries()) for (const hub of parentsOf(model, id)) {
    const known = span.get(hub);
    span.set(hub, { low: known?.low ?? i, high: i });
  }
  for (const [i, id] of plan.order.entries()) for (const link of memberLinks(model, id)) {
    const { own, far } = endsOf(link, id);
    if (!hubs.has(far.node)) continue;
    // The chord from face to face, as the proof and the freeze read it.
    const chord = straightChord(model, link, undefined, true);
    if (chord === undefined) continue;
    const [p, q] = own === link.attachments!.from ? [chord.from, chord.to] : [chord.to, chord.from], dir = Math.sign(q.x - p.x);
    const gap = dir > 0 ? i : i - 1;
    if (dir === 0 || Math.abs(q.y - p.y) <= PLACEMENT_EPS || gap < 0 || gap >= steps.length) continue;
    const stroke = linkStrokeWidth(link), targets = span.get(far.node)!, m = ((targets.low > gap ? 1 : 0) + (targets.high > gap ? 1 : 0)) / 2;
    const share = (y: number): number => Math.min(1, Math.max(0, (y - p.y) / (q.y - p.y)));
    const at = (y: number): number => p.x + (q.x - p.x) * share(y);
    for (const [j, other] of plan.order.entries()) {
      if ((j - i) * dir <= 0) continue;
      const node = model.nodes[other]!, body = STRAIGHT_PATH_CLEARANCE.node + (stroke + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
      const shapes = [grow(node.bounds!, body), ...node.ports.flatMap(port => port.pill !== undefined && port.pill.layer !== 'overlay'
        ? [grow(port.pill.bounds, (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2)] : [])];
      for (const box of shapes) {
        const inner = dir > 0 ? box.x : box.x + box.width, outer = dir > 0 ? box.x + box.width : box.x;
        const [nearY, farY] = q.y > p.y ? [box.y, box.y + box.height] : [box.y + box.height, box.y];
        // A chord past the shape before it reaches the shape's y, or still short of it there, leaves the shape alone.
        if ((at(nearY) - outer) * dir >= 0 || (farY - p.y) * (q.y - p.y) <= 0) continue;
        const short = (at(farY) - inner) * dir, t = share(farY);
        // Toward a hub on the right the shape moves with the gap; toward a hub on the left the member does.
        const rate = Math.max(CHORD_RATE_FLOOR, dir > 0 ? 1 - t * m : 1 - t + t * m);
        steps[gap] = Math.max(steps[gap]!, short / rate);
      }
    }
  }
  return steps;
}
/**
 * The face pitch each compact hub of a seated chord row needs for its chords to stand apart (dense-16x9 ticket 03, slice C): the least face pitch,
 * from the face's own up to `FAN_PITCH_CAP` in whole px, at which every two chords of neighbouring ports cross strictly or keep the clearance
 * the fan rule measures (`STRAIGHT_PATH_CLEARANCE.path` plus `FAN_SLACK`, both strokes; `measureFans`). The ports stand centred at that pitch,
 * each pair at no less than a pair floor the face stores (`faceOffsets`, `neighbourPitch`), the member ends where they stand. The result is a
 * face-wide pitch for `sidePitch`; a pair floor never enters it. Only a hub that needs more than it has is listed; a hub that the cap cannot help keeps its pitch, and the
 * freeze judges its chords.
 */
function chordPitches(model: LayoutModel, plan: StaggerRow): Map<string, number> {
  const side = opposite(plan.side), members = new Set(plan.order), result = new Map<string, number>();
  for (const id of plan.chordHubs!) {
    const node = model.nodes[id]!, ports = node.ports.filter(port => port.side === side).sort((a, b) => a.anchor!.x - b.anchor!.x);
    const centre = (ports[0]!.anchor!.x + ports.at(-1)!.anchor!.x) / 2, base = node.sidePitch![side]!;
    // Each port's chords: the far end (a member's face point) and the hub end's offset from the port anchor, with the link's stroke.
    const chords = ports.map(port => memberLinks(model, id).filter(link => portId(endsOf(link, id).own) === portId(port.ref) && members.has(endsOf(link, id).far.node))
      .flatMap(link => {
        const chord = straightChord(model, link, undefined, true);
        if (chord === undefined) return [];
        const [hubEnd, memberEnd] = endsOf(link, id).own === link.attachments!.from ? [chord.from, chord.to] : [chord.to, chord.from];
        return [{ dx: hubEnd.x - port.anchor!.x, y: hubEnd.y, far: memberEnd, stroke: linkStrokeWidth(link) }];
      }));
    // The ports stand centred at the trial face pitch, each step at its neighbour-pair pitch (`faceOffsets`), as `seatChordHubs` seats them.
    const at = (k: number, pitch: number): number => { const offsets = faceOffsets(node, side, ports, pitch); return centre - offsets.at(-1)! / 2 + offsets[k]!; };
    const segment = (k: number, pitch: number, chord: typeof chords[number][number]): PathSegment =>
      ({ from: { x: at(k, pitch) + chord.dx, y: chord.y }, to: chord.far, owner: { kind: 'link', id } });
    // A chord also clears the routed pills of the neighbouring ports of its face, as the corridor test reads them (`straightCorridorClear`).
    const pill = (k: number, pitch: number): { x: number; y: number; width: number; height: number } | undefined => {
      const port = ports[k], box = port?.pill?.layer === 'overlay' ? undefined : port?.pill?.bounds;
      return box === undefined ? undefined : { ...box, x: box.x + at(k, pitch) - port!.anchor!.x };
    };
    const holds = (pitch: number): boolean => chords.every((own, k) => own.every(b => [k - 1, k + 1].every(n => {
      const box = pill(n, pitch);
      return box === undefined || segmentRectDistance(segment(k, pitch, b), box) - (b.stroke + DEFAULT_STROKE_WIDTHS.pill) / 2 >= -PLACEMENT_EPS;
    }) && (k === 0 || chords[k - 1]!.every(a => {
      const one = segment(k - 1, pitch, a), two = segment(k, pitch, b);
      return strictCrossing(one, two) || segmentDistance(one, two) - (a.stroke + b.stroke) / 2 >= STRAIGHT_PATH_CLEARANCE.path + FAN_SLACK - PLACEMENT_EPS;
    }))));
    if (holds(base)) continue;
    for (let pitch = Math.ceil(base); pitch <= FAN_PITCH_CAP; pitch++) if (holds(pitch)) { result.set(id, pitch); break; }
  }
  return result;
}

const grow = (box: { x: number; y: number; width: number; height: number }, by: number): { x: number; y: number; width: number; height: number } =>
  ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });

/** What the corridor loop of a chord row settles: the least pitch of each gap, per group, and the port pitch of each compact hub's feeding face. */
interface SeatFloors { pitches: Map<string, number[]>; fans: Map<string, number> }
/** One seat of the rows with the given floors (`seatStaggerRows`); a draft seat of the corridor loop proves no drop. */
function seatOnce(model: LayoutModel, floors: SeatFloors, prove: boolean): void {
  const affected = new Set<number>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group]!;
    measure(model, plan, floors.pitches.get(plan.group));
    const nodes = plan.order.map(id => model.nodes[id]!);
    const min = Math.min(...nodes.map(node => node.bounds!.x));
    const y = Math.min(...nodes.map(node => node.bounds!.y));
    let centre = min + nodes[0]!.bounds!.width / 2;
    nodes.forEach((node, i) => {
      if (i > 0) centre += plan.pitches[i - 1]!;
      const x = centre - node.bounds!.width / 2;
      const offset = lineOf(plan, node.id) === (plan.side === 'top' ? 'far' : 'near') ? 1 : 0;
      const top = y + offset * plan.step;
      const dx = x - node.bounds!.x, dy = top - node.bounds!.y;
      node.bounds!.x = x; node.bounds!.y = top;
      for (const port of node.ports) if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
    });
    rebuildNodeGeometry(model, plan.order, 'current');
    fitRegionGroup(model, group);
    affected.add(group.tier!);
  }
  // Unframed sibling rows close up together. Framed columns retain the normal column packer's ownership.
  for (const band of model.tierBands.filter(band => affected.has(band.tier))) {
    const groups = band.groups.map(id => model.groups[id]!).sort((a, b) => a.bounds!.x - b.bounds!.x || (a.id < b.id ? -1 : 1));
    if (groups.some(group => group.frame !== undefined || group.flank)) continue;
    let x = groups[0]!.bounds!.x;
    for (const group of groups) { moveGroup(model, group, x - group.bounds!.x, 0); x += group.bounds!.width + bandGap(model); }
  }
  // A wrapped rank cell (fan wrap, D-Q4): the column packer packs its document tier again against the narrower cell (`packTier`), and the
  // feeding chain of its block moves as one block in x to stand over the block's feeds again. The first seat decides the chain; a later run
  // reads it (R1). Rows in `staggerRows` order; a unit of an earlier row's chain is no unit of a later one, so the chains are disjoint.
  const rankCells = (model.staggerRows ?? []).filter(plan => model.groups[plan.group]!.frame !== undefined);
  for (const plan of rankCells) packTier(model, tierUnitsOf(model, plan.group), new Map());
  for (const [i, plan] of rankCells.entries()) {
    plan.chain ??= decideChain(model, plan, new Set(rankCells.slice(0, i).flatMap(row => row.chain ?? [])));
    standChain(model, plan);
  }
  const seated = seatFeeds(model, floors.fans);
  // D-Q5: a lifted component stands beside the units of the bands it shares; the chain moved and the feeds were seated, so it is seated again.
  seatLifts(model, (group, dx) => moveGroup(model, group, dx, 0), () => deriveFrames(model));
  stackBands(model, true);
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  // The freeze's band test (`validateSkeletonBands`), by name: first each seated parent's band, whose group the seat widened, then every band.
  for (const parent of seated) {
    const peer = model.groups[model.document.nodes[parent.id]!.group]!;
    const errors = validateSkeletonBands(model, true, peer.tier);
    if (errors.length) refuseParent(model, parent, `leaves its band invalid: ${errors.join('; ')}`);
    // The freeze's flank test: a flank of the parent's group keeps its authored side of the group's centre, also when the seat moved the group past it.
    const centre = peer.bounds!.x + peer.bounds!.width / 2;
    for (const flank of Object.values(model.groups).filter(group => group.flank?.of === peer.id).sort((a, b) => compareId(a.id, b.id))) {
      const sides = [flank.bounds!, ...flank.nodes.map(id => model.nodes[id]!.bounds!)].map(box => box.x + box.width / 2);
      if (sides.some(x => flank.flank!.align === 'left' ? x >= centre : x <= centre)) refuseParent(model, parent, `moves ${peer.id} past its ${flank.flank!.align} flank ${flank.id}`);
    }
  }
  const bandErrors = validateSkeletonBands(model);
  if (bandErrors.length) {
    throw new PlacementRefusal('stagger', `Stagger rows ${(model.staggerRows ?? []).map(plan => plan.group).join(', ')}: the seat leaves the bands invalid: ${bandErrors.join('; ')}`,
      { stage: 'sides-two', owners: (model.staggerRows ?? []).map(plan => ({ kind: 'group' as const, id: plan.group })) });
  }
  if (prove) for (const plan of model.staggerRows ?? []) proveDrops(model, plan);
}

/**
 * The stage-5 proof that each drop of a stagger is one straight vertical through to routing (ticket 51, from the width-budget trials that
 * stage 5 admitted and routing refused). Each check names its refusal:
 * - the far end is the horizontal face over the member (a lateral face bends round its node);
 * - the vertical from the parent face to the member, at the clearances of a straight corridor, meets no foreign body, pill, title or group
 *   box; where it crosses a tier between (a transit), it clears every group box of that tier by half a lane, as 7a stands the lane;
 * - the parent port stands over the member, and the centre rule (7c) moves the parents over the row, not the row under the parents: the
 *   anchor tier is the row's tier or lies beyond it, away from the parents. A bar parent takes its span from the drops in 7d.
 */
function proveDrops(model: LayoutModel, plan: StaggerRow): void {
  const tier = model.groups[plan.group]!.tier!, face = opposite(plan.side), anchor = selectAnchorTier(model);
  const hubs = new Set(plan.chordHubs ?? []);
  for (const id of plan.order) for (const link of memberLinks(model, id)) {
    const { own, far } = endsOf(link, id), ownPort = findPort(model, own)!, farPort = findPort(model, far)!;
    if (farPort.side !== face) refuse(plan, `link ${link.id} ends on the ${farPort.side ?? 'unset'} face of ${far.node}, not on the face over ${id}`);
    if (hubs.has(far.node)) { proveChord(model, plan, link, id); continue; }
    // A bar seats its ports over the drops in 7d, so its face ports are not yet where they will stand: the drop treats them as its own.
    const bar = groupShape(model, model.document.nodes[far.node]!.group) === 'bar';
    const ports = [portId(own), portId(far), ...(bar ? model.nodes[far.node]!.ports.filter(port => port.side === face).map(port => portId(port.ref)) : [])];
    const refusal: { reason?: 'body' | 'pill' | 'lane' | 'frame' | 'corridor' } = {};
    const drop = { from: { x: ownPort.anchor!.x, y: farPort.anchor!.y }, to: { ...ownPort.anchor! }, owner: { kind: 'link' as const, id: link.id } };
    if (!straightCorridorClear(model, link, drop, { refusal, attached: { nodes: [own.node, far.node], ports } })) {
      refuse(plan, `the drop of link ${link.id} to ${id} meets a foreign ${refusal.reason ?? 'shape'}`);
    }
    // A transit: 7a stands the lane of a link beside the occupied box of every group of a tier it crosses, so the drop must clear each by half a lane.
    const farTier = nodeTier(model, far.node), half = laneWidth(model, link) / 2, x = ownPort.anchor!.x;
    const crossed = Object.values(model.groups).filter(group => group.bounds && group.nodes.length && (group.tier! - farTier) * (group.tier! - tier) < 0)
      .filter(group => { const box = occupied(model, group, link); return x > box.x - half + PLACEMENT_EPS && x < box.x + box.width + half - PLACEMENT_EPS; })
      .map(group => group.id).sort(compareId);
    if (crossed.length) refuse(plan, `link ${link.id} crosses the box of ${crossed[0]} between ${far.node} and ${id}, where its lane must stand beside the box`);
    if (!bar && Math.abs(farPort.anchor!.x - ownPort.anchor!.x) > PLACEMENT_EPS) refuse(plan, `the port of ${far.node} does not stand over ${id}`);
  }
  if (anchor === undefined || (plan.side === 'top' ? anchor < tier : anchor > tier)) {
    refuse(plan, `the centre rule (7c) aligns the row under its parents: the anchor tier ${anchor ?? 'none'} lies on the parents' side`);
  }
}

/**
 * The stage-5 proof of a chord to a compact hub (dense-16x9 ticket 03, slice C): the hub stands on the sub-tier next to the row's, so the chord
 * crosses no band; the chord, port face to port face, meets no foreign body, pill, title or group box at the clearances of a straight corridor;
 * and a far-line member's stem, the vertical from its port to the far edge of the near line, is clear too, so a chord the freeze refuses
 * keeps its reserved stem in the corridor (owner ruling 15). The port need not stand over the member.
 */
function proveChord(model: LayoutModel, plan: StaggerRow, link: LayoutLink, id: string): void {
  const { own, far } = endsOf(link, id), tier = model.groups[plan.group]!.tier!, hubTier = nodeTier(model, far.node);
  if (hubTier === undefined || Math.abs(hubTier - tier) !== 1) refuse(plan, `its compact hub ${far.node} stands off the sub-tier next to the row`);
  // The chord from face to face, as the freeze reads it (`chordVerdict`): its shapes are judged by the corridor test, which names them.
  const chord = straightChord(model, link, undefined, true), refusal: { reason?: 'body' | 'pill' | 'lane' | 'frame' | 'corridor' } = {};
  if (chord === undefined) refuse(plan, `the chord of link ${link.id} from ${id} to ${far.node} has no face to leave`);
  if (!straightCorridorClear(model, link, { ...chord, owner: { kind: 'link', id: link.id } }, { refusal })) {
    refuse(plan, `the chord of link ${link.id} from ${id} to ${far.node} meets a foreign ${refusal.reason ?? 'shape'}`);
  }
  if (lineOf(plan, id) !== 'far') return;
  const port = findPort(model, own)!.anchor!, near = plan.order.filter(item => lineOf(plan, item) === 'near').map(item => model.nodes[item]!.bounds!);
  const edge = plan.side === 'bottom' ? Math.max(...near.map(box => box.y + box.height)) : Math.min(...near.map(box => box.y));
  const stem = { from: { ...port }, to: { x: port.x, y: edge }, owner: { kind: 'link' as const, id: link.id } };
  if (!straightCorridorClear(model, link, stem, { refusal })) refuse(plan, `the stem of link ${link.id} from ${id} meets a foreign ${refusal.reason ?? 'shape'} in its corridor`);
}

/** A refusal of a stagger reservation, from the seat, its proof or its validator: the first run declines the row, and a fan re-run is cut. */
export function staggerRefusal(error: unknown): error is PlacementRefusal {
  return error instanceof PlacementRefusal && error.code === 'stagger';
}

/** Publication and restore keep the two lines, pitch, feed order and passing corridors. Diagnostics grant no exception. */
export function validateStaggerRows(model: LayoutModel): void {
  validateArrangements(model);
  validateColumns(model);
  const seen = new Set<string>(), claimed = new Set<string>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    const members = new Set(plan.order);
    if (seen.has(plan.group) || group === undefined || exitSide(model, group) !== plan.side
      || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order) || !Array.isArray(plan.pitches) || plan.pitches.length !== plan.order.length - 1
      || !plan.pitches.every(pitch => pitch > 0 && Number.isFinite(pitch)) || !(plan.step > 0)
      || !Array.isArray(plan.far) || plan.far.length === 0 || plan.far.length >= plan.order.length
      || new Set(plan.far).size !== plan.far.length || plan.far.some(id => !members.has(id))
      // A rank cell carries its decided feeding chain (fan wrap, D-Q4), a plain row none (`StaggerRow.chain`).
      || (group.frame !== undefined) !== Array.isArray(plan.chain)
      // The compact hubs are decided (`[]` = none): sorted, distinct node ids, and a row with them is the row of a member with several links.
      || !Array.isArray(plan.chordHubs) || plan.chordHubs.some((id, i) => model.nodes[id] === undefined || (i > 0 && compareId(plan.chordHubs![i - 1]!, id) >= 0))
      || JSON.stringify(plan.chordHubs) !== JSON.stringify(decideChordHubs(model, plan))) throw new PlacementRefusal('stagger', 'Invalid stagger reservation');
    // A member with several links stands on the near line (dense-16x9 ticket 03, slice C).
    const several = plan.far.find(id => memberLinks(model, id).length > 1);
    if (several !== undefined) throw new PlacementRefusal('stagger', `Stagger row ${plan.group}: member ${several} has several links and stands on the far line`, { owners: [{ kind: 'group', id: plan.group }] });
    seen.add(plan.group);
    if (plan.chain?.length) validateChain(model, plan, claimed);
    for (const id of plan.chain ?? []) claimed.add(id);
    const first = model.nodes[plan.order[0]!]!.bounds!;
    const nearY = model.nodes[plan.order.find(id => lineOf(plan, id) === 'near')!]!.bounds!.y;
    const nearMembers = plan.order.filter(id => lineOf(plan, id) === 'near');
    let offset = 0;
    for (const [i, id] of plan.order.entries()) {
      const box = model.nodes[id]!.bounds!;
      const line = lineOf(plan, id);
      const dy = (line === 'far' ? 1 : 0) * plan.step * (plan.side === 'top' ? 1 : -1);
      if (i > 0) offset += plan.pitches[i - 1]!;
      if (Math.abs(box.y - nearY - dy) > PLACEMENT_EPS
        || Math.abs(box.x + box.width / 2 - first.x - first.width / 2 - offset) > PLACEMENT_EPS) throw new PlacementRefusal('stagger', 'Stagger placement lost its reserved pitch or lines', { owners: [{ kind: 'group', id: plan.group }] });
      if (line === 'near') continue;
      for (const port of model.nodes[id]!.ports.filter(port => port.side === plan.side && !port.unused)) {
        const x = port.anchor!.x;
        for (const near of nearMembers) {
          const obstacle = obstacleX(model, near);
          if (x > obstacle.low + PLACEMENT_EPS && x < obstacle.high - PLACEMENT_EPS) throw new PlacementRefusal('stagger', 'Stagger vertical corridor enters a neighbouring obstacle', { owners: [{ kind: 'group', id: plan.group }] });
        }
      }
      // The chord of a far-line member to its compact hub passes the near line through its corridor: it clears every near-line obstacle.
      for (const link of memberLinks(model, id).filter(item => plan.chordHubs!.includes(endsOf(item, id).far.node))) {
        const { own, far } = endsOf(link, id), from = findPort(model, own)!.anchor!, to = findPort(model, far)!.anchor!;
        for (const near of nearMembers) {
          const box = model.nodes[near]!.bounds!, obstacle = obstacleX(model, near);
          const shape = { x: obstacle.low, y: box.y, width: obstacle.high - obstacle.low, height: box.height };
          if (segmentRectDistance({ from, to, owner: { kind: 'link', id: link.id } }, shape) <= PLACEMENT_EPS) {
            throw new PlacementRefusal('stagger', `Stagger chord corridor of link ${link.id} enters ${near}`, { owners: [{ kind: 'group', id: plan.group }] });
          }
        }
      }
    }
  }
}

/** The stage-5 canvas, which `stackBands` sets from the band extents; undefined when it is not set or has no area (the aspect rule then refuses, R6). */
function aspectOf(model: LayoutModel): { width: number; height: number } | undefined {
  const canvas = model.canvas;
  return canvas !== undefined && canvas.width > 0 && canvas.height > 0 ? { width: canvas.width, height: canvas.height } : undefined;
}
const size = (box: { width: number; height: number } | undefined): string => box === undefined ? 'unmeasured' : `${box.width.toFixed(2)} x ${box.height.toFixed(2)} px`;

/**
 * Whether the stage-5 wrap gate owns the arrangement of `group` (dense-16x9 ticket 36, ruling A): a row the arrangement may try as a stagger,
 * that is a candidate (`exitSide`) that `rowReason` passes (every hub feeds three or more members), with `layout.autoArrange` on. One owner
 * per row arrangement: the seat set of the rows rule does not change a premise this gate decided on, so such a row is no seat-set row.
 */
export function wrapGateOwns(model: LayoutModel, group: LayoutGroup): boolean {
  if (model.document.layout?.autoArrange === false) return false;
  return exitSide(model, group) !== undefined && rowReason(model, group, true) === undefined;
}

/** The first rule that keeps `group` one row before any draft (ticket 51), or undefined when stage 5 may try it. */
function rowReason(model: LayoutModel, group: LayoutGroup, candidate: boolean): string | undefined {
  const source = model.document.groups[group.id];
  if (source?.shapeAuthored) return 'the author set the shape';
  if (group.flank) return 'a flank group';
  if (groupShape(model, group.id) !== 'row') return `a ${groupShape(model, group.id)} group`;
  if (group.nodes.length < 3) return 'fewer than three members';
  if (!candidate) return 'its members do not all link out of the row through one horizontal face';
  // A member may have several links (dense-16x9 ticket 03, slice C), each a plain routed link: no group link, no stub or overlay, no bundle member,
  // no flank at the far end.
  for (const id of group.nodes) {
    const all = model.links.filter(link => link.attachments === undefined
      ? [link.from, link.to].some(end => 'group' in end && end.group === group.id)
      : link.attachments.from.node === id || link.attachments.to.node === id);
    const links = memberLinks(model, id);
    if (!links.length || all.length !== links.length) return `member ${id} has ${all.length} links, ${links.length} of them plain routed`;
    if (links.some(link => link.bundle !== undefined)) return `${links.length === 1 ? 'the link' : 'a link'} of member ${id} is a bundle member`;
    if (links.some(link => model.groups[model.document.nodes[endsOf(link, id).far.node]!.group]!.flank)) return `member ${id} links to a flank`;
  }
  if (!decideFar(model, group.rowOrder ?? group.nodes).length) return 'every member has several links: no member stands on the far line';
  // A fan (D-Q4): every hub of the row feeds three or more of its members; in a row of one-link members the hub runs stand side by side
  // (`parentGaps` refuses interleaved runs); compact hubs need no such run.
  const runs = new Map<string, number>();
  for (const id of group.nodes) for (const hub of parentsOf(model, id)) runs.set(hub, (runs.get(hub) ?? 0) + 1);
  const small = [...runs].filter(([, count]) => count < 3).sort(([a], [b]) => compareId(a, b))[0];
  if (small !== undefined) return `hub ${small[0]} feeds ${small[1]} of its members, not three or more`;
  return undefined;
}

/**
 * The two triggers of a stage-5 stagger (decision review 2026-11, D-Q4; ADR-0024, second amendment), in one place. Returns the reason the
 * trigger refuses, or undefined when the row may be tried on a draft.
 * - A rank cell (a fan wrap): the block trigger. Its one line must be wider than the widest other group of its tier block (the unit
 *   `columnTiers` reads: a top-level frame with its child frames), read on `model`, the one-line stage-5 model, so no seated hub is read.
 * - A plain row (no other block content): the aspect trigger (user decision 2026-11-02; ADR-0025). The sheet is wider than the aspect aim,
 *   read on `base`, the stage-5 canvas that `stackBands` sets with the rows accepted so far. No "one widest band" test and no stage-5
 *   area test: the acceptance gate (`wrapGateVerdict`) judges each row on the complete placement (dense-16x9 ticket 22).
 */
function triggerReason(model: LayoutModel, base: LayoutModel, id: string): string | undefined {
  const group = model.groups[id]!;
  if (group.frame !== undefined) {
    const others = (unitOf(model, id)?.groups ?? []).filter(other => other.id !== id && other.bounds !== undefined && other.nodes.length);
    if (!others.length) return 'block: its block holds no other group';
    const width = group.bounds!.width, widest = Math.max(...others.map(item => item.bounds!.width));
    return width > widest + PLACEMENT_EPS ? undefined : `block: one line (${width.toFixed(2)} px) is no wider than the rest of its block (${widest.toFixed(2)} px)`;
  }
  const before = aspectOf(base), aim = aspectAim(base.document);
  return before !== undefined && before.width > before.height * aim + PLACEMENT_EPS ? undefined
    : `aspect: the sheet is ${size(before)}, not wider than the aim ${aim.toFixed(3)}`;
}

/**
 * Stage 5 of the first placement run, before the seat (ticket 51): pick each group's arrangement when no budget gave the rows. A candidate
 * row (`rowReason`: a row of three or more members, each with only plain routed links out through one horizontal face, one member at least
 * for the far line, every hub feeding three or more of them) is tried widest first on a draft. It staggers only when its trigger holds (`triggerReason`: the block trigger for a rank
 * cell, the aspect trigger for a plain row) and the seated draft passes `prove` (the stage-5 refusals and the topology-freeze validation). The
 * stage-5 canvas does not judge the gain (dense-16x9 ticket 22): later stages move the tier that sets its width (7c stands a tier under its
 * feeds), and a second line can stand in a gap the band already has, so the acceptance gate judges each row on the complete placement
 * (`wrapGateVerdict`, in `initial.ts`). A draft that a stage-5 stagger refusal
 * refuses is dropped, the row stays, and the record names the reason; any other error of the draft ends the run (a freeze validation that the
 * stage-5 proof did not foresee is a defect, not a reason). Each candidate is tried once (a finite traversal). A `declined` group stays a row:
 * a later stage of an earlier attempt of the first run, or the acceptance gate (`wrapGateVerdict`), could not keep its stagger. When every group
 * keeps its row by a rule before any draft there is nothing to choose and no record: an absent record and an all-`row` record both mean
 * "every group stays one row"; the record exists only when stage 5 tried a group. `columns` are the columns stage 5 seated earlier (ticket
 * 52): each is recorded `column`, and a group the column rule refused by name keeps that reason (the two filters are disjoint).
 */
export function arrangeGroups(model: LayoutModel, declined: ReadonlyMap<string, string>, prove: (draft: LayoutModel) => void,
  columns: { plans: readonly ColumnPlan[]; reasons: ReadonlyMap<string, string> } = { plans: [], reasons: new Map() }): void {
  if (model.document.layout?.autoArrange === false || model.groupArrangements !== undefined) return;
  const ids = Object.keys(model.groups).sort(compareId), column = new Set(columns.plans.map(plan => plan.group));
  if (model.staggerRows !== undefined) {
    // The width-budget search gave the rows: stage 5 chooses no stagger, but it seated its columns, or declined one, and the record says so (R1).
    if (!column.size && declined.size === 0) return;
    const given = new Set(model.staggerRows.map(row => row.group)), record: Record<string, GroupArrangement> = {};
    for (const id of ids) record[id] = column.has(id) ? { chosen: 'column' } : given.has(id) ? { chosen: 'stagger' }
      : { chosen: 'row', reason: columns.reasons.get(id) ?? 'the width-budget search gave the rows' };
    model.groupArrangements = record;
    return;
  }
  const candidates = staggerCandidates(model);
  const reasons = new Map<string, string>();
  for (const id of ids) {
    // The two filters are disjoint (ticket 52): a column group, and a group the column rule refused by name (a flank, or a tier group
    // with a lateral link), never pass `rowReason`, so the column reason is the one recorded for them.
    if (column.has(id)) continue;
    const reason = columns.reasons.get(id) ?? rowReason(model, model.groups[id]!, candidates.some(row => row.group === id))
      ?? (declined.has(id) ? `a later stage of the first run refused the two lines: ${declined.get(id)!}` : undefined);
    if (reason !== undefined) reasons.set(id, reason);
  }
  // No group the rule may try (every group keeps its row by a rule of `rowReason`): nothing to choose, no record. A declined group was tried.
  if (declined.size === 0 && ids.every(id => reasons.has(id))) return;
  const accepted: StaggerRow[] = [];
  let base = model;
  for (const row of candidates) {
    if (reasons.has(row.group)) continue;
    const trigger = triggerReason(model, base, row.group);
    if (trigger !== undefined) {
      reasons.set(row.group, trigger);
      continue;
    }
    const draft = JSON.parse(JSON.stringify(model)) as LayoutModel;
    draft.staggerRows = JSON.parse(JSON.stringify([...accepted, row])) as StaggerRow[];
    try { seatStaggerRows(draft); prove(draft); } catch (error) {
      // A stage-5 stagger refusal (`staggerRefusal`) is the decision "row"; the record keeps its text (R6). Anything else, the freeze's
      // validation included, is a defect that the stage-5 proof missed or a bug, and ends the run: it is never recorded as a reason.
      if (!staggerRefusal(error)) throw error;
      reasons.set(row.group, `stage 5 refused the two lines: ${error.message}`);
      continue;
    }
    const proved = draft.staggerRows!.find(item => item.group === row.group)!;
    // The proved draft decided the lines and the compact hubs (`[]` included); the retained row carries both, so no later seat decides them again (R1).
    accepted.push({ ...row, far: [...proved.far], chordHubs: [...proved.chordHubs!] }); base = draft;
  }
  const arrangements: Record<string, GroupArrangement> = {};
  for (const id of ids) arrangements[id] = column.has(id) ? { chosen: 'column' } : accepted.some(row => row.group === id) ? { chosen: 'stagger' } : { chosen: 'row', reason: reasons.get(id)! };
  model.groupArrangements = arrangements;
  if (accepted.length) model.staggerRows = accepted;
}

/** The record agrees with the rows and the document (R1, R5): one entry per group, `stagger` exactly for a reserved row, absent under `autoArrange: false`. */
function validateArrangements(model: LayoutModel): void {
  const record = model.groupArrangements;
  if (record === undefined) return;
  if (model.document.layout?.autoArrange === false) throw new PlacementRefusal('stagger', 'Group arrangements are recorded although layout.autoArrange is false');
  const staggered = new Set((model.staggerRows ?? []).map(row => row.group));
  const ids = Object.keys(model.groups).sort(compareId);
  if (JSON.stringify(Object.keys(record).sort(compareId)) !== JSON.stringify(ids)) throw new PlacementRefusal('stagger', 'Group arrangements do not name each group once');
  for (const id of ids) {
    const entry = record[id]!;
    if ((entry.chosen === 'stagger') !== staggered.has(id)
      || (entry.chosen === 'row' ? !(typeof entry.reason === 'string' && entry.reason.length > 0) : entry.chosen !== 'stagger' && entry.chosen !== 'column')) {
      throw new PlacementRefusal('stagger', `The arrangement of ${id} contradicts its stagger reservation`);
    }
  }
}


/**
 * The block of a wrapped rank cell among the document tiers (`documentTiers`): the unit that holds the row (a top-level frame with its child
 * frames), its tier index, and the step toward the row's feeds (-1 when the feeds stand above the row, `plan.side` 'top').
 */
function blockOf(model: LayoutModel, plan: StaggerRow): { tiers: Unit[][]; index: number; block: Unit; step: number } {
  const tiers = documentTiers(model);
  const index = tiers.findIndex(tier => tier.some(unit => unit.groups.some(group => group.id === plan.group)));
  const block = tiers[index]!.find(unit => unit.groups.some(group => group.id === plan.group))!;
  return { tiers, index, block, step: plan.side === 'top' ? -1 : 1 };
}

/**
 * The feeds of a row's stored chain into its block (fan wrap, D-Q4): each routed link between a node of a chain unit on the document tier next
 * to the block and a node of the block, the chain port on the face toward the block and the block port on the row's feed face, with both x.
 * The one reader of where the chain stands: the stage-5 move (`standChain`) and the publication check (`validateChain`) call it (R1).
 */
function chainFeeds(model: LayoutModel, plan: StaggerRow): ChainFeed[] {
  if (!plan.chain?.length) return [];
  const { tiers, index, block, step } = blockOf(model, plan), chain = new Set(plan.chain);
  const near = new Map((tiers[index + step] ?? []).filter(unit => chain.has(unit.id)).flatMap(unit => unit.groups.map(group => [group.id, unit.id] as const)));
  const inBlock = new Set(block.groups.map(group => group.id)), groupOf = (ref: PortRef): string => model.document.nodes[ref.node]!.group;
  const feeds: ChainFeed[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [own, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      const unit = near.get(groupOf(own));
      if (unit === undefined || !inBlock.has(groupOf(other))) continue;
      const a = findPort(model, own), b = findPort(model, other);
      if (a?.anchor && b?.anchor && a.side === opposite(plan.side) && b.side === plan.side) feeds.push({ unit, link: link.id, from: a.anchor.x, to: b.anchor.x });
    }
  }
  return feeds;
}
/** One feed of a chain into its block: the near chain unit, the link, the x of the chain port and of the block port. */
interface ChainFeed { unit: string; link: string; from: number; to: number }
/**
 * The offset of each near unit of a chain, sorted by unit id: the mean of (block port x - chain port x) over the unit's own feeds. A chain
 * stands over its block when every offset is zero; one move stands it there only when all offsets are equal.
 */
function unitOffsets(feeds: readonly ChainFeed[]): [string, number][] {
  const units = [...new Set(feeds.map(feed => feed.unit))].sort(compareId);
  return units.map(unit => {
    const own = feeds.filter(feed => feed.unit === unit);
    return [unit, own.reduce((sum, feed) => sum + feed.to - feed.from, 0) / own.length];
  });
}

/**
 * Decides the feeding chain of a wrapped rank cell once (fan wrap, D-Q4; `StaggerRow.chain`). From the block, tier by tier toward the row's
 * feeds, a unit joins when one of its nodes has a routed link into the units that joined on the tier before (the block first). A node that
 * also links to another unit of that tier before is a shared parent: a move over one would leave the other, so its unit stays out, and the
 * chain ends at a tier where no unit joins. A unit of an earlier row's chain (`claimed`) or a unit that holds a stagger row stays out too.
 * A chain whose near tier has no feed on the faces `chainFeeds` reads has nothing to stand over and is no chain. Unit ids sorted.
 */
function decideChain(model: LayoutModel, plan: StaggerRow, claimed: ReadonlySet<string>): string[] {
  const { tiers, index, block, step } = blockOf(model, plan);
  const unitOfGroup = new Map<string, Unit>(tiers.flat().flatMap(unit => unit.groups.map(group => [group.id, unit] as const)));
  // Each routed link as its two ends: the node and the unit that holds it (none for a flank node).
  const ends = model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
    .map(link => [link.attachments!.from.node, link.attachments!.to.node].map(node => ({ node, unit: unitOfGroup.get(model.document.nodes[node]!.group) })));
  const rows = new Set((model.staggerRows ?? []).map(row => row.group));
  const chain: Unit[] = [];
  let front = new Set<Unit>([block]), before = new Set<Unit>(tiers[index]!);
  for (let at = index + step; at >= 0 && at < tiers.length; at += step) {
    const next = tiers[at]!.filter(unit => {
      if (claimed.has(unit.id) || unit.groups.some(group => rows.has(group.id))) return false;
      const feeders = new Set(ends.flatMap(pair => pair.flatMap((end, i) => end.unit === unit && pair[1 - i]!.unit !== undefined && front.has(pair[1 - i]!.unit!) ? [end.node] : [])));
      return feeders.size > 0
        && !ends.some(pair => pair.some((end, i) => feeders.has(end.node) && pair[1 - i]!.unit !== undefined && before.has(pair[1 - i]!.unit!) && !front.has(pair[1 - i]!.unit!)));
    });
    if (!next.length) break;
    chain.push(...next); front = new Set(next); before = new Set(tiers[at]!);
  }
  const ids = chain.map(unit => unit.id).sort(compareId);
  return ids.length && chainFeeds(model, { ...plan, chain: ids }).length ? ids : [];
}

/**
 * Moves the stored chain of a wrapped rank cell as one block in x (fan wrap, D-Q4), after the re-pack of its tier: its feeds into the block
 * stand over the block's ports (`unitOffsets`: every near unit needs the same move). Whole units move (every cell of a chain frame, a flank with its group), so every
 * reservation inside a unit holds. The move must keep a beside gap (`besideGap`) from every group box and frame beside the chain on its own
 * rows; a chain with no room for the whole move, or with no feed left, refuses the row by name (a stagger refusal: the first run keeps the row
 * one line, a later run is cut). Each run measures the move on its own stage-5 geometry; the units are the stored decision.
 */
function standChain(model: LayoutModel, plan: StaggerRow): void {
  if (!plan.chain?.length) return;
  const feeds = chainFeeds(model, plan);
  if (!feeds.length) refuse(plan, `its feeding chain (${plan.chain.join(', ')}) has no feed into its block`);
  // One move for the whole chain: every near unit must need the same move, so each stands over its own feeds afterwards (D-Q4 review: the
  // mean of two units that need different moves stands neither over its block).
  const offsets = unitOffsets(feeds), dx = offsets[0]![1];
  const other = offsets.find(([, offset]) => Math.abs(offset - dx) > PLACEMENT_EPS);
  if (other !== undefined) {
    refuse(plan, `its feeding chain (${plan.chain.join(', ')}) cannot stand over its block with one move: ${offsets[0]![0]} needs ${dx.toFixed(2)} px, ${other[0]} ${other[1].toFixed(2)} px`);
  }
  const chain = new Set(plan.chain);
  const moving = Object.values(model.groups).filter(group => chain.has(columnUnitId(model, group.id))).sort((a, b) => compareId(a.id, b.id));
  const movingIds = new Set(moving.map(group => group.id)), frames = deriveFrames(model) ?? [];
  // A lifted unit (D-Q5, `groupLifts`) does not stop the chain: `seatLifts` seats it again beside the moved chain after this move.
  const lifted = new Set([...liftedGroups(model).keys()].map(id => columnUnitId(model, id)));
  // The boxes that stand beside each other: the moving groups and the chain's frames against every unframed group and top-level frame that stays.
  const boxes = (inChain: boolean): { box: { x: number; y: number; width: number; height: number }; frame: boolean }[] => [
    ...Object.values(model.groups).filter(group => group.bounds && group.nodes.length && movingIds.has(group.id) === inChain
      && (inChain || (group.frame === undefined && !lifted.has(columnUnitId(model, group.id)))))
      .map(group => ({ box: group.bounds!, frame: false })),
    ...frames.filter(frame => frame.parent === undefined && chain.has(frame.id) === inChain && (inChain || !lifted.has(frame.id))).map(frame => ({ box: frame.box, frame: true }))];
  let low = -Infinity, high = Infinity;
  const others = boxes(false);
  for (const own of boxes(true)) for (const other of others) {
    if (other.box.y >= own.box.y + own.box.height || own.box.y >= other.box.y + other.box.height) continue;
    const gap = besideGap(model, own.frame, other.frame);
    if (other.box.x + other.box.width <= own.box.x + PLACEMENT_EPS) low = Math.max(low, other.box.x + other.box.width + gap - own.box.x);
    else if (other.box.x >= own.box.x + own.box.width - PLACEMENT_EPS) high = Math.min(high, other.box.x - gap - own.box.x - own.box.width);
  }
  if (dx < low - PLACEMENT_EPS || dx > high + PLACEMENT_EPS) {
    refuse(plan, `its feeding chain (${plan.chain.join(', ')}) has no room to stand over its block: it must move ${dx.toFixed(2)} px, the boxes beside it allow ${low.toFixed(2)} to ${high.toFixed(2)} px`);
  }
  if (Math.abs(dx) > PLACEMENT_EPS) for (const group of moving) moveGroup(model, group, dx, 0);
}

/**
 * The publication check of a stored chain (fan wrap, D-Q4): its units are sorted, distinct, held by no other row's chain, and stand on the
 * document tiers on the feed side of the block; and the chain still stands over its block (`chainFeeds`, `unitOffsets`, each near unit on its own): no later stage moved
 * it off. Geometry and the record only; no diagnostic excuses it (R5).
 */
function validateChain(model: LayoutModel, plan: StaggerRow, claimed: ReadonlySet<string>): void {
  const chain = plan.chain!, owners = [{ kind: 'group' as const, id: plan.group }];
  const { tiers, index, step } = blockOf(model, plan);
  const beyond = new Set(tiers.filter((_, at) => (at - index) * step > 0).flat().map(unit => unit.id));
  if (chain.some((id, i) => (i > 0 && compareId(chain[i - 1]!, id) >= 0) || claimed.has(id) || !beyond.has(id))) {
    throw new PlacementRefusal('stagger', `Stagger row ${plan.group}: invalid feeding chain`, { owners });
  }
  // Each near unit on its own: a mean would pass two units moved by equal and opposite amounts.
  const feeds = chainFeeds(model, plan), off = unitOffsets(feeds).find(([, offset]) => Math.abs(offset) > PLACEMENT_EPS);
  if (!feeds.length || off !== undefined) {
    throw new PlacementRefusal('stagger', `Stagger row ${plan.group}: the feeding chain (${chain.join(', ')}) no longer stands over its block (${off === undefined ? 'no feed' : `${off[0]} ${off[1].toFixed(2)} px off`})`, { owners });
  }
}

/** The extent of every node, group box and frame box of a placed model, width x height (the acceptance gate's canvas). */
export function placedExtent(model: LayoutModel): { width: number; height: number } {
  const boxes = [...Object.values(model.nodes).flatMap(node => node.bounds ? [node.bounds] : []),
    ...Object.values(model.groups).flatMap(group => group.bounds && group.nodes.length ? [group.bounds] : []), ...(deriveFrames(model) ?? []).map(frame => frame.box)];
  if (!boxes.length) return { width: 0, height: 0 };
  return { width: Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x)),
    height: Math.max(...boxes.map(box => box.y + box.height)) - Math.min(...boxes.map(box => box.y)) };
}

/**
 * The links a placed model draws as one straight segment: both ends on facing faces, on one x (top and bottom) or one y (left and right),
 * a held routed chord (`isRoutedChord`), and an overlay link the overlay rule draws as one segment (`straightOverlaysAsDrawn`).
 */
function placedStraight(model: LayoutModel): Set<string> {
  const straight = new Set<string>([...straightOverlaysAsDrawn(model).map(item => item.id), ...model.links.filter(link => isRoutedChord(model, link)).map(link => link.id)]);
  for (const link of model.links) {
    if (!link.attachments || link.technique === 'stub') continue;
    const a = findPort(model, link.attachments.from), b = findPort(model, link.attachments.to);
    if (!a?.anchor || !b?.anchor || a.side === undefined || b.side === undefined) continue;
    const vertical = (a.side === 'top' && b.side === 'bottom') || (a.side === 'bottom' && b.side === 'top');
    const lateral = (a.side === 'left' && b.side === 'right') || (a.side === 'right' && b.side === 'left');
    if ((vertical && Math.abs(a.anchor.x - b.anchor.x) <= PLACEMENT_EPS) || (lateral && Math.abs(a.anchor.y - b.anchor.y) <= PLACEMENT_EPS)) straight.add(link.id);
  }
  return straight;
}

/** The diagnostic code of a stage-5 stagger that the acceptance gate declines (fan wrap, D-Q4; ADR-0024, second amendment). */
export const FAN_WRAP_DECLINED = 'FAN_WRAP_DECLINED';

/**
 * Which trigger admitted a stagger row (`triggerReason`), read from its record (R1): a rank cell (a fan wrap, the block trigger) carries its
 * decided feeding chain, a plain row (the aspect trigger) none (`StaggerRow.chain`, checked by `validateStaggerRows`).
 */
export const staggerTrigger = (row: StaggerRow): 'block' | 'aspect' => Array.isArray(row.chain) ? 'block' : 'aspect';

/**
 * The acceptance gate of a stagger stage 5 chose (fan wrap, D-Q4; dense-16x9 ticket 22): the complete placement with the row's two lines
 * (`wrapped`, after 7f, before routing) against the placement without it (`plain`, the rows kept so far), both read by `placedExtent`. The
 * size test follows the row's trigger (`staggerTrigger`), as stage 5 does:
 * - `block` (a rank cell, the fan wrap of D-Q4: its block is too wide for its hub): less area, strictly;
 * - `aspect` (a plain row: the sheet is wider than the aim): nearer the aspect aim (ADR-0025, `aspectGap` smaller by more than
 *   `ASPECT_EPS`), or, at an equal gap, less area.
 * Then, for both, every link `plain` holds straight at its 7f trial stays straight at the wrapped trial (`wrapGateDecline`), no hard separation is shorter than in `plain`, and the planned bends of
 * all links (`plannedBends`, the placement's lower bound, CONTEXT.md) add up to no more than in `plain` (the gate trades no turn it can see;
 * dense-16x9 ticket 22 review). Returns the reason to decline, or undefined to keep.
 */
export function wrapGateVerdict(wrapped: LayoutModel, plain: LayoutModel, trigger: 'block' | 'aspect'): string | undefined {
  return wrapGateDecline(wrapped, plain, trigger)?.text;
}

/** One decline of the acceptance gate: the clause that declines (`StaggerDeclineClause`), the links it names, and the sentence that says why. */
export interface GateDecline { readonly clause: StaggerDeclineClause; readonly links?: readonly string[]; readonly text: string }

/**
 * The acceptance gate's judgement of one row (`wrapGateVerdict`), with the clause that declines it (dense-16x9 ticket 35): the ledger records the
 * clause and the links it names (`staggerDeclined`). The straight-link clause reads the links held straight at the 7f trial of the placement
 * (`placedStraight`: held chords, aligned ends, straight overlays), the reading the gate can afford before the rounds and routing: it is named so,
 * and is no reading of the published sheet (ticket 35 ruling of 2026-11-17).
 */
export function wrapGateDecline(wrapped: LayoutModel, plain: LayoutModel, trigger: 'block' | 'aspect'): GateDecline | undefined {
  const w = placedExtent(wrapped), p = placedExtent(plain), aim = aspectAim(plain.document), less = w.width * w.height < p.width * p.height - PLACEMENT_EPS;
  if (trigger === 'block' && !less) return { clause: 'area', text: `the complete placement is ${size(w)} with two lines, not less area than ${size(p)} without` };
  if (trigger === 'aspect') {
    const gap = aspectGap(w.width, w.height, aim) - aspectGap(p.width, p.height, aim);
    if (gap > ASPECT_EPS) return { clause: 'aspect', text: `the complete placement is ${size(w)} with two lines, farther from the aim ${aim.toFixed(3)} than ${size(p)} without` };
    if (gap >= -ASPECT_EPS && !less) return { clause: 'aspect', text: `the complete placement is ${size(w)} with two lines, as near the aim ${aim.toFixed(3)} as ${size(p)} without and not less area` };
  }
  // A link the plain run stands straight only by a seat that slid its body (ADR-0027) is not lost: the move is a choice of the plain run, which
  // the two lines may decline (ruling of 2026-11-15).
  const links = new Map(plain.links.map(link => [link.id, link]));
  const kept = placedStraight(wrapped), lost = [...placedStraight(plain)].filter(id => !kept.has(id) && !standsBySeatMove(plain, links.get(id)!)).sort(compareId);
  if (lost.length) {
    return { clause: 'held-straight', links: lost,
      text: `the link${lost.length > 1 ? 's' : ''} ${lost.join(', ')} ${lost.length > 1 ? 'are' : 'is'} held straight at the 7f trial of the placement without the two lines and not with them` };
  }
  const short = worseSeparations(separationShortfalls(wrapped), separationShortfalls(plain)).sort(compareId);
  if (short.length) return { clause: 'separation', text: `the two lines leave the separation ${short[0]} short` };
  // Last, so a lost straight link (which also adds planned bends) is named as such.
  const bends = (model: LayoutModel): number => model.links.reduce((sum, link) => sum + (link.removed === true ? 0 : plannedBends(model, link)), 0);
  const [after, before] = [bends(wrapped), bends(plain)];
  if (after > before) return { clause: 'planned-bends', text: `the planned bends rise from ${before} to ${after} with two lines` };
  return undefined;
}
