import type { Point, Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { groupShape } from './grid.js';
import { selectAnchorTier } from './lanes.js';
import { crosses } from './overlay-paths.js';
import { placementWarning } from './regions.js';
import { bandGap, compareId, nodeGap, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { frameTiers, packTier, unitOrder, type Column } from './columns.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

function readDraft(model: LayoutModel) {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return undefined;
  const overlay = model.links.filter(link => link.layer === 'overlay' && link.attachments);
  if (!overlay.length) return undefined;
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const placed = (node: string): boolean => model.nodes[node]?.bounds !== undefined && groupOf(node).bounds !== undefined && !groupOf(node).flank;
  const tiers = [...new Set(Object.values(model.groups).filter(group => !group.flank && group.nodes.length).map(group => group.tier!))].sort((a, b) => a - b);
  const index = new Map(tiers.map((tier, i) => [tier, i]));
  const tierOf = (node: string): number => index.get(groupOf(node).tier!)!;
  const centre = (node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;

  interface Pair { from: string; to: string; link: LayoutLink }
  const pairs = (links: LayoutLink[]): Pair[] => links.filter(link => placed(link.attachments!.from.node) && placed(link.attachments!.to.node))
    .map(link => ({ from: link.attachments!.from.node, to: link.attachments!.to.node, link }));
  const routed = pairs(model.links.filter(link => link.layer === 'routed' && link.attachments && link.technique !== 'stub'
    && link.attachments.from.node !== link.attachments.to.node));
  const drawn = pairs(overlay);

  // Who pulls whom: routed partners in the adjacent tiers, overlay partners in any other tier.
  const partners = new Map<string, string[]>();
  const pull = (one: string, other: string): void => { partners.set(one, [...(partners.get(one) ?? []), other]); };
  for (const { from, to } of routed) if (Math.abs(tierOf(from) - tierOf(to)) === 1) { pull(from, to); pull(to, from); }
  for (const { from, to } of drawn) if (tierOf(from) !== tierOf(to)) { pull(from, to); pull(to, from); }
  const touched = new Set(drawn.flatMap(pair => [tierOf(pair.from), tierOf(pair.to)]));

  const mean = (values: number[]): number | undefined => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : undefined;
  /** The mean x of the partners of `nodes`, leaving out any partner in `except` (what moves with the nodes). */
  const keyOfNodes = (nodes: string[], except: ReadonlySet<string> = new Set()): number | undefined =>
    mean(nodes.flatMap(node => partners.get(node) ?? []).filter(partner => !except.has(partner)).map(centre));
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= PLACEMENT_EPS;

  // ---- measurement -------------------------------------------------------------------------

  /** Routed crossings in the region between tiers `a` and `b` (indices), links read as straight lines. */
  const regionCrossings = (a: number, b: number): number => {
    const across = routed.filter(pair => Math.min(tierOf(pair.from), tierOf(pair.to)) <= a && Math.max(tierOf(pair.from), tierOf(pair.to)) >= b)
      .map(pair => {
        const [upper, lower] = tierOf(pair.from) <= tierOf(pair.to) ? [pair.from, pair.to] : [pair.to, pair.from];
        const p = tierOf(upper), q = tierOf(lower), top = centre(upper), end = centre(lower);
        const at = (k: number): number => top + (end - top) * (k - p) / (q - p);
        return [at(a), at(b)] as const;
      });
    let count = 0;
    for (const [i, one] of across.entries()) for (const two of across.slice(i + 1)) {
      const upper = same(one[0], two[0]) ? 0 : Math.sign(one[0] - two[0]), lower = same(one[1], two[1]) ? 0 : Math.sign(one[1] - two[1]);
      if (upper * lower < 0) count++;
    }
    return count;
  };
  const bodies = (): Rect[] => Object.keys(model.nodes).filter(placed).map(node => model.nodes[node]!.bounds!);
  /**
   * The rank cells of one sub-tier stand at ELK's own heights on the draft and are top-aligned to one row later,
   * with the ports on the centre line of each node. `rowBoxes` gives every body as it stands on that row; a body
   * that is not in a rank cell stays where it is.
   */
  const rowBoxes = (): Map<string, Rect> => {
    const tops = new Map<number, number>();
    for (const group of Object.values(model.groups)) {
      if (group.frame === undefined || group.flank || group.bounds === undefined || !group.nodes.length) continue;
      const tier = index.get(group.tier!)!;
      tops.set(tier, Math.min(tops.get(tier) ?? Infinity, group.bounds.y));
    }
    return new Map(Object.keys(model.nodes).filter(placed).map(node => {
      const box = model.nodes[node]!.bounds!, group = groupOf(node);
      const shift = group.frame === undefined ? 0 : tops.get(index.get(group.tier!)!)! - group.bounds!.y;
      return [node, { ...box, y: box.y + shift }];
    }));
  };
  /**
   * Whether `pair`, two bodies of one sub-tier of which at least one stands in a rank cell, is one straight
   * segment on the row they will share: no other body of the sub-tier covers the port height between them.
   */
  const straightOnRow = (pair: Pair, rows: Map<string, Rect>): boolean => {
    const one = rows.get(pair.from)!, two = rows.get(pair.to)!;
    const [left, right] = one.x <= two.x ? [one, two] : [two, one];
    const from = { x: left.x + left.width, y: left.y + left.height / 2 }, to = { x: right.x, y: right.y + right.height / 2 };
    return ![...rows].some(([node, box]) => node !== pair.from && node !== pair.to && tierOf(node) === tierOf(pair.from) && crosses(from, to, box));
  };
  const onRow = (pair: Pair): boolean => tierOf(pair.from) === tierOf(pair.to) && (groupOf(pair.from).frame !== undefined || groupOf(pair.to).frame !== undefined);
  /** Whether the overlay link is one straight segment on the draft: no other body on the face-to-face line. */
  const straight = (pair: Pair, boxes: Rect[], rows?: Map<string, Rect>): boolean => {
    if (rows !== undefined && onRow(pair)) return straightOnRow(pair, rows);
    const one = model.nodes[pair.from]!.bounds!, two = model.nodes[pair.to]!.bounds!;
    let from: Point, to: Point;
    if (tierOf(pair.from) !== tierOf(pair.to)) {
      const [upper, lower] = tierOf(pair.from) < tierOf(pair.to) ? [one, two] : [two, one];
      from = { x: upper.x + upper.width / 2, y: upper.y + upper.height }; to = { x: lower.x + lower.width / 2, y: lower.y };
    } else {
      const [left, right] = one.x <= two.x ? [one, two] : [two, one];
      from = { x: left.x + left.width, y: left.y + left.height / 2 }; to = { x: right.x, y: right.y + right.height / 2 };
    }
    return !boxes.some(box => crosses(from, to, box));
  };
  /**
   * The two things a re-order is judged by over the tiers `low` to `high` (indices): the routed crossings of the
   * regions that touch them, and the overlay links that touch or pass over them and are one straight segment.
   * `aligned` reads a link inside one sub-tier, when an end stands in a rank cell, on the row the cells will share,
   * and also counts `blocked`: the routed links inside one sub-tier with a body between their ends.
   */
  const measureRange = (low: number, high: number, aligned = false): { crossings: number; straight: number; blocked: number } => {
    let crossings = 0;
    for (let a = low - 1; a <= high; a++) if (a >= 0 && a + 1 < tiers.length) crossings += regionCrossings(a, a + 1);
    const boxes = bodies(), rows = aligned ? rowBoxes() : undefined;
    const spanning = drawn.filter(pair => Math.min(tierOf(pair.from), tierOf(pair.to)) <= high && Math.max(tierOf(pair.from), tierOf(pair.to)) >= low);
    const inside = rows === undefined ? [] : routed.filter(pair => onRow(pair) && tierOf(pair.from) >= low && tierOf(pair.from) <= high);
    return { crossings, straight: spanning.filter(pair => straight(pair, boxes, rows)).length, blocked: inside.filter(pair => !straightOnRow(pair, rows!)).length };
  };
  const measure = (tier: number): { crossings: number; straight: number; blocked: number } => measureRange(index.get(tier)!, index.get(tier)!);
  /** `items` sorted by key where a key exists; an item with no key keeps its slot, a tie keeps the old order. */
  const reorder = <T>(items: T[], key: (item: T) => number | undefined): T[] => {
    const keys = new Map(items.map(item => [item, key(item)]));
    const queue = items.filter(item => keys.get(item) !== undefined).sort((a, b) => {
      const one = keys.get(a)!, two = keys.get(b)!;
      return same(one, two) ? items.indexOf(a) - items.indexOf(b) : one - two;
    });
    return items.map(item => keys.get(item) === undefined ? item : queue.shift()!);
  };
  return { anchor, tiers, index, tierOf, partners, touched, keyOfNodes, same, measure, measureRange, reorder };
}

/** What both orderings (groups and nodes, and frames) read: the draft's keys, its tiers and its two measures. */

/**
 * Overlay-weighted order (ranked-groups spec, section 3.2, ticket 06).
 *
 * ELK orders the groups of a tier, and the nodes of a group, from the links it is given. It does
 * not weigh the overlay family against the routed one, it counts no straight segment, and it lays
 * an edge between two nodes of one tier out as an in-layer edge that its crossing minimisation
 * hardly reads. This rule takes ELK's order as the start and refines it, once, at the end of the
 * skeleton stage and before `sides-two` reads any position:
 *
 * - **The key** of a group is the mean x of the centres of its partners: the far ends of the routed
 *   links its nodes have into the two adjacent tiers, and of the overlay links its nodes have into
 *   any other tier. A routed and an overlay link weigh the same. The key of a node is the same mean
 *   over its own links. A partner in the same tier is left out: its position moves with the order
 *   this rule is choosing, and a pair of same-tier partners would swap places on every run.
 * - **The sweep** takes the tiers one after the other, from the anchor tier downwards and then from
 *   the anchor tier upwards. The anchor tier keeps ELK's order: it is the fixed reference. A group
 *   with no key keeps its slot; ties keep ELK's order.
 * - **What moves.** A group moves only among the groups around it that can move too. A flank, a bar,
 *   a rank cell, a group that has a child group or a parent group is a wall: it keeps its place and
 *   the groups between two walls are ordered among themselves. The nodes of a `row` group are
 *   ordered when nothing else places them: no flank stands beside the group.
 * - **Acceptance** (spec section 5), per tier and separately for the groups and for the nodes: the
 *   re-order stands only when the routed crossings of the two regions that touch the tier do not
 *   rise and the straight overlay links that touch or pass over the tier do not fall. Both are
 *   measured on the draft, after the tier has been re-packed. A refusal is one warning per tier
 *   (`OVERLAY_ORDER_REFUSED`) and leaves the tier as ELK had it.
 *
 * The draft has no sides and no port order yet, and this rule runs before both: a link is read from
 * the centres of its two bodies, at the faces the tiers imply (a cross-tier overlay link leaves the
 * lower face of the upper body for the upper face of the lower one, a same-tier link rides the
 * row), and a routed link is a straight line between its two body centres. `sides-two` then orders
 * the ports from the order chosen here, so no port order goes stale.
 *
 * A tier that no overlay link touches keeps ELK's order, so an input with no overlay link is
 * untouched.
 */
export function orderByOverlay(model: LayoutModel): void {
  const draft = readDraft(model);
  if (draft === undefined) return;
  const { anchor, tiers, touched, keyOfNodes, measure, reorder } = draft;

  // ---- moving ------------------------------------------------------------------------------

  const parents = new Set(Object.values(model.document.groups).flatMap(group => group.parent === undefined ? [] : [group.parent]));
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  const movable = (group: LayoutGroup): boolean => group.bounds !== undefined && group.nodes.length > 0 && !group.flank
    && group.frame === undefined && !parents.has(group.id) && model.document.groups[group.id]?.parent === undefined
    && model.document.groups[group.id]?.shape !== 'bar';
  const save = (groups: LayoutGroup[]): (() => void) => saveGroups(model, groups);
  /** The least room the skeleton keeps between two groups of a tier: what ELK is given as node spacing. */
  const minGap = spacing.nodeClearance + Math.max(DEFAULT_STROKE_WIDTHS.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
  /** Re-orders the groups of `tier` inside each run between two walls. Returns whether any run changed. */
  const orderGroups = (tier: number): boolean => {
    const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tier && group.bounds)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    const gap = bandGap(model);
    const runs: LayoutGroup[][] = [];
    for (const group of groups) {
      if (!movable(group)) { runs.push([]); continue; }
      if (!runs.length) runs.push([]);
      runs[runs.length - 1]!.push(group);
    }
    // Keys are read before any run moves: the runs of one tier do not read each other.
    const plans = runs.filter(run => run.length > 1).map(run => ({ run, next: reorder(run, group => keyOfNodes(group.nodes)) }))
      .filter(({ run, next }) => next.some((group, i) => group !== run[i]));
    for (const { run, next } of plans) {
      let x = Math.min(...run.map(group => group.bounds!.x));
      for (const group of next) { moveGroup(model, group, x - group.bounds!.x, 0); x += group.bounds!.width + gap; }
    }
    return plans.length > 0;
  };
  /** Re-orders the nodes of every movable `row` group of `tier`; returns whether any group changed. */
  const orderNodes = (tier: number): boolean => {
    let changed = false;
    for (const group of Object.values(model.groups).filter(group => group.tier === tier && movable(group) && !flanked.has(group.id))) {
      const order = group.rowOrder ?? group.nodes;
      if (order.length < 2 || groupShape(model, group.id) !== 'row') continue;
      const next = reorder(order, node => keyOfNodes([node]));
      if (next.every((node, i) => node === order[i])) continue;
      const left = Math.min(...order.map(node => model.nodes[node]!.bounds!.x));
      let need = left;
      for (const [i, node] of next.entries()) need += (i ? nodeGap(model, next[i - 1]!, node) : 0) + model.nodes[node]!.bounds!.width;
      // The box grows to the right and no neighbour is re-packed: a row that would grow past the room
      // the group to its right leaves is refused, so that no two groups of the tier overlap.
      const right = group.bounds!.x + group.bounds!.width, grown = Math.max(right, need + spacing.padding);
      const wall = Math.min(Infinity, ...Object.values(model.groups)
        .filter(other => other !== group && other.tier === tier && other.bounds && other.bounds.x >= right - PLACEMENT_EPS).map(other => other.bounds!.x));
      if (grown > right + PLACEMENT_EPS && grown > wall - minGap) continue;
      let x = left;
      for (const [i, node] of next.entries()) {
        if (i) x += nodeGap(model, next[i - 1]!, node);
        const body = model.nodes[node]!, dx = x - body.bounds!.x;
        body.bounds!.x = x;
        for (const port of body.ports) if (port.anchor) port.anchor.x += dx;
        x += body.bounds!.width;
      }
      group.rowOrder = next;
      group.bounds!.width = Math.max(group.bounds!.width, x + spacing.padding - group.bounds!.x);
      changed = true;
    }
    return changed;
  };

  const at = tiers.indexOf(anchor);
  let moved = false;
  for (const tier of [...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()]) {
    if (!touched.has(tier)) continue;
    const refused: string[] = [];
    for (const step of [orderGroups, orderNodes]) {
      const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tier && group.bounds);
      const before = measure(tier), undo = save(groups);
      if (!step(tier)) continue;
      const after = measure(tier);
      if (after.crossings > before.crossings) refused.push(`routed crossings would rise from ${before.crossings} to ${after.crossings}`);
      else if (after.straight < before.straight) refused.push(`straight overlay links would fall from ${before.straight} to ${after.straight}`);
      else if (after.straight === before.straight && after.crossings === before.crossings) { /* no gain on the draft: ELK's order stands, silently */ }
      else { moved = true; continue; }
      undo();
    }
    if (refused.length) {
      placementWarning(model, 'OVERLAY_ORDER_REFUSED', `The overlay-weighted order of tier ${tier} was refused and ELK's order stands: ${refused.join('; ')}.`,
        Object.values(model.groups).filter(group => !group.flank && group.tier === tier).map(group => group.id), 'group');
    }
  }
  if (moved) rebuildBands(model, false);
}

/**
 * Saves what a re-order or a move can change in `groups` (their boxes, row orders, node bodies and port
 * anchors) and returns the way back. Port pills and labels are not saved: a caller that has drawn
 * them refreshes them after the way back, with `rebuildNodeGeometry`.
 */
export function saveGroups(model: LayoutModel, groups: LayoutGroup[]): () => void {
  const copy = JSON.stringify(groups.map(group => ({ id: group.id, bounds: group.bounds, rowOrder: group.rowOrder,
    nodes: group.nodes.map(node => ({ id: node, bounds: model.nodes[node]!.bounds, anchors: model.nodes[node]!.ports.map(port => port.anchor) })) })));
  return () => {
    for (const saved of JSON.parse(copy) as { id: string; bounds: Rect; rowOrder?: string[];
      nodes: { id: string; bounds: Rect; anchors: (Point | undefined)[] }[] }[]) {
      const group = model.groups[saved.id]!;
      group.bounds = saved.bounds;
      if (saved.rowOrder) group.rowOrder = saved.rowOrder; else delete group.rowOrder;
      for (const node of saved.nodes) {
        model.nodes[node.id]!.bounds = node.bounds;
        model.nodes[node.id]!.ports.forEach((port, i) => { if (node.anchors[i]) port.anchor = node.anchors[i]!; });
      }
    }
  };
}

/**
 * Overlay-weighted order of frames (ranked-groups spec, section 3.2, ticket 06b). A frame is an
 * ordering unit like a one-rank group, and it moves as a column: every cell shifts by the same dx and
 * its width is its column (ticket 09). Call it after `packFrameColumns` (the widths are known then) and
 * before `sides-two`; it re-packs the tiers it changes, so the columns stay disjoint, and it keeps
 * `columns` up to date. Returns whether any tier changed.
 *
 * - **The key** of a frame is the mean x of the partners of all the nodes of its cells: the routed
 *   partners in the adjacent sub-tiers and the overlay partners in any other sub-tier, equal weight,
 *   as in `orderByOverlay`. A partner in the same sub-tier is left out, and so is a partner inside the
 *   frame itself: it moves with the frame and only pulls the key toward the frame's own place.
 * - **The order** is that of the rank-0 cell in the document tier (ELK's order). The frames of a
 *   tier take the places the frames of the tier hold, in the order of their keys; a frame with no key
 *   keeps its place and ties keep ELK's order. A one-rank group keeps its place: the groups of the
 *   tier were ordered before, and are the walls here, as are a frame with a bar, a grid or a flanked cell.
 * - **The sweep** is the one of `orderByOverlay`, over the document tiers: from the anchor tier
 *   downwards, then upwards. A tier that holds the anchor sub-tier keeps ELK's order.
 * - **Acceptance** is per document tier with the two proxies of `orderByOverlay`, measured over all
 *   the sub-tiers of the tier: the routed crossings of the regions that touch it do not rise and the
 *   straight overlay links over it do not fall, one of the two improves. A third term guards the
 *   routed links inside one sub-tier (an end in a rank cell): the number that have a body between their
 *   ends does not rise. A link inside a sub-tier is read on the row the rank cells will share (the cells
 *   are top-aligned, the ports stand on the centre line of a node), so a body blocks it only when it
 *   covers the height of the link. A refusal is one warning per tier.
 */
export function orderFramesByOverlay(model: LayoutModel, columns: Map<string, Column>): boolean {
  const draft = readDraft(model);
  if (draft === undefined) return false;
  const { anchor, tiers, index, touched, keyOfNodes, measureRange, reorder } = draft;
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  const free = (unit: { frame: boolean; groups: LayoutGroup[] }): boolean => unit.frame && unit.groups.every(group => group.bounds !== undefined
    && groupShape(model, group.id) === 'row' && !flanked.has(group.id) && model.document.groups[group.id]?.shape !== 'bar');
  /** The indices in `tiers` of the first and the last sub-tier from `low` to `high`. */
  const span = (low: number, high: number): [number, number] => {
    const inside = tiers.filter(tier => tier >= low && tier <= high).map(tier => index.get(tier)!);
    return [Math.min(...inside), Math.max(...inside)];
  };

  const all = frameTiers(model).filter(tier => tier.every(unit => unit.groups.every(group => group.bounds !== undefined)));
  type Tier = typeof all[number];
  const low = (tier: Tier): number => Math.min(...tier.map(unit => unit.low)), high = (tier: Tier): number => Math.max(...tier.map(unit => unit.high));
  const sweep = [...all.filter(tier => low(tier) > anchor), ...all.filter(tier => high(tier) < anchor).reverse()];
  let moved = false;
  for (const tier of sweep) {
    const [from, to] = span(low(tier), high(tier));
    if (![...touched].some(at => at >= from && at <= to)) continue;
    const members = [...tier].sort((a, b) => unitOrder(a) - unitOrder(b) || compareId(a.id, b.id));
    const movable = members.filter(free);
    if (movable.length < 2) continue;
    const keyOf = (unit: Tier[number]): number | undefined => {
      const inside = new Set(unit.groups.flatMap(group => group.nodes));
      return keyOfNodes([...inside], inside);
    };
    const next = reorder(movable, keyOf);
    if (next.every((unit, i) => unit === movable[i])) continue;
    // The frames take the places of the frames, in the new order; every other unit keeps its place.
    const places = movable.map(unitOrder), sequence = new Map(next.map((unit, i) => [unit.id, places[i]!]));
    const groups = tier.flatMap(unit => unit.groups);
    const cells = new Map(groups.map(group => [group.id, columns.get(group.id)]));
    const undo = saveGroups(model, groups);
    const before = measureRange(from, to, true);
    packTier(model, tier, columns, sequence);
    const after = measureRange(from, to, true);
    let refusal: string | undefined;
    if (after.crossings > before.crossings) refusal = `routed crossings would rise from ${before.crossings} to ${after.crossings}`;
    else if (after.blocked > before.blocked) refusal = `routed links with a body between their ends would rise from ${before.blocked} to ${after.blocked}`;
    else if (after.straight < before.straight) refusal = `straight overlay links would fall from ${before.straight} to ${after.straight}`;
    else if (after.straight === before.straight && after.crossings === before.crossings && after.blocked === before.blocked) { /* no gain on the draft: ELK's order stands, silently */ }
    else { moved = true; continue; }
    undo();
    for (const [id, column] of cells) if (column === undefined) columns.delete(id); else columns.set(id, column);
    // One warning per tier: `orderByOverlay` may have refused the groups of a tier this order of frames covers.
    const warned = (): boolean => model.diagnostics.some(item => item.code === 'OVERLAY_ORDER_REFUSED' && [...item.message.matchAll(/order of tier (\d+) /g)]
      .some(found => Number(found[1]) >= low(tier) && Number(found[1]) <= high(tier)));
    if (refusal !== undefined && !warned()) {
      placementWarning(model, 'OVERLAY_ORDER_REFUSED', `The overlay-weighted order of the frames of sub-tiers ${low(tier)} to ${high(tier)} was refused and ELK's order stands: ${refusal}.`,
        movable.map(unit => unit.id), 'group');
    }
  }
  return moved;
}
