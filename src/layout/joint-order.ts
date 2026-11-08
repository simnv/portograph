import type { Diagnostic, LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { corridorSide, corridorXOnSide, laneSource, laneWidth, ownsTransitLanes, reservedCorridorX, transitedCore, transitTiers } from './lanes.js';
import { foreignRoot } from './frames.js';
import { readDraft, reseatRow, saveGroups } from './overlay-order.js';
import { bandGap, compareId } from './skeleton-graph.js';
import { findPort } from './row-paths.js';
import { moveGroup } from './skeleton-geometry.js';
import { reservation, type Reservation } from './reservations.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The joint stage-4 order (architecture-2 ticket 72): a free row, the group order of the sub-tier away from the anchor, and the sides of the
 * transit corridors through the row's sub-tier, decided together. Step 0 of the ticket showed that a key of the free row alone cannot do it:
 * the draft does not hold the x where 7c puts the far groups, and the corridor of a far source takes the far side of the row.
 *
 * - **Where.** After the two corridor sweeps of `orderByCorridors` and before the far-end pull; each sub-tier with a free row the sweeps may
 *   turn (`turnable`), the anchor tier first, then downward, then upward.
 * - **Candidates.** Per free row, the current order and the orders of five key builders over the normalized ranks of both neighbour sub-tiers (`rowFeedCandidates`);
 *   every order of each movable group run of the outward sub-tier (`groupOrderCandidates`); every side vector of the transit corridors
 *   through the sub-tier (`sideVectors`). Each enumeration puts the current order first.
 * - **Predictor.** The outward groups stand at a prediction of their 7c centres (`seatPredicted7c`): a surrogate of 7c, which runs on ports
 *   and lanes that do not exist in stage 4. Its error is measured, not assumed: the ticket's oracle experiment and the oracle test.
 * - **Acceptance.** Measured on the draft over the regions the rows and runs reach (`evaluate`): the straight overlay links do not fall, the
 *   blocked links do not rise, the crossings fall strictly. Among the accepted, the most straight links, then the fewest blocked, then the
 *   fewest crossings, then the least feed stretch; a tie keeps the first enumerated (R3: the current order of every row, group run and
 *   corridor first; then the row builders in their fixed order, the group orders in the lexicographic order of their positions, and the side
 *   vectors in `sourceIndex` order of the transit links, the last key).
 * - **Left out.** A row whose links the draft does not model (a link to a lateral port, a same-row U-turn, a labelled same-row link) is not
 *   judged and is named (`JOINT_ORDER_LEFT_OUT`, R6).
 * - **Record (R1).** A turned row records `feed-order` (`orderByCorridors`); a turned group run a `groupOrder` entry with its premise, the free
 *   rows and their orders; every corridor of an accepted candidate a `corridorSide` entry, which `reservedCorridorX` reads for every consumer.
 * - **Bounds (R4).** `JOINT_GROUP_RUN`, `JOINT_GROUP_ORDERS` and `JOINT_TRANSIT_SIDES` per sub-tier, `JOINT_ROW_ORDERS` per group order, and every evaluation
 *   spends one candidate of `ROW_ORDER_BUDGET` with the sweeps. A truncation is a `ROW_ORDER_SEARCH_CAPPED` reason.
 *
 * `layout.feedOrder: false` switches it off.
 */

/** A group run of at most this many groups is judged in every order; a longer run as it stands and reversed. */
export const JOINT_GROUP_RUN = 4;
/** The most group-order combinations one sub-tier judges, over its runs; above it, each further run as it stands and once turned. */
export const JOINT_GROUP_ORDERS = 24;
/** The most transit corridors whose every side vector one sub-tier judges; above it, the current sides and the side the ranks ask for. */
export const JOINT_TRANSIT_SIDES = 4;
/** The most row-order combinations one group order judges; above it, each row alone, and the n-th builder of every row together. */
export const JOINT_ROW_ORDERS = 16;

/** Two keys nearer than this are one key: a normalised rank, dimensionless (not the ordinal `SAME_KEY` of `feed-order.ts`). */
const SAME_FEED_KEY = 1e-6;
/** The authored order of a far port shifts its normalised feed key by this much per order unit: a deliberate tie-break, not numerical noise. */
const AUTHOR_ORDER_KEY_STEP = 1e-4;

type CorridorSide = 'left' | 'right';
/** The sides of the transit corridors of one sub-tier, in the order of `transitLinks`; undefined when no corridor passes. */
export type SideVector = readonly CorridorSide[] | undefined;
/** Why a free row is not judged: its links are ones the draft does not model. */
export type LeftOutReason = 'lateral-port' | 'same-row-u-turn' | 'labelled-same-row';
const REASON_RANK: Record<LeftOutReason, number> = { 'lateral-port': 0, 'same-row-u-turn': 1, 'labelled-same-row': 2 };

/** The candidate budget the joint order shares with the corridor sweeps (`ROW_ORDER_BUDGET`) and the truncation reasons. */
export interface JointBudget { spent: number; readonly limit: number; readonly caps: Set<string> }
/** A run of movable groups side by side on the outward sub-tier, between the walls of its unmovable neighbours. */
export interface GroupRun { groups: LayoutGroup[]; wallLeft: number; wallRight: number; permute: boolean }
/** What the joint order decided: the rows it turned, the group orders and the corridor sides it reserves. */
export interface JointResult {
  moved: boolean;
  jointMoved: Set<LayoutGroup>;
  groupOrders: { tier: number; order: string[]; rows: LayoutGroup[] }[];
  corridorSides: Reservation[];
}
type Draft = NonNullable<ReturnType<typeof readDraft>>;
interface JointScore { crossings: number; straight: number; blocked: number; freeBlocked: number; stretch: number }

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((node, i) => node === b[i]);
const centreOf = (model: LayoutModel, node: string): number => { const box = model.nodes[node]!.bounds!; return box.x + box.width / 2; };
const lateral = (side: string | undefined): boolean => side === 'left' || side === 'right';
const horizontal = (side: string | undefined): boolean => side === 'top' || side === 'bottom';
const mean = (values: readonly number[]): number | undefined => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : undefined;

/** Every order of `items`, the given order first, then in the lexicographic order of the positions. */
function permutations(items: readonly string[]): string[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((first, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [first, ...rest]));
}
/** `items` with the keyed ones sorted into the keyed slots by `cmp`; an item with no key keeps its slot. */
function slotSortBy(items: readonly string[], keys: ReadonlyMap<string, number | undefined>, cmp: (a: string, b: string) => number): string[] {
  const queue = items.filter(item => keys.get(item) !== undefined).sort(cmp);
  return items.map(item => keys.get(item) === undefined ? item : queue.shift()!);
}

/** The links the joint order reads, once per sheet. */
export interface JointLinks {
  groupOf: (node: string) => LayoutGroup;
  /** Routed links between two nodes whose two ends are on a top or bottom face (or have no side yet). */
  vertical: LayoutLink[];
  /** Routed links between two nodes of one group. */
  sameRow: LayoutLink[];
}
const plainRouted = (link: LayoutLink): boolean => link.layer === 'routed' && link.meshBus === undefined && link.attachments !== undefined
  && link.technique !== 'stub' && link.attachments.from.node !== link.attachments.to.node;
export function jointLinks(model: LayoutModel): JointLinks {
  const groupOf = (node: string): LayoutGroup => model.groups[model.document.nodes[node]!.group]!;
  const sides = (link: LayoutLink): (string | undefined)[] => [link.attachments!.from, link.attachments!.to].map(ref => {
    const port = findPort(model, ref);
    return port?.side ?? port?.sizingSide;
  });
  const routed = model.links.filter(plainRouted);
  return {
    groupOf,
    vertical: routed.filter(link => !sides(link).some(lateral)),
    sameRow: routed.filter(link => groupOf(link.attachments!.from.node) === groupOf(link.attachments!.to.node)),
  };
}

/**
 * The free rows the draft cannot judge, with the reason (R6): both groups of a link with a lateral end in two groups (the router lays it
 * among the reserved parts, `residual part`), and the group of a same-row link with a top or bottom end (a U-turn) or a label (7f opens
 * its gap for the label). A row with two reasons names the first in that order, so the reason does not follow the link order (R3).
 */
export function leftOutRows(model: LayoutModel, links: JointLinks): Map<LayoutGroup, LeftOutReason> {
  const out = new Map<LayoutGroup, LeftOutReason>();
  const note = (group: LayoutGroup, reason: LeftOutReason): void => {
    const was = out.get(group);
    if (was === undefined || REASON_RANK[reason] < REASON_RANK[was]) out.set(group, reason);
  };
  for (const link of model.links.filter(plainRouted)) {
    const { from, to } = link.attachments!;
    const gf = links.groupOf(from.node), gt = links.groupOf(to.node);
    const [sf, st] = [from, to].map(ref => { const port = findPort(model, ref); return port?.side ?? port?.sizingSide; });
    if (gf !== gt) {
      if (lateral(sf) || lateral(st)) { note(gf, 'lateral-port'); note(gt, 'lateral-port'); }
    } else if (horizontal(sf) || horizontal(st)) note(gf, 'same-row-u-turn');
    else if (model.document.links[link.sourceIndex]?.label !== undefined) note(gf, 'labelled-same-row');
  }
  return out;
}

// ---- Candidates ----------------------------------------------------------------------------------------------------------------------

/**
 * The normalized left-to-right rank of each node of sub-tier `tier` as it stands, in [0, 1]: one slot per node of a group whose nodes share
 * one row, one slot for all nodes of a group whose nodes stand on two rows or more (stacked ranks are no left and right siblings).
 * Rank, not x: the draft x of a far node is not where 7c will put it (ticket 72, Step 0).
 */
export function tierRanks(model: LayoutModel, tier: number | undefined): Map<string, number> {
  if (tier === undefined) return new Map();
  const groups = Object.values(model.groups)
    .filter(group => !group.flank && group.tier === tier && group.bounds !== undefined && group.nodes.length > 0)
    .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
  const slots: string[][] = [];
  for (const group of groups) {
    const order = group.rowOrder ?? [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x || compareId(a, b));
    const boxes = order.map(id => model.nodes[id]!.bounds!);
    const oneRow = boxes.every(box => box.y < boxes[0]!.y + boxes[0]!.height && boxes[0]!.y < box.y + box.height);
    if (oneRow) for (const id of order) slots.push([id]);
    else slots.push(order);
  }
  const out = new Map<string, number>();
  slots.forEach((ids, i) => { const rank = slots.length <= 1 ? 0.5 : i / (slots.length - 1); for (const id of ids) out.set(id, rank); });
  return out;
}

/**
 * The candidate orders of the free row `row`, the current order first, then the orders of five key builders, without repeats. Each node's
 * keys are the mean ranks of its far ends above (`rankUp`) and below (`rankDown`), an authored port order breaking a tie by a hair; the
 * two-sided key is their mean, or the one that exists. Routed same-row peers that stand side by side stay side by side, as one block with
 * the mean key of its nodes; a block with a lateral end keeps its inner order. A node with no key keeps its slot. The builders: the two-sided
 * key with the key from above, then from below, as tie-breaks; the two-sided key with a two-sided node toward the middle; the key from above;
 * the key from below. The last tie-break of every builder is the current order (R3).
 */
export function rowFeedCandidates(model: LayoutModel, links: JointLinks, row: LayoutGroup,
  rankUp: ReadonlyMap<string, number>, rankDown: ReadonlyMap<string, number>): string[][] {
  const cur = [...(row.rowOrder ?? row.nodes)], own = new Set(cur), slot = new Map(cur.map((node, i) => [node, i]));
  const up = new Map<string, number | undefined>(), down = new Map<string, number | undefined>(), both = new Map<string, number | undefined>();
  for (const node of cur) {
    const upVals: number[] = [], downVals: number[] = [];
    for (const link of links.vertical) {
      const { from, to } = link.attachments!;
      const far = from.node === node ? to : to.node === node ? from : undefined;
      if (far === undefined || own.has(far.node)) continue;
      const order = findPort(model, far)?.authorOrder, shift = order !== undefined ? order * AUTHOR_ORDER_KEY_STEP : 0;
      if (rankUp.has(far.node)) upVals.push(rankUp.get(far.node)! + shift);
      else if (rankDown.has(far.node)) downVals.push(rankDown.get(far.node)! + shift);
    }
    const ku = mean(upVals), kd = mean(downVals);
    up.set(node, ku);
    down.set(node, kd);
    both.set(node, ku !== undefined && kd !== undefined ? (ku + kd) / 2 : (ku ?? kd));
  }
  const blocks: { nodes: string[]; fixedInner: boolean }[] = [];
  for (const [i, node] of cur.entries()) {
    const prev = i > 0 ? cur[i - 1]! : undefined;
    const join = prev === undefined ? [] : links.sameRow.filter(link => {
      const { from, to } = link.attachments!;
      return (from.node === prev && to.node === node) || (from.node === node && to.node === prev);
    });
    if (join.length === 0) { blocks.push({ nodes: [node], fixedInner: false }); continue; }
    const block = blocks[blocks.length - 1]!;
    block.nodes.push(node);
    block.fixedInner ||= join.some(link => [link.attachments!.from, link.attachments!.to].some(ref => lateral(findPort(model, ref)?.side)));
  }
  const differ = (a: number | undefined, b: number | undefined): number | undefined =>
    a !== undefined && b !== undefined && Math.abs(a - b) > SAME_FEED_KEY ? a - b : undefined;
  const byKey = (keys: ReadonlyMap<string, number | undefined>, then: (a: string, b: string) => number) => (a: string, b: string): number =>
    differ(keys.get(a), keys.get(b)) ?? then(a, b);
  const current = (a: string, b: string): number => slot.get(a)! - slot.get(b)!;
  const upThenDown = (a: string, b: string): number => differ(up.get(a), up.get(b)) ?? differ(down.get(a), down.get(b)) ?? current(a, b);
  const downThenUp = (a: string, b: string): number => differ(down.get(a), down.get(b)) ?? differ(up.get(a), up.get(b)) ?? current(a, b);
  const outer = (a: string, b: string): number => {
    const ka = both.get(a)!, twoA = up.get(a) !== undefined && down.get(a) !== undefined, twoB = up.get(b) !== undefined && down.get(b) !== undefined;
    if (twoA !== twoB && Math.abs(ka - 0.5) > SAME_FEED_KEY) return ka < 0.5 ? (twoA ? 1 : -1) : (twoA ? -1 : 1);
    return upThenDown(a, b);
  };
  const build = (keys: ReadonlyMap<string, number | undefined>, cmp: (a: string, b: string) => number): string[] => {
    if ([...keys.values()].filter(v => v !== undefined).length < 2) return [...cur];
    const heads = blocks.map(block => block.nodes[0]!);
    const blockKeys = new Map(blocks.map(block => [block.nodes[0]!, mean(block.nodes.map(n => keys.get(n)).filter((v): v is number => v !== undefined))]));
    const inner = new Map(blocks.map(block => [block.nodes[0]!, block.fixedInner || block.nodes.length < 2 ? block.nodes : slotSortBy(block.nodes, keys, cmp)]));
    return slotSortBy(heads, blockKeys, byKey(blockKeys, cmp)).flatMap(head => inner.get(head)!);
  };
  const raw = [cur, build(both, byKey(both, upThenDown)), build(both, byKey(both, downThenUp)), build(both, byKey(both, outer)),
    build(up, byKey(up, current)), build(down, byKey(down, current))];
  const unique: string[][] = [];
  for (const order of raw) if (!unique.some(other => sameOrder(other, order))) unique.push(order);
  return unique;
}

/**
 * The runs of movable groups on the outward sub-tier `tierOut`, left to right, each between the walls of its unmovable neighbours. A run is
 * permuted when it has two groups or more, a link of the free rows or a transit corridor of the sub-tier touches it, no routed link joins
 * two of its groups, and no group of it is frame-bound.
 */
export function groupRuns(model: LayoutModel, links: JointLinks, tierOut: number | undefined, rows: readonly LayoutGroup[],
  transitLinks: readonly LayoutLink[], movable: (group: LayoutGroup) => boolean, frameBound: ReadonlySet<LayoutGroup>): GroupRun[] {
  if (tierOut === undefined) return [];
  const gap = bandGap(model);
  const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tierOut && group.bounds !== undefined && group.nodes.length > 0)
    .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
  const rowNodes = new Set(rows.flatMap(group => group.nodes));
  const runs: GroupRun[] = [];
  for (let i = 0; i < groups.length;) {
    if (!movable(groups[i]!)) { i++; continue; }
    let j = i;
    while (j < groups.length && movable(groups[j]!)) j++;
    const slice = groups.slice(i, j), nodes = new Set(slice.flatMap(group => group.nodes));
    const wallLeft = i > 0 ? groups[i - 1]!.bounds!.x + groups[i - 1]!.bounds!.width + gap : -Infinity;
    const wallRight = j < groups.length ? groups[j]!.bounds!.x - gap : Infinity;
    const touches = links.vertical.some(link => (nodes.has(link.attachments!.from.node) && rowNodes.has(link.attachments!.to.node))
      || (nodes.has(link.attachments!.to.node) && rowNodes.has(link.attachments!.from.node)))
      || transitLinks.some(link => nodes.has(link.attachments!.from.node) || nodes.has(link.attachments!.to.node));
    const joined = model.links.some(link => link.layer === 'routed' && link.attachments !== undefined && nodes.has(link.attachments.from.node)
      && nodes.has(link.attachments.to.node) && links.groupOf(link.attachments.from.node) !== links.groupOf(link.attachments.to.node));
    runs.push({ groups: slice, wallLeft, wallRight, permute: slice.length > 1 && touches && !joined && !slice.some(group => frameBound.has(group)) });
    i = j;
  }
  return runs;
}

