/**
 * Sibling rows (dense-16x9 ticket 06, slice C; owner ruling 2026-11-15, "mirror one pair").
 *
 * A **sibling-frame link** joins members of two frames of one document tier, in `row` cells of one sub-tier (`siblingFrameLink`, the one predicate of the rule).
 *
 * - **Stage 4** (`seatSiblingFrameEnds`, after the frame order settles): a member with such a link stands at the end of its row that faces the other cell. The
 *   links between one pair of cells are its *pair set*; when a set holds two or more pairs, one cell turns its linked block so that the pairs nest: the inner
 *   pair stands on the two facing row ends (a level chord, slice B) and every other pair stands next to it in mirrored order (a U, slice A). The decision is
 *   `LayoutModel.siblingRows`, one record per pair of cells; the freeze keeps a copy and every later publication checks the row orders against it.
 * - **Stage 5** (`planSiblingUTurns`, once the sides are voted): each outer link of a record takes a `u-turn` course on the face of the sub-tier its U rows cross
 *   fewer links on, so the tier-gap plan of 7a reserves its row and the router discovers nothing.
 *
 * What the rule declines, by name and at severity `info` (stage 8 then routes the link as before): a pair set that is not one-to-one, or a member linked to
 * two cells on one side (`SIBLING_PAIR_NON_MATCHING`); a member of a row of two or more linked toward both sides (`SIBLING_FRAME_END_CONFLICT`: the end with more
 * links keeps it, a tie the left end); a row that cannot stand in its seat (`SIBLING_SEAT_REFUSED`); an outer link whose U is not allowed (`SIBLING_UTURN_DECLINED`).
 */
import type { Course, LayoutGroup, LayoutLink, LayoutModel, LayoutPort, SiblingRow } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { siblingFrameLink } from './frame-paths.js';
import { orderTools, reseatRow, saveGroups } from './overlay-order.js';
import { compareId } from './skeleton-graph.js';
import { courseEntries, rowOrderOf } from './reservations.js';
import { linksAt, uTurnFacesGap } from './courses.js';
import { findPort } from './row-paths.js';
import { authoredSide } from './grid.js';

export const SIBLING_PAIR_NON_MATCHING = 'SIBLING_PAIR_NON_MATCHING';
export const SIBLING_FRAME_END_CONFLICT = 'SIBLING_FRAME_END_CONFLICT';
export const SIBLING_SEAT_REFUSED = 'SIBLING_SEAT_REFUSED';
export const SIBLING_UTURN_DECLINED = 'SIBLING_UTURN_DECLINED';

/** One oriented pair: the link, its end in the left cell and its end in the right cell. */
interface Pair { link: string; left: string; right: string; leftCell: string; rightCell: string }

const cellOf = (model: LayoutModel, node: string): string => model.document.nodes[node]!.group;
const centreX = (group: LayoutGroup): number => group.bounds!.x + group.bounds!.width / 2;
const right = (group: LayoutGroup): number => group.bounds!.x + group.bounds!.width;

function note(model: LayoutModel, code: string, message: string, links: readonly string[]): void {
  model.diagnostics.push({ stage: 'placement', severity: 'info', code, message, owners: [...links].sort(compareId).map(id => ({ kind: 'link' as const, id })) });
}

/** The cells that a flank stands beside: `placeFlanksAndPeers` seats the primary peer at the outer end, so the rule leaves them alone. */
const flankedCells = (model: LayoutModel): Set<string> => new Set(Object.values(model.groups).flatMap(group => group.flank ? [group.flank.of] : []));

/**
 * The sibling-frame links that the seat may move: both cells stand placed, no flank stands beside either, and neither is a free row (a group in no frame, whose
 * order the corridor order of stage 4 decides and records, ticket 17: the seat orders rank cells, as the feed order does).
 */
function seatableLinks(model: LayoutModel): LayoutLink[] {
  const flanked = flankedCells(model), { freeRow } = orderTools(model);
  return model.links.filter(link => siblingFrameLink(model, link)
    && [link.attachments!.from.node, link.attachments!.to.node].every(node => {
      const group = model.groups[cellOf(model, node)];
      return group?.bounds !== undefined && !flanked.has(group.id) && !freeRow(group);
    }))
    .sort((a, b) => compareId(a.id, b.id));
}

