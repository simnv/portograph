import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { bandGap, compareId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
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
export function gridMetrics(model: LayoutModel, rows: string[][], gap: (a: string, b: string) => number, rowGap: number): GridMetrics {
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
  const rowHeight = rows.map(row => Math.max(0, ...row.map(id => model.nodes[id]!.size!.height)));
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
 * takes fewer columns than a group of narrow ones of the same count. On the maintainer's Enterprise
 * NTP locations — seven nodes about 130 × 70 — it answers two columns, which is what the original
 * draws.
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
 * (`gridRows`) without a stored field the mutation boundary would have to carry.
 */
export function packGridRows(model: LayoutModel, group: LayoutGroup, rows: string[][],
  gap: (a: string, b: string) => number, rowGap: number): void {
  const original = group.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const metrics = gridMetrics(model, rows, gap, rowGap);
  const originX = original.x + spacing.padding, originY = original.y + spacing.padding;
  for (const [r, row] of rows.entries()) {
    for (const [c, id] of row.entries()) moveNodeTo(model, id, originX + metrics.columnX[c]!, originY + metrics.rowY[r]!);
  }
  group.rowOrder = rows.flat();
  group.bounds = { x: original.x, y: original.y,
    width: Math.max(2 * spacing.padding, metrics.width + 2 * spacing.padding),
    height: Math.max(2 * spacing.padding, metrics.height + 2 * spacing.padding) };
}

/** Pack `order` into the column count the aspect rule chooses, at the skeleton's node clearance. */
export function packGrid(model: LayoutModel, group: LayoutGroup, order: string[]): void {
  const gap = gridNodeGap(model, group);
  packGridRows(model, group, gridChunks(order, gridColumns(model, group, order)), () => gap, gridRowGap(model));
}

/**
 * The rows of a packed grid, read back from the geometry. Nodes of one row share a y exactly, so
 * the clustering is exact rather than tolerant; no later rule moves one node of a row in y without
 * the others (centring cannot change y at all, and the bundle and band rules move whole tiers).
 */
export function gridRows(model: LayoutModel, group: LayoutGroup): string[][] {
  const byY = new Map<number, string[]>();
  for (const id of group.nodes) {
    const y = model.nodes[id]!.bounds!.y;
    const list = byY.get(y) ?? []; list.push(id); byY.set(y, list);
  }
  return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) =>
    ids.sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x || compareId(a, b)));
}

/**
 * The rows a rule that repacks a group must walk: one row for a `row` group, the packed rows for a
 * grid. A rule that pushes node *i* clear of node *i - 1* must not push the first node of a grid row
 * clear of the last node of the row above it — they do not share a line.
 */
export function packRowsOf(model: LayoutModel, group: LayoutGroup): string[][] {
  return isGridGroup(model, group.id) ? gridRows(model, group) : [group.rowOrder ?? group.nodes];
}