/**
 * The group-order candidates of the runs: one order per run, the current orders first. A run of at most `JOINT_GROUP_RUN` groups takes every
 * order, a longer one its current order and the reverse. Where the product passes `JOINT_GROUP_ORDERS`, the further run adds only its first
 * turned order, with every earlier run as it stands (a `caps` reason).
 */
export function groupOrderCandidates(runs: readonly GroupRun[], caps: Set<string>, tier: number | undefined): string[][][] {
  let combos: string[][][] = [[]];
  for (const run of runs) {
    const base = run.groups.map(group => group.id);
    if (run.permute && run.groups.length > JOINT_GROUP_RUN) caps.add(`a group run of sub-tier ${tier} has ${run.groups.length} groups, so only its reverse was judged`);
    const options = !run.permute ? [base] : run.groups.length <= JOINT_GROUP_RUN ? permutations(base) : [base, [...base].reverse()];
    const next = combos.flatMap(prefix => options.map(option => [...prefix, option]));
    if (next.length <= JOINT_GROUP_ORDERS) { combos = next; continue; }
    caps.add(`the group runs of sub-tier ${tier} have ${next.length} orders together, so a further run was judged once turned`);
    combos = [...combos.map(prefix => [...prefix, base]), ...(options.length > 1 ? [[...combos[0]!, options[1]!]] : [])];
  }
  return combos;
}

