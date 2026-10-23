import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { busPortKeys, farCoordinate, lanePitchFloors, portPeers, seatAuthored, sortFace } from './sides-two.js';
import { groupShape } from './grid.js';
import { corridorReader, corridorSide, directPlan, fixedSourceGroups, laneSource, laneWidth, ownsTransitLanes, selectAnchorTier, transitedCore, transitTiers } from './lanes.js';
import { crosses } from './overlay-paths.js';
import { placementWarning } from './regions.js';
import { bandGap, compareId, nodeGap, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { findPort } from './row-paths.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { cellReach, foreignRoot } from './frames.js';
import { frameSubtreeCells } from '../model/model.js';
import { frameTiers, packTier, unitOrder, type Column } from './columns.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { isCantonUnit } from './read/canton.js';
import { overlayCourse } from './courses.js';

/** Two placed nodes that a link joins, and the link. */
export interface Pair { from: string; to: string; link: LayoutLink }

/** The stage-4 draft as the orders read it: its tiers and keys, and the measures that judge a re-order. */
export function readDraft(model: LayoutModel) {
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return undefined;
  // A bus member is neither straight nor bent (mesh-bus.md, section 4): it is no straight overlay link to keep, and its pairs are
  // satisfied by contiguity, which `rowTools` reads from `busDrawn`.
  const overlay = model.links.filter(link => link.layer === 'overlay' && link.attachments && link.meshBus === undefined && !overlayCourse(model, link));
  const members = model.links.filter(link => link.layer === 'overlay' && link.attachments && link.meshBus !== undefined);
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const placed = (node: string): boolean => model.nodes[node]?.bounds !== undefined && groupOf(node).bounds !== undefined && !groupOf(node).flank;
  const tiers = [...new Set(Object.values(model.groups).filter(group => !group.flank && group.nodes.length).map(group => group.tier!))].sort((a, b) => a - b);
  const index = new Map(tiers.map((tier, i) => [tier, i]));
  const tierOf = (node: string): number => index.get(groupOf(node).tier!)!;
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  /** Whether a group is a plain row: no flank, no flanked group, no bar, no grid. Only two bodies of such rows can be neighbours on a row. */
  const isRow = (group: LayoutGroup): boolean => !group.flank && !flanked.has(group.id) && groupShape(model, group.id) === 'row' && model.document.groups[group.id]?.shape !== 'bar';
  const centre = (node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;

  const pairs = (links: LayoutLink[]): Pair[] => links.filter(link => placed(link.attachments!.from.node) && placed(link.attachments!.to.node))
    .map(link => ({ from: link.attachments!.from.node, to: link.attachments!.to.node, link }));
  const routed = pairs(model.links.filter(link => link.layer === 'routed' && link.attachments && link.technique !== 'stub'
    && link.attachments.from.node !== link.attachments.to.node));
  const drawn = pairs(overlay), busDrawn = pairs(members);

  // Who pulls whom: routed partners in the adjacent tiers, overlay partners in any other tier.
  const partners = new Map<string, string[]>();
  const pull = (one: string, other: string): void => { partners.set(one, [...(partners.get(one) ?? []), other]); };
  for (const { from, to } of routed) if (Math.abs(tierOf(from) - tierOf(to)) === 1) { pull(from, to); pull(to, from); }
  for (const { from, to } of drawn) if (tierOf(from) !== tierOf(to)) { pull(from, to); pull(to, from); }
  const touched = new Set([...drawn, ...busDrawn].flatMap(pair => [tierOf(pair.from), tierOf(pair.to)]));

  const mean = (values: number[]): number | undefined => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : undefined;
  /** The mean x of the partners of `nodes`, leaving out any partner in `except` (what moves with the nodes). */
  const keyOfNodes = (nodes: string[], except: ReadonlySet<string> = new Set()): number | undefined =>
    mean(nodes.flatMap(node => partners.get(node) ?? []).filter(partner => !except.has(partner)).map(centre));
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= PLACEMENT_EPS;

  // ---- measurement -------------------------------------------------------------------------

  // `layout.corridorRowOrder: false` keeps the measure of main as well (ticket 17): no transit link is cut at a corridor.
  const cut = model.document.layout?.corridorRowOrder !== false;
  const corridors = corridorReader(model), fixed = fixedSourceGroups(model);
  // The bus ports do not change with a candidate's geometry, so one set serves every measurement (`sortFace`).
  const peers = portPeers(model), floors = lanePitchFloors(model), buses = busPortKeys(model);
  /** A port's side as stage 3 reads it: the decided side, else the sizing estimate (a shared port stage 2 deferred, a mesh-bus port). */
  const sideOf = (port: LayoutPort | undefined): Side | undefined => port?.side ?? port?.sizingSide;
  /**
   * What one measurement reads again and again on one geometry: the groups of each sub-tier left to right, and the predicted x of each
   * port. `measureRange` empties it, because a candidate moves the geometry between two measurements.
   */
  const memo = { groups: new Map<number, LayoutGroup[]>(), port: new Map<string, number>() };
  const groupsAt = (tier: number): LayoutGroup[] => {
    let list = memo.groups.get(tier);
    if (list === undefined) {
      list = Object.values(model.groups).filter(group => group.tier === tier && group.bounds !== undefined && group.nodes.length)
        .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
      memo.groups.set(tier, list);
    }
    return list;
  };
  /**
   * The x a port on a top or bottom face is predicted to hold (ticket 17 and its follow-up). The draft has no final port x yet: `sides-two`
   * centres the ports of a face over the node at the face's pitch, in its provisional engine order, and gives the face of an alignment
   * end at least the lane width as pitch. This reads that order with the same functions (`farCoordinate`, `sortFace`, `seatAuthored`,
   * `lanePitchFloors`; R1) on the draft, without the planned first turns (stage 5 plans them later) and without a bundle's pitch. A port is on
   * the face of its side, else of its sizing side (`sideOf`, as stage 3 reads it); one whose side is not `top` or `bottom` is read at its
   * node centre. Links that share a node meet at their own ports, not at one centre:
   * the order of their ports decides whether they cross.
   */
  const portX = (ref: PortRef): number => {
    const id = portId(ref), known = memo.port.get(id);
    if (known !== undefined) return known;
    const node = model.nodes[ref.node]!, side = sideOf(findPort(model, ref));
    if (side !== 'top' && side !== 'bottom') {
      memo.port.set(id, centre(ref.node));
      return centre(ref.node);
    }
    // The whole face at once: one order gives the x of each of its ports.
    const ports = node.ports.filter(port => sideOf(port) === side);
    const face = seatAuthored(sortFace(model, ports, new Map(ports.map(port => [port, { far: farCoordinate(model, peers, port.ref, side) }])), buses));
    const pitch = Math.max(node.sidePitch?.[side] ?? 0, floors.get(`${ref.node}\u0000${side}`)?.width ?? 0);
    face.forEach((port, at) => memo.port.set(portId(port.ref), centre(ref.node) + (at - (face.length - 1) / 2) * pitch));
    return memo.port.get(id)!;
  };
  /** The x the alignment end of a transit link is predicted to hold. */
  const sourceX = (link: LayoutLink): number => portX(laneSource(model, link));
  /**
   * The x of the corridor a transit link is predicted to hold in the sub-tier `k` (index) it crosses (ticket 17), as 7a reserves it:
   * beside the main group of that sub-tier nearest the source. The side is the one of 7a's direct plan at the source x (`directPlan`,
   * the same function, with the draft boxes and the groups 7a holds), which faces the target where it can; where no direct plan exists,
   * 7a keeps the side the source asks for. The target is read at its node centre. A prediction of 7a, not its answer. Undefined when the
   * sub-tier holds no main group.
   */
  const corridorX = (link: LayoutLink, k: number): number | undefined => {
    const tier = tiers[k]!, sx = sourceX(link), groups = groupsAt(tier), main = groups.filter(group => !group.flank);
    const core = transitedCore(main, sx);
    if (core === undefined) return undefined;
    const box = core.bounds!, far = corridors.target(link, tier), width = laneWidth(model, link), half = width / 2;
    const wanted = far === undefined ? undefined : corridorSide(box, sx, centre(far.node)), at = groups.indexOf(core);
    const plan = directPlan(group => group.bounds!, groups, at, wanted, sx, width, [], fixed);
    const side = plan === undefined ? corridorSide(box, sx) : plan.split <= at ? 'left' : 'right';
    return side === 'left' ? Math.min(sx, box.x - half) : Math.max(sx, box.x + box.width + half);
  };
  /**
   * Routed crossings in the region between tiers `a` and `b` (indices). A link is read as a straight line between its two ends at
   * their predicted ports (`portX`; at the body centres under `layout.corridorRowOrder: false`), except a link that owns transit lanes: it is cut at its predicted corridor in each sub-tier it crosses, one straight
   * piece per tier gap (ticket 17), because 7a puts the run beside the transited group, not on the diagonal. A link that passes a frame
   * it is foreign to keeps the diagonal (`passesFrame`).
   */
  /**
   * Whether a link is foreign to a frame cell of a sub-tier it crosses. 7a passes such a link outside the frame at one x, by a gap choice
   * over the frame roots this draft does not hold (the frame columns are packed later), so the link keeps the diagonal of main's measure
   * (ticket 17 review, R1: no second copy of 7a's gap choice). The answer does not depend on geometry, so it is kept for the whole step.
   */
  const passing = new Map<LayoutLink, boolean>();
  const passesFrame = (link: LayoutLink): boolean => {
    let known = passing.get(link);
    if (known === undefined) {
      const crossed = new Set(transitTiers(model, link));
      known = Object.values(model.groups).some(group => group.tier !== undefined && crossed.has(group.tier) && foreignRoot(model, group.id, link) !== undefined);
      passing.set(link, known);
    }
    return known;
  };
  const regionCrossings = (a: number, b: number): number => {
    const across = routed.filter(pair => Math.min(tierOf(pair.from), tierOf(pair.to)) <= a && Math.max(tierOf(pair.from), tierOf(pair.to)) >= b)
      .map(pair => {
        const { from, to } = pair.link.attachments!;
        const [upper, lower] = tierOf(pair.from) <= tierOf(pair.to) ? [from, to] : [to, from];
        // The ends at their predicted ports where the corridors are read, at the body centres as on main under the setting (ticket 17).
        const p = tierOf(upper.node), q = tierOf(lower.node), top = cut ? portX(upper) : centre(upper.node), end = cut ? portX(lower) : centre(lower.node);
        const owns = cut && q - p > 1 && ownsTransitLanes(model, pair.link) && !passesFrame(pair.link);
        const at = (k: number): number => (owns && k > p && k < q ? corridorX(pair.link, k) : undefined) ?? top + (end - top) * (k - p) / (q - p);
        return [at(a), at(b)] as const;
      });
    let count = 0;
    for (const [i, one] of across.entries()) for (const two of across.slice(i + 1)) {
      const upper = same(one[0], two[0]) ? 0 : Math.sign(one[0] - two[0]), lower = same(one[1], two[1]) ? 0 : Math.sign(one[1] - two[1]);
      if (upper * lower < 0) count++;
    }
    return count;
  };
  /**
   * The sub-tiers (indices) a re-order of the rows of `groups` can change the routed crossings of: their own, and every sub-tier a routed
   * link spans that has an end in them or crosses one of their sub-tiers. A turned row moves the source x and the target of such a link,
   * and with them its corridor in every sub-tier it crosses (ticket 17 review).
   */
  const reach = (groups: readonly LayoutGroup[]): [number, number] => {
    const own = new Set(groups.flatMap(group => group.nodes)), at = new Set(groups.map(group => index.get(group.tier!)!));
    let low = Math.min(...at), high = Math.max(...at);
    for (const pair of routed) {
      const p = Math.min(tierOf(pair.from), tierOf(pair.to)), q = Math.max(tierOf(pair.from), tierOf(pair.to));
      if (own.has(pair.from) || own.has(pair.to) || [...at].some(k => k > p && k < q)) { low = Math.min(low, p); high = Math.max(high, q); }
    }
    return [low, high];
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
  const measureRange = (low: number, high: number, aligned = false, crossOnly = false): { crossings: number; straight: number; blocked: number } => {
    memo.groups.clear(); memo.port.clear();
    let crossings = 0;
    for (let a = low - 1; a <= high; a++) if (a >= 0 && a + 1 < tiers.length) crossings += regionCrossings(a, a + 1);
    const boxes = bodies(), rows = aligned ? rowBoxes() : undefined;
    const spanning = drawn.filter(pair => !(crossOnly && tierOf(pair.from) === tierOf(pair.to) && isRow(groupOf(pair.from)) && isRow(groupOf(pair.to))) && Math.min(tierOf(pair.from), tierOf(pair.to)) <= high && Math.max(tierOf(pair.from), tierOf(pair.to)) >= low);
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
  return { anchor, tiers, index, tierOf, groupOf, drawn, busDrawn, centre, isRow, partners, touched, keyOfNodes, same, measure, measureRange, reach, reorder, portX };
}

/** What both orderings (groups and nodes, and frames) read: the draft's keys, its tiers and its two measures. */

/**
 * Puts the nodes of a row group in the order `next`, left to right from the left edge of the row, and keeps the ports on their nodes.
 * With `grow` the box may grow to the right, as far as the group to its right leaves room; without it a row that needs more room than
 * it has is refused (a frame cell stands in a column whose width is fixed). Returns whether the row was seated.
 */
export function reseatRow(model: LayoutModel, group: LayoutGroup, next: string[], grow: boolean): boolean {
  const order = group.rowOrder ?? group.nodes;
  const left = Math.min(...order.map(node => model.nodes[node]!.bounds!.x));
  let need = left;
  for (const [i, node] of next.entries()) need += (i ? nodeGap(model, next[i - 1]!, node) : 0) + model.nodes[node]!.bounds!.width;
  // The box grows to the right and no neighbour is re-packed: a row that would grow past the room
  // the group to its right leaves is refused, so that no two groups of the tier overlap.
  const right = group.bounds!.x + group.bounds!.width, grown = Math.max(right, need + spacing.padding);
  if (grown > right + PLACEMENT_EPS) {
    // The least room the skeleton keeps between two groups of a tier: what ELK is given as node spacing.
    const minGap = spacing.nodeClearance + Math.max(DEFAULT_STROKE_WIDTHS.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
    const wall = Math.min(Infinity, ...Object.values(model.groups)
      .filter(other => other !== group && other.tier === group.tier && other.bounds && other.bounds.x >= right - PLACEMENT_EPS).map(other => other.bounds!.x));
    if (!grow || grown > wall - minGap) return false;
  }
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
  return true;
}

/**
 * What both orderings share for ticket 78, the order of a row by its overlay partners. A same-row link is one straight segment
 * only when its two ends are neighbours on the row, so the row is ordered to put linked bodies next to each other.
 */
function rowTools(model: LayoutModel, draft: NonNullable<ReturnType<typeof readDraft>>) {
  const { tierOf, drawn, busDrawn, centre, index, reorder, measureRange, isRow } = draft;
  /** The overlay links whose two ends stand in one tier, as node pairs; the members of a bus among them (contiguity satisfies them). */
  const sameRow = [...drawn, ...busDrawn].filter(pair => pair.from !== pair.to && tierOf(pair.from) === tierOf(pair.to));
  const linksBetween = (one: string[], two: string[]): number => sameRow.filter(pair =>
    (one.includes(pair.from) && two.includes(pair.to)) || (one.includes(pair.to) && two.includes(pair.from))).length;
  /** The mean x of the same-tier partners of `nodes` that stand outside `inside`. */
  const outsideKey = (nodes: string[], inside: ReadonlySet<string>): number | undefined => {
    const xs = sameRow.flatMap(pair => nodes.includes(pair.from) && !inside.has(pair.to) ? [centre(pair.to)]
      : nodes.includes(pair.to) && !inside.has(pair.from) ? [centre(pair.from)] : []);
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : undefined;
  };
  /**
   * Fragments of `items` in which linked ones stand next to each other. A fragment is grown from the heaviest pair down
   * (an item takes at most two neighbours and a pair never closes a ring); a tie keeps the old order. A fragment keeps
   * the direction it had, and the fragments stand where the mean old place of their items was.
   */
  const chain = <T>(items: T[], weight: (one: T, two: T) => number): T[][] => {
    const edges = items.flatMap((one, i) => items.slice(i + 1).map((two, k) => ({ i, j: i + 1 + k, w: weight(one, two) })))
      .filter(edge => edge.w > 0).sort((a, b) => b.w - a.w || a.i - b.i || a.j - b.j);
    const parent = items.map((_, i) => i), root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]!));
    const next = new Map<number, number[]>(items.map((_, i) => [i, []]));
    for (const { i, j } of edges) {
      if (next.get(i)!.length > 1 || next.get(j)!.length > 1 || root(i) === root(j)) continue;
      parent[root(i)] = root(j); next.get(i)!.push(j); next.get(j)!.push(i);
    }
    const seen = new Set<number>(), fragments: number[][] = [];
    for (const start of items.keys()) {
      if (seen.has(start) || next.get(start)!.length > 1) continue;
      const path = [start];
      seen.add(start);
      for (let at = start, prev = -1; ;) {
        const step = next.get(at)!.find(k => k !== prev);
        if (step === undefined) break;
        prev = at; at = step; path.push(at); seen.add(at);
      }
      fragments.push(path[0]! <= path[path.length - 1]! ? path : path.reverse());
    }
    const place = (fragment: number[]): number => fragment.reduce((sum, i) => sum + i, 0) / fragment.length;
    return fragments.sort((a, b) => place(a) - place(b) || a[0]! - b[0]!).map(fragment => fragment.map(i => items[i]!));
  };
  /** The nodes of a row, chained by the overlay links inside it; a chain leans toward its partners outside the row. */
  const chainNodes = (standing: string[]): string[] => {
    const order = [...standing].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x || standing.indexOf(a) - standing.indexOf(b));
    const inside = new Set(order);
    const fragments = chain(order, (one, two) => linksBetween([one], [two])).map(fragment => {
      const first = outsideKey([fragment[0]!], inside), last = outsideKey([fragment[fragment.length - 1]!], inside);
      return first !== undefined && last !== undefined && first > last ? [...fragment].reverse() : fragment;
    });
    return reorder(fragments, fragment => outsideKey(fragment, inside)).flat();
  };
  /**
   * The same-row overlay links over the sub-tiers `low` to `high` (indices) that stand between neighbours on the row. The draft has not
   * levelled the rows yet (ELK layers a row group on several heights), so a link is read from the order the bodies will stand in: the
   * groups by x, the nodes of a group by its row order. Only a link between two nodes of row groups counts.
   */
  const adjacent = (low: number, high: number): number => {
    let count = 0;
    for (let here = low; here <= high; here++) {
      const sequence = Object.values(model.groups).filter(group => !group.flank && index.get(group.tier!) === here && group.bounds && group.nodes.length)
        .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id))
        .flatMap(group => (group.rowOrder ?? [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x))
          .map(node => ({ node, row: isRow(group) })));
      const at = new Map(sequence.map((entry, i) => [entry.node, i]));
      count += sameRow.filter(pair => tierOf(pair.from) === here && sequence[at.get(pair.from)!]?.row && sequence[at.get(pair.to)!]?.row
        && Math.abs(at.get(pair.from)! - at.get(pair.to)!) === 1).length;
    }
    return count;
  };
  /** The measures a chained order is judged by: the acceptance of the draft (cross-tier links only) and the neighbours on the row. */
  const readChain = (low: number, high: number): ReturnType<typeof measureRange> & { near: number } =>
    ({ ...measureRange(low, high, true, true), near: adjacent(low, high) });
  /** Whether a chained order stands: routed crossings, blocked routed links and straight cross-tier links do not worsen, and more row links are neighbours. */
  const gains = (before: ReturnType<typeof readChain>, after: ReturnType<typeof readChain>): boolean =>
    after.crossings <= before.crossings && after.blocked <= before.blocked && after.straight >= before.straight && after.near > before.near;
  return { sameRow, linksBetween, chain, chainNodes, isRow, adjacent, readChain, gains };
}

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
 *   the anchor tier upwards. The key order leaves the anchor tier as ELK had it: it is the fixed reference
 *   of the sweep. Ticket 78 chains its rows by same-row partners first (see below). A group with no key
 *   keeps its slot; ties keep ELK's order.
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
 * row), and a routed link is a straight line between its two ends at the port x `sides-two` will give them on a top or bottom face
 * (`readDraft`, ticket 17 follow-up; at the body centres under `layout.corridorRowOrder: false`). `sides-two` then orders
 * the ports from the order chosen here, so no port order goes stale.
 *
 * **Row partners** (ticket 78). After the key order, and for the anchor tier before the sweep, the groups of a
 * run and the nodes of a `row` group are chained by their same-tier overlay links, so that linked bodies stand
 * next to each other and the link is one straight segment. This step is judged by a third term: the routed
 * crossings and blocked routed links do not rise, the cross-tier straight links (a same-tier link counts there
 * only when it touches a group that is not a plain row) do not fall, and the count of same-row linked pairs that
 * stand next to each other rises. A refusal is silent.
 *
 * A tier that no overlay link touches keeps ELK's order, so an input with no overlay link is
 * untouched.
 */
