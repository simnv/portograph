import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { gridCells, packRowsOf } from '../../src/layout/grid.js';
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

it('more drops than the last row holds keeps its slots and says so', async () => {
  const model = await run(fixture('a-grid-has-more-drops-than-its-last-row-holds'));
  // Three downward exits, two cells in the last row: one drop is reserved through a node body.
  expect(rows(model, 'place').map(row => row.length)).toEqual([2, 2]);
  const warnings = model.diagnostics.filter(item => item.code === 'BAR_DROP_OBSTRUCTED');
  expect(warnings.length).toBe(1);
  expect(warnings[0]!.severity).toBe('warning');
  expect(warnings[0]!.message).toMatch(/^Reserved drop of link-\d+ runs through c;/);
  // Pinned so the defect cannot change shape or spread unnoticed.
  expect(failed(model)).toEqual(['G2', 'G3', 'G4', 'G6']);
}, 60000);