/** The pair of a link, its ends read left to right by the centres of their cells (last key: the cell id, R3). */
function orient(model: LayoutModel, link: LayoutLink): Pair {
  const { from, to } = link.attachments!;
  const a = cellOf(model, from.node), b = cellOf(model, to.node);
  const ga = model.groups[a]!, gb = model.groups[b]!;
  const leftFirst = centreX(ga) < centreX(gb) || (centreX(ga) === centreX(gb) && compareId(a, b) < 0);
  return leftFirst ? { link: link.id, left: from.node, right: to.node, leftCell: a, rightCell: b } : { link: link.id, left: to.node, right: from.node, leftCell: b, rightCell: a };
}

/**
 * Whether a unit stands between two cells on their sub-tier: a group of the sub-tier, or a frame that is neither cell's own nor an ancestor of one, whose box
 * meets the strip between the facing row ends. A level chord there would cross it, so every pair of the set is a U.
 */
function unitBetween(model: LayoutModel, left: LayoutGroup, rightCell: LayoutGroup): boolean {
  const low = right(left), high = rightCell.bounds!.x;
  const top = Math.min(left.bounds!.y, rightCell.bounds!.y), bottom = Math.max(left.bounds!.y + left.bounds!.height, rightCell.bounds!.y + rightCell.bounds!.height);
  const meets = (box: { x: number; y: number; width: number; height: number }): boolean => box.x < high && box.x + box.width > low && box.y < bottom && box.y + box.height > top;
  const own = new Set<string>();
  for (const cell of [left, rightCell]) {
    let frame: string | undefined = cell.frame;
    while (frame !== undefined && !own.has(frame)) { own.add(frame); frame = model.document.frames?.[frame]?.parent; }
  }
  if (Object.values(model.groups).some(group => group !== left && group !== rightCell && group.tier === left.tier && group.bounds !== undefined && meets(group.bounds))) return true;
  return (model.frames ?? []).some(frame => !own.has(frame.id) && meets(frame.box));
}

/**
 * Stage 4: seats the ends of the sibling-frame links at the facing ends of their rows and writes `siblingRows` (module comment). Runs once the frame order
 * has settled, so left and right are final. Returns whether a cell moved; the caller then reads the feed orders again (`refreshFeedOrders` keeps each seat
 * through `siblingSeatOrder`). No search: one pass per pair set, a finite traversal (R4 needs no cap).
 */