/**
 * The side vectors of the transit corridors of a sub-tier, the current sides first: every vector of at most `JOINT_TRANSIT_SIDES` corridors,
 * else the current sides and the sides the ranks of the two ends ask for (left of the middle: left), a `caps` reason. `base` is the side each
 * corridor takes with no reservation. The vector order follows the corridors in `sourceIndex` order, the last tie-break (R3).
 */
export function sideVectors(model: LayoutModel, transitLinks: readonly LayoutLink[], base: readonly CorridorSide[],
  tierUp: number | undefined, tierDown: number | undefined, caps: Set<string>, tier: number): SideVector[] {
  if (transitLinks.length === 0) return [undefined];
  if (transitLinks.length <= JOINT_TRANSIT_SIDES) {
    let all: CorridorSide[][] = [[]];
    for (const side of base) all = all.flatMap(prefix => [[...prefix, side], [...prefix, side === 'left' ? 'right' : 'left']]);
    return all;
  }
  caps.add(`sub-tier ${tier} has ${transitLinks.length} transit corridors, so only the sides their ends ask for were judged`);
  const rankUp = tierRanks(model, tierUp), rankDown = tierRanks(model, tierDown);
  const asked = transitLinks.map((link, m): CorridorSide => {
    const ranks = [link.attachments!.from.node, link.attachments!.to.node].map(node => rankUp.get(node) ?? rankDown.get(node)).filter((v): v is number => v !== undefined);
    const at = mean(ranks);
    return at === undefined || Math.abs(at - 0.5) <= SAME_FEED_KEY ? base[m]! : at < 0.5 ? 'left' : 'right';
  });
  return [base, ...(asked.some((side, m) => side !== base[m]) ? [asked] : [])];
}

