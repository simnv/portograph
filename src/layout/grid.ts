import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { orderedGroupIds } from '../model/model.js';
import { bandGap, compareId, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

/**
 * `grid` is the third group shape `CONTEXT.md` names (`row`, `bar`, `grid`, `ring`, `free`).
 *
 * A `row` group puts every node on one line, so a location of twelve nodes becomes a 1 111 px
 * ribbon; the partners of its links then stand far apart, every direct line between them is long,
 * and a long line meets something. A `grid` group packs the same nodes into columns and rows, which
 * is what the maintainer's own Enterprise NTP diagram does with every location.
 *
 * Everything this file decides is decided during placement: the column count, the column x, the row
 * y and both gaps. Nothing here is discovered while routing.
 */
export const isGridGroup = (model: LayoutModel, id: string): boolean =>
  model.document.groups[id]?.shape === 'grid';

/**
 * The gap between two grid rows. It is `bandGap` — the same room the pipeline reserves between two
 * tiers — and not the node clearance a row uses between side-by-side nodes, because a port on the
 * bottom of a node in an upper row has to leave the group past every row below it. That is a
 * horizontal run inside the group box, and a run needs the room a tier gap holds. Reserving it here
 * keeps routing from discovering it.
 */
export const gridRowGap = (model: LayoutModel): number => bandGap(model);

/** The clearance every pair of nodes in `group` satisfies, whichever two of them end up adjacent. */
export function gridNodeGap(model: LayoutModel, group: LayoutGroup): number {
  const stroke = Math.max(DEFAULT_STROKE_WIDTHS.node,
    ...group.nodes.map(id => model.nodes[id]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
  return spacing.nodeClearance + stroke;
}

/**
 * One row of a packed grid, by column. A cell is empty where the row is shorter than the grid is
 * wide: a ragged row is not always packed against the left column, because a right flank's peer has
 * to sit at the outer end of the row it is in (`seatFlankPeers`).
 */
export type GridCells = (string | undefined)[][];

/** Cut `order` into `columns`-wide rows, reading order preserved. */
export function gridChunks(order: readonly string[], columns: number): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < order.length; i += columns) rows.push(order.slice(i, i + columns));
  return rows;
}

interface GridMetrics { columnX: number[]; columnWidth: number[]; rowY: number[]; rowHeight: number[]; width: number; height: number }

/**
 * Column x and row y for one chunking, from the measured node sizes. Columns are shared by every
 * row — a node is placed at its column's x, not packed against its own left neighbour — so the grid
 * reads as a grid and every later rule that repacks it lands on the same coordinates.
 */
export function gridMetrics(model: LayoutModel, rows: GridCells, gap: (a: string, b: string) => number, rowGap: number): GridMetrics {
  const columns = Math.max(0, ...rows.map(row => row.length));
  const columnWidth: number[] = [], columnX: number[] = [];
  for (let c = 0; c < columns; c++) {
    columnWidth.push(Math.max(0, ...rows.filter(row => row[c] !== undefined).map(row => model.nodes[row[c]!]!.size!.width)));
  }
  let x = 0;
  for (let c = 0; c < columns; c++) {
    columnX.push(x);
    const pairs = rows.filter(row => row[c] !== undefined && row[c + 1] !== undefined).map(row => gap(row[c]!, row[c + 1]!));
    x += columnWidth[c]! + (pairs.length ? Math.max(...pairs) : 0);
  }
  const rowHeight = rows.map(row => Math.max(0, ...row.filter((id): id is string => id !== undefined).map(id => model.nodes[id]!.size!.height)));
  const rowY: number[] = [];
  let y = 0;
  for (const [i, height] of rowHeight.entries()) { rowY.push(y); y += height + (i + 1 < rows.length ? rowGap : 0); }
  const width = columns ? columnX[columns - 1]! + columnWidth[columns - 1]! : 0;
  return { columnX, columnWidth, rowY, rowHeight, width, height: y };
}

/**
 * How many columns a grid of `order` takes.
 *
 * The count is the one whose packed box comes closest to square, ties to the fewer columns. Nothing
 * is fixed: the answer follows the measured node sizes and the two gaps, so a group of wide nodes
 * takes fewer columns than a group of narrow ones of the same count.
 *
 * Two things the caller has to know. The box measured here is the **stage-4** box: the count is
 * chosen from the sizes the nodes have before stage 5 grows them to their final port capacity, and
 * stage 5 then re-lays the same count out at the larger sizes, so the published box is near square
 * and not square. Measured on the shipped fixtures: four nodes take two columns and publish at
 * 161.5 × 206.5, twelve take four and publish at 313 × 308.5
 * (`goldens/synthetic/a-grid-of-twelve-keeps-its-columns.yaml`). And the target is a **square**, not
 * the proportions of the original Enterprise NTP diagram, which draws its locations portrait. A
 * portrait target is one constant away if the maintainer wants it; stress ticket 26 measures what
 * the difference costs on that sheet, and names the input each of its figures came from.
 */
export function gridColumns(model: LayoutModel, group: LayoutGroup, order: readonly string[]): number {
  if (order.length <= 1) return 1;
  const gap = gridNodeGap(model, group), rowGap = gridRowGap(model);
  let best = 1, bestScore = Infinity;
  for (let columns = 1; columns <= order.length; columns++) {
    const metrics = gridMetrics(model, gridChunks(order, columns), () => gap, rowGap);
    if (metrics.width <= 0 || metrics.height <= 0) continue;
    const score = Math.abs(Math.log(metrics.width / metrics.height));
    if (score < bestScore - 1e-9) { bestScore = score; best = columns; }
  }
  return best;
}

function moveNodeTo(model: LayoutModel, id: string, x: number, y: number): void {
  const node = model.nodes[id]!, old = node.bounds;
  if (old) for (const port of node.ports) if (port.anchor) { port.anchor.x += x - old.x; port.anchor.y += y - old.y; }
  node.bounds = { x, y, ...node.size! };
}

/**
 * Place `rows` inside `group`, top-left at the group's own padded origin, and refit the box.
 *
 * Every node of a row takes the row's y, so the rows can always be read back off the geometry
 * (`gridCells`) without a stored field the mutation boundary would have to carry.
 */
export function packGridRows(model: LayoutModel, group: LayoutGroup, rows: GridCells,
  gap: (a: string, b: string) => number, rowGap: number): void {
  const original = group.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const metrics = gridMetrics(model, rows, gap, rowGap);
  const originX = original.x + spacing.padding, originY = original.y + spacing.padding;
  for (const [r, row] of rows.entries()) {
    for (const [c, id] of row.entries()) {
      if (id !== undefined) moveNodeTo(model, id, originX + metrics.columnX[c]!, originY + metrics.rowY[r]!);
    }
  }
  group.rowOrder = rows.flat().filter((id): id is string => id !== undefined);
  group.bounds = { x: original.x, y: original.y,
    width: Math.max(2 * spacing.padding, metrics.width + 2 * spacing.padding),
    height: Math.max(2 * spacing.padding, metrics.height + 2 * spacing.padding) };
}

/**
 * Which grid row a node belongs in, from the way its links leave the group.
 *
 * A row group has nothing above or below its nodes, so a port that leaves on `top` or `bottom` has
 * a clear way out by construction. A grid has rows, and a port that leaves downward from a row that
 * is not the last has to cross every row below it — which nothing reserves, and which `bars.ts`
 * does not even test for, because `crosses` looks only at nodes in `bar` groups (its filter is the
 * whole obstacle test a drop gets). So the exits decide the rows: a node whose links leave upward
 * takes the first row, one whose links leave downward takes the last, and the rest sit between
 * them. Stable within each rank, so ELK's crossing-minimised order survives inside a rank.
 *
 * A node that leaves **both** ways is ranked downward. It cannot satisfy both, and the downward
 * exit is the one that is reserved silently: a bar drop publishes a `fixed` path and an empty
 * `barCross` whatever stands under it, where an upward link goes to stage 8 and fails a gate where
 * a reader can see it. `shapeBars` warns `BAR_DROP_OBSTRUCTED` when the reservation still meets a
 * node, so neither case is silent again.
 *
 * Sides are read as `side ?? sizingSide` — the same expression `skeleton-graph.ts` dereferences to
 * hand ELK its port sides, so it is settled by the time this runs. Stage 5 may still move an
 * undecided side, and a rank taken from the guess it overturns can land a reservation on a body
 * after all. What that costs is a G2 `through-node` failure **and** the warning below, which is a
 * reader's two signals; it is never the silence this rule was written for.
 */
function exitRank(model: LayoutModel, group: LayoutGroup, id: string): number {
  let up = false, down = false;
  const members = new Set(group.nodes);
  for (const link of model.links) {
    const ends = link.attachments;
    if (!ends || link.technique === 'stub') continue;
    for (const [own, peer] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      if (own.node !== id || members.has(peer.node)) continue;
      const port = model.nodes[id]!.ports.find(item => portId(item.ref) === portId(own));
      const side = port?.side ?? port?.sizingSide;
      if (side === 'top') up = true;
      if (side === 'bottom') down = true;
    }
  }
  return down ? 2 : up ? 0 : 1;
}

/**
 * Put each attached flank's stored primary peer at the outer end of its own row, and pack that row
 * against the flank's own side when the row is ragged.
 *
 * The lateral link runs at the peer's own y, so what it must not cross is a node of the peer's
 * **row**; a node two rows up stands at another y and is no obstacle. That alone would already pass
 * every gate — but on a ragged row it leaves a right flank's peer in **column 0**, because reading
 * order packs a short row against the left, and the link then runs the whole width of the group box
 * over empty cells to reach it. The three 7-node locations of the Enterprise NTP sheet all pack
 * 3 × 3 × 1, so that is the common case and not a corner. A ragged row that holds a right-aligned
 * peer is therefore packed against the right columns instead, which leaves the empty cells on the
 * side the link does not come from.
 *
 * Untested corner, recorded rather than guarded: two flanks whose primary peers land in the same
 * ragged row. Both would be spliced and the row right-padded, so the left peer would leave column 0,
 * and `FLANK_PRIMARY_CONFLICT` does not cover it — that covers a shared *peer*, not a shared row.
 * `placeFlanksAndPeers` sends the two peers to opposite ends of the reading order, which is why no
 * probe has reached it (stress ticket 26 re-check).
 */
function seatFlankPeers(model: LayoutModel, group: LayoutGroup, rows: string[][], columns: number): GridCells {
  const rightAligned = new Set<number>();
  for (const flank of orderedGroupIds(model.document).map(id => model.groups[id]!)) {
    const peer = flank.flank?.of === group.id ? flank.flank.primaryPeer ?? flank.flank.proxyPeer : undefined;
    if (peer === undefined) continue;
    const index = rows.findIndex(item => item.includes(peer));
    if (index < 0) continue;
    const row = rows[index]!, align = flank.flank!.align;
    row.splice(row.indexOf(peer), 1);
    row.splice(align === 'left' ? 0 : row.length, 0, peer);
    if (align === 'right') rightAligned.add(index);
  }
  return rows.map((row, index) => rightAligned.has(index) && row.length < columns
    ? [...new Array<undefined>(columns - row.length), ...row] : row);
}

/** Pack `order` into the column count the aspect rule chooses, at the skeleton's node clearance. */
export function packGrid(model: LayoutModel, group: LayoutGroup, order: string[]): void {
  const gap = gridNodeGap(model, group);
  const ranked = [...order].map((id, index) => ({ id, index, rank: exitRank(model, group, id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.id);
  const columns = gridColumns(model, group, ranked);
  const cells = seatFlankPeers(model, group, gridChunks(ranked, columns), columns);
  packGridRows(model, group, cells, () => gap, gridRowGap(model));
}

/**
 * The cells of a packed grid, read back from the geometry.
 *
 * Nodes of one row share a y exactly and nodes of one column share an x exactly, so both clusterings
 * are exact rather than tolerant, and an empty cell — the gap a ragged row packed against the right
 * leaves — comes back as one. No later rule moves one node of a row in y without the others
 * (centring cannot change y at all, and the bundle and band rules move whole tiers). Centring may
 * widen a node leftwards, which can split a shared column x; that only ever adds a column to this
 * reading, and the two readers below want rows in x order, which stays right either way.
 */
export function gridCells(model: LayoutModel, group: LayoutGroup): GridCells {
  const xs = [...new Set(group.nodes.map(id => model.nodes[id]!.bounds!.x))].sort((a, b) => a - b);
  const ys = [...new Set(group.nodes.map(id => model.nodes[id]!.bounds!.y))].sort((a, b) => a - b);
  const cells: GridCells = ys.map(() => new Array<string | undefined>(xs.length).fill(undefined));
  for (const id of [...group.nodes].sort(compareId)) {
    const box = model.nodes[id]!.bounds!;
    cells[ys.indexOf(box.y)]![xs.indexOf(box.x)] = id;
  }
  return cells;
}

/**
 * The rows a rule that repacks a group must walk: one row for a `row` group, the packed rows for a
 * grid. A rule that pushes node *i* clear of node *i - 1* must not push the first node of a grid row
 * clear of the last node of the row above it — they do not share a line.
 */
export function packRowsOf(model: LayoutModel, group: LayoutGroup): string[][] {
  return isGridGroup(model, group.id)
    ? gridCells(model, group).map(row => row.filter((id): id is string => id !== undefined))
    : [group.rowOrder ?? group.nodes];
}