export function seatSiblingFrameEnds(model: LayoutModel): boolean {
  delete model.siblingRows;
  const links = seatableLinks(model);
  if (!links.length) return false;
  let pairs = links.map(link => orient(model, link));
  const size = (cell: string): number => model.groups[cell]!.nodes.length;
  // A member of a row of two or more that links toward both sides stands at one end only: the side with more pairs, a tie the left end (its left pairs stay).
  const sideCount = (node: string, side: 'left' | 'right'): number => pairs.filter(pair => side === 'right' ? pair.left === node : pair.right === node).length;
  const relays = [...new Set(pairs.flatMap(pair => [pair.left, pair.right]))].filter(node => size(cellOf(model, node)) > 1 && sideCount(node, 'left') > 0 && sideCount(node, 'right') > 0).sort(compareId);
  for (const node of relays) {
    const keep: 'left' | 'right' = sideCount(node, 'right') > sideCount(node, 'left') ? 'right' : 'left';
    const dropped = pairs.filter(pair => keep === 'left' ? pair.left === node : pair.right === node);
    note(model, SIBLING_FRAME_END_CONFLICT, `${node} links to sibling frames on both sides of its row; it stands at the ${keep} end, and ${dropped.map(pair => pair.link).join(', ')} keep the route stage 8 gives.`, dropped.map(pair => pair.link));
    pairs = pairs.filter(pair => !dropped.includes(pair));
  }
  // A member linked to two cells on one side keeps the pairs of the nearer cell (last key: the cell id).
  const distance = (pair: Pair): number => centreX(model.groups[pair.rightCell]!) - centreX(model.groups[pair.leftCell]!);
  for (const node of [...new Set(pairs.flatMap(pair => [pair.left, pair.right]))].sort(compareId)) {
    for (const side of ['left', 'right'] as const) {
      const own = pairs.filter(pair => side === 'right' ? pair.left === node : pair.right === node);
      const cells = [...new Set(own.map(pair => side === 'right' ? pair.rightCell : pair.leftCell))];
      if (cells.length < 2) continue;
      const nearest = [...own].sort((a, b) => distance(a) - distance(b) || compareId(side === 'right' ? a.rightCell : a.leftCell, side === 'right' ? b.rightCell : b.leftCell))[0]!;
      const keepCell = side === 'right' ? nearest.rightCell : nearest.leftCell;
      const dropped = own.filter(pair => (side === 'right' ? pair.rightCell : pair.leftCell) !== keepCell);
      note(model, SIBLING_PAIR_NON_MATCHING, `${node} links to two sibling frames on its ${side}; it faces ${keepCell}, and ${dropped.map(pair => pair.link).join(', ')} keep the route stage 8 gives.`, dropped.map(pair => pair.link));
      pairs = pairs.filter(pair => !dropped.includes(pair));
    }
  }
  // The pair sets: one per pair of cells. A set whose pairs are not one-to-one (a fan, or two links between one pair of nodes) is declined whole.
  const sets = new Map<string, Pair[]>();
  for (const pair of pairs) { const id = `${pair.leftCell}\0${pair.rightCell}`; sets.set(id, [...(sets.get(id) ?? []), pair]); }
  const records: { row: SiblingRow; pairs: Pair[] }[] = [];
  const blocks = new Map<string, { left: Map<string, string[]>; right: Map<string, string[]> }>();
  const blockOf = (cell: string) => { let block = blocks.get(cell); if (block === undefined) { block = { left: new Map(), right: new Map() }; blocks.set(cell, block); } return block; };
  const decided = (cell: string): boolean => rowOrderOf(model.reservations, 'cell', cell) !== undefined;
  for (const id of [...sets.keys()].sort(compareId)) {
    const set = sets.get(id)!, L = model.groups[set[0]!.leftCell]!, R = model.groups[set[0]!.rightCell]!;
    if (new Set(set.map(pair => pair.left)).size !== set.length || new Set(set.map(pair => pair.right)).size !== set.length) {
      note(model, SIBLING_PAIR_NON_MATCHING, `The links between ${L.id} and ${R.id} are not one pair per member; their ends keep their seats and the route stage 8 gives.`, set.map(pair => pair.link));
      continue;
    }
    const leftOrder = L.rowOrder ?? L.nodes, rightOrder = R.rowOrder ?? R.nodes;
    const byLeft = new Map(set.map(pair => [pair.left, pair])), byRight = new Map(set.map(pair => [pair.right, pair]));
    let ls = leftOrder.filter(node => byLeft.has(node)), rs = rightOrder.filter(node => byRight.has(node));
    const nested = rs.every((node, i) => byLeft.get(ls[ls.length - 1 - i]!)!.right === node);
    let mirrored: SiblingRow['mirrored'] = 'none';
    if (!nested) {
      // The cell whose order its feeds decided keeps it and the other turns; when both or neither did, the left cell keeps its order (R3: x order, never declaration order).
      if (decided(R.id) && !decided(L.id)) { ls = [...rs].reverse().map(node => byRight.get(node)!.left); mirrored = 'left'; } else { rs = [...ls].reverse().map(node => byLeft.get(node)!.right); mirrored = 'right'; }
    }
    blockOf(L.id).right.set(R.id, ls);
    blockOf(R.id).left.set(L.id, rs);
    const inner = byLeft.get(ls[ls.length - 1]!)!, level = !unitBetween(model, L, R);
    const outer = ls.slice(0, level ? -1 : undefined).map(node => byLeft.get(node)!.link);
    records.push({ row: { subTier: L.tier!, leftCell: L.id, rightCell: R.id, mirrored, ...(level ? { levelLink: inner.link } : {}), outerLinks: outer }, pairs: set });
  }
  if (!records.length) { model.siblingRows = []; return false; }
  // The new order of each cell: the blocks that face left (the nearest cell's first), the members that link to no sibling frame in the order they stand, then the
  // blocks that face right (the nearest cell's last).
  const orders = new Map<string, string[]>();
  for (const cell of [...blocks.keys()].sort(compareId)) {
    const group = model.groups[cell]!, block = blocks.get(cell)!;
    const near = (a: string, b: string): number => Math.abs(centreX(model.groups[a]!) - centreX(group)) - Math.abs(centreX(model.groups[b]!) - centreX(group)) || compareId(a, b);
    const leftBlock = [...block.left.keys()].sort(near).flatMap(other => block.left.get(other)!);
    const rightBlock = [...block.right.keys()].sort(near).reverse().flatMap(other => block.right.get(other)!);
    const seated = new Set([...leftBlock, ...rightBlock]);
    orders.set(cell, [...leftBlock, ...(group.rowOrder ?? group.nodes).filter(node => !seated.has(node)), ...rightBlock]);
  }
  // Every cell takes its seat, or none does: a row that cannot stand in its room (it would grow into the next group) declines the whole decision by name.
  const cells = [...orders.keys()].map(cell => model.groups[cell]!);
  const undo = saveGroups(model, cells);
  let moved = false;
  for (const group of cells) {
    const next = orders.get(group.id)!, now = group.rowOrder ?? group.nodes;
    if (next.every((node, i) => node === now[i])) continue;
    if (!reseatRow(model, group, next, true)) {
      undo();
      note(model, SIBLING_SEAT_REFUSED, `Cell ${group.id} cannot stand in the order its sibling-frame links give (${next.join(', ')}): it does not fit its room. No row is seated for its sibling frames.`, records.flatMap(item => item.pairs.map(pair => pair.link)));
      model.siblingRows = [];
      return false;
    }
    moved = true;
  }
  model.siblingRows = records.map(item => item.row).sort((a, b) => a.subTier - b.subTier || compareId(a.leftCell, b.leftCell) || compareId(a.rightCell, b.rightCell));
  return moved;
}

