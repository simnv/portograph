import { GROUP_EDGE_LINK_CLEARANCE, routedStrokeWidth } from '../theme/geometry.js';
import type { Bundle, LayoutLink, LayoutModel, LayoutPort, Point, Side } from '../model/index.js';
import { repackOverlaps } from './rows.js';
import { applyBundleOrder } from './bundle-order.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { fitRegionGroup, bottom, right } from './regions.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { rowGap } from './sides-two.js';

export const MEMBER_GAP = 16;
export const MIN_STEM = 15;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface Member { link: LayoutLink; a: LayoutPort; b: LayoutPort; reversed: boolean }
export function members(model: LayoutModel, bundle: Bundle): Member[] {
  return bundle.members.map(id => {
    const link = model.links.find(link => link.id === id)!;
    const reversed = link.attachments!.from.node !== bundle.nodes[0];
    return { link, a: findPort(model, link.attachments![reversed ? 'to' : 'from'])!,
      b: findPort(model, link.attachments![reversed ? 'from' : 'to'])!, reversed };
  });
}
export function axis(side: Side): 'x' | 'y' { return side === 'top' || side === 'bottom' ? 'x' : 'y'; }

/** A group box as a closed interval along one depth axis; `toDepth` maps a corner to that axis. */
export type DepthPair = [number, number];
export function groupDepthPairs(model: LayoutModel, groupIds: Iterable<string>, toDepth: (p: Point) => number): DepthPair[] {
  return [...new Set(groupIds)].map(id => {
    const box = model.groups[id]!.bounds!;
    const values = [toDepth({ x: box.x, y: box.y }), toDepth({ x: box.x + box.width, y: box.y + box.height })];
    return [Math.min(...values), Math.max(...values)] as DepthPair;
  });
}
/** The stroke-aware edge margin: centreline distance a link of this stroke keeps from a group edge. */
export function edgeMargin(strokeWidth: number): number { return GROUP_EDGE_LINK_CLEARANCE + strokeWidth / 2; }
/**
 * A coordinate on or outside a group box, closer to its edge than the margin, moves `direction`-ward
 * to margin distance from that edge (ADR-0013). Strictly inside a box it is the group's own routing
 * space and stays. Bounded, so a chain of boxes cannot loop.
 */
