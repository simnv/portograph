import { LAYOUT_STAGES, stageReached, type LayoutGroup, type LayoutLink, type LayoutModel, type LayoutPort } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { expectedRowPath, findPort } from './row-paths.js';
import { equationEnds, equationKind } from './read/seat-equation.js';
import { portId } from './skeleton-graph.js';
import { portKey } from './sides-one.js';
import { ofKind, reservation, seatSetFault, type ReservationOf, type SeatEquation, type SeatSetPayload } from './reservations.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { movedOpen, resortFaces, type Resorted } from './free-slots.js';
import { belowReader } from './feed-order.js';
import { openMembers } from './read/open-member.js';
import { rowGap } from './sides-two.js';
import { labelSpans, rowGroups } from './rows.js';
import { rowLabelGap } from './row-label-room.js';
import { groupShape } from './grid.js';
import { wrapGateOwns } from './stagger.js';
import { chainBlockOf } from './read/chain.js';
import { isCantonFrame } from './read/canton.js';
import { contentBox } from './regions.js';
import { deriveFrames } from './frames.js';
import { besideGap, holdColumnAxes, separateFrameColumns } from './columns.js';
import { rebuildBands, validateSkeletonBands } from './skeleton-geometry.js';
import { validateLanes } from './lanes.js';
import { blockDemands, type BlockDemand } from './solid-blocks.js';
import { BLOCK_CAP } from './block-checks.js';
import { PLACEMENT_EPS, SEAT_STANDS_EPS } from './tolerance.js';
import { attemptCounters } from './attempt-counters.js';
import { EPS } from '../geometry/planar.js';

/**
 * The seat set of a child row (dense-16x9 ticket 36, slice 1; design `36-seats-design.md`, mechanisms III and IV). With
 * `layout.moveBeforeGrow`, stage 6 (the last repack of the rows rule, where the parents' rows are packed) chooses where each member of a
 * rank cell stands under its parents' bottom ports, all members together, with the row order, the face port orders, the body widths and
 * the parents fixed. The choice is one `seatSet` ledger entry: the kept verticals as equations, the verticals and block faces the members
 * already hold, the parent ports the equations read, the member positions and the interval the cell reserves, all relative to one
 * parent port. The cell box covers the interval and the siblings of its band give way on either side; every later repack and 7c apply
 * the stored positions and do not choose again.
 */

/**
 * The most distinct x positions one member is offered (one per parent port it can stand under). The design experiment bounded a
 * fed body at eight positions; a member with more is a cut of the search (`SEAT_SET_BOUND`), never a silent truncation, and the row
 * keeps no record.
 */
export const SEAT_SET_CANDIDATES = 8;
/**
 * The most partial assignments the search visits for one row (R4: a count). The design experiment's row search stopped at 5000
 * expansions; a row that needs more is a cut (`SEAT_SET_BOUND`) and keeps no record.
 */
export const SEAT_SET_VISITS = 5000;
/**
 * The most times the rows rule decides the seat sets again after the frame columns, moved apart for them, brought a frame or a row group
 * nearer than the beside gap to a flank, bar or grid (`seatRowsAndColumns`). Each time refuses one more set, so the count of sets bounds the
 * loop too; the constant states the bound as a count (R4). Past it every set of the run is refused by name.
 */
export const SEAT_SET_REDECISIONS = 8;

/**
 * The most candidates whose gain one row reads (`straightLinks` on the moved members, ruling 4 of 2026-11-17). Each read checks the corridor of every
 * link of the members; past the bound the row is declined (clause `no-gain`) with the best candidate it read. R4: a count, not a time.
 */
export const SEAT_SET_GAIN_READS = 16;

export type { SeatEquation, SeatSetPayload };

/** Why a seat set is declined or cut, as `SEAT_SET_DECLINED` names it. */
export type SeatSetClause = 'scope' | 'no-gain' | 'owner' | 'bound' | 'withdrawn';
export type SeatSetOutcome = { kind: 'set'; payload: SeatSetPayload } | { kind: 'declined'; clause: SeatSetClause; why: string };

interface Feed { link: LayoutLink; member: number; port: LayoutPort; far: LayoutPort; x: number }
interface RowInput {
  group: LayoutGroup;
  order: string[];
  widths: number[];
  x0: number[];
  gaps: number[];
  feeds: Feed[];
  holds: { link: LayoutLink; member: number; port: LayoutPort; far: LayoutPort }[];
  fixed: Set<number>;
  candidates: number[][];
}

const right = (box: Rect): number => box.x + box.width;
const NO_FEED = 'no member is fed from a higher tier of its frame';
const linkKey = (link: LayoutLink): string => `${portId(link.attachments!.from)}>${portId(link.attachments!.to)}`;

/** Why the cell `group` is no seat-set row, or undefined: the solver cannot state its stagger, grid, canton or feeding chain. */
export function seatSetScope(model: LayoutModel, group: LayoutGroup): string | undefined {
  if (group.frame === undefined) return 'not a rank cell';
  if (groupShape(model, group.id) !== 'row') return `a ${groupShape(model, group.id)} group`;
  if (model.staggerRows?.some(row => row.group === group.id)) return 'a staggered row';
  if (wrapGateOwns(model, group)) return 'the wrap gate owns this row';
  let frame: string | undefined = group.frame;
  while (frame !== undefined) { if (isCantonFrame(model, frame)) return 'in a canton'; frame = model.document.frames?.[frame]?.parent; }
  if (group.nodes.some(node => chainBlockOf(model, node) !== undefined)) return 'a member of a feeding chain';
  return undefined;
}


/**
 * The gaps the repack keeps between the members (`repackOverlaps` with the label detours): `rowGap`, and the room of a labelled link that
 * spans more gaps (`labelSpans`, the repack's own reader), folded into the last gap of its span at the tightest pack of the members between
 * (enough, since the members between only stand farther apart). So no later repack pushes a seated member.
 */
function repackGaps(model: LayoutModel, order: readonly string[], widths: readonly number[]): number[] {
  const gaps = order.slice(1).map((id, i) => rowGap(model, order[i]!, id, true));
  for (const span of labelSpans(model, order).sort((a, b) => a.right - b.right || b.left - a.left)) {
    const needed = rowLabelGap(model, order[span.left]!, order[span.right]!, true);
    let between = 0;
    for (let i = span.left + 1; i < span.right; i++) between += gaps[i - 1]! + widths[i]!;
    gaps[span.right - 1] = Math.max(gaps[span.right - 1]!, needed - between);
  }
  return gaps;
}

/** The row as the solver reads it: members, widths, gaps, the feeds from a higher tier of the frame, the verticals a member holds. */
function readRow(model: LayoutModel, group: LayoutGroup, rowOrder: readonly string[] = group.rowOrder ?? group.nodes): RowInput | string {
  const order = [...rowOrder], index = new Map(order.map((id, i) => [id, i]));
  const bodies = order.map(id => model.nodes[id]!.bounds!);
  const gaps = repackGaps(model, order, bodies.map(body => body.width));
  const feeds: Feed[] = [], holds: RowInput['holds'] = [];
  for (const link of model.links) {
    // A solid block member is the block's chord, never a seat or a held vertical: the block reservation owns it (`blockFaces`, the owner check).
    const pair = equationEnds(model, link);
    if (pair === undefined) continue;
    for (const [port, far] of [pair, [pair[1], pair[0]] as const]) {
      const member = index.get(port.ref.node);
      if (member === undefined || index.has(far.ref.node)) continue;
      const kind = equationKind(model, group, link, port, far);
      if (kind === 'feed') feeds.push({ link, member, port, far, x: far.anchor!.x - (port.anchor!.x - bodies[member]!.x) });
      else if (kind === 'side' && Math.abs(far.anchor!.x - port.anchor!.x) <= SEAT_STANDS_EPS) holds.push({ link, member, port, far });
    }
  }
  const fixed = new Set(holds.map(item => item.member));
  const candidates = order.map((_, i) => {
    if (fixed.has(i)) return [bodies[i]!.x];
    const xs: number[] = [];
    for (const feed of feeds.filter(item => item.member === i).sort((a, b) => a.x - b.x || linkKey(a.link).localeCompare(linkKey(b.link)))) {
      if (!xs.some(x => Math.abs(x - feed.x) <= PLACEMENT_EPS)) xs.push(feed.x);
    }
    return xs;
  });
  const wide = candidates.findIndex(xs => xs.length > SEAT_SET_CANDIDATES);
  if (wide >= 0) return `${order[wide]} has ${candidates[wide]!.length} seat positions, more than ${SEAT_SET_CANDIDATES}`;
  return { group, order, widths: bodies.map(box => box.width), x0: bodies.map(box => box.x), gaps, feeds, holds, fixed, candidates };
}