/** The members of `cell` that a record seats at its left end and at its right end. */
function seatedMembers(model: LayoutModel, cell: string): { left: Set<string>; right: Set<string> } {
  const left = new Set<string>(), rightEnd = new Set<string>();
  for (const row of model.siblingRows ?? []) {
    if (row.leftCell !== cell && row.rightCell !== cell) continue;
    for (const id of [...(row.levelLink === undefined ? [] : [row.levelLink]), ...row.outerLinks]) {
      const ends = model.links.find(link => link.id === id)?.attachments;
      if (ends === undefined) continue;
      for (const node of [ends.from.node, ends.to.node]) if (cellOf(model, node) === cell) (row.leftCell === cell ? rightEnd : left).add(node);
    }
  }
  return { left, right: rightEnd };
}

/**
 * The order a feed decision gives `cell` with its seat kept (the reader of `siblingRows` for the feed order, R1): the members a record seats at the left end
 * stand first and those at the right end last, each block in the order it stands; the other members take `order`. A cell with no record takes `order`.
 */
export function siblingSeatOrder(model: LayoutModel, cell: string, order: readonly string[]): string[] {
  const { left, right: rightEnd } = seatedMembers(model, cell);
  if (!left.size && !rightEnd.size) return [...order];
  const now = model.groups[cell]?.rowOrder ?? model.groups[cell]?.nodes ?? [];
  return [...now.filter(node => left.has(node)), ...order.filter(node => !left.has(node) && !rightEnd.has(node)), ...now.filter(node => rightEnd.has(node))];
}

/**
 * Why the sibling rows do not hold on the model, or undefined (R1, R5): the record is read, never decided again. Each record names two placed `row` cells of
 * its sub-tier in two frames, the left one left of the other; each link is a sibling-frame link between them, named once in all records, with one pair per
 * member; and each cell stands in the seated order: the linked members of the record are one run at the facing end of the row, inner pair outermost on the
 * end, and only members that other records seat stand between that run and the end.
 */
