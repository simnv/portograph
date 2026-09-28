import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { groupShape } from './grid.js';
import { occupiedOverhang, selectAnchorTier } from './lanes.js';
import { overlayBlockers, overlayPath } from './overlay-paths.js';
import { saveGroups } from './overlay-order.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { groupInsets } from './regions.js';
import { rowGap } from './sides-two.js';
import { bandGap, compareId } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * Overlay barycentre for the free (ranked-groups spec, section 3.1, ticket 05).
 *
 * A group with no routed link to any node outside itself has nothing that routed geometry could
 * ask of its position. The one thing that does ask is its overlay links, and an overlay link is
 * one straight segment from face to face, so the way to keep it straight is to stand the group
 * under its partners. This pass runs at the start of the centre rule, before any centring step:
 *
 * - **A free group** takes x = the mean of its overlay partners' centres, where a partner is the node
 *   at the other end of an overlay link of any member. The tier's free groups with a target are
 *   sorted by target and swept left to right with the band gap between them, pushing right on
 *   overlap; a run that was pushed as a whole is centred back (least squared displacement, the
 *   cluster rule of Abacus), so two groups with one target stand either side of it.
 * - **A free node** of a group in which no node has a routed link is ordered inside its group by the
 *   same key, and the row is repacked from its left edge with `rowGap`. Only the order changes; a
 *   group whose new row would not fit its old box keeps its order.
 *
 * Routed geometry never moves for it. A group that has any routed link to another group is a
 * fixed wall for the sweep, so are a flank, a bar, a rank cell, a group that has a child group or a
 * parent group, a group in the anchor tier (`mutation.ts` does not let centring move it), and every
 * lane of the tier. A free group never crosses a wall: it stays between the two walls that the
 * order by target puts it between, and when that interval cannot hold the run it goes back to the
 * interval it had.
 *
 * A partner counts only when it is *settled*: a group that is not free, or a free group of a tier
 * nearer the anchor tier that this pass has already placed. Tiers are taken from the anchor tier
 * outward, in the order the centre steps take them. Because a target reads only settled positions
 * and the sweep reads only targets, widths and walls, a second run finds the same targets and
 * leaves every group where the first run put it.
 *
 * The routed groups of the tiers below the anchor are centred under their feeds after the first run
 * and may move, so `centreDraft` runs the pass again after each pass of its steps: the free groups
 * end at the mean of partners that stand where centring left them.
 */
