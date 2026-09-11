import type { Bundle, LayoutLink, LayoutModel, LayoutPort, Point, Side } from '../model/index.js';
import { repackOverlaps } from './rows.js';
import { applyBundleOrder } from './bundle-order.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { fitRegionGroup, bottom, right } from './regions.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';

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

/** Geometry-only plan. No path, lane owner, bar reservation or envelope is written here. */
export function prepareBundleGeometry(model: LayoutModel): void {
  if (!model.bundles.length) return;
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
    const start = Math.max(lower ?? -Infinity, ...bundle.nodes.map(id => model.nodes[id]!.bounds![tangent] + 10 + spacing / 2));
    for (const end of ['a', 'b'] as const) {
      const far = end === 'a' ? 'b' : 'a';
      const ordered = [...list].sort((a, b) => a[end].engineOrder! - b[end].engineOrder! || a[far].engineOrder! - b[far].engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
      const ports = [...new Set(ordered.map(m => m[end]))];
      ports.forEach(port => set(port, start + ordered.findIndex(m => m[end] === port) * spacing));
      const node = model.nodes[ports[0]!.ref.node]!, dim = tangent === 'x' ? 'width' : 'height';
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
  // Shared trees and their normal continuation must finish before the nearest fixed lane.
  const incidence = new Map<string, { port: LayoutPort; links: LayoutLink[] }>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments) for (const ref of [link.attachments.from, link.attachments.to]) {
    const port = findPort(model, ref)!, key = portId(ref), entry = incidence.get(key) ?? { port, links: [] };
    entry.links.push(link); incidence.set(key, entry);
  }
  for (const { port, links } of incidence.values()) {
    if (links.length < 2 || !links.some(link => link.bundle) || axis(port.side!) !== 'x') continue;
    const n = normal(port.side!), tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
    const memberIds = new Set(links.map(link => link.id));
    const adjacent = model.lanes.filter(lane => lane.owner.kind === 'link' && memberIds.has(lane.owner.id))
      .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
    if (!adjacent) continue;
    const band = model.tierBands.find(b => b.tier === adjacent.tier)!;
    const entry = n.y > 0 ? band.bounds!.y - 10.75 : -bottom(band.bounds!) - 10.75;
    const incidentBundles = model.bundles.filter(bundle => links.some(link => link.bundle === bundle.id));
    const degree = Math.max(links.length, ...incidentBundles.map(bundle => bundle.members.length));
    const q = Math.max(17.5, ...incidentBundles.map(bundle => pitch(model, bundle)));
    const required = 2 * MIN_STEM + q * (degree + 1);
    const delta = Math.max(0, required - (entry - n.y * port.anchor!.y));
    const movedTier = n.y > 0 ? adjacent.tier : tier;
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
    const delta = Math.max(0, 30 + (2 * list.length + 1) * pitch(model, bundle) - (entry - start));
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
    const mergeAllowance = shared && list.filter(m => m.link.technique === 'merge').length >= 2 ? (2 * list.length + 1) * q : 0;
    const required = mergeAllowance + (shared ? 2 * (15 + q * degree) : 0) + 2 * MIN_STEM + (inversions ? 4 * q * inversions + 2 * q * (list.length + 1) : q * (list.length + 1));
    const delta = Math.max(0, required - (lower.bounds!.y - bottom(upper.bounds!)));
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= lowerTier)) moveGroup(model, group, 0, delta);
  }
  rebuildBands(model);
}