/** The x of every member for anchors `fixed` (index to x): a free member stands nearest its own x inside the room its anchors leave. */
function placeFree(input: RowInput, anchors: ReadonlyMap<number, number>): number[] {
  const n = input.order.length, xs = new Array<number>(n);
  const span = (i: number, j: number): number => { let s = 0; for (let k = i; k < j; k++) s += input.widths[k]! + input.gaps[k]!; return s; };
  const keys = [...anchors.keys()].sort((a, b) => a - b);
  for (let k = 0; k < n; k++) {
    if (anchors.has(k)) { xs[k] = anchors.get(k)!; continue; }
    const before = keys.filter(i => i < k).at(-1), after = keys.find(i => i > k);
    const low = before === undefined ? -Infinity : anchors.get(before)! + span(before, k);
    const high = after === undefined ? Infinity : anchors.get(after)! - span(k, after);
    xs[k] = Math.min(high, Math.max(low, input.x0[k]!));
  }
  for (let k = 1; k < n; k++) if (!anchors.has(k)) xs[k] = Math.max(xs[k]!, xs[k - 1]! + input.widths[k - 1]! + input.gaps[k - 1]!);
  return xs;
}

/** The feeds a placement keeps: a feed stands when its member stands at its x; a parent port keeps one feed (the first member in order). */
function keptFeeds(input: RowInput, xs: readonly number[]): Feed[] {
  const claimed = new Set<string>(), kept: Feed[] = [];
  const feeds = [...input.feeds].sort((a, b) => a.member - b.member || linkKey(a.link).localeCompare(linkKey(b.link)) || a.link.sourceIndex - b.link.sourceIndex);
  for (const feed of feeds) {
    const key = portId(feed.far.ref);
    if (Math.abs(xs[feed.member]! - feed.x) > PLACEMENT_EPS || claimed.has(key)) continue;
    claimed.add(key); kept.push(feed);
  }
  return kept;
}

/**
 * One link of an open member (slice 3) as the slot choice reads it: the member's index in the order, its port's offset on the body and the centre x of
 * the far node. The slot choice prefers the slots nearest the far ends (`reach`; the far-end pull of a free member, architecture-2 ticket 22). The far
 * node's centre, not its port: the far face is sorted again for the slot the candidate takes, so the port's slot now is the slot of the provisional
 * order, which declaration order decides between two equal open members (review 1 of slice 3, R3).
 */
interface OpenEnd { member: number; offset: number; x: number }
/** The links of the `open` members of `input` (`OpenEnd`), in member and link order (R3: by the content key of the link). */
function openEnds(model: LayoutModel, input: RowInput, open: ReadonlySet<string>): OpenEnd[] {
  const ends: (OpenEnd & { key: string })[] = [];
  for (const link of model.links) {
    const a = link.attachments;
    if (a === undefined) continue;
    for (const [mine, other] of [[a.from, a.to], [a.to, a.from]] as const) {
      const member = input.order.indexOf(mine.node), port = findPort(model, mine), far = model.nodes[other.node]?.bounds;
      if (!open.has(mine.node) || member < 0 || port?.anchor === undefined || far === undefined) continue;
      ends.push({ member, offset: port.anchor.x - input.x0[member]!, x: far.x + far.width / 2, key: linkKey(link) });
    }
  }
  return ends.sort((p, q) => p.member - q.member || p.key.localeCompare(q.key)).map(({ member, offset, x }) => ({ member, offset, x }));
}
/** One assignment of a row order (`order`, read as `input`): the member x, the kept feeds, the row width, the movement and the content keys. */
interface Leaf { xs: number[]; kept: Feed[]; width: number; reach: number; settled: number; slotted: boolean; movement: number; key: string; index: string; order: string[]; input: RowInput }

/**
 * Every assignment of the fed members (a seat position, or free) that the row order and gaps admit, with one seat per parent port.
 * Undefined when the count bound cuts the search (R4).
 */
function assignments(input: RowInput, ends: readonly OpenEnd[] = [], open: ReadonlySet<string> = new Set()): Leaf[] | undefined {
  const n = input.order.length, leaves: Leaf[] = [];
  const span = (i: number, j: number): number => { let s = 0; for (let k = i; k < j; k++) s += input.widths[k]! + input.gaps[k]!; return s; };
  let visits = 0, cut = false;
  const visit = (k: number, anchors: Map<number, number>, last: number | undefined): void => {
    if (cut) return;
    if (++visits > SEAT_SET_VISITS) { cut = true; return; }
    if (k === n) {
      const xs = placeFree(input, anchors), kept = keptFeeds(input, xs);
      const low = Math.min(...xs), high = Math.max(...xs.map((x, i) => x + input.widths[i]!));
      const keys = kept.map(feed => linkKey(feed.link)).sort();
      const moves = xs.map((x, i) => Math.abs(x - input.x0[i]!));
      leaves.push({ xs, kept, width: high - low, reach: ends.reduce((sum, end) => sum + Math.abs(xs[end.member]! + end.offset - end.x), 0),
        settled: moves.reduce((sum, move, i) => open.has(input.order[i]!) ? sum : sum + move, 0), slotted: false, movement: moves.reduce((sum, move) => sum + move, 0), key: keys.join('|'),
        index: kept.map(feed => feed.link.sourceIndex).sort((a, b) => a - b).join(','), order: input.order, input });
      return;
    }
    const options = input.candidates[k]!;
    for (const x of options) {
      if (last !== undefined && x + PLACEMENT_EPS < anchors.get(last)! + span(last, k)) continue;
      anchors.set(k, x); visit(k + 1, anchors, k); anchors.delete(k);
    }
    if (!input.fixed.has(k)) visit(k + 1, anchors, last);
  };
  visit(0, new Map(), undefined);
  return cut ? undefined : leaves;
}

/**
 * What a candidate costs the placed extent, read at stage 6 (owner ruling 'tight room' is area, not span): `span` the interval width, `dw` the
 * growth of the cell box, `dh` the growth of the tier gaps its solid blocks demand (`blockDemands` with the members at the candidate's xs, by
 * tier gap: the larger of the band gap and the 34 degree demand, or the floor of a flat block, as `reserveBlockGaps` reserves them), `area` the
 * area the extent `W x H` of the groups gains, (W + dw)(H + dh) - W H.
 */
interface Cost { span: number; dw: number; dh: number; area: number }

/** The height of each tier gap that the solid blocks demand (`reserveBlockGaps`' mandatory gap, without the room of a flat gap). */
function blockHeights(demands: readonly BlockDemand[]): Map<number, number> {
  const heights = new Map<number, number>();
  for (const item of demands) heights.set(item.below, Math.max(heights.get(item.below) ?? item.gap, item.gap, item.steep > BLOCK_CAP + EPS ? item.floor : item.steep));
  return heights;
}

/**
 * The cost of `leaf` (`Cost`) against the row where it stands now (`start`: its box width, the block heights, the extent of the groups), from what
 * `planSeatSet` read once with the leaf staged: the cell's content box `fit` and the block demands `demands` (undefined: the row feeds no block).
 */