export function siblingRowsFault(model: LayoutModel): string | undefined {
  const rows = model.siblingRows;
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows)) return 'the sibling rows are not a list';
  const named = new Set<string>();
  const facing = new Map<string, { left: Set<string>; right: Set<string> }>();
  const seats = (cell: string) => { let seat = facing.get(cell); if (seat === undefined) { seat = { left: new Set(), right: new Set() }; facing.set(cell, seat); } return seat; };
  const checked: { row: SiblingRow; ls: string[]; rs: string[] }[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !Number.isInteger(row.subTier) || typeof row.leftCell !== 'string' || typeof row.rightCell !== 'string'
      || !['left', 'right', 'none'].includes(row.mirrored) || !Array.isArray(row.outerLinks) || !row.outerLinks.every(id => typeof id === 'string')
      || (row.levelLink !== undefined && typeof row.levelLink !== 'string')) return 'a sibling row is malformed';
    const L = model.groups[row.leftCell], R = model.groups[row.rightCell];
    if (L?.bounds === undefined || R?.bounds === undefined || L === R || L.tier !== row.subTier || R.tier !== row.subTier) return `the sibling row ${row.leftCell}, ${row.rightCell} names no two placed cells of sub-tier ${row.subTier}`;
    if (centreX(L) >= centreX(R)) return `${row.leftCell} does not stand left of ${row.rightCell}`;
    const ids = [...row.outerLinks, ...(row.levelLink === undefined ? [] : [row.levelLink])];
    if (!ids.length) return `the sibling row ${row.leftCell}, ${row.rightCell} names no link`;
    const ls: string[] = [], rs: string[] = [];
    for (const id of ids) {
      const link = model.links.find(item => item.id === id);
      if (link === undefined || !siblingFrameLink(model, link)) return `${id} is no sibling-frame link`;
      if (named.has(id)) return `${id} is named by two sibling rows`;
      named.add(id);
      const { from, to } = link.attachments!;
      const [left, rightEnd] = cellOf(model, from.node) === L.id && cellOf(model, to.node) === R.id ? [from.node, to.node]
        : cellOf(model, to.node) === L.id && cellOf(model, from.node) === R.id ? [to.node, from.node] : [undefined, undefined];
      if (left === undefined || rightEnd === undefined) return `${id} does not join ${row.leftCell} and ${row.rightCell}`;
      ls.push(left); rs.push(rightEnd);
    }
    if (new Set(ls).size !== ls.length || new Set(rs).size !== rs.length) return `the sibling row ${row.leftCell}, ${row.rightCell} is not one pair per member`;
    for (const node of ls) seats(L.id).right.add(node);
    for (const node of rs) seats(R.id).left.add(node);
    checked.push({ row, ls, rs });
  }
  for (const { row, ls, rs } of checked) {
    // Outermost first in `ls` and in `rs`: the left run reads ls left to right and ends on the facing end; the right run reads rs right to left.
    for (const [cell, run, end] of [[row.leftCell, ls, 'right'], [row.rightCell, [...rs].reverse(), 'left']] as const) {
      const order = model.groups[cell]!.rowOrder ?? model.groups[cell]!.nodes;
      const at = run.map(node => order.indexOf(node));
      if (at.some((index, i) => index < 0 || (i > 0 && index !== at[i - 1]! + 1))) return `${cell} does not hold the members of its sibling row with ${end === 'right' ? row.rightCell : row.leftCell} as one run in the seated order`;
      const seat = facing.get(cell)!;
      const beyond = end === 'right' ? order.slice(at[at.length - 1]! + 1) : order.slice(0, at[0]!);
      if (beyond.some(node => !(end === 'right' ? seat.right : seat.left).has(node))) return `${cell} does not stand its sibling-frame members at its ${end} end`;
    }
  }
  return undefined;
}

/** Why an outer link of a sibling row takes no u-turn course, or undefined: each end owns a lateral port that no author, hint or other course set, and no other link shares. */
function uTurnRefusal(model: LayoutModel, link: LayoutLink): string | undefined {
  if ((model.courses ?? []).some(course => course.link === link.id)) return 'the link has a course';
  for (const ref of [link.attachments!.from, link.attachments!.to]) {
    const port: LayoutPort | undefined = findPort(model, ref);
    if (port === undefined) return 'a port is missing';
    if (authoredSide(model, ref) !== undefined) return 'authored-side';
    if (port.sideHint === true || port.laneHint === true || port.courseHint === true) return 'hinted-port';
    if (linksAt(model, ref) !== 1) return 'shared-port';
    if (port.side !== 'left' && port.side !== 'right') return 'no lateral side';
  }
  return undefined;
}

