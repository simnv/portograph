/** Width-budget row reservations, made before stage 5 freezes port topology (ticket 166). */
import type { LayoutModel, LayoutGroup } from '../model/layout.js';
import type { StaggerRow } from '../model/layout.js';
import { groupShape } from './grid.js';
import { findPort } from './row-paths.js';
import { bandGap, nodeGap, portId } from './skeleton-graph.js';
import { moveGroup, stackBands } from './skeleton-geometry.js';
import { fitRegionGroup } from './regions.js';
import { nodeObstacleReach, routedStroke } from './bands.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { portEndInsets } from './port-insets.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { PlacementRefusal } from './placement-refusal.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rowGap } from './sides-two.js';

export const staggerOf = (model: LayoutModel, group: string): StaggerRow | undefined => model.staggerRows?.find(row => row.group === group);

/** The horizontal extent of the router's node obstacle: body clearance and stroke-expanded routed pills. */
function obstacleX(model: LayoutModel, id: string): { low: number; high: number } {
  const node = model.nodes[id]!, box = node.bounds!, reach = nodeObstacleReach(model, node);
  const pillGap = (routedStroke(model) + DEFAULT_STROKE_WIDTHS.pill) / 2;
  const pills = node.ports.flatMap(port => port.pill !== undefined && port.pill.layer !== 'overlay' ? [port.pill.bounds] : []);
  return { low: Math.min(box.x - reach, ...pills.map(pill => pill.x - pillGap)),
    high: Math.max(box.x + box.width + reach, ...pills.map(pill => pill.x + pill.width + pillGap)) };
}

/** All members have routed links, all exit through the same horizontal face, none stay inside the row. */
function exitSide(model: LayoutModel, group: LayoutGroup): 'top' | 'bottom' | undefined {
  if (group.flank || groupShape(model, group.id) !== 'row' || group.nodes.length < 3) return undefined;
  let side: 'top' | 'bottom' | undefined;
  for (const id of group.nodes) {
    const links = model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments
      && (link.attachments.from.node === id || link.attachments.to.node === id));
    if (!links.length) return undefined;
    for (const link of links) {
      const own = link.attachments!.from.node === id ? link.attachments!.from : link.attachments!.to;
      const far = link.attachments!.from.node === id ? link.attachments!.to : link.attachments!.from;
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
    return [{ group: group.id, order, side, pitch: 0, step: 0 }];
  }).sort((a, b) => model.groups[b.group]!.bounds!.width - model.groups[a.group]!.bounds!.width
    || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/** Reserve the least uniform centre pitch that clears the bodies, their pills and every passing vertical. */
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
  plan.pitch = pitch;
  plan.step = Math.max(...nodes.map(node => node.bounds!.height)) + Math.max(...nodes.map(node => nodeGap(model, node.id, node.id))) + topReach + bottomReach;
}