function candidateCost(leaf: Leaf, fit: Rect, demands: readonly BlockDemand[] | undefined,
  start: { width: number; heights: ReadonlyMap<number, number>; w: number; h: number }): Cost {
  const heights = demands === undefined ? undefined : blockHeights(demands);
  const dw = Math.max(0, fit.width - start.width);
  let dh = 0;
  for (const [below, height] of heights ?? []) dh += Math.max(0, height - (start.heights.get(below) ?? height));
  return { span: leaf.width, dw, dh, area: (start.w + dw) * (start.h + dh) - start.w * start.h };
}

/** The extent of the placed groups, W x H. */
function groupExtent(model: LayoutModel): { w: number; h: number } {
  const boxes = Object.values(model.groups).flatMap(group => group.bounds ? [group.bounds] : []);
  if (!boxes.length) return { w: 0, h: 0 };
  const low = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
  return { w: Math.max(...boxes.map(right)) - low, h: Math.max(...boxes.map(box => box.y + box.height)) - top };
}

/**
 * The order the candidates are read in (owner ruling 'tight room'): the most kept verticals, then the least interval width, the open members nearest
 * their far nodes (`reach`, slice 3; 0 in a row with none), the least movement of the members that are not movable open members (`settled`), the
 * order stage 4 left before an order the slot choice adds (`slotted`: an open member takes another slot only for a gain above), the row order by
 * content (the slots of the open members, slice 3), the least movement of all members, the kept links by content, then sourceIndex (R3). The
 * movement of a movable open member comes after the row order: it reads the member's provisional x, which declaration order decides for two equal
 * open members (review 1 of slice 3). In a row with no movable member `settled` is the movement and the leaves of the one row order tie on the rest,
 * so the row reads as in slice 1. The read bound (`SEAT_SET_GAIN_READS`) cuts this order, so the candidate this order admits first is always read.
 */
const readOrder = (a: Leaf, b: Leaf): number => b.kept.length - a.kept.length || (Math.abs(a.width - b.width) > PLACEMENT_EPS ? a.width - b.width : 0)
  || (Math.abs(a.reach - b.reach) > PLACEMENT_EPS ? a.reach - b.reach : 0) || (Math.abs(a.settled - b.settled) > PLACEMENT_EPS ? a.settled - b.settled : 0)
  || Number(a.slotted) - Number(b.slotted) || a.order.join('|').localeCompare(b.order.join('|')) || (Math.abs(a.movement - b.movement) > PLACEMENT_EPS ? a.movement - b.movement : 0)
  || a.key.localeCompare(b.key) || a.index.localeCompare(b.index);

/**
 * The choice among the admitted candidates of the most kept verticals and the narrowest row (owner ruling of 2026-11-17: straight links win
 * over compactness inside a frame; reserve only the exact room the seats need): the least added area (`candidateCost`, the block height of the
 * spread included), then the read order. Area never overrides the kept verticals or the row width, so it never buys back a straight link the
 * read order keeps: a wider row with a smaller block changed the extent of a stagger-gate trial and the block room of the kept placement, and
 * bent chords the narrower row kept straight (dense-16x9 ticket 36a, outside sheet).
 */
const choice = (a: { leaf: Leaf; cost: Cost }, b: { leaf: Leaf; cost: Cost }): number =>
  (Math.abs(a.cost.area - b.cost.area) > PLACEMENT_EPS ? a.cost.area - b.cost.area : 0) || readOrder(a.leaf, b.leaf);

/** Moves the members to `xs` (bodies and port anchors), and gives back a function that undoes the move exactly. */
function moveMembers(model: LayoutModel, order: readonly string[], xs: readonly number[]): () => void {
  const saved = order.map(id => { const node = model.nodes[id]!; return { node, box: { ...node.bounds! }, anchors: node.ports.map(port => port.anchor && { ...port.anchor }) }; });
  for (const [i, id] of order.entries()) {
    const node = model.nodes[id]!, dx = xs[i]! - node.bounds!.x;
    node.bounds = { ...node.bounds!, x: xs[i]! };
    for (const port of node.ports) if (port.anchor) port.anchor = { ...port.anchor, x: port.anchor.x + dx };
  }
  return () => { for (const item of saved) { item.node.bounds = item.box; item.node.ports.forEach((port, i) => { if (item.anchors[i]) port.anchor = item.anchors[i]; }); } };
}

/**
 * Why the candidate breaks a block owner, or undefined: an under-cap block passes the cap, or a flat block's floor demand grows past its gap. `after`
 * is the block demands read once with the candidate staged (`planSeatSet`).
 */
function blockOwnerFault(model: LayoutModel, before: readonly BlockDemand[], after: readonly BlockDemand[] | undefined): string | undefined {
  if (!before.length || after === undefined) return undefined;
  for (const was of before) {
    const now = after.find(item => item.family === was.family)!;
    if (was.steep <= BLOCK_CAP + EPS && now.steep > BLOCK_CAP + EPS) return `the block ${was.family} would pass its ${BLOCK_CAP} px cap (${now.steep.toFixed(1)} px)`;
    const gap = Math.max(was.floor, model.flatBlockGaps?.find(item => item.family === was.family)?.gap ?? -Infinity);
    if (was.steep > BLOCK_CAP + EPS && now.floor > gap + EPS) return `the flat block ${was.family} would need ${now.floor.toFixed(1)} px, past its gap ${gap.toFixed(1)} px`;
  }
  return undefined;
}

/**
 * The most row orders the slot choice of one row tries (dense-16x9 ticket 36, slice 3; R4: a count). Each order is read by stage 4's own reader
 * (`belowReader`, the pair search under the row) and searched by `assignments`. Two open members in a row of six, the core rows of the outside sheet,
 * give 30 orders; past the bound the open members keep their provisional slots, named (`SEAT_SET_SLOT_BOUND`).
 */
export const SEAT_SET_SLOT_ORDERS = 64;
/** The diagnostic of a row whose slot orders pass `SEAT_SET_SLOT_ORDERS`: its open members keep the slots stage 4 gave them. */
export const SEAT_SET_SLOT_BOUND = 'SEAT_SET_SLOT_BOUND';

/**
 * The orders the slot choice of `group` tries (dense-16x9 ticket 36, slice 3): its order now first, then every order that puts the `movable` open
 * members in other slots and keeps the other members in their order, if stage 4's reader decides the same below the row under it (`belowReader`).
 */
function slotOrders(model: LayoutModel, group: LayoutGroup, base: readonly string[], movable: ReadonlySet<string>): { orders: string[][]; bound?: number } {
  if (!movable.size) return { orders: [[...base]] };
  const rest = base.filter(id => !movable.has(id)), items = base.filter(id => movable.has(id));
  let count = 1;
  for (let k = 1; k <= items.length; k++) count *= rest.length + k;
  if (count > SEAT_SET_SLOT_ORDERS) return { orders: [[...base]], bound: count };
  let orders = [rest];
  for (const item of items) orders = orders.flatMap(order => Array.from({ length: order.length + 1 }, (_, i) => [...order.slice(0, i), item, ...order.slice(i)]));
  const below = belowReader(model), today = below(group, base);
  return { orders: [[...base], ...orders.filter(order => !sameOrder(order, base) && below(group, order) === today)] };
}

/** What stands a leaf (`stageLeaf`): the cell, its order now, and its open members. */
interface Stage { model: LayoutModel; group: LayoutGroup; base: readonly string[]; open: ReadonlySet<string> }

/**
 * Stands the members of `group` as `leaf` has them: the cell in the leaf's order, the bodies at its x, and every face that reads a moved open member
 * sorted again by the stage-5 sorter (`resortFaces`, with the pills when `pills`). Gives back the undo and the faces sorted again, or why a face cannot be.
 */