/**
 * The row-order combinations of the free rows of a sub-tier, the current orders first: the product while it is at most `JOINT_ROW_ORDERS`,
 * else the n-th candidate of every row together (n = 0, 1, ...) and each candidate of one row with the others as they stand (a `caps` reason).
 */
export function rowCombinations(perRow: readonly (readonly string[][])[], caps: Set<string>, tier: number): string[][][] {
  const product = perRow.reduce((size, list) => size * list.length, 1);
  if (product <= JOINT_ROW_ORDERS) return perRow.reduce<string[][][]>((all, list) => all.flatMap(prefix => list.map(order => [...prefix, order])), [[]]);
  caps.add(`the free rows of sub-tier ${tier} have ${product} candidate orders together, so each row was judged alone`);
  const longest = Math.max(...perRow.map(list => list.length));
  return [
    perRow.map(list => list[0]!),
    ...Array.from({ length: longest - 1 }, (_, n) => perRow.map(list => list[Math.min(n + 1, list.length - 1)]!)),
    ...perRow.flatMap((list, i) => list.slice(1).map(order => perRow.map((other, j) => i === j ? order : other[0]!))),
  ];
}

// ---- Predictor -----------------------------------------------------------------------------------------------------------------------

/** The x the corridor of `link` takes in sub-tier `tier`: the reserved side (`reservedCorridorX`), else the side the source asks for. */
function corridorAt(model: LayoutModel, main: readonly LayoutGroup[], link: LayoutLink, tier: number): number {
  const sx = centreOf(model, laneSource(model, link).node);
  const reserved = reservedCorridorX(model, link, tier, sx);
  if (reserved !== undefined) return reserved;
  const core = (transitedCore([...main], sx) ?? main[0]!).bounds!;
  return corridorXOnSide(core, corridorSide(core, sx), laneWidth(model, link) / 2, sx);
}

