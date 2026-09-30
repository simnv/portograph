import type { Rect } from '../model/geometry.js';
import { orderedNodeIds } from '../model/model.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { frameColumns, overlayFreeGroups, type FrameColumn } from './columns.js';
import { groupShape } from './grid.js';
import { laneSidesHold, occupiedOverhang, selectAnchorTier } from './lanes.js';
import { EPS } from '../score/geometry.js';
import { crosses, overlayBlockers, overlayPath, straightChord } from './overlay-paths.js';
import { saveGroups } from './overlay-order.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { deriveFrames } from './frames.js';
import { GROUP_PADDING, groupInsets, placementWarning } from './regions.js';
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
  stepOutOfChords(model, tiers, free, columns);
}

/** The step of `placeOverlayFree` alone, for the 7f rounds that replay without a budget (ticket 76 review). */
export function stepLinklessOutOfChords(model: LayoutModel, columns: readonly FrameColumn[] = frameColumns(model)): boolean {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return false;
  const before = JSON.stringify(Object.values(model.groups).map(group => group.bounds));
  const free = overlayFreeGroups(model, anchor);
  stepOutOfChords(model, model.tierBands.map(band => band.tier), free, columns);
  stepOverChords(model, free, columns);
  return JSON.stringify(Object.values(model.groups).map(group => group.bounds)) !== before;
}

/** How many candidate x a group tries, nearest first, before it stays (ticket 77). */
const CHORD_TRIALS = 24;

/**
 * A straight overlay chord between two tiers is a reservation for the tiers between them (ticket 77, Q64). After centring
 * settles, a free group on such a tier (no routed link, so no routed geometry asks for its x) that stands on a chord moves along
 * its tier to the nearest x that clears every chord that is straight without it, and stays clear of the walls of its tier: the
 * other groups and the columns a band gap away, the lanes, and the canton it is a member of. A candidate x is kept only when
 * the straight overlay count, read by the real overlay decision, rises — a move that bends a straight link and straightens
 * another is a trade that counts, one that only bends is refused. The move keeps inside the box of the whole layout, so it
 * never widens the canvas. `laneSidesHold` refuses a lane side or a frozen chord. A group with a routed link is not moved:
 * its links are the walls of its x. Linkless groups are `stepOutOfChords`'.
 */