function stageLeaf(stage: Stage, leaf: Pick<Leaf, 'order' | 'xs'>, pills = false): { undo: () => void; faces: Resorted['faces'] } | string {
  const { model, group } = stage, was = group.rowOrder, moved = movedOpen(stage.open, stage.base, leaf.order);
  const back = (): void => { if (moved.size) { if (was === undefined) delete group.rowOrder; else group.rowOrder = was; } };
  if (moved.size) group.rowOrder = [...leaf.order];
  const members = moveMembers(model, leaf.order, leaf.xs);
  const resorted = resortFaces(model, moved, pills);
  if (typeof resorted === 'string') { members(); back(); return resorted; }
  return { faces: resorted.faces, undo: () => { resorted.undo(); members(); back(); } };
}
/** The links of the ports of `faces`: the other links of a face sorted again, which ruling 4 reads too. */
function faceLinks(model: LayoutModel, faces: Resorted['faces']): Set<string> {
  const ports = new Set(faces.flatMap(face => face.after));
  return new Set(model.links.filter(link => link.attachments !== undefined && (ports.has(portId(link.attachments.from)) || ports.has(portId(link.attachments.to)))).map(link => link.id));
}

/** A group the rows rule does not move for a row: a flank, or a group that is no row (a bar, a grid). The name it has in a decline. */
const fixedKind = (model: LayoutModel, group: LayoutGroup): string | undefined => group.flank !== undefined ? 'the flank'
  : groupShape(model, group.id) !== 'row' ? `the ${groupShape(model, group.id)}` : undefined;

/**
 * The seat set of the cell `group` on `model` (no write): the best assignment that breaks no owner, as a record payload, or why there is
 * none. The model is moved only to read an owner, and is given back exactly.
 */
export function planSeatSet(model: LayoutModel, group: LayoutGroup): SeatSetOutcome {
  const scope = seatSetScope(model, group);
  if (scope !== undefined) return { kind: 'declined', clause: 'scope', why: scope };
  const base = [...(group.rowOrder ?? group.nodes)];
  const input = readRow(model, group, base);
  if (typeof input === 'string') return { kind: 'declined', clause: 'bound', why: input };
  if (!input.feeds.length) return { kind: 'declined', clause: 'scope', why: NO_FEED };
  // The open members (slice 3, `rowOrder.open`) that hold no vertical move to the slots the choice tries; the others keep their slots.
  const open = openMembers(model.reservations, group.id);
  const movable = new Set([...open].filter(id => input.order.includes(id) && !input.fixed.has(input.order.indexOf(id))));
  const slots = slotOrders(model, group, base, movable);
  if (slots.bound !== undefined) {
    const message = `The open members of ${group.id} keep their slots: ${slots.bound} slot orders, more than ${SEAT_SET_SLOT_ORDERS}.`;
    if (!model.diagnostics.some(item => item.code === SEAT_SET_SLOT_BOUND && item.message === message))
      model.diagnostics.push({ stage: 'placement', severity: 'info', code: SEAT_SET_SLOT_BOUND, message, owners: [{ kind: 'group', id: group.id }] });
  }
  const leaves: Leaf[] = [];
  for (const order of slots.orders) {
    const read: RowInput | string = order === slots.orders[0] ? input : readRow(model, group, order);
    if (typeof read === 'string') continue;
    const found = assignments(read, openEnds(model, read, movable), movable);
    if (found === undefined) return { kind: 'declined', clause: 'bound', why: `the search passed ${SEAT_SET_VISITS} visits` };
    if (read === input) { leaves.push(...found); continue; }
    for (const leaf of found) leaf.slotted = true;
    // An order the slot choice adds is one candidate per kept set: its first leaf in read order (the narrowest row, then the least movement). Its other
    // leaves differ only where the free members stand, and would spend the read bound of the row on one slot choice.
    const best = new Map<string, Leaf>();
    for (const leaf of found.sort(readOrder)) if (!best.has(leaf.key)) best.set(leaf.key, leaf);
    leaves.push(...best.values());
  }
  const now = keptFeeds(input, input.x0).length;
  const hasBlocks = input.order.some(id => model.links.some(link => link.solidBlock && (link.attachments?.from.node === id || link.attachments?.to.node === id)));
  const blocks = hasBlocks ? blockDemands(model).demands : [];
  const start = { width: group.bounds!.width, heights: blockHeights(blocks), ...groupExtent(model) };
  const gaining = leaves.filter(leaf => leaf.kept.length > now).sort(readOrder);
  const stage: Stage = { model, group, base, open: movable };
  let first: string | undefined, reads = 0, lost: string | undefined;
  // The reading of each link on the row as it stands, kept for the solve: every candidate's `before` reads the same geometry (review 1 of slice 3).
  const standing = new Map<string, 'vertical' | 'straight' | 'bent'>();
  const baseline = straightLinks(model, base, new Set(), standing), admitted: { leaf: Leaf; cost: Cost; fit: Rect }[] = [];
  // In read order, up to the read bound: the first admitted candidate sets the kept verticals and the row width, and every later candidate
  // with both (the width to PLACEMENT_EPS) is read too; the choice among them is made by area.
  for (const leaf of gaining) {
    const head = admitted[0]?.leaf;
    if (head && (leaf.kept.length < head.kept.length || leaf.width - head.width > PLACEMENT_EPS)) break;
    if (reads >= SEAT_SET_GAIN_READS) break;
    const box = group.bounds!, staged = stageLeaf(stage, leaf);
    reads++;
    // A face that reads a moved open member and that another owner holds declines the candidate by name (slice 3).
    if (typeof staged === 'string') { first ??= staged; continue; }
    const fit = contentBox(model, group);
    // The gain is read on both faces of the members (ruling 4 of 2026-11-17), and on the other links of a face sorted again (slice 3): a set that
    // wins k verticals and turns more than k straight links into bends or refused chords is no gain. Read on the moved members, before the model is given back.
    const also = faceLinks(model, staged.faces), after = straightLinks(model, leaf.order, also);
    // The block demands with the candidate staged and the cell box over it, read once for the owner check and the area (review 1 of slice 3: one staging).
    let demands: BlockDemand[] | undefined;
    if (hasBlocks) { group.bounds = fit; try { demands = blockDemands(model).demands; } finally { group.bounds = box; } }
    staged.undo(); group.bounds = box;
    const before = also.size ? straightLinks(model, base, also, standing) : baseline;
    const fault = blockOwnerFault(model, blocks, demands);
    if (fault !== undefined) { first ??= fault; continue; }
    const gained = [...after.vertical].filter(id => !before.vertical.has(id)).length, gone = [...before.straight].filter(id => !after.straight.has(id)).sort();
    if (gone.length > gained) { lost ??= `wins ${gained} verticals and loses ${gone.length} straight links (${gone.join(', ')})`; continue; }
    admitted.push({ leaf, cost: candidateCost(leaf, fit, demands, start), fit });
  }
  if (admitted.length) {
    const best = admitted.sort(choice)[0]!;
    return { kind: 'set', payload: payloadOf(model, best.leaf.input, best.leaf, best.fit) };
  }
  if (first !== undefined) return { kind: 'declined', clause: 'owner', why: first };
  return { kind: 'declined', clause: 'no-gain', why: lost !== undefined ? `the best seat set ${lost}`
    : `no seat set keeps more than the ${now} verticals the row stands` };
}

/**
 * The links of the members of `order` to nodes outside the row (and the links `also` names: the other links of a face the slot choice sorts again), on both faces, that stand vertical and that stand straight on the anchors now: vertical (within
 * `SEAT_STANDS_EPS`), or a path the frame and row rules would pin on these anchors (`expectedRowPath`: a held chord or a level path). This is
 * what placement can read at stage 6 of what a set costs elsewhere: the chords are decided after the rows rule (`rebuildRowPaths`) on the
 * same reading. A link an overlay or a later rule draws is not read.
 */