/**
 * Seats the groups of each run in the order `sigma` names at a prediction of their 7c centres (ticket 72): each group wants the mean x of its
 * feeds on the free rows' sub-tier (node centres) and of the corridors of its transit links (not a bundle), and a run is packed left to right
 * a band gap apart at the least-squares fit of those wants (pooled adjacent violators), inside its walls. A surrogate: 7c reads ports, lanes
 * and growth that do not exist in stage 4, so its error is measured by the oracle test (`joint-order.test.ts`) and in the ticket, not assumed.
 */
export function seatPredicted7c(model: LayoutModel, links: JointLinks, main: readonly LayoutGroup[], runs: readonly GroupRun[],
  sigma: readonly (readonly string[])[], transitLinks: readonly LayoutLink[], tier: number): void {
  const gap = bandGap(model), mainNodes = new Set(main.flatMap(group => group.nodes));
  const corridors = new Map(transitLinks.map(link => [link, corridorAt(model, main, link, tier)]));
  for (const [r, run] of runs.entries()) {
    const blocks = sigma[r]!.map(id => {
      const group = model.groups[id]!, nodes = new Set(group.nodes), xs: number[] = [];
      for (const link of links.vertical) {
        const { from, to } = link.attachments!;
        if (nodes.has(from.node) && mainNodes.has(to.node)) xs.push(centreOf(model, to.node));
        else if (nodes.has(to.node) && mainNodes.has(from.node)) xs.push(centreOf(model, from.node));
      }
      for (const link of transitLinks) {
        if (!link.bundle && (nodes.has(link.attachments!.from.node) || nodes.has(link.attachments!.to.node))) xs.push(corridors.get(link)!);
      }
      const want = mean(xs);
      return { ids: [id], desired: want === undefined ? group.bounds!.x : want - group.bounds!.width / 2, weight: Math.max(1, xs.length), span: group.bounds!.width };
    });
    for (let m = 0; m + 1 < blocks.length;) {
      const a = blocks[m]!, b = blocks[m + 1]!, off = a.span + gap;
      if (a.desired + off <= b.desired + PLACEMENT_EPS) { m++; continue; }
      blocks.splice(m, 2, { ids: [...a.ids, ...b.ids], desired: (a.desired * a.weight + (b.desired - off) * b.weight) / (a.weight + b.weight), weight: a.weight + b.weight, span: off + b.span });
      if (m > 0) m--;
    }
    let cursor = run.wallLeft;
    const starts = blocks.map(block => { const x = Math.max(cursor, block.desired); cursor = x + block.span + gap; return x; });
    let high = run.wallRight;
    for (let m = blocks.length - 1; m >= 0; m--) {
      if (starts[m]! + blocks[m]!.span > high) starts[m] = Math.max(run.wallLeft, high - blocks[m]!.span);
      high = starts[m]! - gap;
    }
    for (const [m, block] of blocks.entries()) {
      let x = starts[m]!;
      for (const id of block.ids) {
        const group = model.groups[id]!;
        moveGroup(model, group, x - group.bounds!.x, 0);
        x += group.bounds!.width + gap;
      }
    }
  }
}

