import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { frameColumns, overlayFreeGroups, type FrameColumn } from './columns.js';
import { groupShape } from './grid.js';
import { occupiedOverhang, selectAnchorTier } from './lanes.js';
import { overlayBlockers, overlayPath } from './overlay-paths.js';
import { saveGroups } from './overlay-order.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { deriveFrames } from './frames.js';
import { GROUP_PADDING, groupInsets } from './regions.js';
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
 * fixed wall for the sweep, so are a flank, a bar, the column of a frame (a rank cell is walled by
 * the whole column it stands in, ranked-groups ticket 09), a group that has a child group or a
 * parent group, a group in the anchor tier (`mutation.ts` does not let centring move it), and every
 * lane of the tier. A free group never crosses a wall: it stays between the two walls that the
 * order by target puts it between, and when that interval cannot hold the run it goes back to the
 * interval it had.
 *
 * **Into the span** (ranked-groups ticket 22). A free group whose box stands outside the x-span of its
 * partners (the lowest and highest partner centre) is first moved to the nearest point of the span, by
 * the same sweep, and the move is kept when the total length of its overlay links falls. It is not
 * judged by the straight count: a move into the span often crosses a rank of bodies between the group
 * and its partners, and a chord that only looked straight from far away is not worth a canvas as wide
 * as the gap. The straight-count guard then judges only the fine placement (the mean of the partners)
 * from the place the group entered at, so a group ends inside its span even where the fine move is
 * refused.
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
export function placeOverlayFree(model: LayoutModel, columns: readonly FrameColumn[] = frameColumns(model)): void {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined || !model.links.some(link => link.layer === 'overlay')) return;
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const routedAny = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    for (const node of [link.attachments.from.node, link.attachments.to.node]) routedAny.add(node);
  }
  /** The groups this pass may move: no routed link out, and no other rule that owns the group's place. */
  const free = overlayFreeGroups(model, anchor);
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
   * The x of every settled partner of `nodes` that stands in another tier. A partner in the same tier
   * is left out: the side phases froze the order of a tier's groups and the sides of their overlay
   * ports, and a target at that partner's x could put the group on the wrong side of it and turn a
   * straight link into a detour.
   */
  const partnerXs = (nodes: string[], own: string): number[] => {
    const tier = model.groups[own]!.tier;
    return nodes.flatMap(node => partners.get(node) ?? [])
      .filter(other => model.groups[groupOf(other)]!.tier !== tier && settled.has(groupOf(other))).map(centreOf);
  };
  /** Mean of `partnerXs`, or undefined when there is none. */
  const keyOf = (nodes: string[], own: string): number | undefined => {
    const xs = partnerXs(nodes, own);
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : undefined;
  };
  /**
   * Sum of the chord lengths (centre to centre) of the overlay links of `nodes` to the partners the
   * span is read from — settled, in another tier. A free partner still stands at ELK's raw x, the
   * very condition the into-span step corrects, and its chord would veto the move (ticket 22 review).
   */
  const overlayLength = (nodes: string[], tier: number): number => {
    let total = 0;
    for (const node of nodes) {
      for (const other of partners.get(node) ?? []) {
        if (model.groups[groupOf(other)]!.tier === tier || !settled.has(groupOf(other))) continue;
        total += Math.hypot(centreOf(node) - centreOf(other), model.nodes[node]!.bounds!.y - model.nodes[other]!.bounds!.y);
      }
    }
    return total;
  };

  const tiers = model.tierBands.map(band => band.tier), at = tiers.indexOf(anchor);
  for (const tier of [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()]) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier);
    const movers = groups.filter(group => free.has(group.id));
    // A member of a canton is moved as a frame inside its canton (ticket 56); the sweep below reads every column as a wall.
    const inner = (group: LayoutGroup): boolean => group.frame !== undefined;
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
    // Into the span (ticket 22): a group outside the x-span of its partners is first moved into it and
    // the move is accepted on the total length of its overlay links, not on the straight count; the
    // straight count below judges only the fine placement that follows.
    const entering = new Map<string, number>();
    for (const group of movers.filter(group => !inner(group))) {
      const xs = partnerXs(group.nodes, group.id);
      if (!xs.length) continue;
      const low = Math.min(...xs), high = Math.max(...xs), box = group.bounds!;
      if (box.x + box.width < low - PLACEMENT_EPS || box.x > high + PLACEMENT_EPS) {
        entering.set(group.id, Math.min(Math.max(box.x + box.width / 2, low), high));
      }
    }
    if (entering.size) {
      const before = signature();
      const enterers = movers.filter(group => entering.has(group.id)), entered = enterers.flatMap(group => group.nodes);
      const length = overlayLength(entered, tier);
      const back = saveGroups(model, groups);
      sweep(model, tier, groups, entering, columns);
      if (signature() !== before) {
        rebuildNodeGeometry(model, nodesOfTier, 'current');
        if (overlayLength(entered, tier) >= length - PLACEMENT_EPS) { back(); rebuildNodeGeometry(model, nodesOfTier, 'current'); }
      }
    }
    const start = signature();
    const undo = saveGroups(model, groups);
    for (const group of movers) orderNodes(model, group, node => keyOf([node], group.id), routedAny);
    const targets = new Map<string, number>();
    for (const group of movers) {
      const target = keyOf(group.nodes, group.id);
      if (target !== undefined) targets.set(group.id, target);
    }
    if (targets.size) {
      const plain = new Map([...targets].filter(([id]) => !inner(model.groups[id]!)));
      if (plain.size) sweep(model, tier, groups, plain, columns);
      if (plain.size < targets.size) sweepMembers(model, tier, new Map([...targets].filter(([id]) => inner(model.groups[id]!))), columns);
    }
    if (spanning.length && signature() !== start) {
      // `centre` moves groups with `moveGroup`, which leaves the pills behind. The count before the move
      // and the count after it must read the same kind of geometry, so the tier goes back, its pills
      // are refreshed and counted, then the move is redone and counted the same way.
      const redo = saveGroups(model, groups);
      undo();
      rebuildNodeGeometry(model, nodesOfTier, 'current');
      const before = straightCount();
      redo();
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
function sweep(model: LayoutModel, tier: number, groups: LayoutGroup[], targets: ReadonlyMap<string, number>, columns: readonly FrameColumn[]): void {
  const gap = bandGap(model);
  const reach = new Map(groups.map(group => [group.id, occupiedOverhang(model, group)]));
  const occupied = (group: LayoutGroup): { low: number; high: number } => ({
    low: group.bounds!.x - reach.get(group.id)!.left, high: group.bounds!.x + group.bounds!.width + reach.get(group.id)!.right });
  const walls: Wall[] = [
    // A cell is walled by its frame's column, which is wider than the cell where a neighbour rank is wider.
    ...groups.filter(group => !targets.has(group.id) && !columns.some(column => column.cells.has(group.id))).map(group => {
      const box = occupied(group);
      return { ...box, centre: (box.low + box.high) / 2, gap };
    }),
    ...columns.filter(column => column.from <= tier && tier <= column.to).map((column): Wall => ({ low: column.x, high: column.x + column.width,
      centre: column.x + column.width / 2, gap })),
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
 * Place the free members of a canton on one tier (canton-groups ticket 56, Section 2b rule 3). A member is a frame of one
 * cell, and its target is the mean x of its settled partners as for any free group. It stands inside its canton: the canton
 * frame box, less the group margin, bounds the member's frame, and the other members that hold a cell on the tier are walls
 * `2 * GROUP_PADDING` away, the beside rule. The same run packer as `sweep` places what falls between two walls.
 */
function sweepMembers(model: LayoutModel, tier: number, targets: ReadonlyMap<string, number>, columns: readonly FrameColumn[]): void {
  const frames = model.document.frames, derived = deriveFrames(model);
  if (frames === undefined || derived === undefined) return;
  const box = new Map(derived.map(frame => [frame.id, frame.box]));
  const gap = 2 * GROUP_PADDING;
  const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
  for (const column of columns.filter(item => item.wall !== undefined && item.from <= tier && tier <= item.to)) {
    const movers = [...targets.keys()].filter(id => column.cells.has(id)).map(id => model.groups[id]!);
    if (!movers.length) continue;
    const own = new Set(movers.map(group => group.frame!));
    const walls = Object.keys(frames).filter(id => frames[id]!.parent === column.id && !own.has(id) && cellsOf(id).some(cell => model.groups[cell]!.tier === tier))
      .map(id => ({ low: box.get(id)!.x, high: box.get(id)!.x + box.get(id)!.width })).sort((a, b) => a.low - b.low);
    const low = column.wall!.x + GROUP_PADDING, high = column.wall!.x + column.wall!.width - GROUP_PADDING;
    const item = (group: LayoutGroup): Item => {
      const frame = box.get(group.frame!)!;
      return { id: group.id, want: targets.get(group.id)! - (group.bounds!.x + group.bounds!.width / 2 - frame.x) - 0, width: frame.width };
    };
    const centre = (wall: { low: number; high: number }): number => (wall.low + wall.high) / 2;
    const interval = (group: LayoutGroup): number => walls.filter(wall => centre(wall) < targets.get(group.id)!).length;
    const result = new Map<string, number>();
    for (let k = 0; k <= walls.length; k++) {
      const members = movers.filter(group => interval(group) === k).sort((a, b) => targets.get(a.id)! - targets.get(b.id)! || compareId(a.id, b.id));
      if (!members.length) continue;
      const before = walls[k - 1], after = walls[k];
      const solved = packRun(members.map(item), Math.max(low, before ? before.high + gap : -Infinity), Math.min(high, after ? after.low - gap : Infinity), gap);
      if (solved) for (const [id, x] of solved) result.set(id, x);
    }
    for (const group of movers) {
      const x = result.get(group.id);
      if (x === undefined) continue;
      const dx = x - box.get(group.frame!)!.x;
      if (Math.abs(dx) > PLACEMENT_EPS) moveGroup(model, group, dx, 0);
    }
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