function straightLinks(model: LayoutModel, order: readonly string[], also: ReadonlySet<string> = new Set(),
  read?: Map<string, 'vertical' | 'straight' | 'bent'>): { vertical: Set<string>; straight: Set<string> } {
  const members = new Set(order), vertical = new Set<string>(), straight = new Set<string>();
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || link.layer !== 'routed' || (members.has(ends.from.node) === members.has(ends.to.node) && !also.has(link.id))) continue;
    // `read` keeps the reading of each link on one geometry (the row as it stands, `planSeatSet`), so a link is read there once per solve.
    let state = read?.get(link.id);
    if (state === undefined) {
      const a = findPort(model, ends.from)?.anchor, b = findPort(model, ends.to)?.anchor;
      if (a === undefined || b === undefined) continue;
      state = Math.abs(a.x - b.x) <= SEAT_STANDS_EPS ? 'vertical' : expectedRowPath(model, link) !== undefined ? 'straight' : 'bent';
      read?.set(link.id, state);
    }
    if (state === 'vertical') vertical.add(link.id);
    if (state !== 'bent') straight.add(link.id);
  }
  return { vertical, straight };
}

function payloadOf(model: LayoutModel, input: RowInput, leaf: Leaf, fit: Rect): SeatSetPayload {
  const equation = (link: LayoutLink, port: LayoutPort, far: LayoutPort, memberX: number): SeatEquation => ({ link: link.id, member: { ...port.ref }, far: { ...far.ref },
    memberOffset: port.anchor!.x - memberX, farOffset: far.anchor!.x - model.nodes[far.ref.node]!.bounds!.x });
  const seats = leaf.kept.map(feed => equation(feed.link, feed.port, feed.far, input.x0[feed.member]!));
  const holds = input.holds.map(item => equation(item.link, item.port, item.far, input.x0[item.member]!));
  const farPorts = [...new Map([...seats, ...holds].map(item => [portKey(item.far), item.far] as const)).values()].sort((a, b) => (portKey(a) < portKey(b) ? -1 : portKey(a) > portKey(b) ? 1 : 0));
  const anchor = (ref: SeatEquation['far']): number => findPort(model, ref)!.anchor!.x, origin = anchor(farPorts[0]!);
  const blockFaces: SeatSetPayload['blockFaces'] = [];
  for (const id of input.order) for (const side of ['top', 'bottom'] as const) {
    const solid = new Set(model.links.filter(link => link.solidBlock).flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
    const ports = model.nodes[id]!.ports.filter(port => port.side === side && port.anchor && solid.has(portId(port.ref))).sort((a, b) => a.anchor!.x - b.anchor!.x);
    if (ports.length) blockFaces.push({ node: id, side, ports: ports.map(port => portKey(port.ref)) });
  }
  const keptIds = new Set(leaf.kept.map(feed => feed.link.id)), claimed = new Set(leaf.kept.map(feed => portId(feed.far.ref)));
  const declined = input.feeds.filter(feed => !keptIds.has(feed.link.id)).sort((a, b) => a.link.id.localeCompare(b.link.id))
    .map(feed => ({ link: feed.link.id, reason: input.fixed.has(feed.member) ? 'fixed' as const : claimed.has(portId(feed.far.ref)) ? 'shared-port' as const
      : leaf.kept.some(seat => seat.member === feed.member && seat.far.ref.node === feed.far.ref.node) ? 'pitch' as const : 'conflict' as const }));
  return {
    row: input.group.id, frame: input.group.frame!, order: [...input.order], widths: [...input.widths], seats, holds, blockFaces,
    boundary: farPorts.map(ref => ({ port: { ...ref }, x: anchor(ref) - origin })),
    xs: leaf.xs.map(x => x - origin), interval: { low: fit.x - origin, high: right(fit) - origin }, declined,
  };
}

/** The diagnostic of a row the seat set declines (`planSeatSet`): the row, the clause, why. Not for a row that no parent feeds. */
export const SEAT_SET_DECLINED = 'SEAT_SET_DECLINED';

/**
 * Stage 6, at the end of each `repackOverlaps`, with `layout.moveBeforeGrow`: band by band from the top tier, each rank cell that holds a
 * seat set stands on it where its boundary stands now (`applySeatSet`); with `solve` (the last repack of the rows rule) each cell in scope
 * without one gets its set (`planSeatSet`, top tier first, then by id, R3) on the geometry the repack left. A set moves its members, makes
 * the cell box cover its interval and writes its `seatSet` entry (producer `rows`). The caller then moves the frame columns apart as wholes
 * (`separateFrameColumns`): a frame moves with the parents of its rows, so no seat moves off its parent. A set whose boundary no longer
 * stands is withdrawn by name; a declined row keeps its place and gets `SEAT_SET_DECLINED`. True when a set stands.
 */
export function seatRows(model: LayoutModel, solve: boolean, refused: ReadonlyMap<string, string> = new Map(), declined: ReadonlyMap<string, string> = new Map()): boolean {
  if (model.document.layout?.moveBeforeGrow !== true) return false;
  if (!solve && !(model.reservations ?? []).some(entry => entry.kind === 'seatSet')) return false;
  let moved = false;
  for (const band of [...model.tierBands].sort((a, b) => a.tier - b.tier || a.bounds!.y - b.bounds!.y)) {
    const cells = rowGroups(model, band).filter(group => group.frame !== undefined).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const owned = new Set<string>();
    for (const group of cells) {
      const entry = seatSetOf(model, group.id);
      if (entry !== undefined) {
        const why = applySeatSet(model, group, entry);
        if (why !== undefined) { withdrawSeatSet(model, group.id, why); continue; }
      }
      else if (solve) {
        const plan: SeatSetOutcome = declined.has(group.id) ? { kind: 'declined', clause: 'withdrawn', why: `in an earlier placement of this command it was ${declined.get(group.id)!}` }
          : refused.has(group.id) ? { kind: 'declined', clause: 'owner', why: refused.get(group.id)! } : planSeatSet(model, group);
        if (plan.kind === 'declined') {
          if (plan.why !== NO_FEED) model.diagnostics.push({ stage: 'placement', severity: 'info', code: SEAT_SET_DECLINED,
            message: `The seat set of ${group.id} is declined (${plan.clause}): ${plan.why}.`, owners: [{ kind: 'group', id: group.id }] });
          continue;
        }
        const p = plan.payload, origin = boundaryOrigin(model, p)!;
        // The slots of the open members close here (slice 3): the cell takes the set's order and the faces that read a moved open member are sorted again.
        const base = group.rowOrder ?? group.nodes, staged = stageLeaf({ model, group, base, open: openMembers(model.reservations, group.id) }, { order: p.order, xs: p.xs.map(x => origin + x) }, true);
        if (typeof staged === 'string') throw new Error(`The seat set of ${group.id} no longer stands its plan: ${staged}`);
        rebuildNodeGeometry(model, p.order, 'current');
        coverInterval(model, group, p);
        model.reservations = [...(model.reservations ?? []), reservation('seatSet', { kind: 'group', id: group.id }, '', 'rows', 0, p)];
      }
      else continue;
      owned.add(group.id);
    }
    if (owned.size) moved = true;
  }
  return moved;
}

/**
 * The pairs (frame or row group, fixed group) that stand nearer than the beside gap across a sub-tier they share, the clearance G9 reads, each
 * with how much of the gap it lacks.
 */
function fixedClearances(model: LayoutModel): Map<string, number> {
  const pairs = new Map<string, number>(), gap = besideGap(model, true, false);
  const fixed = Object.values(model.groups).filter(group => group.bounds !== undefined && fixedKind(model, group) !== undefined && (group.nodes.length > 0 || group.flank !== undefined));
  const units = [...(deriveFrames(model, false) ?? []).filter(frame => frame.parent === undefined).map(frame => ({ id: `frame:${frame.id}`, box: frame.box })),
    ...Object.values(model.groups).filter(group => group.frame === undefined && group.bounds !== undefined && fixedKind(model, group) === undefined).map(group => ({ id: group.id, box: group.bounds! }))];
  for (const unit of units) for (const other of fixed) {
    const o = other.bounds!, b = unit.box;
    if (!(o.y < b.y + b.height && b.y < o.y + o.height)) continue;
    const short = gap - Math.max(o.x - right(b), b.x - right(o));
    if (short > PLACEMENT_EPS) pairs.set(`${unit.id}|${other.id}`, short);
  }
  return pairs;
}

/**
 * The seat sets of the last repack of the rows rule, with the frame columns moved apart after them (`separateFrameColumns`): a frame moves
 * with the parents of its rows, so no seat moves. A flank, bar or grid gives no way: when the sets would bring a frame or a row group nearer to
 * one than the beside gap, the model is given back and the last set that stood is refused by name (clause `owner`), and the sets are decided
 * again, at most once per set. Every other repack applies the sets it finds.
 */
export function seatRowsAndColumns(model: LayoutModel, solve: boolean, declined: ReadonlyMap<string, string> = new Map()): void {
  if (!solve) { if (seatRows(model, false)) { separateFrameColumns(model); holdColumnAxes(model); } return; }
  // The rows the command declined (ruling B) are in the ledger of every run, from its input, so the row is not decided again.
  const input = [...declined].filter(([row]) => model.groups[row] !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (input.length) model.reservations = [...(model.reservations ?? []),
    ...input.map(([row, why]) => reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0, { row, at: 'input', why }))];
  const before = fixedClearances(model), saved = JSON.stringify({ nodes: model.nodes, groups: model.groups, labels: model.labels, reservations: model.reservations, diagnostics: model.diagnostics });
  const restore = (): void => { Object.assign(model, JSON.parse(saved) as Pick<LayoutModel, 'nodes' | 'groups' | 'labels' | 'reservations' | 'diagnostics'>); };
  const refused = new Map<string, string>();
  for (let round = 0; ; round++) {
    if (!seatRows(model, true, refused, declined)) return;
    // The column moves of every later repack, here once: the frames move apart, and each column is pulled back toward its feeds (both move
    // whole frames, so no seat moves). The clearance to a fixed group is read where those moves leave the frames, not before them.
    separateFrameColumns(model);
    holdColumnAxes(model);
    // A pair the sets bring nearer than it stood (or that is new) is theirs; a pair the repack left short as it is, later moves settle.
    const added = [...fixedClearances(model)].filter(([pair, short]) => short > (before.get(pair) ?? 0) + PLACEMENT_EPS).map(([pair]) => pair).sort();
    const sets = (model.reservations ?? []).filter(entry => entry.kind === 'seatSet');
    if (!added.length || !sets.length) return;
    const [unit, fixed] = added[0]!.split('|');
    const why = `the frame columns would move ${unit!.replace('frame:', 'the frame ')} nearer than the beside gap to ${fixedKind(model, model.groups[fixed!]!)} ${fixed}, which gives no way`;
    restore();
    if (round + 1 >= SEAT_SET_REDECISIONS) {
      // The bound: every set of the run is refused by name, and the rows stand as the repack left them.
      for (const entry of sets) refused.set(entry.payload.row, `${why} (the sets were decided ${SEAT_SET_REDECISIONS} times)`);
      seatRows(model, true, refused, declined);
      return;
    }
    refused.set(sets.at(-1)!.payload.row, why);
  }
}

/** The seat set of `group` on `model`, or undefined: the one reader of the entry for every stage that fits, moves or reads the cell. */
export function seatSetOf(model: LayoutModel, group: string): SeatSetPayload | undefined {
  return (model.reservations ?? []).find((entry): entry is ReservationOf<'seatSet'> => entry.kind === 'seatSet' && entry.owner.kind === 'group' && entry.owner.id === group)?.payload;
}

/** The anchor x of the first boundary port of `p` where it stands now: the origin of every x of the set, or undefined. */
export function boundaryOrigin(model: LayoutModel, p: SeatSetPayload): number | undefined {
  return findPort(model, p.boundary[0]!.port)?.anchor?.x;
}

/** The interval of a seat set where its boundary stands now: [low, high] in model x. */
export function seatInterval(model: LayoutModel, p: SeatSetPayload): { low: number; high: number } {
  const origin = boundaryOrigin(model, p)!;
  return { low: origin + p.interval.low, high: origin + p.interval.high };
}

/** Grows the box of `group` to cover the interval of its seat set (never shrinks it): the entry owns that room. */
export function coverInterval(model: LayoutModel, group: LayoutGroup, p: SeatSetPayload = seatSetOf(model, group.id)!): void {
  const { low, high } = seatInterval(model, p), box = group.bounds!;
  const x = Math.min(box.x, low), end = Math.max(right(box), high);
  if (x < box.x || end > right(box)) group.bounds = { ...box, x, width: end - x };
}

/** The diagnostic of a seat set 7c withdraws: the row, the equation that failed, and what stays. */
export const SEAT_SET_WITHDRAWN = 'SEAT_SET_WITHDRAWN';

/** The far ends of the equations of every standing seat set and of every set withdrawn from 7c on (`fixed`), each with the row of the first entry that reads it (entry order). */
function seatSetFarEnds(model: LayoutModel): Map<string, string> {
  const far = new Map<string, string>();
  for (const entry of model.reservations ?? []) {
    if (entry.kind === 'seatSet') for (const eq of [...entry.payload.seats, ...entry.payload.holds]) { if (!far.has(eq.far.node)) far.set(eq.far.node, entry.payload.row); }
    else if (entry.kind === 'seatSetDeclined') for (const { node } of entry.payload.fixed ?? []) if (!far.has(node)) far.set(node, entry.payload.row);
  }
  return far;
}

/** The nodes every seat set reads as fixed (dense-16x9 ticket 36, slice 1): its members and the far ends of its equations. No parent spread moves them. */
export function seatSetNodes(model: LayoutModel): Set<string> {
  const nodes = new Set<string>(seatSetFarEnds(model).keys());
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSet') for (const id of entry.payload.order) nodes.add(id);
  return nodes;
}

/** The clause of a seat-set withdrawal on the wall of its frame column (`seatWall` of 7c): read by the step decision of 7f (`chordDecision`) and counted. */
export const SEAT_WALL_COLUMN = 'the row would leave the column of its frame';

/**
 * The rows whose seat set stands on `before` and is withdrawn on `after` by the clause `clause` (all clauses when undefined), read from the
 * ledgers (dense-16x9 ticket 36a, review 2): identities, not counts, so a move that withdraws one set and keeps another that `before` withdrew
 * still loses the first. The one reading of the step decisions that compare two settled copies (`chordDecision`).
 */
export function seatSetsLost(before: LayoutModel, after: LayoutModel, clause?: string): string[] {
  const standing = new Set((before.reservations ?? []).flatMap(entry => entry.kind === 'seatSet' ? [entry.payload.row] : []));
  return (after.reservations ?? []).flatMap(entry => entry.kind === 'seatSetDeclined' && standing.has(entry.payload.row)
    && (clause === undefined || entry.payload.why.startsWith(clause)) ? [entry.payload.row] : []).sort();
}

/** The diagnostic of a 7c move a standing seat set clamps (`seatFarEndRange`): the mover, the row, how far it asked and how far it went, and why. */
export const SEAT_FAR_END_CLAMPED = 'SEAT_FAR_END_CLAMPED';

/** The x shifts a 7c mover may give a translation, and the condition that bounds them (`seatFarEndRange`). */
export interface FarEndRange { low: number; high: number; why: string }

/**
 * The x shifts a 7c mover may give the groups `moving`, translated together, or undefined when none of them carries a far end of a seat set
 * (dense-16x9 ticket 36a, ruling 3 on review 1 finding 2). A far end of a standing set moves only together with its set: the set translates as
 * a whole, as stage 6 placed it, so every group that carries one of its far ends must move, and only as far as the box of the seated row stays in
 * `room` (the window of its frame column in 7c, `columnWindow`). A set whose row moves with them sets no bound. A set
 * withdrawn from 7c on keeps the far ends of its own equations where 7c left them (`seatSetDeclined.fixed`), and a set whose box does not stand
 * in its room does not move. A set seated on the anchor tier sets no bound: it cannot translate, and its rule withdraws it. The rows that move
 * along are read as a closure before any bound, so the range does not depend on the order of the ledger (R3). The range always holds 0; the one
 * reading of every 7c mover.
 */
export function seatFarEndRange(model: LayoutModel, moving: Iterable<string>, room: (row: string) => { low: number; high: number }): FarEndRange | undefined {
  const start = new Set(moving), groupOf = (node: string): string => model.document.nodes[node]!.group;
  let range: FarEndRange | undefined;
  const bound = (low: number, high: number, why: string): void => {
    low = Math.min(low, 0); high = Math.max(high, 0);
    if (range === undefined) { range = { low, high, why }; return; }
    if (low > range.low) range = { ...range, low, why };
    if (high < range.high) range = { ...range, high, why };
  };
  const sets = (model.reservations ?? []).flatMap(entry => entry.kind === 'seatSet' ? [entry.payload] : []);
  const carriersOf = (p: SeatSetPayload): string[] => [...new Set([...p.seats, ...p.holds].map(eq => groupOf(eq.far.node)))].sort();
  // The closure first (R3: no ledger order): a set whose far ends all move takes its row along, unless the row stands on the anchor tier, which no
  // step of 7c moves; that row may carry far ends of a further set (a chain). Each row joins once, so the loop ends after at most one round per set (R4).
  const moved = new Set(start), joined = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const p of sets) {
      if (moved.has(p.row) || model.groups[p.row]!.tier === model.anchorTier || !carriersOf(p).every(id => moved.has(id))) continue;
      moved.add(p.row); joined.add(p.row); grew = true;
    }
  }
  // A set withdrawn from 7c on keeps the far ends of its own equations where 7c left them (`seatSetDeclined.fixed`).
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSetDeclined') {
    const held = (entry.payload.fixed ?? []).find(item => moved.has(groupOf(item.node)));
    if (held !== undefined) bound(0, 0, `${held.node} is a far end of ${held.link} in the seat set of ${entry.payload.row}, withdrawn at ${entry.payload.at}, and stays where 7c left it`);
  }
  for (const p of sets) {
    const carriers = carriersOf(p);
    if (!carriers.some(id => moved.has(id)) || (moved.has(p.row) && !joined.has(p.row))) continue;
    const left = carriers.filter(id => !moved.has(id));
    if (left.length) { bound(0, 0, `the far ends of the seat set of ${p.row} stand in ${carriers.join(', ')}, and ${left.join(', ')} does not move with them`); continue; }
    // A set seated on the anchor tier cannot translate: no step of 7c moves that row. It sets no bound, so a mover is not frozen by it; the rows
    // rule withdraws the set at its next application ("its row is the anchor tier") and the retry runs without it. A clamp to 0 here froze
    // the parent row and cost more straight links than the set holds (forced-on corpus, 2026-11-17: a new G5 and 8 bends on three sheets).
    if (!joined.has(p.row)) continue;
    // The box the wall reads is the one the set leaves when it is applied where its far ends stand: its interval (`payloadOf` takes it from the cell's fit).
    // The cell box may also be wider than the interval (a label): the wall reads the union where the set stands now.
    const at = seatInterval(model, p), cell = model.groups[p.row]!.bounds!, x = Math.min(at.low, cell.x), end = Math.max(at.high, cell.x + cell.width);
    const box = { x, width: end - x }, window = room(p.row), low = window.low - box.x, high = window.high - box.x - box.width;
    // A box that does not stand in its room now has no shift that keeps it there: the set does not move.
    if (low > PLACEMENT_EPS || high < -PLACEMENT_EPS) bound(0, 0, `the box of ${p.row} (${box.x.toFixed(1)} to ${(box.x + box.width).toFixed(1)}) does not stand in its window (${window.low.toFixed(1)} to ${window.high.toFixed(1)}), so its seat set does not move`);
    else bound(low, high, `the seat set of ${p.row} translates with its far ends and stays in its window (${window.low.toFixed(1)} to ${window.high.toFixed(1)})`);
  }
  return range;
}