export function stepOverChords(model: LayoutModel, free: ReadonlySet<string>, columns: readonly FrameColumn[]): void {
  const overlays = model.links.filter(link => link.layer === 'overlay' && link.attachments);
  if (!overlays.length) return;
  const tierOf = (node: string): number => model.groups[model.document.nodes[node]!.group]!.tier!;
  const linked = new Set<string>();
  for (const link of overlays) for (const end of [link.attachments!.from.node, link.attachments!.to.node]) linked.add(model.document.nodes[end]!.group);
  const gap = bandGap(model);
  const all = Object.values(model.groups).filter(group => group.bounds);
  const world = { low: Math.min(...all.map(group => group.bounds!.x)), high: Math.max(...all.map(group => group.bounds!.x + group.bounds!.width)) };
  const straight = (): Set<string> => {
    const blockers = overlayBlockers(model);
    return new Set(overlays.filter(link => overlayPath(model, link, blockers).segments.length === 1).map(link => link.id));
  };
  const tiers = [...new Set(all.map(group => group.tier!))].sort((a, b) => a - b);
  /** Whether any trial ran: each one rebuilt a group's labels and so moved them to the end of the list. */
  let moved = false;
  for (const tier of tiers) {
    const groups = all.filter(group => group.tier === tier);
    // Only the chords that pass over this tier can be in the way; a chord that ends on it is the group's own or a same-tier one.
    const passing = overlays.filter(link => {
      const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
      return Math.min(...ends) < tier && tier < Math.max(...ends);
    });
    if (!passing.length) continue;
    for (const group of groups.filter(item => free.has(item.id) && linked.has(item.id))) {
      const box = { ...group.bounds! }, own = new Set(group.nodes);
      const bare = overlayBlockers(model, own);
      const chords = passing.flatMap(link => {
        const chord = straightChord(model, link, bare);
        return chord ? [chord] : [];
      });
      const shapes: Rect[] = group.nodes.flatMap(id => {
        const node = model.nodes[id]!;
        return [node.bounds!, ...node.ports.flatMap(port => port.pill && port.ref.anonymous !== true ? [port.pill.bounds] : [])];
      });
      /** The moves `dx` in the open interval (low, high) that put a shape of the group on a chord. */
      const banned = chords.flatMap(({ from, to }) => shapes.flatMap(shape => {
        const top = shape.y + EPS, floor = shape.y + shape.height - EPS, dy = to.y - from.y;
        let t0 = 0, t1 = 1;
        if (Math.abs(dy) <= EPS) { if (from.y <= top || from.y >= floor) return []; }
        else {
          const a = (top - from.y) / dy, b = (floor - from.y) / dy;
          t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(1, Math.max(a, b));
          if (t1 - t0 <= 0) return [];
        }
        const xs = [from.x + (to.x - from.x) * t0, from.x + (to.x - from.x) * t1];
        return [{ low: Math.min(...xs) - shape.x - shape.width, high: Math.max(...xs) - shape.x }];
      }));
      if (!banned.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) continue;
      const reach = occupiedOverhang(model, group);
      // The walls, as moves of the group: [low, high) is the run of x a move may not put the group's occupied extent into.
      const walls: { low: number; high: number }[] = [];
      let inside = { low: 0, high: 0 };
      const cell = group.frame === undefined ? undefined : columns.find(column => column.cells.has(group.id));
      if (group.frame !== undefined) {
        const frames = model.document.frames!, derived = deriveFrames(model);
        const frame = derived?.find(item => item.id === group.frame);
        if (cell?.wall === undefined || frame === undefined) continue;
        // A member of a canton stands inside the canton, less the group margin, and 2 * GROUP_PADDING from the other frames of its sub-tier.
        const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
        const room = { low: cell.wall.x + GROUP_PADDING, high: cell.wall.x + cell.wall.width - GROUP_PADDING };
        const lead = box.x - frame.box.x, span = frame.box.width;
        inside = { low: Math.max(world.low, room.low + lead), high: Math.min(world.high - box.width, room.high - span + lead) };
        for (const other of derived!) {
          if (other.id === group.frame || frames[other.id]!.parent !== cell.id || !cellsOf(other.id).some(id => model.groups[id]!.tier === tier)) continue;
          walls.push({ low: other.box.x - 2 * GROUP_PADDING - span + lead, high: other.box.x + other.box.width + 2 * GROUP_PADDING + lead });
        }
        for (const lane of model.lanes.filter(item => item.tier === tier)) walls.push({ low: lane.bounds.x - span + lead, high: lane.bounds.x + lane.bounds.width + lead });
      } else {
        const width = box.width + reach.left + reach.right;
        const wall = (low: number, high: number, space: number): void => { walls.push({ low: low - space - width + reach.left, high: high + space + reach.left }); };
        for (const item of groups) {
          if (item === group) continue;
          const one = occupiedOverhang(model, item);
          wall(item.bounds!.x - one.left, item.bounds!.x + item.bounds!.width + one.right, gap);
        }
        for (const column of columns.filter(item => item.from <= tier && tier <= item.to)) wall(column.x, column.x + column.width, gap);
        for (const lane of model.lanes.filter(item => item.tier === tier)) wall(lane.bounds.x, lane.bounds.x + lane.bounds.width, 0);
        inside = { low: world.low + reach.left, high: world.high - box.width - reach.right };
      }
      const feasible = (x: number): boolean => x >= inside.low - PLACEMENT_EPS && x <= inside.high + PLACEMENT_EPS
        && !walls.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS);
      const candidates = [...banned.flatMap(({ low, high }) => [box.x + low, box.x + high]), ...walls.flatMap(({ low, high }) => [low, high])]
        .filter((x, index, all) => feasible(x) && Math.abs(x - box.x) > PLACEMENT_EPS && all.findIndex(other => Math.abs(other - x) <= PLACEMENT_EPS) === index)
        .sort((a, b) => Math.abs(a - box.x) - Math.abs(b - box.x) || a - b);
      const before = straight(), undo = saveGroups(model, [group]);
      for (const target of candidates.slice(0, CHORD_TRIALS)) {
        if (!laneSidesHold(model, [{ group, bounds: { ...box, x: target } }])) continue;
        moved = true;
        moveGroup(model, group, target - box.x, 0);
        rebuildNodeGeometry(model, group.nodes, 'current');
        if (straight().size > before.size) break;
        undo();
        rebuildNodeGeometry(model, group.nodes, 'current');
      }
    }
  }
  // The trials rebuild a group's labels one group at a time and so reorder them; the published order is the document's (`rebuildNodeGeometry`).
  if (moved) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
}