/**
 * Which groups a stage-4 order may move. `movable`: a group with nodes that is no flank, no frame cell, no bar, and has no parent
 * group and no child group. `freeRow`: a movable `row` group that no flank stands beside, so no rule but the order places its nodes.
 * `orderByOverlay` and `orderByCorridors` (ticket 17) read these two, so the two orders agree on what is free.
 */
export function orderTools(model: LayoutModel): { movable: (group: LayoutGroup) => boolean; freeRow: (group: LayoutGroup) => boolean } {
  const parents = new Set(Object.values(model.document.groups).flatMap(group => group.parent === undefined ? [] : [group.parent]));
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  const movable = (group: LayoutGroup): boolean => group.bounds !== undefined && group.nodes.length > 0 && !group.flank
    && group.frame === undefined && !parents.has(group.id) && model.document.groups[group.id]?.parent === undefined
    && model.document.groups[group.id]?.shape !== 'bar';
  const freeRow = (group: LayoutGroup): boolean => movable(group) && !flanked.has(group.id) && groupShape(model, group.id) === 'row';
  return { movable, freeRow };
}

export function orderByOverlay(model: LayoutModel): void {
  const draft = readDraft(model);
  if (draft === undefined) return;
  const { anchor, tiers, touched, keyOfNodes, measure, index, tierOf, reorder } = draft;

  // ---- moving ------------------------------------------------------------------------------

  const { movable, freeRow } = orderTools(model);
  const save = (groups: LayoutGroup[]): (() => void) => saveGroups(model, groups);
  /** Re-orders the groups of `tier` inside each run between two walls. Returns whether any run changed. */
  const orderGroups = (tier: number, pick: (run: LayoutGroup[]) => LayoutGroup[] = run => reorder(run, group => keyOfNodes(group.nodes))): boolean => {
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
    const plans = runs.filter(run => run.length > 1).map(run => ({ run, next: pick(run) }))
      .filter(({ run, next }) => next.some((group, i) => group !== run[i]));
    for (const { run, next } of plans) {
      let x = Math.min(...run.map(group => group.bounds!.x));
      for (const group of next) { moveGroup(model, group, x - group.bounds!.x, 0); x += group.bounds!.width + gap; }
    }
    return plans.length > 0;
  };
  /** Re-orders the nodes of every movable `row` group of `tier`; returns whether any group changed. */
  const orderNodes = (tier: number, pick: (group: LayoutGroup, order: string[]) => string[] = (_group, order) => reorder(order, node => keyOfNodes([node]))): boolean => {
    let changed = false;
    for (const group of Object.values(model.groups).filter(group => group.tier === tier && freeRow(group))) {
      const order = group.rowOrder ?? group.nodes;
      if (order.length < 2) continue;
      const next = pick(group, order);
      if (next.every((node, i) => node === order[i])) continue;
      if (!reseatRow(model, group, next, true)) continue;
      changed = true;
    }
    return changed;
  };

  // ---- same-row partners (ticket 78) --------------------------------------------------------

  const tools = rowTools(model, draft);
  /** The groups of a run, chained by the same-row overlay links between them. */
  const chainGroups = (run: LayoutGroup[]): LayoutGroup[] => tools.chain(run, (one, two) => tools.linksBetween(one.nodes, two.nodes)).flat();
  const chainRow = (_group: LayoutGroup, order: string[]): string[] => tools.chainNodes(order);

  const at = tiers.indexOf(anchor);
  let moved = false;
  for (const tier of [anchor, ...tiers.slice(at + 1), ...tiers.slice(0, at).reverse()]) {
    if (!touched.has(tier)) continue;
    const refused: string[] = [];
    const here = index.get(tier)!, partnered = tools.sameRow.some(pair => tierOf(pair.from) === here);
    const steps: { run: () => boolean; chained: boolean }[] = [
      { run: () => orderGroups(tier), chained: false },
      { run: () => orderNodes(tier), chained: false },
      { run: () => orderGroups(tier, chainGroups), chained: true },
      { run: () => orderNodes(tier, chainRow), chained: true },
    ];
    for (const step of steps) {
      if (step.chained ? !partnered : tier === anchor) continue;
      const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tier && group.bounds);
      if (step.chained) {
        // Ticket 78: the partners of a row stand together only when more of its overlay links are one straight segment and nothing else worsens.
        const before = tools.readChain(here, here), undo = save(groups);
        if (!step.run()) continue;
        if (tools.gains(before, tools.readChain(here, here))) moved = true; else undo();
        continue;
      }
      const before = measure(tier), undo = save(groups);
      if (!step.run()) continue;
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
 *   downwards, then upwards. The key order leaves a tier that holds the anchor sub-tier as ELK had it;
 *   only the row partners step (ticket 78, below) re-orders it, before the sweep.
 * - **Row partners** (ticket 78): the plain frames of a run, the members of a canton that stand beside each
 *   other and the nodes of each rank cell are chained by their same-sub-tier overlay links. Canton order never
 *   changes. The step stands only when the routed crossings and the blocked routed links do not rise, the
 *   cross-tier straight links do not fall, and the count of same-row linked pairs that are neighbours rises
 *   (the third term, `near`). A refusal is silent.
 * - **Acceptance** of the key order is per document tier with the two proxies of `orderByOverlay`, measured over all
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
  const { anchor, tiers, index, touched, partners, keyOfNodes, measureRange, reorder, tierOf } = draft;
  const tools = rowTools(model, draft);
  const flanked = new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));
  const free = (unit: { frame: boolean; groups: LayoutGroup[] }): boolean => unit.frame && unit.groups.every(group => group.bounds !== undefined
    && groupShape(model, group.id) === 'row' && !flanked.has(group.id) && model.document.groups[group.id]?.shape !== 'bar');
  /** The indices in `tiers` of the first and the last sub-tier from `low` to `high`. */
  const span = (low: number, high: number): [number, number] => {
    const inside = tiers.filter(tier => tier >= low && tier <= high).map(tier => index.get(tier)!);
    return [Math.min(...inside), Math.max(...inside)];
  };

  const frames = model.document.frames ?? {};
  const isCanton = (unit: { id: string; frame: boolean }): boolean => isCantonUnit(model, unit);
  const centreOf = (node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;
  const all = frameTiers(model).filter(tier => tier.every(unit => unit.groups.every(group => group.bounds !== undefined)));
  type Tier = typeof all[number];
  type Unit = Tier[number];
  const low = (tier: Tier): number => Math.min(...tier.map(unit => unit.low)), high = (tier: Tier): number => Math.max(...tier.map(unit => unit.high));
  const sweep = [...all.filter(tier => low(tier) > anchor), ...all.filter(tier => high(tier) < anchor).reverse()];
  let moved = false;

  /** The units of a tier from left to right as they stand. */
  const standing = (tier: Tier): Unit[] => [...tier].sort((a, b) => unitOrder(a) - unitOrder(b) || compareId(a.id, b.id));
  /** One warning per tier: `orderByOverlay` may have refused the groups of a tier this order of frames covers. */
  const warnedTiers = new Set<Tier>();
  const warned = (tier: Tier): boolean => warnedTiers.has(tier) || model.diagnostics.some(item => item.code === 'OVERLAY_ORDER_REFUSED' && [...item.message.matchAll(/order of tier (\d+) /g)]
    .some(found => Number(found[1]) >= low(tier) && Number(found[1]) <= high(tier)));
  /** The three conditions of the acceptance: the refusal, `''` when the result changes nothing, `undefined` when it gains. */
  const judge = (before: ReturnType<typeof measureRange>, after: ReturnType<typeof measureRange>): string | undefined => {
    if (after.crossings > before.crossings) return `routed crossings would rise from ${before.crossings} to ${after.crossings}`;
    if (after.blocked > before.blocked) return `routed links with a body between their ends would rise from ${before.blocked} to ${after.blocked}`;
    if (after.straight < before.straight) return `straight overlay links would fall from ${before.straight} to ${after.straight}`;
    if (after.straight === before.straight && after.crossings === before.crossings && after.blocked === before.blocked) return ''; // no gain on the draft: ELK's order stands, silently
    return undefined;
  };
  /**
   * Packs `tier` again with the places of `sequence` and keeps the result when the acceptance holds. Returns the refusal when it
   * was refused for a reason worth a warning, and `undefined` when it stands or changed nothing.
   */
  const settle = (tier: Tier, sequence: ReadonlyMap<string, number>, from: number, to: number, structural = false): string | undefined => {
    const groups = tier.flatMap(unit => unit.groups);
    const cells = new Map(groups.map(group => [group.id, columns.get(group.id)]));
    const undo = saveGroups(model, groups);
    const before = measureRange(from, to, true);
    packTier(model, tier, columns, sequence);
    const verdict = judge(before, measureRange(from, to, true));
    // A move of the shape stands when it gains nothing; it is refused only when a condition worsens.
    if (verdict === undefined || (structural && verdict === '')) { moved = true; return undefined; }
    undo();
    for (const [id, column] of cells) if (column === undefined) columns.delete(id); else columns.set(id, column);
    return verdict === '' ? undefined : verdict;
  };
  const refuse = (tier: Tier, refusal: string | undefined, ids: string[], what: string): void => {
    if (refusal !== undefined && !warned(tier)) {
      warnedTiers.add(tier);
      placementWarning(model, 'OVERLAY_ORDER_REFUSED', `The overlay-weighted order of ${what} was refused and ELK's order stands: ${refusal}.`, ids, 'group');
    }
  };

  /**
   * Canton-groups ticket 57, rule 7: a unit outside every canton that ELK left between two cantons of a tier goes before or after the
   * run of cantons, on the side that holds more of its partners (the routed partners in the adjacent sub-tiers, the anchor feed among
   * them, and the overlay partners in any other: the partners the key reads); a tie goes to the end it stands nearer. Between two canton
   * columns the unit would leave empty room on every other tier of the span, so the move is a rule of the shape and stands when it gains
   * nothing; but it is judged, and refused when it raises the routed crossings, blocks a routed link or bends an overlay link (the
   * canton frame spans the tier gap, so a routed link from the moved unit to the far canton would have to pass the near one). A unit with
   * routed partners in more than one canton of the run can never route clean beside it and stays between them.
   * Returns the units of the tier in their new places, the units that stay between, or `undefined` when none stood between.
   */
  const clearRun = (tier: Tier): { order: Unit[]; stays: Unit[]; moves: Unit[] } | undefined => {
    const order = standing(tier), at = order.map(isCanton), first = at.indexOf(true), last = at.lastIndexOf(true);
    if (first < 0 || first === last || !order.slice(first + 1, last).some(unit => !isCanton(unit))) return undefined;
    const run = order.slice(first, last + 1).filter(isCanton);
    const reaches = run.flatMap(unit => unit.groups.map(group => cellReach(model, group.id)));
    const middle = (Math.min(...reaches.map(reach => reach.x)) + Math.max(...reaches.map(reach => reach.x + reach.width))) / 2;
    const cantonOf = new Map(run.flatMap(unit => unit.groups.flatMap(group => group.nodes.map(node => [node, unit] as const))));
    const routedCantons = (unit: Unit): number => {
      const own = new Set(unit.groups.flatMap(group => group.nodes)), hit = new Set<Unit>();
      for (const link of model.links) {
        if (link.layer !== 'routed' || !link.attachments || link.technique === 'stub') continue;
        const { from, to } = link.attachments;
        for (const [mine, other] of [[from.node, to.node], [to.node, from.node]] as const) if (own.has(mine) && cantonOf.has(other)) hit.add(cantonOf.get(other)!);
      }
      return hit.size;
    };
    const before: Unit[] = [], after: Unit[] = [], stays: Unit[] = [];
    for (const unit of order.slice(first + 1, last).filter(unit => !isCanton(unit))) {
      if (routedCantons(unit) > 1) { stays.push(unit); continue; }
      const nodes = unit.groups.flatMap(group => group.nodes), xs = nodes.flatMap(node => partners.get(node) ?? []).map(centreOf);
      const left = xs.filter(x => x < middle - PLACEMENT_EPS).length, right = xs.filter(x => x > middle + PLACEMENT_EPS).length;
      (left > right || (left === right && unitOrder(unit) < middle) ? before : after).push(unit);
    }
    const moves = [...before, ...after], gone = new Set(moves);
    if (!moves.length) return { order, stays, moves };
    return { order: [...order.slice(0, first), ...before, ...order.slice(first, last + 1).filter(unit => !gone.has(unit)), ...after, ...order.slice(last + 1)], stays, moves };
  };

  /**
   * Canton-groups ticket 57, rule 9: the members of one canton that stand beside each other (their sub-tier ranges touch) are ordered by the
   * key of the frames, with the canton column as the walls. The row keeps its left edge and its gaps, so the canton frame and its column do not
   * move; the members take the places in the order of their keys, and a tie keeps the declaration order the pack gave. A partner in the row
   * is left out of the key (it moves with the order), a partner in a member that stands apart is read where it stands.
   */
  const orderMembers = (tier: Tier, canton: Unit, from: number, to: number, chained = false): void => {
    type Member = { id: string; cells: string[]; nodes: string[]; range: [number, number]; x: number; width: number };
    const members: Member[] = Object.keys(frames).filter(id => frames[id]!.parent === canton.id).map(id => {
      const cells = frameSubtreeCells(frames, id), reaches = cells.map(cell => cellReach(model, cell)), tiers = cells.map(cell => model.groups[cell]!.tier!);
      const x = Math.min(...reaches.map(reach => reach.x));
      return { id, cells, nodes: cells.flatMap(cell => model.groups[cell]!.nodes), range: [Math.min(...tiers), Math.max(...tiers)] as [number, number],
        x, width: Math.max(...reaches.map(reach => reach.x + reach.width)) - x };
    });
    const touches = (a: Member, b: Member): boolean => a.range[0] <= b.range[1] && b.range[0] <= a.range[1];
    // The rows are the connected components of the range overlap (ticket 63): members of two tiers are two rows. Each row is ordered by
    // its own keys, and the canton is judged once, with every row turned.
    const seen = new Set<Member>(), rows: Member[][] = [];
    for (const start of members) {
      if (seen.has(start)) continue;
      const row = new Set<Member>([start]);
      for (let grown = true; grown;) { grown = false; for (const member of members) if (!row.has(member) && [...row].some(other => touches(member, other))) { row.add(member); grown = true; } }
      for (const member of row) seen.add(member);
      if (row.size >= 2) rows.push([...row].sort((a, b) => a.x - b.x || compareId(a.id, b.id)));
    }
    // The rows are taken in the sweep direction, the row nearer the anchor first, and each is turned where it stands before the next is read:
    // a partner in a row already turned is read at its new place, so the second row of a pair follows the first. The canton is judged once.
    const below = low(tier) > anchor;
    rows.sort((a, b) => below ? a[0]!.range[0] - b[0]!.range[0] : b[0]!.range[0] - a[0]!.range[0]);
    const all = rows.flat(), cells = all.flatMap(member => member.cells.map(cell => model.groups[cell]!));
    const undo = saveGroups(model, cells), before = chained ? tools.readChain(from, to) : measureRange(from, to, true), turned: string[] = [];
    for (const [at, slots] of rows.entries()) {
      // A row further from the anchor follows this one, so it is left out of the key as a row of the same order is.
      const inside = new Set(rows.slice(at).flat().flatMap(member => member.nodes));
      const next = chained ? tools.chain(slots, (one, two) => tools.linksBetween(one.nodes, two.nodes)).flat() : reorder(slots, member => keyOfNodes(member.nodes, inside));
      if (next.every((member, i) => member === slots[i])) continue;
      let x = slots[0]!.x;
      for (const [i, member] of next.entries()) {
        for (const cell of member.cells) moveGroup(model, model.groups[cell]!, x - member.x, 0);
        x += member.width + (i + 1 < slots.length ? slots[i + 1]!.x - (slots[i]!.x + slots[i]!.width) : 0);
      }
      turned.push(...next.map(member => member.id));
    }
    if (!turned.length) return;
    if (chained) {
      if (tools.gains(before as ReturnType<typeof tools.readChain>, tools.readChain(from, to))) moved = true; else undo();
      return;
    }
    const verdict = judge(before as ReturnType<typeof measureRange>, measureRange(from, to, true));
    if (verdict === undefined) { moved = true; return; }
    undo();
    refuse(tier, verdict === '' ? undefined : verdict, turned, `the members of the canton ${canton.id} on sub-tiers ${Math.min(...all.map(member => member.range[0]))} to ${Math.max(...all.map(member => member.range[1]))}`);
  };

  /**
   * Ticket 78: the row of a document tier is ordered by its overlay partners so that a same-row link stands between neighbours. Three
   * levers, each judged by the acceptance of `tools.gains` and left silently when refused: the plain frames of a run (the cantons keep
   * their places, ticket 57), the members of a canton that stand beside each other, and the nodes inside a cell.
   */
  const chainRows = (tier: Tier, from: number, to: number): void => {
    if (!tools.sameRow.some(pair => tierOf(pair.from) >= from && tierOf(pair.from) <= to)) return;
    // The plain frames stand in runs that no canton or foreign unit splits; each run takes the places of the run.
    const order = standing(tier), sequence = new Map<string, number>();
    for (let start = 0; start < order.length; start++) {
      if (!free(order[start]!) || isCanton(order[start]!)) continue;
      let end = start;
      while (end + 1 < order.length && free(order[end + 1]!) && !isCanton(order[end + 1]!)) end++;
      const run = order.slice(start, end + 1);
      if (run.length > 1) {
        const places = run.map(unitOrder);
        tools.chain(run, (one, two) => tools.linksBetween(one.groups.flatMap(group => group.nodes), two.groups.flatMap(group => group.nodes))).flat()
          .forEach((unit, i) => sequence.set(unit.id, places[i]!));
      }
      start = end;
    }
    const gainful = (act: () => boolean, groups: LayoutGroup[]): void => {
      const cells = new Map(groups.map(group => [group.id, columns.get(group.id)])), undo = saveGroups(model, groups), before = tools.readChain(from, to);
      if (!act()) return;
      if (tools.gains(before, tools.readChain(from, to))) { moved = true; return; }
      undo();
      for (const [id, column] of cells) if (column === undefined) columns.delete(id); else columns.set(id, column);
    };
    const everyGroup = tier.flatMap(unit => unit.groups);
    if ([...sequence].some(([id, place]) => place !== unitOrder(order.find(unit => unit.id === id)!))) {
      gainful(() => { packTier(model, tier, columns, sequence); return true; }, everyGroup);
    }
    for (const canton of tier.filter(unit => isCanton(unit) && free(unit))) {
      orderMembers(tier, canton, from, to, true);
    }
    const cells = everyGroup.filter(group => group.nodes.length > 1 && free({ frame: true, groups: [group] }));
    gainful(() => {
      let changed = false;
      for (const cell of cells) {
        const rowOrder = cell.rowOrder ?? cell.nodes, next = tools.chainNodes(rowOrder);
        if (next.some((node, i) => node !== rowOrder[i]) && reseatRow(model, cell, next, false)) changed = true;
      }
      return changed;
    }, everyGroup);
  };

  // The tier that holds the anchor sub-tier keeps ELK's order of frames; the partners of its rows are still brought together (ticket 78), before the sweep reads it.
  for (const tier of all.filter(tier => low(tier) <= anchor && high(tier) >= anchor)) chainRows(tier, ...span(low(tier), high(tier)));
  for (const tier of sweep) {
    const [from, to] = span(low(tier), high(tier));
    const cantons = tier.filter(isCanton);
    if (cantons.length) {
      // The run of cantons is clear of foreign units before it is judged: the rule of the shape comes first.
      const cleared = clearRun(tier);
      if (cleared !== undefined) {
        const names = `${cantons.map(unit => unit.id).join(', ')}`;
        if (cleared.stays.length) refuse(tier, 'it has routed links to more than one canton of the run, so it can never route clean beside it',
          cleared.stays.map(unit => unit.id), `the foreign ${cleared.stays.map(unit => unit.id).join(', ')} beside the cantons ${names}`);
        if (cleared.moves.length) {
          const refusal = settle(tier, new Map(cleared.order.map((unit, i) => [unit.id, i])), from, to, true);
          refuse(tier, refusal, cleared.moves.map(unit => unit.id), `the foreign ${cleared.moves.map(unit => unit.id).join(', ')} beside the cantons ${names}`);
        }
      }
    }
    if (![...touched].some(at => at >= from && at <= to)) continue;
    const members = standing(tier);
    const movable = members.filter(free);
    const keyOf = (unit: Unit): number | undefined => {
      const inside = new Set(unit.groups.flatMap(group => group.nodes));
      return keyOfNodes([...inside], inside);
    };
    if (cantons.length) {
      const run = movable.filter(isCanton);
      if (run.length > 1) {
        const next = reorder(run, keyOf);
        if (next.some((unit, i) => unit !== run[i])) {
          // The cantons take the places of the cantons, in the new order; every other unit keeps its place.
          const order = members.map(unit => run.includes(unit) ? next[run.indexOf(unit)]! : unit);
          const refusal = settle(tier, new Map(order.map((unit, i) => [unit.id, i])), from, to);
          refuse(tier, refusal, run.map(unit => unit.id), `the frames of sub-tiers ${low(tier)} to ${high(tier)}`);
        }
      }
      for (const canton of cantons.filter(free)) orderMembers(tier, canton, from, to);
    }
    // The frames outside every canton are ordered among themselves as 06b does; the cantons keep their places.
    const plain = standing(tier).filter(unit => free(unit) && !isCanton(unit));
    const next = plain.length < 2 ? plain : reorder(plain, keyOf);
    if (next.some((unit, i) => unit !== plain[i])) {
      // The frames take the places of the frames, in the new order; every other unit keeps its place.
      const places = plain.map(unitOrder);
      refuse(tier, settle(tier, new Map(next.map((unit, i) => [unit.id, places[i]!])), from, to), plain.map(unit => unit.id), `the frames of sub-tiers ${low(tier)} to ${high(tier)}`);
    }
    chainRows(tier, from, to);
  }
  return moved;
}
