import type { LayoutGroup, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { portKey } from './sides-one.js';
import { reservation, type ReservationOf, type SeatEquation, type SeatSetPayload } from './reservations.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { orderedNodeIds } from '../model/model.js';
import { rowGap } from './sides-two.js';
import { groupShape } from './grid.js';
import { chainBlockOf } from './read/chain.js';
import { isCantonFrame } from './read/canton.js';
import { contentBox } from './regions.js';
import { rebuildBands } from './skeleton-geometry.js';
import { blockDemands, type BlockDemand } from './solid-blocks.js';
import { BLOCK_CAP } from './block-checks.js';
import { PLACEMENT_EPS, SEAT_STANDS_EPS } from './tolerance.js';
import { EPS } from '../geometry/planar.js';

/**
 * The seat set of a child row (dense-16x9 ticket 36, slice 1; design `36-seats-design.md`, mechanisms III and IV). With
 * `layout.moveBeforeGrow`, stage 5 chooses where each member of a rank cell stands under its parents' bottom ports, all members
 * together, with the row order, the face port orders, the body widths and the parents fixed. The choice is one `seatSet` ledger
 * entry: the kept verticals as equations, the verticals and block faces the members already hold, the boundary nodes the equations
 * read, the member positions and the interval the cell reserves, all relative to one boundary node. The cell box covers the
 * interval; 7c applies the stored positions and does not choose again.
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

export type { SeatEquation, SeatSetPayload };

/** Why a seat set is declined or cut, as `SEAT_SET_DECLINED` names it. */
export type SeatSetClause = 'scope' | 'no-gain' | 'owner' | 'bound';
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
  let frame: string | undefined = group.frame;
  while (frame !== undefined) { if (isCantonFrame(model, frame)) return 'in a canton'; frame = model.document.frames?.[frame]?.parent; }
  if (group.nodes.some(node => chainBlockOf(model, node) !== undefined)) return 'a member of a feeding chain';
  return undefined;
}

function ends(model: LayoutModel, link: LayoutLink): [LayoutPort, LayoutPort] | undefined {
  if (!link.attachments || link.layer !== 'routed') return undefined;
  const a = findPort(model, link.attachments.from), b = findPort(model, link.attachments.to);
  return a?.anchor && b?.anchor ? [a, b] : undefined;
}