export function placeOverlayFree(model: LayoutModel): void {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined || !model.links.some(link => link.layer === 'overlay')) return;
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const routedOut = new Set<string>(), routedAny = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    const ends = [link.attachments.from.node, link.attachments.to.node];
    for (const node of ends) routedAny.add(node);
    if (groupOf(ends[0]!) !== groupOf(ends[1]!)) for (const node of ends) routedOut.add(groupOf(node));
  }
  const parents = new Set(Object.values(model.document.groups).flatMap(group => group.parent === undefined ? [] : [group.parent]));
  /** The groups this pass may move: no routed link out, and no other rule that owns the group's place. */
  const free = new Set(Object.values(model.groups).filter(group => group.bounds !== undefined && group.nodes.length > 0
    && !group.flank && group.frame === undefined && group.tier !== anchor && !routedOut.has(group.id)
    && !parents.has(group.id) && model.document.groups[group.id]?.parent === undefined
    && model.document.groups[group.id]?.shape !== 'bar').map(group => group.id));
  if (!free.size) return;

  const partners = new Map<string, string[]>();
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [one, other] of [[from.node, to.node], [to.node, from.node]] as const) {
      partners.set(one, [...(partners.get(one) ?? []), other]);
    }
  }
  const settled = new Set(Object.keys(model.groups).filter(id => !free.has(id)));
  const centreOf = (node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;
  /**
   * Mean x of the settled partners of `nodes` that stand in another tier, or undefined when there is
   * none. A partner in the same tier is left out: the side phases froze the order of a tier's groups
   * and the sides of their overlay ports, and a target at that partner's x could put the group on the
   * wrong side of it and turn a straight link into a detour.
   */
  const keyOf = (nodes: string[], own: string): number | undefined => {
    const tier = model.groups[own]!.tier;
    const xs = nodes.flatMap(node => partners.get(node) ?? [])
      .filter(other => model.groups[groupOf(other)]!.tier !== tier && settled.has(groupOf(other))).map(centreOf);
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : undefined;
  };

  const tiers = model.tierBands.map(band => band.tier), at = tiers.indexOf(anchor);
  for (const tier of [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()]) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier);
    const movers = groups.filter(group => free.has(group.id));
    // The straight overlay links that touch or pass over this tier: a move is kept only where their
    // count, read by the real overlay decision, holds or rises (spec section 5). The mean of partners
    // in two tiers can put a body of the tier between the two ends of a link that was straight.
    const spanning = model.links.filter(link => link.layer === 'overlay' && link.attachments).filter(link => {
      const ends = [link.attachments!.from.node, link.attachments!.to.node].map(node => model.groups[groupOf(node)]!.tier!);
      return Math.min(...ends) <= tier && tier <= Math.max(...ends);
    });
    const straightCount = (): number => {
      const blockers = overlayBlockers(model);
      return spanning.filter(link => overlayPath(model, link, blockers).segments.length === 1).length;
    };
    const nodesOfTier = groups.flatMap(group => group.nodes);
    const signature = (): string => JSON.stringify(groups.map(group => [group.bounds, group.rowOrder, group.nodes.map(node => model.nodes[node]!.bounds)]));
    const start = signature();
    const before = spanning.length && movers.length ? straightCount() : 0, undo = saveGroups(model, groups);
    for (const group of movers) orderNodes(model, group, node => keyOf([node], group.id), routedAny);
    const targets = new Map<string, number>();
    for (const group of movers) {
      const target = keyOf(group.nodes, group.id);
      if (target !== undefined) targets.set(group.id, target);
    }
    if (targets.size) sweep(model, tier, groups, targets);
    if (spanning.length && signature() !== start) {
      rebuildNodeGeometry(model, nodesOfTier, 'current');
      if (straightCount() < before) { undo(); rebuildNodeGeometry(model, nodesOfTier, 'current'); }
    }
    for (const group of movers) settled.add(group.id);
  }
}

/** Order the nodes of a group in which no node has a routed link by `key`; unkeyed nodes keep their slot. */
function orderNodes(model: LayoutModel, group: LayoutGroup, key: (node: string) => number | undefined, routed: ReadonlySet<string>): void {
  const order = group.rowOrder ?? group.nodes;
  if (order.length < 2 || groupShape(model, group.id) !== 'row' || order.some(node => routed.has(node))) return;
  const keys = new Map(order.map(node => [node, key(node)]));
  const keyed = order.filter(node => keys.get(node) !== undefined);
  if (keyed.length < 2) return;
  const sorted = [...keyed].sort((a, b) => keys.get(a)! - keys.get(b)! || order.indexOf(a) - order.indexOf(b));
  const queue = [...sorted];
  const next = order.map(node => keys.get(node) === undefined ? node : queue.shift()!);
  if (next.every((node, i) => node === order[i])) return;
  // Repack from the left edge of the row. The row must still fit the box it had.
  const bodies = order.map(node => model.nodes[node]!.bounds!);
  const start = Math.min(...bodies.map(body => body.x));
  const inset = groupInsets(model, group), box = group.bounds!;
  const placed: number[] = [];
  let x = start;
  for (const [i, node] of next.entries()) {
    if (i) x += rowGap(model, next[i - 1]!, node);
    placed.push(x);
    x += model.nodes[node]!.bounds!.width;
  }
  if (x + inset.right > box.x + box.width + PLACEMENT_EPS) return;
  for (const [i, node] of next.entries()) {
    const body = model.nodes[node]!, dx = placed[i]! - body.bounds!.x;
    body.bounds!.x += dx;
    for (const port of body.ports) if (port.anchor) port.anchor.x += dx;
  }
  group.rowOrder = next;
}

interface Wall { low: number; high: number; centre: number; gap: number }
interface Item { id: string; want: number; width: number }

/**
 * Place the free groups that have a target between the walls of one tier. Every group of the tier
 * that has no target, and every lane, is a wall. A group takes the interval its target falls in;
 * when an interval cannot hold what the targets put in it, every group goes back to the interval it
 * has now, and an interval that cannot hold its own groups is left alone.
 */
