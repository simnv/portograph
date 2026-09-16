import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { gridCells, gridChunks, gridColumnFloor, gridRows, packRowsOf } from '../../src/layout/grid.js';
import { nodeGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const rows = (model: LayoutModel, id: string) => packRowsOf(model, model.groups[id]!);
const box = (model: LayoutModel, id: string) => model.nodes[id]!.bounds!;
/** Every gate that reports a violation, so a fixture's gate result is pinned rather than assumed. */
const failed = (model: LayoutModel) => Object.entries(score(model).snapshot.gates)
  .filter(([, gate]) => (gate.violations ?? []).length).map(([id]) => id).sort();
/** Foreign node bodies a link's published path reaches into. Every drop segment is axis-aligned. */
function throughBodies(model: LayoutModel, link: string): string[] {
  const item = model.links.find(entry => entry.id === link)!;
  const ends = new Set([item.attachments!.from.node, item.attachments!.to.node]);
  return Object.values(model.nodes).filter(node => !ends.has(node.id) && (item.path?.segments ?? []).some(segment =>
    Math.max(segment.from.x, segment.to.x) > node.bounds!.x + 1e-6
    && Math.min(segment.from.x, segment.to.x) < node.bounds!.x + node.bounds!.width - 1e-6
    && Math.max(segment.from.y, segment.to.y) > node.bounds!.y + 1e-6
    && Math.min(segment.from.y, segment.to.y) < node.bounds!.y + node.bounds!.height - 1e-6)).map(node => node.id);
}

it('the floor and the rows read one rank map, so a like exit never lands outside its rank row', () => {
  const order = ['m1', 'm2', 'm3', 'm4', 'm5', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
  const ranks = new Map(order.map(id => [id, id.startsWith('d') ? 2 : 1]));
  expect(gridColumnFloor(order, ranks)).toBe(7);
  // Seven columns satisfy the floor, and slicing the ranked order seven wide still stacks two
  // drops: `d1` and `d2` land in the first row. The rows are built from the ranks instead.
  expect(gridChunks(order, 7)[0]).toContain('d1');
  expect(gridRows(order, ranks, 7)).toEqual([['m1', 'm2', 'm3', 'm4', 'm5'],
    ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']]);
  // A node that exits no way fills whatever room the rank rows leave, so filling never costs a row.
  expect(gridRows(order, ranks, 8)).toEqual([['m1', 'm2', 'm3', 'm4'],
    ['m5', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']]);
  // With no vertical exit at all the answer is the chunking it always was.
  const flat = new Map(order.map(id => [id, 1]));
  expect(gridRows(order, flat, 5)).toEqual(gridChunks(order, 5));
  expect(gridColumnFloor(order, flat)).toBe(1);
});

it('a grid group of four takes two columns and two rows, not one line', async () => {
  const model = await run(fixture('a-grid-packs-its-nodes-into-columns'));
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([2, 2]);
  // The box is taller than one line of nodes and narrower than four of them side by side.
  const group = model.groups.place!.bounds!;
  expect(group.height).toBeGreaterThan(Math.max(...model.groups.place!.nodes.map(id => box(model, id).height)) * 2);
  expect(group.width).toBeLessThan(model.groups.place!.nodes.reduce((sum, id) => sum + box(model, id).width, 0));
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('a grid of twelve holds every row on one y and every column on one x, a tier gap apart', async () => {
  const model = await run(fixture('a-grid-of-twelve-keeps-its-columns'));
  const grid = rows(model, 'place');
  expect(grid.length).toBeGreaterThan(1);
  expect(grid.flat().length).toBe(12);
  for (const row of grid) expect(new Set(row.map(id => box(model, id).y)).size).toBe(1);
  // Column x is shared by every row that reaches the column, so the grid reads as a grid.
  for (let c = 0; c < Math.max(...grid.map(row => row.length)); c++) {
    const xs = grid.filter(row => row[c] !== undefined).map(row => box(model, row[c]!).x);
    expect(new Set(xs).size).toBe(1);
  }
  // Rows clear each other by more than the node clearance a row uses beside its neighbour.
  for (let r = 1; r < grid.length; r++) {
    const above = Math.max(...grid[r - 1]!.map(id => box(model, id).y + box(model, id).height));
    const below = Math.min(...grid[r]!.map(id => box(model, id).y));
    expect(below - above).toBeGreaterThan(nodeGap(model, grid[r - 1]![0]!, grid[r]![0]!));
  }
  // Question 4: a same-group peer that stands below votes bottom, not right. n01 links to n02 in
  // its own row and to n05 in the row below; the two links leave on different sides.
  const sideOf = (from: string, to: string) => {
    const link = model.links.find(item => item.attachments!.from.node === from && item.attachments!.to.node === to)!;
    return model.nodes[from]!.ports.find(port => port.ref.ordinal === link.attachments!.from.ordinal
      && (port.ref.name ?? null) === (link.attachments!.from.name ?? null))!.side;
  };
  expect(grid[0]).toContain('n02');
  expect(sideOf('n01', 'n02')).toBe('right');
  expect(sideOf('n01', 'n05')).toBe('bottom');
  expect(failed(model)).toEqual([]);
}, 60000);

it('a downward exit takes the last grid row, so its reserved bar drop crosses no node', async () => {
  const model = await run(fixture('a-grid-beside-a-flank-and-a-bar'));
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([2, 3]);
  // `a` carries the drop to the bar, so it is ranked into the last row; it is also the flank's
  // stored primary peer, so within that row it takes the left cell the flank faces.
  expect(model.groups.side!.flank!.primaryPeer).toBe('a');
  expect(grid.at(-1)![0]).toBe('a');
  // The reservation itself, not only the gates: a bar drop publishes a fixed path and its own
  // `barCross`, and `crosses` in bars.ts tests bar nodes alone. Before the row ranks this drop ran
  // straight through `d` with `barCross: []` and no diagnostic.
  const drop = model.links.find(link => link.attachments!.to.node === 'rail')!;
  expect(drop.path!.fixed).toBe(true);
  expect(throughBodies(model, drop.id)).toEqual([]);
  expect(model.barDrops.map(item => item.barCross)).toEqual([[]]);
  expect(model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  const place = model.groups.place!.bounds!, side = model.groups.side!.bounds!, rails = model.groups.rails!.bounds!;
  expect(side.x + side.width).toBeLessThanOrEqual(place.x);
  expect(place.y + place.height).toBeLessThanOrEqual(rails.y);
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('a ragged grid packs its last row against the side its right flank comes from', async () => {
  const model = await run(fixture('a-grid-seats-a-right-flank-peer'));
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([3, 3, 1]);
  expect(model.groups.side!.flank!.primaryPeer).toBe('g');
  const peerRow = grid.find(row => row.includes('g'))!;
  // Nothing of the peer's own row stands to its right: that is what the lateral link would cross.
  expect(peerRow.slice(peerRow.indexOf('g') + 1)).toEqual([]);
  // And the cell it takes is the grid's outer column, so the link does not run the whole box width.
  const cells = gridCells(model, model.groups.place!);
  expect(cells.at(-1)!.at(-1)).toBe('g');
  expect(cells.at(-1)!.filter(id => id !== undefined)).toEqual(['g']);
  expect(box(model, 'g').x).toBe(box(model, 'f').x);
  expect(failed(model)).toEqual([]);
}, 60000);

it('a column holds one downward exit, so three drops take three columns', async () => {
  const model = await run(fixture('a-grid-gives-every-drop-its-own-column'));
  // Three downward exits, so the floor is three columns and the last row seats all three. Chunked
  // three wide the ranked order `d a b c` would put `a` and `b` in the first row, so the rows come
  // from the ranks, not from slicing the order.
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([1, 3]);
  expect(grid.at(-1)).toEqual(['a', 'b', 'c']);
  // The reservations themselves, not only the gates: every drop is fixed and meets no node body.
  const drops = model.links.filter(link => link.attachments!.to.node === 'rail');
  expect(drops.map(link => link.path!.fixed)).toEqual([true, true, true]);
  expect(drops.flatMap(link => throughBodies(model, link.id))).toEqual([]);
  expect(model.barDrops.map(item => item.barCross)).toEqual([[], [], []]);
  expect(model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  expect(failed(model)).toEqual([]);
}, 60000);

it('a grid whose nodes all exit one way publishes one row', async () => {
  const model = await run(fixture('a-grid-whose-nodes-all-exit-one-way'));
  // Twelve downward exits, so the floor is twelve: the grid degrades to the row shape exactly where
  // one corridor per exit demands it, and every drop is clear.
  expect(rows(model, 'place').map(row => row.length)).toEqual([12]);
  expect(model.links.flatMap(link => throughBodies(model, link.id))).toEqual([]);
  expect(model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  expect(failed(model)).toEqual([]);
}, 60000);

it('a node that exits both ways keeps its slot and says so', async () => {
  const model = await run(fixture('a-grid-node-that-exits-both-ways'));
  // `a` needs the first row and the last at once and takes the last, so its upward reservation
  // crosses the row above. No column count answers that, which is why the warning stays.
  const grid = rows(model, 'place');
  expect(grid.at(-1)).toContain('a');
  const warnings = model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED');
  expect(warnings.length).toBe(1);
  expect(warnings[0]!.severity).toBe('warning');
  expect(warnings[0]!.message).toMatch(/^Reserved drop of link-\d+ runs through c;/);
  // Pinned so the defect cannot change shape or spread unnoticed.
  expect(failed(model)).toEqual(['G2', 'G3', 'G6']);
}, 60000);