/** Packs the groups of `run` in the order `ids` across the run's own span, so no wall is passed: the draft of a group order. */
function seatRun(model: LayoutModel, run: readonly LayoutGroup[], ids: readonly string[]): void {
  const gap = bandGap(model);
  const minX = Math.min(...run.map(group => group.bounds!.x)), maxRight = Math.max(...run.map(group => group.bounds!.x + group.bounds!.width));
  const sum = ids.reduce((total, id) => total + model.groups[id]!.bounds!.width, 0);
  const step = ids.length > 1 ? Math.max(gap, (maxRight - minX - sum) / (ids.length - 1)) : 0;
  let x = minX;
  for (const id of ids) {
    const group = model.groups[id]!;
    moveGroup(model, group, x - group.bounds!.x, 0);
    x += group.bounds!.width + step;
  }
}

// ---- Evaluation ----------------------------------------------------------------------------------------------------------------------

/** The routed same-row links of `rows`, ends on lateral faces, with another member of the row between their ends. */
function freeRowBlocked(model: LayoutModel, links: JointLinks, rows: readonly LayoutGroup[]): number {
  let blocked = 0;
  for (const row of rows) {
    const order = [...(row.rowOrder ?? row.nodes)];
    for (const link of links.sameRow) {
      const { from, to } = link.attachments!;
      if (links.groupOf(from.node) !== row) continue;
      if ([from, to].some(ref => { const port = findPort(model, ref); return horizontal(port?.side ?? port?.sizingSide); })) continue;
      if (Math.abs(order.indexOf(from.node) - order.indexOf(to.node)) > 1) blocked++;
    }
  }
  return blocked;
}

/** The feed stretch: over every far node of the two neighbour sub-tiers, the x span of its feeds on the rows and of its corridors. */
function feedStretch(model: LayoutModel, links: JointLinks, main: readonly LayoutGroup[], rows: readonly LayoutGroup[],
  transitLinks: readonly LayoutLink[], tier: number, near: readonly (number | undefined)[]): number {
  const rowNodes = new Set(rows.flatMap(group => group.nodes));
  const corridors = new Map(transitLinks.map(link => [link, corridorAt(model, main, link, tier)]));
  const tiers = near.filter((tier): tier is number => tier !== undefined);
  const far = Object.values(model.groups).filter(group => !group.flank && group.tier !== undefined && tiers.includes(group.tier)).flatMap(group => group.nodes);
  let total = 0;
  for (const node of far) {
    const xs: number[] = [];
    for (const link of links.vertical) {
      const { from, to } = link.attachments!;
      if (from.node === node && rowNodes.has(to.node)) xs.push(centreOf(model, to.node));
      else if (to.node === node && rowNodes.has(from.node)) xs.push(centreOf(model, from.node));
    }
    for (const link of transitLinks) if (link.attachments!.from.node === node || link.attachments!.to.node === node) xs.push(corridors.get(link)!);
    if (xs.length > 1) total += Math.max(...xs) - Math.min(...xs);
  }
  return total;
}

/** The corridor-side entries of `sides` for the transit corridors of sub-tier `tier`, each on the group it transits as the draft stands. */
function sideEntries(model: LayoutModel, main: readonly LayoutGroup[], transitLinks: readonly LayoutLink[], sides: readonly CorridorSide[], tier: number): Reservation[] {
  return transitLinks.map((link, m) => {
    const host = transitedCore([...main], centreOf(model, laneSource(model, link).node)) ?? main[0]!;
    return reservation('corridorSide', { kind: 'link', id: link.id }, String(tier), 'skeleton', 0, { link: link.id, tier, group: host.id, side: sides[m]! });
  });
}

