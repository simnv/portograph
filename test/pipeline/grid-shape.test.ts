import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { rebuildBarDrops } from '../../src/layout/bars.js';
import { enclosedBundle, gridCells, gridChunks, gridColumnFloor, gridRows, groupShape, isGridGroup, likeSidePairs, packRowsOf } from '../../src/layout/grid.js';
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
  const rank = new Map(order.map(id => [id, id.startsWith('d') ? 2 : 1]));
  const ranks = { rank, bothWays: new Set<string>() };
  expect(gridColumnFloor(order, ranks)).toBe(7);
  // A node that exits both ways needs the first row and the last, so only one row answers it.
  expect(gridColumnFloor(order, { rank, bothWays: new Set(['d1']) })).toBe(12);
  // Seven columns satisfy the floor, and slicing the ranked order seven wide still stacks two
  // drops: `d1` and `d2` land in the first row. The rows are built from the ranks instead.
  expect(gridChunks(order, 7)[0]).toContain('d1');
  expect(gridRows(order, ranks, 7)).toEqual([['m1', 'm2', 'm3', 'm4', 'm5'],
    ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']]);
  // A node that exits no way fills whatever room the rank rows leave, so filling never costs a row.
  expect(gridRows(order, ranks, 8)).toEqual([['m1', 'm2', 'm3', 'm4'],
    ['m5', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']]);
  // With no vertical exit at all the answer is the chunking it always was.
  const flat = { rank: new Map(order.map(id => [id, 1])), bothWays: new Set<string>() };
  expect(gridRows(order, flat, 5)).toEqual(gridChunks(order, 5));
  expect(gridColumnFloor(order, flat)).toBe(1);
  // An id the rank map does not carry is a middle node, the same default `packGrid` applies, so no
  // node is dropped on a disagreement between the two.
  expect(gridRows(order, { rank: new Map(), bothWays: new Set() }, 5)).toEqual(gridChunks(order, 5));
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
  expect(grid.map(row => row.length)).toEqual([3, 2]);
  // Head and tail rows at once: `b` leaves upward and takes the first row, `a` leaves downward and
  // takes the last. `a` is also the flank's stored primary peer, so within that row it takes the
  // left cell the flank faces.
  expect(grid[0]).toContain('b');
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

it('a node that exits both ways forces a single row', async () => {
  const model = await run(fixture('a-grid-node-that-exits-both-ways'));
  // `a` links to the bar above and the bar below, so it needs the first row and the last at once.
  // One row is the only count that gives it both, and the floor answers with `order.length`.
  expect(rows(model, 'place').map(row => row.length)).toEqual([4]);
  expect(model.links.flatMap(link => throughBodies(model, link.id))).toEqual([]);
  expect(model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  expect(failed(model)).toEqual([]);
}, 60000);

it('BAR_DROP_OBSTRUCTED fires on the reservation itself, not on a grid arrangement', async () => {
  // The column floor removes every arrangement that reached this warning, so no fixture publishes
  // it any more. What it still guards is a body standing in a reserved drop for a reason placement
  // did not choose — the one the ranks cannot see is a side stage 5 overturns. That is not
  // reachable from an input, so the predicate is exercised here instead: take a model whose drops
  // are all clear, move a foreign body into one drop's column, and rebuild the reservations.
  const placed = await run(fixture('a-grid-gives-every-drop-its-own-column'));
  expect(placed.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  const model = JSON.parse(JSON.stringify(placed)) as LayoutModel;
  const drop = model.links.find(link => link.attachments!.from.node === 'a')!;
  const x = Math.min(...drop.path!.segments.map(segment => Math.min(segment.from.x, segment.to.x)));
  const above = box(model, 'a'), rail = box(model, 'rail');
  model.nodes.d!.bounds = { x: x - 10, y: above.y + above.height + 10, width: 40,
    height: rail.y - (above.y + above.height) - 20 };
  rebuildBarDrops(model);
  const warnings = model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED');
  expect(warnings.length).toBe(1);
  expect(warnings[0]!.severity).toBe('warning');
  expect(warnings[0]!.message).toBe(`Reserved drop of ${drop.id} runs through d; `
    + 'the drop keeps its slot and the final gates judge the result.');
  // A report, never a repair: the drop keeps the geometry it had.
  expect(throughBodies(model, drop.id)).toEqual(['d']);
}, 60000);

it('a grid holds all three ranks at once, and a short row that is not the last', async () => {
  const model = await run(fixture('a-grid-holds-three-ranks'));
  const grid = rows(model, 'place');
  // Two upward exits fill the first row with one middle node, three downward exits take the last,
  // and the two middle nodes left over make an interior row narrower than the grid is wide —
  // which slicing the ranked order could never produce.
  expect(grid).toEqual([['u1', 'u2', 'm1'], ['m2', 'm3'], ['d1', 'd2', 'd3']]);
  for (const row of grid) expect(new Set(row.map(id => box(model, id).y)).size).toBe(1);
  // The short row leaves its trailing cells empty, and the geometry reads them back as empty.
  expect(gridCells(model, model.groups.place!)[1]).toEqual(['m2', 'm3', undefined]);
  expect(model.links.flatMap(link => throughBodies(model, link.id))).toEqual([]);
  expect(model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED')).toEqual([]);
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('a group that holds both ends of a bundle declines the grid and says which bundle asked', async () => {
  const model = await run(fixture('a-group-holds-both-ends-of-a-bundle'));
  // Stage 1 reports the refusal and `isGridGroup` enforces it, so the two cannot disagree.
  expect(enclosedBundle(model, 'place')?.id).toBe('bundle-1');
  expect(isGridGroup(model, 'place')).toBe(false);
  const declined = model.diagnostics.filter(item => item.code === 'GROUP_SHAPE_DECLINED');
  expect(declined.map(item => item.severity)).toEqual(['warning']);
  expect(declined[0]!.message).toContain('bundle-1');
  expect(declined[0]!.message).toContain('between a and d');
  // One line, which is what the channel needs: `a` leaves the group upward, `d` and `b` downward,
  // so the ranks would have put `a` in the first row and `d` in the last.
  expect(rows(model, 'place')).toHaveLength(1);
  // The group is a row to every rule and not only to the packer: `rows.ts` and `row-paths.ts` read
  // the same effective shape, so the declined group is not left between the two.
  expect(groupShape(model, 'place')).toBe('row');
  // The two endpoint bodies stand beside each other along the bundle's own normal, which is what
  // the channel is.
  expect(box(model, 'a').x + box(model, 'a').width).toBeLessThanOrEqual(box(model, 'd').x);
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('the count keeps a like-facing vertical pair in one row, and the group stays a grid', async () => {
  const model = await run(fixture('a-grid-would-stack-two-ports-the-author-fixed'));
  // A pair, not a refusal: an arrangement does answer this one, so the shape is kept.
  expect(likeSidePairs(model, model.groups.place!)).toEqual([['a', 'b']]);
  expect(groupShape(model, 'place')).toBe('grid');
  expect(model.diagnostics.filter(item => item.code === 'GROUP_SHAPE_DECLINED')).toEqual([]);
  // Closest-to-square alone takes one column here, which stacks them; the filtered count does not.
  const grid = rows(model, 'place');
  expect(grid.find(row => row.includes('a'))).toContain('b');
  expect(box(model, 'a').y).toBe(box(model, 'b').y);
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('a like-facing pair the count already seats in one row costs the grid nothing', async () => {
  const model = await run(fixture('a-grid-already-seats-a-like-side-pair'));
  expect(likeSidePairs(model, model.groups.place!)).toEqual([['n01', 'n02']]);
  // Three columns by two rows, which is what closest-to-square picks with no pair to satisfy: the
  // rule filters candidate counts, it does not push the count up.
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([3, 3]);
  expect(grid[0]).toContain('n01');
  expect(grid[0]).toContain('n02');
  expect(groupShape(model, 'place')).toBe('grid');
  expect(failed(model)).toEqual([]);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);

it('a bundle with one end outside the group leaves the shape alone, and a free side is no pair', () => {
  const stub = (fromGroup: string, toGroup: string, fromSide?: string, toSide?: string) => ({
    bundles: [{ id: 'bundle-1', nodes: ['x', 'y'] }],
    links: [{ id: 'link-1', owner: { kind: 'link', id: 'link-1' },
      attachments: { from: { node: 'x', name: 'p', ordinal: 1 }, to: { node: 'y', name: 'p', ordinal: 1 } } }],
    groups: { g: { nodes: ['x', 'y'] } },
    document: { groups: { g: { shape: 'grid' } }, nodes: {
      x: { group: fromGroup, ports: [{ name: 'p', ordinal: 1, ...(fromSide ? { side: fromSide } : {}) }] },
      y: { group: toGroup, ports: [{ name: 'p', ordinal: 1, ...(toSide ? { side: toSide } : {}) }] } } },
  } as unknown as LayoutModel);
  // The bundle's channel runs between two groups, so no one group's shape can take it away.
  expect(enclosedBundle(stub('g', 'h'), 'g')).toBeUndefined();
  expect(isGridGroup(stub('g', 'h'), 'g')).toBe(true);
  expect(enclosedBundle(stub('g', 'g'), 'g')?.id).toBe('bundle-1');
  // A pair needs *both* ends authored, on the same vertical side. A free end follows the packed
  // geometry through the same-group vote, and a horizontal stem routes round a stack.
  const group = { id: 'g', nodes: ['x', 'y'] } as unknown as Parameters<typeof likeSidePairs>[1];
  expect(likeSidePairs(stub('g', 'g', 'top', 'top'), group)).toEqual([['x', 'y']]);
  expect(likeSidePairs(stub('g', 'g', 'top'), group)).toEqual([]);
  expect(likeSidePairs(stub('g', 'g', 'right', 'left'), group)).toEqual([]);
  expect(likeSidePairs(stub('g', 'g', 'right', 'right'), group)).toEqual([]);
});