function sweep(model: LayoutModel, tier: number, groups: LayoutGroup[], targets: ReadonlyMap<string, number>): void {
  const gap = bandGap(model);
  const reach = new Map(groups.map(group => [group.id, occupiedOverhang(model, group)]));
  const occupied = (group: LayoutGroup): { low: number; high: number } => ({
    low: group.bounds!.x - reach.get(group.id)!.left, high: group.bounds!.x + group.bounds!.width + reach.get(group.id)!.right });
  const walls: Wall[] = [
    ...groups.filter(group => !targets.has(group.id)).map(group => {
      const box = occupied(group);
      return { ...box, centre: (box.low + box.high) / 2, gap };
    }),
    ...model.lanes.filter(lane => lane.tier === tier).map((lane): Wall => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width,
      centre: lane.bounds.x + lane.bounds.width / 2, gap: 0 })),
  ].sort((a, b) => a.low - b.low);
  const movers = groups.filter(group => targets.has(group.id));
  const interval = (centre: number): number => walls.filter(wall => wall.centre < centre).length;
  const item = (group: LayoutGroup): Item => {
    const box = occupied(group);
    return { id: group.id, want: targets.get(group.id)! - group.bounds!.width / 2 - reach.get(group.id)!.left, width: box.high - box.low };
  };
  const place = (assignment: Map<string, number>): Map<string, number> | undefined => {
    const result = new Map<string, number>();
    for (let k = 0; k <= walls.length; k++) {
      const members = movers.filter(group => assignment.get(group.id) === k)
        .sort((a, b) => targets.get(a.id)! - targets.get(b.id)! || a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
      if (!members.length) continue;
      const before = walls[k - 1], after = walls[k];
      const solved = packRun(members.map(item), before ? before.high + before.gap : -Infinity, after ? after.low - after.gap : Infinity, gap);
      if (!solved) return undefined;
      for (const [id, x] of solved) result.set(id, x);
    }
    return result;
  };
  const wanted = new Map(movers.map(group => [group.id, interval(targets.get(group.id)!)]));
  const current = new Map(movers.map(group => [group.id, interval(group.bounds!.x + group.bounds!.width / 2)]));
  let result = place(wanted);
  if (!result) {
    // Interval by interval, so an interval that cannot hold its own groups leaves only those alone.
    result = new Map();
    for (let k = 0; k <= walls.length; k++) {
      const one = place(new Map([...current].filter(([, index]) => index === k)));
      if (one) for (const [id, x] of one) result.set(id, x);
    }
  }
  for (const group of movers) {
    const left = result.get(group.id);
    if (left === undefined) continue;
    const dx = left - occupied(group).low;
    if (Math.abs(dx) > PLACEMENT_EPS) moveGroup(model, group, dx, 0);
  }
}

/**
 * Left edges for `items`, in order, inside `[low, high]` with `gap` between neighbours, at the least
 * squared distance from the edges they want: each item goes where it wants, an item that overlaps the
 * run before it joins that run, and a run that joined moves as a whole to the mean of what its members
 * want, then back inside the interval. Undefined when the run does not fit the interval.
 */
function packRun(items: Item[], low: number, high: number, gap: number): Map<string, number> | undefined {
  interface Cluster { first: number; last: number; weight: number; sum: number; width: number; x: number }
  const total = items.reduce((sum, one) => sum + one.width, 0) + gap * (items.length - 1);
  if (total > high - low + PLACEMENT_EPS) return undefined;
  const clusters: Cluster[] = [];
  const settle = (cluster: Cluster): void => {
    cluster.x = Math.min(Math.max(cluster.sum / cluster.weight, low), high - cluster.width);
  };
  for (const [index, one] of items.entries()) {
    let cluster: Cluster = { first: index, last: index, weight: 1, sum: one.want, width: one.width, x: 0 };
    settle(cluster);
    for (let previous = clusters[clusters.length - 1]; previous && previous.x + previous.width + gap > cluster.x; previous = clusters[clusters.length - 1]) {
      clusters.pop();
      previous.sum += cluster.sum - cluster.weight * (previous.width + gap);
      previous.weight += cluster.weight;
      previous.width += gap + cluster.width;
      previous.last = cluster.last;
      settle(previous);
      cluster = previous;
    }
    clusters.push(cluster);
  }
  const result = new Map<string, number>();
  for (const cluster of clusters) {
    let x = cluster.x;
    for (let i = cluster.first; i <= cluster.last; i++) {
      result.set(items[i]!.id, x);
      x += items[i]!.width + gap;
    }
  }
  return result;
}
