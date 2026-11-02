/** Two-line row reservations, made before stage 5 freezes port topology: the width-budget search (ticket 166) and stage 5's own choice (ticket 51). */
import type { GroupArrangement, LayoutLink, LayoutModel, LayoutGroup } from '../model/layout.js';
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
import { PLACEMENT_EPS } from './tolerance.js';
import { PlacementRefusal } from './placement-refusal.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rowGap } from './sides-two.js';
import { laneWidth, occupied, selectAnchorTier } from './lanes.js';
import { nodeTier } from './read/tier.js';
import { straightCorridorClear } from './row-paths.js';

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
    return [{ group: group.id, order, side, pitches: [], step: 0 }];
  }).sort((a, b) => model.groups[b.group]!.bounds!.width - model.groups[a.group]!.bounds!.width || compareId(a.group, b.group));
}

/**
 * Reserve the least centre pitch that clears the bodies, their pills and every passing vertical. A gap between the members of two
 * parents is wider (ticket 51): it also holds both parents, each seated over its drops by `seatFeeds`, a row gap apart.
 */
function measure(model: LayoutModel, plan: StaggerRow): void {
  const nodes = plan.order.map(id => model.nodes[id]!);
  let pitch = 0;
  for (const [i, node] of nodes.entries()) {
    const box = node.bounds!, cx = box.x + box.width / 2;
    // Same-line neighbours are two pitches apart. Adjacent bodies live on separate lines.
    if (i >= 2) pitch = Math.max(pitch, (nodes[i - 2]!.bounds!.width / 2 + box.width / 2 + rowGap(model, nodes[i - 2]!.id, node.id)) / 2);
    const obstacle = obstacleX(model, node.id);
    // The ports of an odd member must pass the adjacent even members on the way to their feeds.
    if (i % 2 === 0) {
      for (const [index, next] of [[i - 1, nodes[i - 1]], [i + 1, nodes[i + 1]]] as const) {
        if (next === undefined) continue;
        const nextCx = next.bounds!.x + next.bounds!.width / 2;
        const offsets = next.ports.filter(port => port.side === plan.side && !port.unused).map(port => port.anchor!.x - nextCx);
        const need = index < i ? cx - obstacle.low + Math.max(0, ...offsets) : obstacle.high - cx - Math.min(0, ...offsets);
        pitch = Math.max(pitch, need);
      }
    }
  }
  const topReach = Math.max(0, ...nodes.flatMap(node => node.ports.filter(port => port.pill !== undefined).map(port => node.bounds!.y - port.pill!.bounds.y)));
  const bottomReach = Math.max(0, ...nodes.flatMap(node => node.ports.filter(port => port.pill !== undefined).map(port => port.pill!.bounds.y + port.pill!.bounds.height - node.bounds!.y - node.bounds!.height)));
  plan.pitches = parentGaps(model, plan, pitch);
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
function seatFeeds(model: LayoutModel): SeatedParent[] {
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
  for (const [id, side] of ordered) {
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
      if (targets.get(portId(wanted[i]!.ref))! - targets.get(portId(wanted[i - 1]!.ref))! < node.sidePitch![side]! - PLACEMENT_EPS) {
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
    for (const port of node.ports) if (port.anchor) port.anchor.x += dx + (port.side === 'right' ? width - old.width : 0);
    for (const port of wanted) port.anchor!.x = targets.get(portId(port.ref))!;
    ports.sort((a, b) => a.anchor!.x - b.anchor!.x || a.engineOrder! - b.engineOrder!).forEach((port, index) => { port.engineOrder = index; });
    rebuildNodeGeometry(model, [id], 'current');
    fitRegionGroup(model, group);
  }
  for (const parent of seated) seatedParentFits(model, parent);
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
    if (i > 0 && port.anchor!.x - ports[i - 1]!.anchor!.x < pitch - PLACEMENT_EPS) {
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

/** Stage 5 only: seat both lines, fit containing groups, close the space released in each affected tier. */
export function seatStaggerRows(model: LayoutModel): void {
  const affected = new Set<number>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    if (group === undefined || exitSide(model, group) !== plan.side || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order)) {
      throw new PlacementRefusal('stagger', `Stagger row ${plan.group} no longer has its reserved feed order and exit face`, { stage: 'sides-two', owners: [{ kind: 'group', id: plan.group }] });
    }
    measure(model, plan);
    const nodes = plan.order.map(id => model.nodes[id]!);
    const min = Math.min(...nodes.map(node => node.bounds!.x));
    const y = Math.min(...nodes.map(node => node.bounds!.y));
    let centre = min + nodes[0]!.bounds!.width / 2;
    nodes.forEach((node, i) => {
      if (i > 0) centre += plan.pitches[i - 1]!;
      const x = centre - node.bounds!.width / 2;
      const top = y + ((plan.side === 'top' ? i % 2 : 1 - i % 2) * plan.step);
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
  const seated = seatFeeds(model);
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
  for (const plan of model.staggerRows ?? []) proveDrops(model, plan);
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
  for (const id of plan.order) for (const link of memberLinks(model, id)) {
    const { own, far } = endsOf(link, id), ownPort = findPort(model, own)!, farPort = findPort(model, far)!;
    if (farPort.side !== face) refuse(plan, `link ${link.id} ends on the ${farPort.side ?? 'unset'} face of ${far.node}, not on the face over ${id}`);
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

/** A refusal of a stagger reservation, from the seat, its proof or its validator: the first run declines the row, and a fan re-run is cut. */
export function staggerRefusal(error: unknown): error is PlacementRefusal {
  return error instanceof PlacementRefusal && error.code === 'stagger';
}

/** Publication and restore keep the two lines, pitch, feed order and passing corridors. Diagnostics grant no exception. */
export function validateStaggerRows(model: LayoutModel): void {
  validateArrangements(model);
  const seen = new Set<string>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    if (seen.has(plan.group) || group === undefined || exitSide(model, group) !== plan.side
      || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order) || !Array.isArray(plan.pitches) || plan.pitches.length !== plan.order.length - 1
      || !plan.pitches.every(pitch => pitch > 0 && Number.isFinite(pitch)) || !(plan.step > 0)) throw new PlacementRefusal('stagger', 'Invalid stagger reservation');
    seen.add(plan.group);
    const first = model.nodes[plan.order[0]!]!.bounds!;
    let offset = 0;
    for (const [i, id] of plan.order.entries()) {
      const box = model.nodes[id]!.bounds!;
      const dy = (i % 2) * plan.step * (plan.side === 'top' ? 1 : -1);
      if (i > 0) offset += plan.pitches[i - 1]!;
      if (Math.abs(box.y - first.y - dy) > PLACEMENT_EPS
        || Math.abs(box.x + box.width / 2 - first.x - first.width / 2 - offset) > PLACEMENT_EPS) throw new PlacementRefusal('stagger', 'Stagger placement lost its reserved pitch or lines', { owners: [{ kind: 'group', id: plan.group }] });
      if (i % 2 === 0) continue;
      for (const port of model.nodes[id]!.ports.filter(port => port.side === plan.side && !port.unused)) {
        const x = port.anchor!.x;
        for (const even of plan.order.filter((_, index) => index % 2 === 0)) {
          const obstacle = obstacleX(model, even);
          if (x > obstacle.low + PLACEMENT_EPS && x < obstacle.high - PLACEMENT_EPS) throw new PlacementRefusal('stagger', 'Stagger vertical corridor enters a neighbouring obstacle', { owners: [{ kind: 'group', id: plan.group }] });
        }
      }
    }
  }
}

/** The x extent of every group box and frame: the width the canvas takes from the groups. */
function sheetWidth(model: LayoutModel): number {
  const boxes = [...Object.values(model.groups).flatMap(group => group.bounds && group.nodes.length ? [group.bounds] : []), ...(model.frames ?? []).map(frame => frame.box)];
  return boxes.length ? Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x)) : 0;
}

/** The stage-5 canvas, which `stackBands` sets from the band extents; undefined when it is not set or has no area (the aspect rule then refuses, R6). */
function aspectOf(model: LayoutModel): { width: number; height: number } | undefined {
  const canvas = model.canvas;
  return canvas !== undefined && canvas.width > 0 && canvas.height > 0 ? { width: canvas.width, height: canvas.height } : undefined;
}
const size = (box: { width: number; height: number } | undefined): string => box === undefined ? 'unmeasured' : `${box.width.toFixed(2)} x ${box.height.toFixed(2)} px`;
/** A stagger must bring |ln(W/H)| down by more than this to count as nearer square (a float tolerance, not a design margin). */
const ASPECT_EPS = 1e-9;

/** The first rule that keeps `group` one row before any draft (ticket 51), or undefined when stage 5 may try it. */
function rowReason(model: LayoutModel, group: LayoutGroup, candidate: boolean): string | undefined {
  const source = model.document.groups[group.id];
  if (source?.shapeAuthored) return 'the author set the shape';
  if (group.flank) return 'a flank group';
  if (group.frame !== undefined) return 'a rank cell of a ranked frame';
  if (groupShape(model, group.id) !== 'row') return `a ${groupShape(model, group.id)} group`;
  if (group.nodes.length < 4) return 'fewer than four members';
  if (!candidate) return 'its members do not all link out of the row through one horizontal face';
  for (const id of group.nodes) {
    const all = model.links.filter(link => link.attachments === undefined
      ? [link.from, link.to].some(end => 'group' in end && end.group === group.id)
      : link.attachments.from.node === id || link.attachments.to.node === id);
    const links = memberLinks(model, id);
    if (all.length !== 1 || links.length !== 1) return `member ${id} has ${all.length} links, not one`;
    if (links[0]!.bundle !== undefined) return `the link of member ${id} is a bundle member`;
    if (model.groups[model.document.nodes[endsOf(links[0]!, id).far.node]!.group]!.flank) return `member ${id} links to a flank`;
  }
  return undefined;
}

/**
 * Stage 5 of the first placement run, before the seat (ticket 51): pick each group's arrangement when no budget gave the rows. A candidate
 * row is tried widest first on a draft; it staggers only when its band alone is the widest band, the sheet is wider than tall, the seated
 * draft passes `prove` (the stage-5 refusals and the topology-freeze validation), and the sheet comes out at least one pitch narrower and
 * nearer square (aspect). A draft that a stage-5 stagger refusal refuses is dropped, the row stays, and the record names the reason; any
 * other error of the draft ends the run (a freeze validation that the stage-5 proof did not foresee is a defect, not a reason). Each candidate is tried once (a finite traversal). A `declined` group stays a row: a later
 * stage of an earlier attempt of the first run could not keep its stagger. When every group keeps its row by a rule before any draft there is
 * nothing to choose and no record: an absent record and an all-`row` record both mean "every group stays one row"; the record exists
 * only when stage 5 tried a group.
 */
export function arrangeGroups(model: LayoutModel, declined: ReadonlyMap<string, string>, prove: (draft: LayoutModel) => void): void {
  if (model.document.layout?.autoArrange === false || model.staggerRows !== undefined || model.groupArrangements !== undefined) return;
  const candidates = staggerCandidates(model), ids = Object.keys(model.groups).sort(compareId);
  const reasons = new Map<string, string>();
  for (const id of ids) {
    const reason = rowReason(model, model.groups[id]!, candidates.some(row => row.group === id))
      ?? (declined.has(id) ? `a later stage of the first run refused the two lines: ${declined.get(id)!}` : undefined);
    if (reason !== undefined) reasons.set(id, reason);
  }
  // No group the rule may try (every group keeps its row by a rule of `rowReason`): nothing to choose, no record. A declined group was tried.
  if (declined.size === 0 && ids.every(id => reasons.has(id))) return;
  const accepted: StaggerRow[] = [];
  let base = model, width = sheetWidth(model);
  for (const row of candidates) {
    if (reasons.has(row.group)) continue;
    const band = base.tierBands.find(item => item.tier === base.groups[row.group]!.tier)!;
    if (base.tierBands.some(other => other !== band && other.bounds!.width >= band.bounds!.width - PLACEMENT_EPS)) {
      reasons.set(row.group, 'its band is not the one widest band of the sheet');
      continue;
    }
    // The aspect rule (user decision 2026-11-02): only a sheet wider than tall staggers, and only toward square. Both sizes are the stage-5
    // canvas that `stackBands` sets from the band extents, before the stagger (`base`) and on the seated draft.
    const before = aspectOf(base);
    if (before === undefined || !(before.width > before.height + PLACEMENT_EPS)) {
      reasons.set(row.group, `aspect: the sheet is ${size(before)}, not wider than tall`);
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
    const pitch = Math.min(...draft.staggerRows.find(item => item.group === row.group)!.pitches), next = sheetWidth(draft);
    if (next > width - pitch + PLACEMENT_EPS) {
      reasons.set(row.group, `two lines give ${next.toFixed(2)} px, not one pitch (${pitch.toFixed(2)} px) less than ${width.toFixed(2)} px`);
      continue;
    }
    const after = aspectOf(draft);
    if (after === undefined || !(Math.abs(Math.log(after.width / after.height)) < Math.abs(Math.log(before!.width / before!.height)) - ASPECT_EPS)) {
      reasons.set(row.group, `aspect: two lines give ${size(after)}, not nearer square than ${size(before)}`);
      continue;
    }
    accepted.push(row); base = draft; width = next;
  }
  const arrangements: Record<string, GroupArrangement> = {};
  for (const id of ids) arrangements[id] = accepted.some(row => row.group === id) ? { chosen: 'stagger' } : { chosen: 'row', reason: reasons.get(id)! };
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
    if ((entry.chosen === 'stagger') !== staggered.has(id) || (entry.chosen === 'row' ? !(typeof entry.reason === 'string' && entry.reason.length > 0) : entry.chosen !== 'stagger')) {
      throw new PlacementRefusal('stagger', `The arrangement of ${id} contradicts its stagger reservation`);
    }
  }
}
