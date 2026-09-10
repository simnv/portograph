import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { orderedGroupIds } from '../model/model.js';
import { bandGap, compareId, greatestPeers, groupId, nodeGap, nodeId, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';

const right = (rect: Rect): number => rect.x + rect.width;
const bottom = (rect: Rect): number => rect.y + rect.height;
const contains = (a: Rect, b: Rect): boolean => a.x <= b.x && a.y <= b.y && right(a) >= right(b) && bottom(a) >= bottom(b);
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
const validRect = (r: Rect | undefined): r is Rect => r !== undefined && Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0;
export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 2 * spacing.padding, height: 2 * spacing.padding };
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}
function elkRect(node: ElkNode): Rect {
  const rect = { x: node.x!, y: node.y!, width: node.width!, height: node.height! };
  if (!validRect(rect)) throw new Error(`ELK omitted finite positive bounds for ${node.id}`);
  return rect;
}

/** ROOT ports are already absolute. Do not add the node or compound offsets a second time. */
export function readSkeleton(model: LayoutModel, result: ElkNode, tier?: number): void {
  const groups = new Map(result.children?.map(group => [group.id, group]));
  for (const group of Object.values(model.groups)) {
    if (group.flank || (tier !== undefined && group.tier !== tier)) continue;
    const placed = groups.get(groupId(group.id));
    if (!placed) throw new Error(`ELK omitted group ${group.id}`);
    group.bounds = elkRect(placed);
    const children = new Map(placed.children?.map(node => [node.id, node]));
    for (const id of group.nodes) {
      const node = model.nodes[id]!, child = children.get(nodeId(id));
      if (!child) throw new Error(`ELK omitted node ${id}`);
      const rect = elkRect(child);
      if (rect.width < node.size!.width || rect.height < node.size!.height) throw new Error(`ELK shrank measured node ${id}`);
      if (!contains(group.bounds, rect)) throw new Error(`ELK placed node ${id} outside group ${group.id}`);
      node.bounds = rect;
      node.size = { width: rect.width, height: rect.height };
      const ports = new Map(child.ports?.map(port => [port.id, port]));
      for (const port of node.ports) {
        const placedPort = ports.get(portId(port.ref));
        if (placedPort && Number.isFinite(placedPort.x) && Number.isFinite(placedPort.y)) {
          port.anchor = { x: placedPort.x! + (placedPort.width ?? 0) / 2, y: placedPort.y! + (placedPort.height ?? 0) / 2 };
        }
      }
    }
    group.rowOrder = [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x || compareId(a, b));
  }
}
export function rebuildBands(model: LayoutModel, includeFlanks = true): void {
  const groups = Object.values(model.groups).filter(group => includeFlanks || !group.flank);
  const tiers = [...new Set(groups.map(group => group.tier!))].sort((a, b) => a - b);
  model.tierBands = tiers.map(tier => {
    const members = groups.filter(group => group.tier === tier);
    return { tier, groups: members.map(group => group.id), bounds: union(members.map(group => group.bounds!)) };
  });
}

/** Stage-4 counterpart of G8, usable before paths and final port geometry exist. */
export function validateSkeletonBands(model: LayoutModel, includeFlanks = true, onlyTier?: number): string[] {
  const errors: string[] = [];
  const groups = Object.values(model.groups).filter(group => (includeFlanks || !group.flank) && (onlyTier === undefined || group.tier === onlyTier));
  for (const [i, group] of groups.entries()) {
    const band = model.tierBands.find(band => band.tier === group.tier);
    if (!validRect(group.bounds) || !validRect(band?.bounds) || !band!.groups.includes(group.id) || !contains(band!.bounds!, group.bounds!)) errors.push(`Group ${group.id} is outside its tier band`);
    for (const other of groups.slice(i + 1)) if (validRect(group.bounds) && validRect(other.bounds) && overlaps(group.bounds, other.bounds)) errors.push(`Groups ${group.id} and ${other.id} overlap`);
  }
  const bands = model.tierBands.filter(band => onlyTier === undefined || band.tier === onlyTier).sort((a, b) => a.tier - b.tier);
  for (const [i, band] of bands.entries()) {
    if (!validRect(band.bounds)) errors.push(`Tier ${band.tier} has invalid bounds`);
    const previous = bands[i - 1];
    if (previous && validRect(previous.bounds) && validRect(band.bounds)
      && (previous.tier === band.tier || bottom(previous.bounds) > band.bounds.y)) errors.push(`Tier ${band.tier} precedes or overlaps the previous band`);
  }
  return errors;
}
export function moveGroup(model: LayoutModel, group: LayoutGroup, dx: number, dy: number): void {
  group.bounds!.x += dx; group.bounds!.y += dy;
  for (const id of group.nodes) {
    const node = model.nodes[id]!;
    node.bounds!.x += dx; node.bounds!.y += dy;
    for (const port of node.ports) if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
  }
}
function packRow(model: LayoutModel, group: LayoutGroup, order: string[]): void {
  const original = group.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  let x = original.x + spacing.padding;
  const y = original.y + spacing.padding;
  for (const [i, id] of order.entries()) {
    const node = model.nodes[id]!;
    if (i) x += nodeGap(model, order[i - 1]!, id);
    const old = node.bounds;
    if (old) for (const port of node.ports) if (port.anchor) {
      port.anchor.x += x - old.x; port.anchor.y += y - old.y;
    }
    node.bounds = { x, y, ...node.size! };
    x += node.size!.width;
  }
  group.rowOrder = order;
  group.bounds = { x: original.x, y: original.y,
    width: Math.max(2 * spacing.padding, x - original.x + spacing.padding),
    height: Math.max(0, ...order.map(id => model.nodes[id]!.size!.height)) + 2 * spacing.padding };
}