/** Whether `one` beats `two`: the most straight links, then the fewest blocked, then the fewest crossings, then strictly less feed stretch. */
export function jointBetter(one: JointScore, two: JointScore): boolean {
  if (one.straight !== two.straight) return one.straight > two.straight;
  const blockedOne = one.blocked + one.freeBlocked, blockedTwo = two.blocked + two.freeBlocked;
  if (blockedOne !== blockedTwo) return blockedOne < blockedTwo;
  if (one.crossings !== two.crossings) return one.crossings < two.crossings;
  return one.stretch < two.stretch - PLACEMENT_EPS;
}
/** Whether `score` stands against the current orders: no straight link lost, no link more blocked, strictly fewer crossings. */
export function jointAccepted(score: JointScore, base: JointScore): boolean {
  return score.straight >= base.straight && score.blocked <= base.blocked && score.freeBlocked <= base.freeBlocked && score.crossings < base.crossings;
}

// ---- The step ------------------------------------------------------------------------------------------------------------------------

/**
 * The joint order of every sub-tier with a turnable free row (see the module comment). `turnable(k)` gives the free rows of sub-tier index
 * `k` the sweeps may turn; `before` the order each free row had before the sweeps; `spanned` the sub-tier indices a transit link spans.
 */
export function orderJointFreeRows(model: LayoutModel, draft: Draft, turnable: (k: number) => LayoutGroup[], movable: (group: LayoutGroup) => boolean,
  frameBound: ReadonlySet<LayoutGroup>, before: ReadonlyMap<LayoutGroup, readonly string[]>, spanned: ReadonlySet<number>,
  rowsPermuted: number, budget: JointBudget): JointResult {
  const { anchor, tiers, measureRange, reach } = draft;
  const orderOf = (group: LayoutGroup): string[] => [...(group.rowOrder ?? group.nodes)];
  const links = jointLinks(model), leftOut = leftOutRows(model, links);
  const result: JointResult = { moved: false, jointMoved: new Set(), groupOrders: [], corridorSides: [] };
  const passesFrame = (link: LayoutLink): boolean => {
    const crossed = new Set(transitTiers(model, link));
    return Object.values(model.groups).some(group => group.tier !== undefined && crossed.has(group.tier) && foreignRoot(model, group.id, link) !== undefined);
  };
  const named = new Map<LayoutGroup, LeftOutReason>();
  const at = tiers.indexOf(anchor);
  const sweep = [at, ...Array.from({ length: tiers.length - at - 1 }, (_, i) => at + 1 + i), ...Array.from({ length: at }, (_, i) => at - 1 - i)];

  // Every left-out row is named, also on a sub-tier the budget does not reach.
  for (const k of sweep) for (const row of turnable(k)) { const why = leftOut.get(row); if (why !== undefined) named.set(row, why); }
  for (const k of sweep) {
    const rows = turnable(k).filter(group => !leftOut.has(group));
    if (!rows.length) continue;
    if (budget.spent >= budget.limit) { budget.caps.add(`the sheet spent its budget of ${budget.limit} candidates`); break; }
    const tierK = tiers[k]!, tierUp = k > 0 ? tiers[k - 1] : undefined, tierDown = k + 1 < tiers.length ? tiers[k + 1] : undefined;
    const tierOut = k >= at ? tierDown : tierUp;
    const main = Object.values(model.groups).filter(group => !group.flank && group.tier === tierK && group.bounds !== undefined && group.nodes.length > 0)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    const transitLinks = model.links.filter(link => link.layer === 'routed' && link.attachments && ownsTransitLanes(model, link)
      && transitTiers(model, link).includes(tierK) && !passesFrame(link)).sort((a, b) => a.sourceIndex - b.sourceIndex);
    const runs = groupRuns(model, links, tierOut, rows, transitLinks, movable, frameBound);
    const sigmas = groupOrderCandidates(runs, budget.caps, tierOut);
    const baseSides = transitLinks.map(link => {
      const sx = draft.portX(laneSource(model, link)), core = (transitedCore(main, sx) ?? main[0]!).bounds!;
      return corridorSide(core, sx);
    });
    const vectors = sideVectors(model, transitLinks, baseSides, tierUp, tierDown, budget.caps, tierK);
    const probe = [...rows, ...runs.flatMap(run => run.groups)];
    const [low, high] = reach(probe);
    const ledger = model.reservations;

    /** The draft measure of one candidate, undone after; undefined when a row cannot be seated in its order. Spends one candidate. */
    const evaluate = (sigma: readonly (readonly string[])[], rowOrders: readonly (readonly string[])[], sides: SideVector): JointScore | undefined => {
      budget.spent++;
      const undo = saveGroups(model, probe);
      let ok = true;
      for (const [i, row] of rows.entries()) if (!sameOrder(rowOrders[i]!, orderOf(row)) && !reseatRow(model, row, [...rowOrders[i]!], true)) { ok = false; break; }
      let score: JointScore | undefined;
      if (ok) {
        for (const [r, run] of runs.entries()) seatRun(model, run.groups, sigma[r]!);
        if (sides !== undefined) model.reservations = [...(ledger ?? []), ...sideEntries(model, main, transitLinks, sides, tierK)];
        seatPredicted7c(model, links, main, runs, sigma, transitLinks, tierK);
        score = { ...measureRange(low, high, true), freeBlocked: freeRowBlocked(model, links, rows), stretch: feedStretch(model, links, main, rows, transitLinks, tierK, [tierUp, tierDown]) };
      }
      if (ledger === undefined) delete model.reservations; else model.reservations = ledger;
      undo();
      return score;
    };

    const baseSigma = runs.map(run => run.groups.map(group => group.id)), baseRows = rows.map(orderOf);
    const baseline = evaluate(baseSigma, baseRows, transitLinks.length > 0 ? baseSides : undefined);
    if (baseline === undefined) continue;
    let best: { sigma: string[][]; rowOrders: string[][]; sides: SideVector; score: JointScore } | undefined;
    const stepCovered = k !== at && spanned.has(k) && rows.every(row => row.nodes.length <= rowsPermuted);
    judging: for (const sigma of sigmas) {
      // The ranks are read under `sigma`, so the keys of the rows follow the candidate group order.
      const undoRuns = saveGroups(model, runs.flatMap(run => run.groups));
      for (const [r, run] of runs.entries()) seatRun(model, run.groups, sigma[r]!);
      const rankUp = tierRanks(model, tierUp), rankDown = tierRanks(model, tierDown);
      undoRuns();
      const combos = rowCombinations(rows.map(row => rowFeedCandidates(model, links, row, rankUp, rankDown)), budget.caps, tierK);
      const sigmaKept = sigma.every((ids, r) => sameOrder(ids, baseSigma[r]!));
      for (const rowOrders of combos) {
        if (rowOrders.every((order, i) => sameOrder(order, baseRows[i]!))) continue;
        // A turn a sweep made is not undone back to the order it turned away from.
        if (rowOrders.some((order, i) => { const was = before.get(rows[i]!); return was !== undefined && !sameOrder(was, baseRows[i]!) && sameOrder(was, order); })) continue;
        for (const sides of vectors) {
          // A sweep already judged every order of these rows with the groups and corridors as they stand.
          if (stepCovered && sigmaKept && (sides === undefined || sides.every((side, m) => side === baseSides[m]))) continue;
          if (budget.spent >= budget.limit) { budget.caps.add(`the sheet spent its budget of ${budget.limit} candidates`); break judging; }
          const score = evaluate(sigma, rowOrders, sides);
          if (score === undefined || !jointAccepted(score, baseline)) continue;
          if (best === undefined || jointBetter(score, best.score)) best = { sigma, rowOrders, sides, score };
        }
      }
    }
    if (best === undefined) continue;
    for (const [i, row] of rows.entries()) {
      if (sameOrder(best.rowOrders[i]!, orderOf(row))) continue;
      if (!reseatRow(model, row, [...best.rowOrders[i]!], true)) throw new Error('A joint row order could not be seated again');
      result.jointMoved.add(row);
      result.moved = true;
    }
    for (const [r, run] of runs.entries()) {
      if (sameOrder(best.sigma[r]!, baseSigma[r]!)) continue;
      seatRun(model, run.groups, best.sigma[r]!);
      result.groupOrders.push({ tier: tierOut!, order: [...best.sigma[r]!], rows: [...rows] });
      result.moved = true;
    }
    if (best.sides !== undefined) result.corridorSides.push(...sideEntries(model, main, transitLinks, best.sides, tierK));
  }
  if (named.size) {
    const list = [...named].sort(([a], [b]) => compareId(a.id, b.id)).map(([row, why]) => `${row.id} (${why})`);
    const note: Diagnostic = { stage: 'placement', severity: 'info', code: 'JOINT_ORDER_LEFT_OUT', message: `The joint order did not judge the free rows ${list.join(', ')}: the draft does not model their links.` };
    model.diagnostics.push(note);
  }
  return result;
}

// ---- Record --------------------------------------------------------------------------------------------------------------------------

/**
 * The ledger entries of a joint result (R1): one `groupOrder` per turned run, its premise the free rows it was judged with in the order they
 * stand once the far-end pull has run, and the `corridorSide` entries of every accepted candidate.
 */
export function jointRecord(result: JointResult): Reservation[] {
  return [
    ...result.groupOrders.map(({ tier, order, rows }) => reservation('groupOrder', { kind: 'command', id: 'feed-order' }, `tier:${tier}:${order[0]!}`, 'skeleton', 0, {
      tier, order, feeds: rows.map(row => ({ row: row.id, order: [...(row.rowOrder ?? row.nodes)] })),
    })),
    ...result.corridorSides,
  ];
}