/** The shift a mover takes inside `range`: `dx` clamped, and whether the clamp cut it. */
export function clampFarEndShift(range: FarEndRange | undefined, dx: number): { dx: number; clamped: boolean } {
  if (range === undefined) return { dx, clamped: false };
  const kept = Math.max(range.low, Math.min(range.high, dx));
  return { dx: kept, clamped: Math.abs(kept - dx) > PLACEMENT_EPS };
}

/** Names a clamp of a 7c mover (`seatFarEndRange`) once per mover, row and shift: an info diagnostic, read by no decision. */
export function nameFarEndClamp(model: LayoutModel, mover: string, group: string, asked: number | undefined, kept: number, why: string): void {
  const message = asked === undefined ? `${mover} holds ${group} as a wall: ${why}.` : `${mover} moves ${group} ${kept.toFixed(1)} px of the ${asked.toFixed(1)} px it asked: ${why}.`;
  if (model.diagnostics.some(d => d.code === SEAT_FAR_END_CLAMPED && d.message === message)) return;
  model.diagnostics.push({ stage: 'placement', severity: 'info', code: SEAT_FAR_END_CLAMPED, owners: [{ kind: 'group', id: group }], message });
}

/** Why the boundary of `p` no longer stands as stored (a far port moved off its offset from the first), or undefined. */
function boundaryFault(model: LayoutModel, p: SeatSetPayload): string | undefined {
  const origin = boundaryOrigin(model, p);
  if (origin === undefined) return `${portKey(p.boundary[0]!.port)} has no anchor`;
  for (const { port, x } of p.boundary) {
    const at = findPort(model, port)?.anchor?.x;
    if (at === undefined || Math.abs(at - origin - x) > PLACEMENT_EPS) return `the parent port ${portKey(port)} moved off its offset ${x.toFixed(1)} from ${portKey(p.boundary[0]!.port)}`;
  }
  return undefined;
}