/**
 * The face the U rows of one sibling row take: of the faces whose tier gap exists (`uTurnFacesGap`), the one with fewer ports on the nodes of the sub-tier that
 * stand between the two ends of the outermost link (each of their links on that face crosses the rows); a tie takes the face with fewer ports on the U ends
 * themselves, then `top` (R3: geometry and the fixed face order, never input order). Undefined when neither face looks at a tier gap: the padding row of the
 * outer sheet edge is not built (slice A), so the U is declined.
 */
function uTurnFace(model: LayoutModel, row: SiblingRow, links: readonly LayoutLink[]): 'top' | 'bottom' | undefined {
  const faces = (['top', 'bottom'] as const).filter(face => uTurnFacesGap(model, links[0]!.id, face));
  if (faces.length < 2) return faces[0];
  const ends = new Set(links.flatMap(link => [link.attachments!.from.node, link.attachments!.to.node]));
  const outer = links[0]!.attachments!, xs = [outer.from.node, outer.to.node].map(node => { const box = model.nodes[node]!.bounds!; return box.x + box.width / 2; });
  const low = Math.min(...xs), high = Math.max(...xs);
  const between = Object.values(model.groups).filter(group => group.tier === row.subTier).flatMap(group => group.nodes)
    .filter(node => { const box = model.nodes[node]!.bounds!, x = box.x + box.width / 2; return !ends.has(node) && x > low && x < high; });
  const count = (nodes: Iterable<string>, face: Side): number => [...nodes].reduce((sum, node) => sum + model.nodes[node]!.ports.filter(port => port.side === face).length, 0);
  const key = (face: Side): [number, number] => [count(between, face), count(ends, face)];
  const [top, bottom] = [key('top'), key('bottom')];
  return bottom[0] < top[0] || (bottom[0] === top[0] && bottom[1] < top[1]) ? 'bottom' : 'top';
}

/**
 * Stage 5, once the sides are voted and before the nodes are sized: each outer link of each sibling row takes a `u-turn` course (`runs: ['u']`) on one face of
 * its sub-tier, the face `uTurnFace` gives the row. Both ports move to that face (`courseHint`, with the voted lateral side as `naturalSide`), the course joins
 * `courses` and the ledger (producer `sides-two`), and the tier-gap plan of 7a reserves the U row. An outer link the course may not take keeps its side and the
 * route stage 8 gives (`SIBLING_UTURN_DECLINED`).
 */
export function planSiblingUTurns(model: LayoutModel): void {
  const planned: Course[] = [];
  for (const row of model.siblingRows ?? []) {
    if (!row.outerLinks.length) continue;
    const links: LayoutLink[] = [];
    for (const id of row.outerLinks) {
      const link = model.links.find(item => item.id === id)!, why = uTurnRefusal(model, link);
      if (why === undefined) links.push(link);
      else note(model, SIBLING_UTURN_DECLINED, `The outer pair ${id} of ${row.leftCell} and ${row.rightCell} takes no u-turn course (${why}); it keeps the route stage 8 gives.`, [id]);
    }
    if (!links.length) continue;
    const face = uTurnFace(model, row, links);
    if (face === undefined) {
      note(model, SIBLING_UTURN_DECLINED, `The outer pairs ${links.map(link => link.id).join(', ')} of ${row.leftCell} and ${row.rightCell} take no u-turn course (no-gap: no tier gap above or below sub-tier ${row.subTier}, and the padding row is not built); they keep the route stage 8 gives.`, links.map(link => link.id));
      continue;
    }
    for (const link of links) {
      for (const ref of [link.attachments!.from, link.attachments!.to]) {
        const port = findPort(model, ref)!;
        port.naturalSide = port.side!;
        port.side = face;
        port.courseHint = true;
        delete port.sizingSide;
      }
      planned.push({ link: link.id, kind: 'u-turn', from: { face }, to: { face }, runs: ['u'] });
    }
  }
  if (!planned.length) return;
  model.courses = [...(model.courses ?? []), ...planned];
  model.reservations = [...(model.reservations ?? []), ...courseEntries(planned, undefined, 'sides-two', 0)];
}
