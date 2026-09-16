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

/** How the nodes of one grid group leave it, read once (`exitRanks`) and consumed by both rules. */
export interface ExitRanks {
  /** 0 upward, 1 neither way, 2 downward. A node that leaves **both** ways ranks downward. */
  readonly rank: ReadonlyMap<string, number>;
  /** The nodes that leave both ways, which rank 2 on its own cannot tell from a plain drop. */
  readonly bothWays: ReadonlySet<string>;
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
 * The count is the one whose packed box comes closest to square, ties to the fewer columns, **of the
 * counts a column-as-corridor allows** (`gridColumnFloor`). Nothing else is fixed: the answer
 * follows the measured node sizes and the two gaps, so a group of wide nodes takes fewer columns
 * than a group of narrow ones of the same count.
 *
 * The box each candidate is measured on is the one `gridRows` will actually pack, ranks and all, so
 * the count and the arrangement are one decision rather than two that can disagree. **That is a
 * behaviour change in its own right, not only a bound.** Scoring the ranked arrangement rather than
 * `gridChunks` changes which counts tie, and the tie goes to the fewer columns: the golden's
 * `datacenter`, gridded alone, took three columns in a 3 / 1 split before and takes two in a 2 / 2
 * split now, although its floor is 2 either way and 1 was never in the running (stress ticket 31).
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
export function gridColumns(model: LayoutModel, group: LayoutGroup, order: readonly string[],
  ranks: ExitRanks): number {
  if (order.length <= 1) return 1;
  const gap = gridNodeGap(model, group), rowGap = gridRowGap(model);
  const floor = gridColumnFloor(order, ranks);
  let best = floor, bestScore = Infinity;
  for (let columns = floor; columns <= order.length; columns++) {
    const metrics = gridMetrics(model, gridRows(order, ranks, columns), () => gap, rowGap);
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
 * Which grid row every node of `group` belongs in, from the way its links leave the group: 0 upward,
 * 1 neither way, 2 downward.
 *
 * One reading for the whole group, one pass over `model.links`, handed to both consumers. The rank
 * picks the row and `gridColumnFloor` counts the same reading for the column count, so a rank taken
 * from one reading of the sides and a count taken from another cannot disagree (ADR-0015; stress
 * ticket 31). It replaced a per-node scan of every link, so the pack is one pass rather than *n*.
 *
 * A row group has nothing above or below its nodes, so a port that leaves on `top` or `bottom` has
 * a clear way out by construction. A grid has rows, and a port that leaves downward from a row that
 * is not the last has to cross every row below it — which nothing reserves, and which `bars.ts`
 * does not even test for, because `crosses` looks only at nodes in `bar` groups (its filter is the
 * whole obstacle test a drop gets). So the exits decide the rows: a node whose links leave upward
 * takes the first row, one whose links leave downward takes the last, and the rest sit between
 * them. Stable within each rank, so ELK's crossing-minimised order survives inside a rank.
 *
 * A node that leaves **both** ways is ranked downward, because the downward exit is the one that is
 * reserved silently: a bar drop publishes a `fixed` path and an empty `barCross` whatever stands
 * under it, where an upward link goes to stage 8 and fails a gate where a reader can see it. The
 * rank cannot satisfy both, so `bothWays` is reported beside it and `gridColumnFloor` answers the
 * node with a single row. `shapeBars` still warns `BAR_DROP_OBSTRUCTED` where a reservation meets a
 * node, for the sides stage 5 overturns.
 *
 * Sides are read as `side ?? sizingSide` — the same expression `skeleton-graph.ts` dereferences to
 * hand ELK its port sides, so it is settled by the time this runs. Stage 5 may still move an
 * undecided side, and a rank taken from the guess it overturns can land a reservation on a body
 * after all. What that costs is a G2 `through-node` failure **and** the warning below, which is a
 * reader's two signals; it is never the silence this rule was written for.
 */
export function exitRanks(model: LayoutModel, group: LayoutGroup): ExitRanks {
  const members = new Set(group.nodes);
  const up = new Set<string>(), down = new Set<string>();
  for (const link of model.links) {
    const ends = link.attachments;
    if (!ends || link.technique === 'stub') continue;
    for (const [own, peer] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      if (!members.has(own.node) || members.has(peer.node)) continue;
      const port = model.nodes[own.node]!.ports.find(item => portId(item.ref) === portId(own));
      const side = port?.side ?? port?.sizingSide;
      if (side === 'top') up.add(own.node);
      if (side === 'bottom') down.add(own.node);
    }
  }
  return { rank: new Map(group.nodes.map(id => [id, down.has(id) ? 2 : up.has(id) ? 0 : 1])),
    bothWays: new Set(group.nodes.filter(id => up.has(id) && down.has(id))) };
}

/**
 * The fewest columns a grid of these exits may take: **a column is a corridor**, so it holds at most
 * one node that exits downward and at most one that exits upward.
 *
 * A node that exits **both** ways needs the first row and the last at once, so the only count that
 * answers it is `order.length` — a single row. Measured three ways on this branch, and the answer is
 * one-sided every time: `a-grid-node-that-exits-both-ways` publishes 3 violations at Q 0.8030 as a
 * grid and **0 at Q 0.9081** as one row; `a-grid-beside-a-flank-and-a-bar` with its drop and its
 * flank link on one node published 0 violations at Q 0.6888 and **0 at Q 0.9245** as one row; and a
 * twelve-node grid with four both-way nodes publishes **14 violations at Q 0.3437** and **0 at
 * Q 0.9245** as one row. The cheaper answer — keep the grid and reserve the cells *above* a both-way
 * node empty — is not taken: it needs one empty cell per row above each such node, which in that
 * twelve-node case is eight holes in a twelve-cell grid, and it was not measured end to end.
 *
 * `exitRank` decides *which row* a node takes and stops there. It cannot separate two nodes that
 * exit the same way — they share a rank, the rank is one row, and a row of *k* like exits in a grid
 * of fewer than *k* columns puts two of them in one column with one above the other. The upper
 * node's link then runs down its own column, through the lower node's body. That is the maintainer's
 * gridded golden: `route-reflector` holds `RR-01` and `RR-02`, both dropping to the backbone, and
 * closest-to-square makes one column of two (stress ticket 31).
 *
 * **The bound is hard, and what it costs is measured.** A group whose nodes all exit one way is
 * forced to one row — the `row` shape, which is what a corridor per exit means. That is not a loss:
 * measured on `goldens/synthetic/a-grid-whose-nodes-all-exit-one-way.yaml`, twelve nodes all
 * dropping to a bar pack 4 × 3 without the bound and publish **56 gate violations at Q 0.487** in a
 * 367.5 × 502 canvas — eight of the twelve drops reserved through a node body. The same twelve under
 * the bound publish **no violation at Q 0.9225** in 911.5 × 308. The grid does not lose compaction
 * here; it never had it.
 *
 * The cheaper alternative — let the lower node take a port column the upper node's drop misses, the
 * way `exitRank` works one level down — does not hold, and the golden is the counter-example. Nodes
 * of one column share the column's x and are left-aligned in it, so an upper node's bottom port can
 * clear a lower node's body only where the upper node is wider than the lower one by more than the
 * port inset plus the 10 px G6 clearance. `RR-01` and `RR-02` are both 50 px wide with one port
 * each, so no port column exists for either to take.
 *
 * Sides are read from `side ?? sizingSide`, the same expression `exitRanks` above uses and the same
 * one `skeleton-graph.ts` dereferences to hand ELK its port sides. The count and the rank are two
 * readings of one map, taken in one call, so they cannot disagree.
 */
export function gridColumnFloor(order: readonly string[], ranks: ExitRanks): number {
  if (order.some(id => ranks.bothWays.has(id))) return order.length;
  let up = 0, down = 0;
  for (const id of order) { const rank = ranks.rank.get(id); if (rank === 0) up++; if (rank === 2) down++; }
  return Math.max(1, up, down);
}

/**
 * Cut `order` into rows of `columns`, with every upward exit in the first row and every downward
 * exit in the last.
 *
 * Reading order alone does not do it. `packGrid` sorts the order by rank, so the downward exits are
 * the tail of it — but the tail lands in the last row only when the count before it is a multiple of
 * `columns`. Twelve nodes in seven columns with seven downward exits chunk `[5 middle + 2 down] /
 * [5 down]`, which satisfies the floor above and still stacks two drops. The rows are therefore
 * built from the ranks, not sliced off the order: the downward exits take the last row, the upward
 * exits the first, and a node that exits neither way fills whatever room is left in those rows
 * before it takes a row between them. Filling never costs a row — it only empties the middle — and
 * the flattened result is the ranked order again, so `group.rowOrder` is unchanged in meaning.
 *
 * A rank the floor cannot seat (more like exits than columns) chunks across rows as before rather
 * than widening the grid behind the count's back; `BAR_DROP_OBSTRUCTED` reports what that costs.
 *
 * **A short row is no longer only the last one.** `gridChunks` could leave a remainder at the end
 * and nowhere else; filling a rank row can leave the *middle* short instead, so a grid may hold an
 * interior row narrower than its columns. `gridMetrics` and `gridCells` both take a row's own
 * length and read empty cells back, so the geometry round trip is the same either way; the shipped
 * case is `goldens/synthetic/a-grid-holds-three-ranks.yaml`.
 */
export function gridRows(order: readonly string[], ranks: ExitRanks, columns: number): string[][] {
  if (order.length === 0) return [];
  if (columns < 1 || order.length <= columns) return [[...order]];
  const rank = (id: string) => ranks.rank.get(id) ?? 1;
  const head = gridChunks(order.filter(id => rank(id) === 0), columns);
  const tail = gridChunks(order.filter(id => rank(id) === 2), columns);
  let middle = order.filter(id => rank(id) === 1);
  const headRoom = Math.min(middle.length, columns - (head.at(-1)?.length ?? columns));
  if (headRoom > 0) { head[head.length - 1] = [...head.at(-1)!, ...middle.slice(0, headRoom)]; middle = middle.slice(headRoom); }
  const tailRoom = Math.min(middle.length, columns - (tail[0]?.length ?? columns));
  if (tailRoom > 0) { tail[0] = [...middle.slice(middle.length - tailRoom), ...tail[0]!]; middle = middle.slice(0, middle.length - tailRoom); }
  return [...head, ...gridChunks(middle, columns), ...tail];
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
 * `columns` is the chosen count, which can exceed the widest row `rows` actually holds — a grid of
 * `n` nodes in `n` columns is one row of `n`, and `gridRows` never pads it. The right-pad below
 * would then insert cells past the last column. It is unreachable: a count whose widest row is
 * short ties with the count one smaller, and the strict `< bestScore - 1e-9` in `gridColumns` hands
 * a tie to the smaller, so the chosen count always equals its widest row. An empty leading column
 * costs nothing anyway — `gridMetrics` gives it width 0 and no gap — so this is a note, not a guard.
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
  const ranks = exitRanks(model, group);
  const ranked = [...order].map((id, index) => ({ id, index, rank: ranks.rank.get(id) ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.id);
  const columns = gridColumns(model, group, ranked, ranks);
  const cells = seatFlankPeers(model, group, gridRows(ranked, ranks, columns), columns);
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