/** The row as the solver reads it: members, widths, gaps, the feeds from a higher tier of the frame, the verticals a member holds. */
function readRow(model: LayoutModel, group: LayoutGroup): RowInput | string {
  const order = [...(group.rowOrder ?? group.nodes)], index = new Map(order.map((id, i) => [id, i]));
  const bodies = order.map(id => model.nodes[id]!.bounds!);
  const gaps = order.slice(1).map((id, i) => rowGap(model, order[i]!, id));
  const feeds: Feed[] = [], holds: RowInput['holds'] = [];
  for (const link of model.links) {
    const pair = ends(model, link);
    // A solid block member is the block's chord, never a seat or a held vertical: the block reservation owns it (`blockFaces`, the owner check).
    if (pair === undefined || link.solidBlock) continue;
    for (const [port, far] of [pair, [pair[1], pair[0]] as const]) {
      const member = index.get(port.ref.node);
      if (member === undefined || index.has(far.ref.node)) continue;
      const farGroup = model.groups[model.document.nodes[far.ref.node]!.group]!;
      const feed = port.side === 'top' && far.side === 'bottom' && !link.bundle && farGroup.frame === group.frame && farGroup.tier! < group.tier!;
      if (feed) feeds.push({ link, member, port, far, x: far.anchor!.x - (port.anchor!.x - bodies[member]!.x) });
      else if ((port.side === 'top' || port.side === 'bottom') && Math.abs(far.anchor!.x - port.anchor!.x) <= SEAT_STANDS_EPS) holds.push({ link, member, port, far });
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

interface Leaf { xs: number[]; kept: Feed[]; width: number; movement: number; key: string; index: string }

/**
 * Every assignment of the fed members (a seat position, or free) that the row order and gaps admit, with one seat per parent port.
 * Undefined when the count bound cuts the search (R4).
 */
function assignments(input: RowInput): Leaf[] | undefined {
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
      leaves.push({ xs, kept, width: high - low, movement: xs.reduce((sum, x, i) => sum + Math.abs(x - input.x0[i]!), 0), key: keys.join('|'),
        index: kept.map(feed => feed.link.sourceIndex).sort((a, b) => a - b).join(',') });
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

/** Rank (owner ruling 'tight room'): the most kept verticals, then the least interval width, the least movement, the kept links by content, then sourceIndex (R3). */
const rank = (a: Leaf, b: Leaf): number => b.kept.length - a.kept.length || (Math.abs(a.width - b.width) > PLACEMENT_EPS ? a.width - b.width : 0)
  || (Math.abs(a.movement - b.movement) > PLACEMENT_EPS ? a.movement - b.movement : 0) || a.key.localeCompare(b.key) || a.index.localeCompare(b.index);

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

/** Why the members at `xs` break a block owner, or undefined: an under-cap block passes the cap, or a flat block's floor demand grows past its gap. */
function blockOwnerFault(model: LayoutModel, input: RowInput, xs: readonly number[], before: readonly BlockDemand[]): string | undefined {
  if (!before.length) return undefined;
  const undo = moveMembers(model, input.order, xs), box = input.group.bounds!;
  input.group.bounds = contentBox(model, input.group);
  let after: BlockDemand[];
  try { after = blockDemands(model).demands; } finally { input.group.bounds = box; undo(); }
  for (const was of before) {
    const now = after.find(item => item.family === was.family)!;
    if (was.steep <= BLOCK_CAP + EPS && now.steep > BLOCK_CAP + EPS) return `the block ${was.family} would pass its ${BLOCK_CAP} px cap (${now.steep.toFixed(1)} px)`;
    const gap = Math.max(was.floor, model.flatBlockGaps?.find(item => item.family === was.family)?.gap ?? -Infinity);
    if (was.steep > BLOCK_CAP + EPS && now.floor > gap + EPS) return `the flat block ${was.family} would need ${now.floor.toFixed(1)} px, past its gap ${gap.toFixed(1)} px`;
  }
  return undefined;
}

/** Why the interval `[low, high]` meets a flank or a bar beside the row, or undefined: those groups do not move for a row (stage 6). */
function fixedNeighbourFault(model: LayoutModel, group: LayoutGroup, low: number, high: number): string | undefined {
  const box = group.bounds!;
  for (const other of Object.values(model.groups)) {
    if (other.id === group.id || !other.bounds || (other.flank === undefined && groupShape(model, other.id) !== 'bar')) continue;
    const o = other.bounds;
    if (o.y < box.y + box.height && box.y < o.y + o.height && o.x < high && low < right(o)) return `the row would meet ${other.flank ? 'the flank' : 'the bar'} ${other.id}`;
  }
  return undefined;
}

/**
 * The seat set of the cell `group` on the stage-5 `model` (no write): the best assignment that breaks no owner, as a record payload,
 * or why there is none. The model is moved only to read an owner, and is given back exactly.
 */
export function planSeatSet(model: LayoutModel, group: LayoutGroup): SeatSetOutcome {
  const scope = seatSetScope(model, group);
  if (scope !== undefined) return { kind: 'declined', clause: 'scope', why: scope };
  const input = readRow(model, group);
  if (typeof input === 'string') return { kind: 'declined', clause: 'bound', why: input };
  if (!input.feeds.length) return { kind: 'declined', clause: 'scope', why: NO_FEED };
  const leaves = assignments(input);
  if (leaves === undefined) return { kind: 'declined', clause: 'bound', why: `the search passed ${SEAT_SET_VISITS} visits` };
  const now = keptFeeds(input, input.x0).length;
  leaves.sort(rank);
  const blocks = input.order.some(id => model.links.some(link => link.solidBlock && (link.attachments?.from.node === id || link.attachments?.to.node === id)))
    ? blockDemands(model).demands : [];
  let first: string | undefined;
  for (const leaf of leaves) {
    if (leaf.kept.length <= now) break;
    const box = input.group.bounds!, undo = moveMembers(model, input.order, leaf.xs);
    const fit = contentBox(model, input.group);
    undo(); input.group.bounds = box;
    const fault = blockOwnerFault(model, input, leaf.xs, blocks) ?? fixedNeighbourFault(model, group, fit.x, right(fit));
    if (fault !== undefined) { first ??= fault; continue; }
    return { kind: 'set', payload: payloadOf(model, input, leaf, fit) };
  }
  return first !== undefined ? { kind: 'declined', clause: 'owner', why: first } : { kind: 'declined', clause: 'no-gain', why: `no seat set keeps more than the ${now} verticals the row stands` };
}

function payloadOf(model: LayoutModel, input: RowInput, leaf: Leaf, fit: Rect): SeatSetPayload {
  const equation = (link: LayoutLink, port: LayoutPort, far: LayoutPort, memberX: number): SeatEquation => ({ link: link.id, member: { ...port.ref }, far: { ...far.ref },
    memberOffset: port.anchor!.x - memberX, farOffset: far.anchor!.x - model.nodes[far.ref.node]!.bounds!.x });
  const seats = leaf.kept.map(feed => equation(feed.link, feed.port, feed.far, input.x0[feed.member]!));
  const holds = input.holds.map(item => equation(item.link, item.port, item.far, input.x0[item.member]!));
  const farNodes = [...new Set([...seats, ...holds].map(item => item.far.node))].sort();
  const origin = model.nodes[farNodes[0]!]!.bounds!.x;
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
    boundary: farNodes.map(node => ({ node, x: model.nodes[node]!.bounds!.x - origin })),
    xs: leaf.xs.map(x => x - origin), interval: { low: fit.x - origin, high: right(fit) - origin }, declined,
  };
}

/** The diagnostic of a row the seat set declines (`planSeatSet`): the row, the clause, why. Not for a row that no parent feeds. */
export const SEAT_SET_DECLINED = 'SEAT_SET_DECLINED';

/**
 * Stage 5 (`sidesTwo`, before the freeze), with `layout.moveBeforeGrow`: the seat set of every rank cell, top tier first, then by id (R3).
 * A set moves its members to their seats, makes the cell box cover its interval and writes its `seatSet` entry; the entries of an earlier run
 * are replaced, so a placement re-run decides again on its own geometry. A declined row keeps its place and gets `SEAT_SET_DECLINED`.
 */
export function reserveSeatSets(model: LayoutModel): void {
  if (model.document.layout?.moveBeforeGrow !== true) return;
  const kept = (model.reservations ?? []).filter(entry => entry.kind !== 'seatSet'), entries: ReturnType<typeof reservation<'seatSet'>>[] = [];
  const cells = Object.values(model.groups).filter(group => group.frame !== undefined && group.nodes.length > 0 && group.bounds !== undefined)
    .sort((a, b) => a.tier! - b.tier! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const group of cells) {
    const plan = planSeatSet(model, group);
    if (plan.kind === 'declined') {
      if (plan.why !== NO_FEED) model.diagnostics.push({ stage: 'placement', severity: 'info', code: SEAT_SET_DECLINED,
        message: `The seat set of ${group.id} is declined (${plan.clause}): ${plan.why}.`, owners: [{ kind: 'group', id: group.id }] });
      continue;
    }
    const p = plan.payload, origin = model.nodes[p.boundary[0]!.node]!.bounds!.x;
    moveMembers(model, p.order, p.xs.map(x => origin + x));
    coverInterval(model, group, p);
    entries.push(reservation('seatSet', { kind: 'group', id: group.id }, '', 'sides-two', 0, p));
  }
  // The labels, icons and pills of the moved members, rebuilt in document order as the stage validation rebuilds them.
  if (entries.length) { rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current'); rebuildBands(model); }
  if (model.reservations !== undefined || entries.length) model.reservations = [...kept, ...entries];
}

/** The seat set of `group` on `model`, or undefined: the one reader of the entry for every stage that fits, moves or reads the cell. */
export function seatSetOf(model: LayoutModel, group: string): SeatSetPayload | undefined {
  return (model.reservations ?? []).find((entry): entry is ReservationOf<'seatSet'> => entry.kind === 'seatSet' && entry.owner.kind === 'group' && entry.owner.id === group)?.payload;
}

/** The interval of a seat set where its boundary stands now: [low, high] in model x. */
export function seatInterval(model: LayoutModel, p: SeatSetPayload): { low: number; high: number } {
  const origin = model.nodes[p.boundary[0]!.node]!.bounds!.x;
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

/** The nodes every seat set reads as fixed (dense-16x9 ticket 36, slice 1): its members and the far ends of its equations. No parent spread moves them. */
export function seatSetNodes(model: LayoutModel): Set<string> {
  const nodes = new Set<string>();
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSet') {
    for (const id of entry.payload.order) nodes.add(id);
    for (const eq of [...entry.payload.seats, ...entry.payload.holds]) nodes.add(eq.far.node);
  }
  return nodes;
}

/** Why the boundary of `p` no longer stands as stored (a far end moved off its offset, or one far port moved on its face), or undefined. */
function boundaryFault(model: LayoutModel, p: SeatSetPayload): string | undefined {
  const origin = model.nodes[p.boundary[0]!.node]?.bounds?.x;
  if (origin === undefined) return `${p.boundary[0]!.node} has no box`;
  for (const { node, x } of p.boundary) {
    const box = model.nodes[node]?.bounds;
    if (box === undefined || Math.abs(box.x - origin - x) > PLACEMENT_EPS) return `the parent ${node} moved off its offset ${x.toFixed(1)} from ${p.boundary[0]!.node}`;
  }
  for (const eq of [...p.seats, ...p.holds]) {
    const far = findPort(model, eq.far), box = model.nodes[eq.far.node]?.bounds;
    if (far?.anchor === undefined || box === undefined || Math.abs(far.anchor.x - box.x - eq.farOffset) > PLACEMENT_EPS) return `the far port of ${eq.link} moved on its face`;
  }
  return undefined;
}

/**
 * 7c applies the seat set of `group` (the step does not choose again): each member stands at its stored x relative to the boundary where the
 * boundary stands now, and the box covers the interval. Undefined when it stands; else why it cannot, and nothing is moved.
 */
export function applySeatSet(model: LayoutModel, group: LayoutGroup, p: SeatSetPayload): string | undefined {
  const fault = boundaryFault(model, p);
  if (fault !== undefined) return fault;
  if (!sameOrder(group.rowOrder ?? group.nodes, p.order)) return 'the row no longer stands in its order';
  const origin = model.nodes[p.boundary[0]!.node]!.bounds!.x;
  moveMembers(model, p.order, p.xs.map(x => origin + x));
  rebuildNodeGeometry(model, p.order, 'current');
  const box = contentBox(model, group);
  group.bounds = { ...group.bounds!, x: box.x, width: box.width };
  coverInterval(model, group, p);
  return undefined;
}
const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * Withdraws the seat set of `group` whole, by name (ruling 1 of slice 1): the entry leaves the ledger, the row is seated by the legacy path,
 * and the diagnostic names the failed equation. What stays: the interval the cell box covered. After 7a the lanes own their windows, so the
 * frame column keeps that room; the diagnostic says so and the corpus count reads it.
 */
export function withdrawSeatSet(model: LayoutModel, group: string, why: string): void {
  if (model.reservations === undefined || seatSetOf(model, group) === undefined) return;
  model.reservations = model.reservations.filter(entry => !(entry.kind === 'seatSet' && entry.owner.kind === 'group' && entry.owner.id === group));
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code: SEAT_SET_WITHDRAWN, owners: [{ kind: 'group', id: group }],
    message: `The seat set of ${group} is withdrawn at ${model.stage}: ${why}. The row is seated by the centring step; the room its interval reserved in the frame column stays, because the lanes own their windows.` });
}