export function clearOfGroupEdges(value: number, pairs: DepthPair[], direction: 1 | -1, margin: number = GROUP_EDGE_LINK_CLEARANCE): number {
  let result = value;
  for (let guard = 0; guard < 8; guard++) {
    const blocking = pairs.find(([lo, hi]) => !(result > lo + 1e-9 && result < hi - 1e-9)
      && (Math.abs(result - lo) < margin - 1e-9 || Math.abs(result - hi) < margin - 1e-9));
    if (!blocking) return result;
    const edge = Math.abs(result - blocking[0]) <= Math.abs(result - blocking[1]) ? blocking[0] : blocking[1];
    result = edge + direction * margin;
  }
  return result;
}
export function coordinate(port: LayoutPort): number { return port.anchor![axis(port.side!)]; }
export function normal(side: Side): Point {
  return side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 }
    : side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
}
export function outward(port: LayoutPort, length = MIN_STEM): Point {
  const n = normal(port.side!); return { x: port.anchor!.x + n.x * length, y: port.anchor!.y + n.y * length };
}
export function pitch(model: LayoutModel, bundle: Bundle): number {
  return MEMBER_GAP + Math.max(DEFAULT_STROKE_WIDTHS.path, ...members(model, bundle).map(m => linkStrokeWidth(m.link)));
}
export function inversionPairs(list: Member[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < list.length; i++) for (const b of list.slice(i + 1)) {
    const a = list[i]!;
    if ((coordinate(a.a) - coordinate(b.a)) * (coordinate(a.b) - coordinate(b.b)) < -1e-6) pairs.push([a.link.id, b.link.id]);
  }
  return pairs;
}
export function facing(list: Member[]): boolean {
  const a = list[0]!.a.side!, b = list[0]!.b.side!, n = normal(a), m = normal(b);
  return n.x === -m.x && n.y === -m.y && list.every(item => item.a.side === a && item.b.side === b);
}
function sorted(ports: LayoutPort[], preferred: (p: LayoutPort) => number, unrelated = new Set<LayoutPort>()): LayoutPort[] {
  const pending = new Set(ports), result: LayoutPort[] = [];
  while (pending.size) {
    const ready = [...pending].filter(p => (p.authorOrder === undefined || ![...pending].some(q => q.authorOrder !== undefined && q.authorOrder < p.authorOrder!))
      && (!unrelated.has(p) || ![...pending].some(q => unrelated.has(q) && q.engineOrder! < p.engineOrder!)));
    if (!ready.length) throw new Error('Bundle side order contradicts authored or unrelated-port precedence');
    ready.sort((a, b) => preferred(a) - preferred(b) || a.engineOrder! - b.engineOrder! || a.ref.ordinal - b.ref.ordinal);
    const next = ready[0]!; pending.delete(next); result.push(next);
  }
  return result;
}
/** Joint common order for distinct endpoint pairs, constrained by both authored partial orders. */
function orderDistinct(model: LayoutModel, bundle: Bundle): void {
  const list = members(model, bundle);
  if (new Set(list.map(m => portId(m.a.ref))).size !== list.length || new Set(list.map(m => portId(m.b.ref))).size !== list.length) return;
  const pending = new Set(list), order: Member[] = [];
  while (pending.size) {
    const ready = [...pending].filter(m => ![...pending].some(n => (['a', 'b'] as const).some(end =>
      n[end].side === m[end].side && n[end].authorOrder !== undefined && m[end].authorOrder !== undefined && n[end].authorOrder! < m[end].authorOrder!)));
    if (!ready.length) return; // Unequal authored keys force real crossovers.
    ready.sort((a, b) => a.a.engineOrder! - b.a.engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
    pending.delete(ready[0]!); order.push(ready[0]!);
  }
  for (const end of ['a', 'b'] as const) {
    const ports = order.map(m => m[end]);
    if (new Set(ports.map(p => p.side)).size !== 1) continue;
    const node = model.nodes[ports[0]!.ref.node]!, side = ports[0]!.side;
    const existing = node.ports.filter(p => p.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    const slots = existing.filter(p => ports.includes(p)).map(p => p.engineOrder!).sort((a, b) => a - b);
    const proposed = [...existing]; ports.forEach((p, i) => { proposed[slots[i]!] = p; });
    const authored = proposed.filter(p => p.authorOrder !== undefined);
    if (authored.some((p, i) => i && p.authorOrder! < authored[i - 1]!.authorOrder!)) continue;
    const coords = existing.map(coordinate);
    proposed.forEach((p, i) => { p.engineOrder = i; p.anchor![axis(p.side!)] = coords[i]!; });
  }
}

/**
 * The ports stage 7e gives a junction tree, with the links that join it: two or more routed links
 * on one port, none a self-link (ticket 20). In a bundle-less cohort a member whose complete path a
 * rule already fixed (rows, flanks, bars: `path.fixed === true`) keeps that path and stays out of
 * the tree; the remaining routed members form it when two or more are left. Shared with the
 * capacity loop below, so a plain fan reserves its depth exactly when it will get a tree.
 */
export function treeCohorts(model: LayoutModel): { port: LayoutPort; links: LayoutLink[] }[] {
  const incidence = new Map<string, { port: LayoutPort; links: LayoutLink[] }>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments && link.technique !== 'stub') for (const ref of [link.attachments.from, link.attachments.to]) {
    const port = findPort(model, ref)!, key = portId(ref), entry = incidence.get(key) ?? { port, links: [] };
    entry.links.push(link); incidence.set(key, entry);
  }
  return [...incidence.values()]
    .filter(({ links }) => new Set(links.map(link => link.id)).size === links.length)
    .map(({ port, links }) => ({ port, links: links.some(link => link.bundle) ? links : links.filter(link => link.path?.fixed !== true) }))
    .filter(({ links }) => links.length >= 2);
}

/** Geometry-only plan. No path, lane owner, bar reservation or envelope is written here. */
export function prepareBundleGeometry(model: LayoutModel): void {
  // A diagram with no bundle still reserves the depth of its plain fans (ticket 20); one with
  // neither has nothing to plan.
  if (!model.bundles.length && !treeCohorts(model).some(({ port }) => axis(port.side!) === 'x')) return;
  const oldBands = clone(model.tierBands);
  for (const bundle of model.bundles) { orderDistinct(model, bundle); applyBundleOrder(model, bundle); }
  const planned = new Map<string, Map<LayoutPort, number>>();
  const set = (port: LayoutPort, value: number): void => {
    const key = JSON.stringify([port.ref.node, port.side]);
    const plan = planned.get(key) ?? new Map<LayoutPort, number>();
    plan.set(port, value); planned.set(key, plan);
  };
  const done = new Set<string>();
  const block = (bundle: Bundle, lower?: number): void => {
    const list = members(model, bundle);
    if (!facing(list)) return;
    const tangent = axis(list[0]!.a.side!);
    const q = pitch(model, bundle), inverted = inversionPairs(list).length > 0;
    // A shared bar slot can lie midway between peer tracks. Leave a full pitch from its
    // normal to either independent approach, rather than half a pitch at a two-leaf star.
    const freeBarStar = (['a', 'b'] as const).some(end => {
      const far = end === 'a' ? 'b' : 'a';
      return new Set(list.map(m => portId(m[end].ref))).size === 1
        && model.document.groups[model.document.nodes[list[0]![end].ref.node]!.group]!.shape === 'bar'
        && new Set(list.map(m => portId(m[far].ref))).size === list.length;
    }) && !model.lanes.some(lane => lane.owner.kind === 'link' && bundle.members.includes(lane.owner.id))
      && !model.barDrops.some(drop => bundle.members.includes(drop.link) && drop.barCross.length);
    const spacing = Math.max(q * (inverted || freeBarStar ? 2 : 1), ...list.flatMap(m => [model.nodes[m.a.ref.node]!.sidePitch![m.a.side!]!, model.nodes[m.b.ref.node]!.sidePitch![m.b.side!]!]));
    for (const item of list) for (const p of [item.a, item.b]) model.nodes[p.ref.node]!.sidePitch![p.side!] = spacing;
    const commonStart = Math.max(lower ?? -Infinity, ...bundle.nodes.map(id => model.nodes[id]!.bounds![tangent] + 10 + spacing / 2));
    for (const end of ['a', 'b'] as const) {
      const far = end === 'a' ? 'b' : 'a';
      const ordered = [...list].sort((a, b) => a[end].engineOrder! - b[end].engineOrder! || a[far].engineOrder! - b[far].engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
      const ports = [...new Set(ordered.map(m => m[end]))];
      const node = model.nodes[ports[0]!.ref.node]!, dim = tangent === 'x' ? 'width' : 'height';
      let start = commonStart;
      if (tangent === 'x') {
        const group = model.groups[model.document.nodes[node.id]!.group]!;
        let limit = Infinity;
        for (const id of group.rowOrder ?? []) {
          const sibling = model.nodes[id]!;
          if (id !== node.id && sibling.bounds!.x > node.bounds!.x
            && Math.min(bottom(node.bounds!), bottom(sibling.bounds!)) > Math.max(node.bounds!.y, sibling.bounds!.y)) {
            limit = Math.min(limit, sibling.bounds!.x - rowGap(model, node.id, id));
          }
        }
        for (const lane of model.lanes) if (lane.tier === group.tier && lane.x > group.bounds!.x) {
          limit = Math.min(limit, lane.bounds.x - 12);
        }
        // Alignment is optional; capacity and immutable lanes are not. Leave a bundle bent when
        // projecting a distant peer's x would grow this node across a sibling or reserved lane.
        const sideCount = node.ports.filter(port => port.side === ports[0]!.side).length;
        if (start + (sideCount - 1) * spacing + 10 + spacing / 2 > limit) {
          start = node.bounds!.x + 10 + spacing / 2;
        }
      }
      ports.forEach(port => set(port, start + ordered.findIndex(m => m[end] === port) * spacing));
      node.bounds![dim] = Math.max(node.bounds![dim], start + (list.length - 1) * spacing + 10 + spacing / 2 - node.bounds![tangent]);
      node.size![dim] = node.bounds![dim];
    }
    if (tangent === 'x') for (const item of list) for (const port of [item.a, item.b]) {
      const tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
      const lane = model.lanes.filter(l => l.owner.kind === 'link' && l.owner.id === item.link.id)
        .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
      if (!lane) continue;
      const node = model.nodes[port.ref.node]!, oldRight = right(node.bounds!);
      node.bounds!.x = Math.min(node.bounds!.x, lane.x - 10 - spacing / 2);
      node.bounds!.width = Math.max(oldRight, lane.x + 10 + spacing / 2) - node.bounds!.x;
      node.size!.width = node.bounds!.width;
      set(port, lane.x);
    }
    done.add(bundle.id);
  };
  // Primary facing blocks occupy the upper range; secondary corridors clear every intervening box.
  for (const group of Object.values(model.groups)) {
    if (!group.flank?.primaryPeer || group.nodes.length !== 1) continue;
    const own = group.nodes[0]!, primary = model.nodes[group.flank.primaryPeer]!;
    const primaryBundle = model.bundles.find(b => b.nodes.includes(own) && b.nodes.includes(primary.id));
    if (!primaryBundle || !facing(members(model, primaryBundle))) continue;
    const list = members(model, primaryBundle);
    if (axis(list[0]!.a.side!) !== 'y' || inversionPairs(list).length) continue;
    const flank = model.nodes[own]!, dy = Math.max(0, primary.bounds!.y - flank.bounds!.y);
    if (dy) moveGroup(model, group, 0, dy);
    block(primaryBundle);
    const q = Math.max(pitch(model, primaryBundle), ...list.flatMap(m => [model.nodes[m.a.ref.node]!.sidePitch![m.a.side!]!, model.nodes[m.b.ref.node]!.sidePitch![m.b.side!]!]));
    primary.bounds!.height = Math.max(primary.bounds!.height, 20 + new Set(list.map(m => m.a.ref.node === primary.id ? m.a : m.b)).size * q);
    primary.size!.height = primary.bounds!.height;
    // Each block has to clear whatever stroke its own members really carry.
    const memberStroke = (item: Bundle): number =>
      Math.max(DEFAULT_STROKE_WIDTHS.path, ...members(model, item).map(m => linkStrokeWidth(m.link)));
    let lower = bottom(primary.bounds!) + 10 + (memberStroke(primaryBundle) + (primary.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
    for (const secondary of model.bundles.filter(b => b.id !== primaryBundle.id && b.nodes.includes(own))) {
      const peers = members(model, secondary);
      if (!facing(peers) || axis(peers[0]!.a.side!) !== 'y' || inversionPairs(peers).length) continue;
      const boxes = secondary.nodes.map(id => model.nodes[id]!.bounds!);
      const left = Math.min(...boxes.map(right)), rightEdge = Math.max(...boxes.map(b => b.x));
      for (const n of Object.values(model.nodes)) {
        if (secondary.nodes.includes(n.id) || n.bounds!.x >= rightEdge || right(n.bounds!) <= left) continue;
        if (model.groups[model.document.nodes[n.id]!.group]!.tier !== group.tier) continue;
        lower = Math.max(lower, bottom(n.bounds!) + 10 + (memberStroke(secondary) + (n.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2);
      }
      block(secondary, lower);
      lower += peers.length * pitch(model, secondary);
    }
  }
  for (const bundle of model.bundles) if (!done.has(bundle.id)) block(bundle);
  // Install all blocks jointly. Unrelated ports keep their relative order and authored keys stay strict.
  for (const [key, plan] of planned) {
    const [id, side] = JSON.parse(key) as [string, Side], node = model.nodes[id]!;
    const tangent = axis(side), spacing = node.sidePitch![side]!;
    if (tangent === 'x') for (const port of node.ports.filter(p => p.side === side && !plan.has(p))) {
      const incident = model.links.filter(l => l.attachments && [l.attachments.from, l.attachments.to].some(ref => portId(ref) === portId(port.ref)));
      const positions = incident.flatMap(link => model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id).map(lane => lane.x));
      if (positions.length && new Set(positions).size === 1) plan.set(port, positions[0]!);
    }
    const bundled = new Set(model.links.filter(l => l.bundle).flatMap(l => [portId(l.attachments!.from), portId(l.attachments!.to)]));
    const unrelated = new Set(node.ports.filter(p => p.side === side && !bundled.has(portId(p.ref))));
    const ports = sorted(node.ports.filter(p => p.side === side), p => plan.get(p) ?? coordinate(p), unrelated);
    let prior = node.bounds![tangent] + 10 - spacing / 2;
    ports.forEach((port, engineOrder) => {
      const value = Math.max(plan.get(port) ?? coordinate(port), prior + spacing);
      port.engineOrder = engineOrder; port.anchor![tangent] = value; prior = value;
    });
    const dim = tangent === 'x' ? 'width' : 'height';
    node.bounds![dim] = Math.max(node.bounds![dim], prior + 10 + spacing / 2 - node.bounds![tangent], 20 + ports.length * spacing);
    node.size![dim] = node.bounds![dim];
  }
  for (const node of Object.values(model.nodes)) for (const port of node.ports) {
    if (port.side === 'bottom') port.anchor!.y = bottom(node.bounds!);
    if (port.side === 'right') port.anchor!.x = right(node.bounds!);
    if (port.side === 'left') port.anchor!.x = node.bounds!.x;
  }
  for (const group of Object.values(model.groups)) fitRegionGroup(model, group);
  repackOverlaps(model);
  rebuildBands(model);
  let shift = 0;
  for (const band of [...model.tierBands].sort((a, b) => a.tier - b.tier)) {
    const old = oldBands.find(b => b.tier === band.tier)!;
    if (shift) for (const group of Object.values(model.groups).filter(g => g.tier === band.tier)) moveGroup(model, group, 0, shift);
    shift += Math.max(0, bottom(band.bounds!) - bottom(old.bounds!));
  }
  rebuildBands(model);
  // Shared trees and their normal continuation must finish before the nearest fixed lane. Every
  // cohort that stage 7e will give a tree — a bundle's own fan, a cross-bundle port or a plain fan
  // of routed links (ticket 20) — reserves the depth its rows and tracks need before its lane.
  for (const { port, links } of treeCohorts(model)) {
    if (axis(port.side!) !== 'x') continue;
    const n = normal(port.side!), tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
    const memberIds = new Set(links.map(link => link.id));
    // Only a lane the fan actually runs towards — beyond the port's normal — bounds it; a lane on
    // the other side of the node belongs to a link that leaves this port and turns back.
    const adjacent = model.lanes.filter(lane => lane.owner.kind === 'link' && memberIds.has(lane.owner.id)
      && (n.y > 0 ? lane.tier > tier : lane.tier < tier))
      .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
    // A fan whose links own no lane ends in the next tier band itself: its tree still needs the
    // same depth before that band's entry (ticket 20), so the band is the boundary to reserve against.
    const nextTier = adjacent?.tier ?? [...model.tierBands].map(b => b.tier)
      .filter(t => n.y > 0 ? t > tier : t < tier).sort((a, b) => n.y > 0 ? a - b : b - a)[0];
    if (nextTier === undefined) continue;
    const band = model.tierBands.find(b => b.tier === nextTier)!;
    const entry = n.y > 0 ? band.bounds!.y - 10.75 : -bottom(band.bounds!) - 10.75;
    const incidentBundles = model.bundles.filter(bundle => links.some(link => link.bundle === bundle.id));
    const degree = Math.max(links.length, ...incidentBundles.map(bundle => bundle.members.length));
    const q = Math.max(17.5, 16 + Math.max(...links.map(linkStrokeWidth)), ...incidentBundles.map(bundle => pitch(model, bundle)));
    // Fan rows may each move one edge margin off a group edge (ADR-0013); reserve that room.
    const required = 2 * MIN_STEM + q * (degree + 1) + 2 * edgeMargin(routedStrokeWidth(model));
    const delta = Math.max(0, required - (entry - n.y * port.anchor!.y));
    const movedTier = n.y > 0 ? nextTier : tier;
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= movedTier)) moveGroup(model, group, 0, delta);
    rebuildBands(model);
  }
  // Merged members need a free join/fan interval before their individual lanes.
  for (const bundle of model.bundles) {
    const list = members(model, bundle).filter(m => m.link.technique === 'merge');
    if (list.length < 2) continue;
    const selectedIds = new Set(list.map(m => m.link.id));
    const own = model.lanes.filter(l => l.owner.kind === 'link' && selectedIds.has(l.owner.id));
    if (!own.length) continue;
    const n = normal(list[0]!.a.side!);
    if (n.y === 0) continue;
    const tier = n.y > 0 ? Math.min(...own.map(l => l.tier)) : Math.max(...own.map(l => l.tier));
    const band = model.tierBands.find(b => b.tier === tier)!;
    const entry = n.y > 0 ? band.bounds!.y - 10.75 : -bottom(band.bounds!) - 10.75;
    const start = Math.max(...list.map(m => n.y * m.a.anchor!.y));
    const delta = Math.max(0, 30 + (2 * list.length + 1) * pitch(model, bundle) + 2 * edgeMargin(routedStrokeWidth(model)) - (entry - start));
    const movedTier = n.y > 0 ? tier : model.groups[model.document.nodes[list[0]!.a.ref.node]!.group]!.tier!;
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= movedTier)) moveGroup(model, group, 0, delta);
    rebuildBands(model);
  }
  // Reserve the complete crossing area before any producer pins paths.
  for (const bundle of model.bundles) {
    const list = members(model, bundle), inversions = inversionPairs(list).length;
    if (!facing(list)) continue;
    if (axis(list[0]!.a.side!) === 'y') {
      if (inversions) {
        const q = pitch(model, bundle), [left, rightNode] = bundle.nodes.map(id => model.nodes[id]!).sort((a, b) => a.bounds!.x - b.bounds!.x);
        const required = 30 + 4 * q * inversions + 2 * q * (list.length + 1), threshold = rightNode!.bounds!.x;
        const delta = Math.max(0, required - (threshold - right(left!.bounds!)));
        const tier = model.groups[model.document.nodes[rightNode!.id]!.group]!.tier;
        if (delta) for (const group of Object.values(model.groups).filter(g => g.tier === tier)) {
          const moved = group.nodes.filter(id => model.nodes[id]!.bounds!.x >= threshold);
          if (moved.length === group.nodes.length) moveGroup(model, group, delta, 0);
          else for (const id of moved) { model.nodes[id]!.bounds!.x += delta; model.nodes[id]!.ports.forEach(p => { p.anchor!.x += delta; }); }
          fitRegionGroup(model, group);
        }
      }
      continue;
    }
    const q = pitch(model, bundle), a = model.nodes[bundle.nodes[0]]!, b = model.nodes[bundle.nodes[1]]!;
    const upper = a.bounds!.y < b.bounds!.y ? a : b, lower = upper === a ? b : a;
    const upperTier = model.groups[model.document.nodes[upper.id]!.group]!.tier!, lowerTier = model.groups[model.document.nodes[lower.id]!.group]!.tier!;
    if (upperTier >= lowerTier || model.lanes.some(lane => bundle.members.includes(lane.owner.kind === 'link' ? lane.owner.id : ''))) continue;
    const shared = (['a', 'b'] as const).some(end => new Set(list.map(m => portId(m[end].ref))).size < list.length);
    const degree = Math.max(list.length, ...list.flatMap(m => [m.a, m.b]).map(p => model.links.filter(l => l.attachments && [l.attachments.from, l.attachments.to].some(ref => portId(ref) === portId(p.ref))).length));
    const mergeMembers = list.filter(m => m.link.technique === 'merge').length;
    const mergeAllowance = shared && mergeMembers >= 2 ? (2 * list.length + 1) * q : 0;
    // Join, leave and fan rows may each move one edge margin off a group edge (ADR-0013).
    const general = mergeAllowance + (shared ? 2 * (15 + q * degree) : 0) + 2 * MIN_STEM + (inversions ? 4 * q * inversions + 2 * q * (list.length + 1) : q * (list.length + 1))
      + 2 * edgeMargin(routedStrokeWidth(model));
    // An unshared merge trunk needs its interleaved join and leave rows between the two stems too.
    const mergeTrunk = mergeMembers >= 2 ? 2 * MIN_STEM + (2 * mergeMembers - 1) * q + 2 * edgeMargin(routedStrokeWidth(model)) : 0;
    const required = Math.max(general, mergeTrunk);
    const delta = Math.max(0, required - (lower.bounds!.y - bottom(upper.bounds!)));
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= lowerTier)) moveGroup(model, group, 0, delta);
  }
  rebuildBands(model);
}