/** Seat the feeding faces before lanes fix their x. An ordinary parent needs the same reservation a bar gets from its span. */
function seatFeeds(model: LayoutModel): void {
  const parents = new Map<string, 'top' | 'bottom'>();
  for (const plan of model.staggerRows ?? []) for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    for (const [own, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      if (!plan.order.includes(own.node)) continue;
      const side = findPort(model, far)!.side;
      if (side === 'top' || side === 'bottom') {
        if (parents.has(far.node) && parents.get(far.node) !== side) throw new PlacementRefusal('ledger', 'A feeding node faces staggered rows in both directions');
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
  for (const [id, side] of ordered) {
    const node = model.nodes[id]!, group = model.groups[model.document.nodes[id]!.group]!;
    if (groupShape(model, group.id) === 'bar') continue; // 7d derives the bar's span from these same reserved drops.
    const targets = new Map<string, number>();
    for (const link of model.links) {
      if (link.layer !== 'routed' || !link.attachments) continue;
      for (const [own, far] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
        if (own.node !== id || findPort(model, own)!.side !== side) continue;
        const key = portId(own), x = findPort(model, far)!.anchor!.x, prior = targets.get(key);
        if (prior !== undefined && Math.abs(prior - x) > PLACEMENT_EPS) throw new PlacementRefusal('ledger', 'A shared feeding port cannot hold distinct vertical drops');
        targets.set(key, x);
      }
    }
    const ports = node.ports.filter(port => port.side === side);
    const wanted = ports.filter(port => targets.has(portId(port.ref))).sort((a, b) => targets.get(portId(a.ref))! - targets.get(portId(b.ref))! || a.engineOrder! - b.engineOrder!);
    for (let i = 1; i < wanted.length; i++) {
      if (targets.get(portId(wanted[i]!.ref))! - targets.get(portId(wanted[i - 1]!.ref))! < node.sidePitch![side]! - PLACEMENT_EPS) {
        throw new PlacementRefusal('ledger', 'A feeding face cannot keep its pitch over the stagger');
      }
    }
    const authored = wanted.filter(port => port.authorOrder !== undefined);
    if (authored.some((port, i) => i > 0 && port.authorOrder! < authored[i - 1]!.authorOrder!)) {
      throw new PlacementRefusal('ledger', 'A feeding face cannot keep its authored order over the stagger');
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
}

/** Stage 5 only: seat both lines, fit containing groups, close the space released in each affected tier. */
export function seatStaggerRows(model: LayoutModel): void {
  const affected = new Set<number>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    if (group === undefined || exitSide(model, group) !== plan.side || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order)) {
      throw new PlacementRefusal('ledger', `Stagger row ${plan.group} no longer has its reserved feed order and exit face`, { stage: 'sides-two' });
    }
    measure(model, plan);
    const nodes = plan.order.map(id => model.nodes[id]!);
    const min = Math.min(...nodes.map(node => node.bounds!.x));
    const y = Math.min(...nodes.map(node => node.bounds!.y));
    const half = nodes[0]!.bounds!.width / 2;
    nodes.forEach((node, i) => {
      const x = min + half + i * plan.pitch - node.bounds!.width / 2;
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
  seatFeeds(model);
  stackBands(model, true);
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
}

/** Publication and restore keep the two lines, pitch, feed order and passing corridors. Diagnostics grant no exception. */
export function validateStaggerRows(model: LayoutModel): void {
  const seen = new Set<string>();
  for (const plan of model.staggerRows ?? []) {
    const group = model.groups[plan.group];
    if (seen.has(plan.group) || group === undefined || exitSide(model, group) !== plan.side
      || JSON.stringify(group.rowOrder) !== JSON.stringify(plan.order) || !(plan.pitch > 0) || !(plan.step > 0)) throw new PlacementRefusal('ledger', 'Invalid stagger reservation');
    seen.add(plan.group);
    const first = model.nodes[plan.order[0]!]!.bounds!;
    for (const [i, id] of plan.order.entries()) {
      const box = model.nodes[id]!.bounds!;
      const dy = (i % 2) * plan.step * (plan.side === 'top' ? 1 : -1);
      if (Math.abs(box.y - first.y - dy) > PLACEMENT_EPS
        || Math.abs(box.x + box.width / 2 - first.x - first.width / 2 - i * plan.pitch) > PLACEMENT_EPS) throw new PlacementRefusal('ledger', 'Stagger placement lost its reserved pitch or lines');
      if (i % 2 === 0) continue;
      for (const port of model.nodes[id]!.ports.filter(port => port.side === plan.side && !port.unused)) {
        const x = port.anchor!.x;
        for (const even of plan.order.filter((_, index) => index % 2 === 0)) {
          const obstacle = obstacleX(model, even);
          if (x > obstacle.low + PLACEMENT_EPS && x < obstacle.high - PLACEMENT_EPS) throw new PlacementRefusal('ledger', 'Stagger vertical corridor enters a neighbouring obstacle');
        }
      }
    }
  }
}