/**
 * A group with no link of any member has nothing that asks for an x, and ELK's skeleton x is
 * arbitrary (ticket 76). It is a wall for the sweeps above, so an overlay chord that passes through
 * its tier can find the group in its way and the link takes the orthogonal branch. This step runs
 * after every partner is settled: each such group stands at the x nearest its own where its box
 * crosses no straight overlay chord, using the chords as drawn (face to face) and counting a chord
 * that is straight once the group's own nodes are taken away. The x must keep the band gap to the
 * other groups and the lanes of the tier and stay inside their span; if no x does, the group goes
 * past the tier's end. A move that bends an overlay link that was straight is refused, with a warning.
 */
export function stepOutOfChords(model: LayoutModel, tiers: readonly number[], free: ReadonlySet<string>, columns: readonly FrameColumn[]): void {
  const linked = new Set<string>();
  for (const link of model.links) {
    if (!link.attachments) continue;
    for (const end of [link.attachments.from.node, link.attachments.to.node]) linked.add(model.document.nodes[end]!.group);
  }
  const overlays = model.links.filter(link => link.layer === 'overlay' && link.attachments);
  if (!overlays.length) return;
  const gap = bandGap(model);
  for (const tier of tiers) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier);
    for (const group of groups.filter(item => free.has(item.id) && !linked.has(item.id) && item.frame === undefined && item.bounds)) {
      const box = { ...group.bounds! }, own = new Set(group.nodes);
      const bare = overlayBlockers(model, own);
      // Every chord that is straight without the group and runs through the box's rows bans an interval of the box's x, not only the
      // chords that cross the box now: the nearest edge of one chord may lie inside the next (ticket 76 review).
      const rows = overlays.flatMap(link => {
        const chord = straightChord(model, link, bare);
        return chord && Math.max(chord.from.y, chord.to.y) > box.y + PLACEMENT_EPS && Math.min(chord.from.y, chord.to.y) < box.y + box.height - PLACEMENT_EPS ? [chord] : [];
      });
      if (!rows.some(({ from, to }) => crosses(from, to, box))) continue;
      // The x-interval of the box's left edge in which the box touches a chord: the chord's x-extent within the box's rows, less the width.
      const banned = rows.map(({ from, to }) => {
        const dy = to.y - from.y, low = Math.min(from.y, to.y), high = Math.max(from.y, to.y);
        const at = (y: number): number => dy === 0 ? from.x : from.x + (to.x - from.x) * (y - from.y) / dy;
        const xs = dy === 0 ? [from.x, to.x] : [at(Math.min(Math.max(box.y, low), high)), at(Math.min(Math.max(box.y + box.height, low), high))];
        return { low: Math.min(...xs) - box.width, high: Math.max(...xs) };
      });
      const reach = occupiedOverhang(model, group);
      const others = [
        ...groups.filter(item => item !== group && item.bounds).map(item => {
          const one = occupiedOverhang(model, item);
          return { low: item.bounds!.x - one.left, high: item.bounds!.x + item.bounds!.width + one.right, gap };
        }),
        ...columns.filter(column => column.from <= tier && tier <= column.to).map(column => ({ low: column.x, high: column.x + column.width, gap })),
        ...model.lanes.filter(lane => lane.tier === tier).map(lane => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width, gap: 0 })),
      ];
      const width = box.width + reach.left + reach.right;
      const fits = (x: number): boolean => !banned.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS)
        && !others.some(wall => x - reach.left < wall.high + wall.gap - PLACEMENT_EPS && x - reach.left + width > wall.low - wall.gap + PLACEMENT_EPS);
      const candidates = [...banned.flatMap(({ low, high }) => [low, high]),
        ...others.flatMap(wall => [wall.high + wall.gap + reach.left, wall.low - wall.gap - width + reach.left])].filter(fits);
      if (!candidates.length) continue;
      const spanLow = Math.min(...others.map(wall => wall.low)), spanHigh = Math.max(...others.map(wall => wall.high));
      const inside = candidates.filter(x => !others.length || (x - reach.left >= spanLow - PLACEMENT_EPS && x - reach.left + width <= spanHigh + PLACEMENT_EPS));
      const pool = inside.length ? inside : candidates;
      const target = pool.reduce((best, x) => Math.abs(x - box.x) < Math.abs(best - box.x) - PLACEMENT_EPS ? x : best);
      const straight = (): Set<string> => {
        const blockers = overlayBlockers(model);
        return new Set(overlays.filter(link => overlayPath(model, link, blockers).segments.length === 1).map(link => link.id));
      };
      const before = straight(), undo = saveGroups(model, [group]);
      moveGroup(model, group, target - box.x, 0);
      rebuildNodeGeometry(model, group.nodes, 'current');
      const after = straight();
      if ([...before].some(id => !after.has(id))) {
        undo();
        rebuildNodeGeometry(model, group.nodes, 'current');
        placementWarning(model, 'LINKLESS_GROUP_MOVE_REFUSED',
          `Group ${group.id} has no link and stands in the path of a straight overlay chord, but a step out of it would bend another straight overlay link.`, [group.id], 'group');
      }
    }
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
 * `2 * GROUP_PADDING` away, the beside rule; the lanes held in the tier are walls with no gap, as in `sweep`. The same run packer as
 * `sweep` places what falls between two walls.
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
    const walls = [
      ...Object.keys(frames).filter(id => frames[id]!.parent === column.id && !own.has(id) && cellsOf(id).some(cell => model.groups[cell]!.tier === tier))
        .map(id => ({ low: box.get(id)!.x, high: box.get(id)!.x + box.get(id)!.width, gap })),
      ...model.lanes.filter(lane => lane.tier === tier).map(lane => ({ low: lane.bounds.x, high: lane.bounds.x + lane.bounds.width, gap: 0 })),
    ].sort((a, b) => a.low - b.low);
    const low = column.wall!.x + GROUP_PADDING, high = column.wall!.x + column.wall!.width - GROUP_PADDING;
    const item = (group: LayoutGroup): Item => {
      const frame = box.get(group.frame!)!;
      return { id: group.id, want: targets.get(group.id)! - (group.bounds!.x + group.bounds!.width / 2 - frame.x) - 0, width: frame.width };
    };
    const centre = (wall: { low: number; high: number; gap: number }): number => (wall.low + wall.high) / 2;
    const interval = (group: LayoutGroup): number => walls.filter(wall => centre(wall) < targets.get(group.id)!).length;
    const result = new Map<string, number>();
    for (let k = 0; k <= walls.length; k++) {
      const members = movers.filter(group => interval(group) === k).sort((a, b) => targets.get(a.id)! - targets.get(b.id)! || compareId(a.id, b.id));
      if (!members.length) continue;
      const before = walls[k - 1], after = walls[k];
      const solved = packRun(members.map(item), Math.max(low, before ? before.high + before.gap : -Infinity), Math.min(high, after ? after.low - after.gap : Infinity), gap);
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