/**
 * Why the translated row breaks what a step of 7c may not change, or undefined: a band check the row did not fail before (a cell over a
 * sibling cell), or a lane fault `validateLanes` did not read before (a lane the box now meets, or a lane on the wrong side of its group). The row's own repack (`seatRows`) makes its
 * siblings give way instead; from 7c on the lanes own their windows and the step only translates.
 */
function translationFault(model: LayoutModel, group: LayoutGroup, before: TranslationReading): string | undefined {
  const added = validateSkeletonBands(model, true, group.tier).find(error => !before.bands.has(error));
  if (added !== undefined) return `the translated row breaks the band: ${added}`;
  const lane = laneFault(model);
  if (lane !== undefined && lane !== before.lane) return `the translated row breaks a lane: ${lane}`;
  return undefined;
}

/** What the translation check compares against: the band errors of the tier and the lane fault (`validateLanes`) before the row moved. */
interface TranslationReading { bands: ReadonlySet<string>; lane: string | undefined }
/** The first fault `validateLanes` reads on `model`, or undefined: the lanes own their windows after 7a, and the validator is their one reader. */
function laneFault(model: LayoutModel): string | undefined {
  try { validateLanes(model); return undefined; } catch (error) { return (error as Error).message; }
}

/** The wall a step of 7c reads for a translated row: why its box leaves the window centring gives the cell (its frame column), or undefined. */
export type SeatWall = (group: LayoutGroup) => string | undefined;