/** Select all primary peers from the same ELK result before any repack changes distances. */
export function placeFlanksAndPeers(model: LayoutModel): void {
  const gap = bandGap(model);
  const flanks = orderedGroupIds(model.document).map(id => model.groups[id]!).filter(group => group.flank !== undefined);
  for (const group of flanks) {
    const flank = group.flank!, peerGroup = model.groups[flank.of]!;
    const distance = (id: string): number => flank.align === 'left'
      ? model.nodes[id]!.bounds!.x - peerGroup.bounds!.x
      : right(peerGroup.bounds!) - right(model.nodes[id]!.bounds!);
    const candidates = greatestPeers(model, group).sort((a, b) => distance(a) - distance(b) || compareId(a, b));
    if (candidates[0] !== undefined) flank.primaryPeer = candidates[0];
  }
  for (const peerGroup of Object.values(model.groups).filter(group => !group.flank)) {
    const attached = flanks.filter(group => group.flank!.of === peerGroup.id && group.flank!.primaryPeer !== undefined);
    if (!attached.length) continue;
    let order = [...peerGroup.rowOrder!];
    const outerOwners = new Map<string, LayoutGroup>();
    for (const group of attached) {
      const peer = group.flank!.primaryPeer!;
      const first = outerOwners.get(peer);
      if (order.length > 1 && first && first.flank!.align !== group.flank!.align) {
        model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'FLANK_PRIMARY_CONFLICT',
          message: `Flanks ${first.id} and ${group.id} share primary peer ${peer}; ${first.id} keeps its ${first.flank!.align} outer position. Obstructed flank links require routing.`,
          owners: [first.owner, group.owner, { kind: 'node', id: peer }],
        });
        continue;
      }
      outerOwners.set(peer, group);
      order = order.filter(id => id !== peer);
      if (group.flank!.align === 'left') order.unshift(peer); else order.push(peer);
    }
    packRow(model, peerGroup, order);
  }
  // Repacked rows can grow. Retain group order and move only groups that would collide.
  for (const tier of new Set(Object.values(model.groups).map(group => group.tier))) {
    const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    let end = -Infinity;
    for (const group of groups) {
      if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
      end = right(group.bounds!) + gap;
    }
    const core = union(groups.map(group => group.bounds!));
    let left = core.x - gap, rightX = right(core) + gap;
    for (const flank of flanks.filter(group => group.tier === tier)) {
      packRow(model, flank, [...flank.nodes]);
      const x = flank.flank!.align === 'left' ? left - flank.bounds!.width : rightX;
      moveGroup(model, flank, x - flank.bounds!.x, core.y - flank.bounds!.y);
      if (flank.flank!.align === 'left') left = x - gap;
      else rightX = x + flank.bounds!.width + gap;
    }
  }
  stackBands(model, true);
}

/** Stack complete band geometry. Preserve each band's valid ELK positions and internal gaps. */
export function stackBands(model: LayoutModel, includeFlanks: boolean): void {
  const gap = bandGap(model);
  rebuildBands(model, includeFlanks);
  let y = spacing.padding;
  for (const band of model.tierBands) {
    const dy = y - band.bounds!.y;
    for (const id of band.groups) moveGroup(model, model.groups[id]!, 0, dy);
    band.bounds!.y = y;
    y += band.bounds!.height + gap;
  }
  const all = Object.values(model.groups).filter(group => includeFlanks || !group.flank);
  const bounds = union(all.map(group => group.bounds!));
  const dx = spacing.padding - bounds.x;
  for (const group of all) moveGroup(model, group, dx, 0);
  rebuildBands(model, includeFlanks);
  model.canvas = { x: 0, y: 0, width: bounds.width + 2 * spacing.padding, height: Math.max(bounds.height + 2 * spacing.padding, y - gap + spacing.padding) };
}