/**
 * Applies the seat set of `group` (no choice again): each member stands at its stored x relative to the boundary where the boundary stands now,
 * and the box covers the interval. Undefined when it stands; else why it cannot, and nothing is moved. With `wall` (7c), the row only
 * translates: the anchor tier does not move, and a translation that the wall or `translationFault` refuses is given back.
 */
export function applySeatSet(model: LayoutModel, group: LayoutGroup, p: SeatSetPayload, wall?: SeatWall): string | undefined {
  const guard = wall !== undefined;
  const fault = boundaryFault(model, p);
  if (fault !== undefined) return fault;
  if (!sameOrder(group.rowOrder ?? group.nodes, p.order)) return 'the row no longer stands in its order';
  const origin = boundaryOrigin(model, p)!, xs = p.xs.map(x => origin + x);
  const moves = p.order.some((id, i) => Math.abs(model.nodes[id]!.bounds!.x - xs[i]!) > PLACEMENT_EPS);
  if (guard && moves && group.tier === model.anchorTier) return 'its row is the anchor tier, which the centring step does not move';
  const before: TranslationReading | undefined = guard && moves ? { bands: new Set(validateSkeletonBands(model, true, group.tier)), lane: laneFault(model) } : undefined, was = { ...group.bounds! };
  const nodesWere = JSON.stringify(p.order.map(id => model.nodes[id]));
  const undo = moveMembers(model, p.order, xs);
  rebuildNodeGeometry(model, p.order, 'current');
  const box = contentBox(model, group);
  group.bounds = { ...group.bounds!, x: box.x, width: box.width };
  coverInterval(model, group, p);
  // The bands are derived from the boxes: read the band check on bands rebuilt for the translated row, and rebuild them again on a refusal.
  if (before !== undefined) rebuildBands(model);
  const refused = before === undefined ? undefined : wall!(group) ?? translationFault(model, group, before);
  if (refused !== undefined) { undo(); rebuildNodeGeometry(model, p.order, 'current'); group.bounds = was; rebuildBands(model); }
  // A move, a changed cell box, a band rebuild (also of a refused translation: the bands are read again from the boxes), or a node the geometry
  // rebuild changed (its pills) leaves the regions to rebuild.
  if (before !== undefined || moves || Object.entries(was).some(([key, value]) => Math.abs((group.bounds as unknown as Record<string, number>)[key]! - (value as number)) > PLACEMENT_EPS)
    || JSON.stringify(p.order.map(id => model.nodes[id])) !== nodesWere) seatMoves.add(model);
  return refused;
}

/** The models on which a seat-set application moved a member or a cell box since the last read of `takeSeatSetMoves`. */
const seatMoves = new WeakSet<LayoutModel>();
/**
 * Whether a seat set was applied with a move on `model` since the last call (and forget it): 7c rebuilds its regions after the seat applications of
 * a pass only when one moved something (review 1 of slice 1: an unconditional rebuild doubled the centring passes of a large sheet).
 */
export function takeSeatSetMoves(model: LayoutModel): boolean {
  const moved = seatMoves.has(model);
  seatMoves.delete(model);
  return moved;
}
const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * Withdraws the seat set of `group` whole, by name (ruling 1 of slice 1): the entry leaves the ledger, the row is seated by the legacy path,
 * and the diagnostic names the failed equation. What stays: the interval the cell box covered. After 7a the lanes own their windows, so the
 * frame column keeps that room; the diagnostic says so and the corpus count reads it.
 */
export function withdrawSeatSet(model: LayoutModel, group: string, why: string): void {
  if (model.reservations === undefined || seatSetOf(model, group) === undefined) return;
  // A rule edits a draft that still carries the stage before it: the rule that withdraws is the next stage.
  const rule = LAYOUT_STAGES[LAYOUT_STAGES.indexOf(model.stage) + 1] ?? model.stage;
  attemptCounters.seatWithdrawals++;
  if (why.includes(SEAT_WALL_COLUMN)) attemptCounters.seatWallWithdrawals++;
  // A set withdrawn from 7c on keeps the far ends of its own equations where 7c left them (`seatFarEndRange`), each with the link that proves it
  // (`seatSetDeclinedFault`). Lifetime: the rest of this placement run, its publication replays included. The placement that the command runs
  // without the set writes the decline again at its input (`at: 'input'`, stage 6) with no far ends, so its 7c moves those rows again.
  const p = seatSetOf(model, group)!, keeps = stageReached(rule, 'centre');
  const fixed = [...p.seats, ...p.holds].map(eq => ({ link: eq.link, node: eq.far.node })).sort((a, b) => a.link.localeCompare(b.link) || a.node.localeCompare(b.node));
  // The withdrawal is a decline in the ledger (ruling B): the command reads it and places once more without the set (`retryWithdrawnSeatSets`).
  model.reservations = [...model.reservations.filter(entry => !(entry.kind === 'seatSet' && entry.owner.kind === 'group' && entry.owner.id === group)),
    reservation('seatSetDeclined', { kind: 'group', id: group }, '', 'rows', 0, { row: group, at: rule, why, ...(keeps ? { fixed } : {}) })];
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code: SEAT_SET_WITHDRAWN, owners: [{ kind: 'group', id: group }],
    message: rule === 'rows'
      ? `The seat set of ${group} is withdrawn at rows: ${why}. The row stands as the repack leaves it and is seated by the centring step.`
      : `The seat set of ${group} is withdrawn at ${rule}: ${why}. The command places once more without it; until then the room its interval reserved in the frame column stays, because the lanes own their windows.` });
}

/**
 * The rows whose seat set `model` withdrew in this run (the `seatSetDeclined` entries a rule wrote, not the ones the rows rule wrote from the
 * command's input), each with where and why: what `retryWithdrawnSeatSets` declines for the next placement.
 */
export function withdrawnSeatRows(model: LayoutModel): Map<string, string> {
  return new Map(ofKind(model.reservations ?? [], 'seatSetDeclined').filter(entry => entry.payload.at !== 'input')
    .map(entry => [entry.payload.row, `withdrawn at ${entry.payload.at}: ${entry.payload.why}`] as const));
}

/**
 * Applies every seat set of `model` where its boundary stands now (`applySeatSet`), and withdraws by name each one that cannot stand. 7c
 * calls it after the rules that move groups it does not step (the settled rows, the overlay windows), so that a row stands on its seats
 * at the end of every run of the passes. True when a member moved.
 */
export function applySeatSets(model: LayoutModel, wall: SeatWall): boolean {
  let moved = false;
  for (const entry of [...(model.reservations ?? [])]) {
    if (entry.kind !== 'seatSet' || entry.owner.kind !== 'group') continue;
    const group = model.groups[entry.owner.id];
    if (group === undefined) { withdrawSeatSet(model, entry.owner.id, 'its row has no group'); continue; }
    const before = entry.payload.order.map(id => model.nodes[id]?.bounds?.x);
    const why = applySeatSet(model, group, entry.payload, wall);
    if (why !== undefined) { withdrawSeatSet(model, group.id, why); continue; }
    if (entry.payload.order.some((id, i) => Math.abs(model.nodes[id]!.bounds!.x - (before[i] ?? NaN)) > PLACEMENT_EPS)) moved = true;
  }
  return moved;
}

/**
 * At the end of each rule from 7c to 7f (`mutation.ts`, beside the fallen seats of ADR-0027): a seat set its rule's moves broke is withdrawn
 * whole, by name, with the fault that broke it. The members stay where the rule left them; the record names only sets that stand (R5).
 */
export function withdrawBrokenSeatSets(model: LayoutModel): void {
  for (const entry of [...(model.reservations ?? [])]) {
    if (entry.kind !== 'seatSet' || entry.owner.kind !== 'group') continue;
    const fault = seatSetFault(entry, model);
    if (fault !== undefined) withdrawSeatSet(model, entry.owner.id, fault);
  }
}
