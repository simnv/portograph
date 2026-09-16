import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { gridRows } from '../../src/layout/grid.js';
import { nodeGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const rows = (model: LayoutModel, id: string) => gridRows(model, model.groups[id]!);
const box = (model: LayoutModel, id: string) => model.nodes[id]!.bounds!;

it('a grid group of four takes two columns and two rows, not one line', async () => {
  const model = await run(fixture('a-grid-packs-its-nodes-into-columns'));
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([2, 2]);
  // The box is taller than one line of nodes and narrower than four of them side by side.
  const group = model.groups.place!.bounds!;
  expect(group.height).toBeGreaterThan(Math.max(...model.groups.place!.nodes.map(id => box(model, id).height)) * 2);
  expect(group.width).toBeLessThan(model.groups.place!.nodes.reduce((sum, id) => sum + box(model, id).width, 0));
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
  expect(rows(model, 'place')[0]).toContain('n02');
  expect(sideOf('n01', 'n02')).toBe('right');
  expect(sideOf('n01', 'n05')).toBe('bottom');
}, 60000);

it('a grid keeps its shape beside a flank and a bar, and the flank peer takes an outer cell', async () => {
  const model = await run(fixture('a-grid-beside-a-flank-and-a-bar'));
  const grid = rows(model, 'place');
  expect(grid.map(row => row.length)).toEqual([3, 2]);
  // `a` is the flank's stored primary peer, so it is repacked into the left cell of the first row.
  expect(model.groups.side!.flank!.primaryPeer).toBe('a');
  expect(grid[0]![0]).toBe('a');
  const place = model.groups.place!.bounds!, side = model.groups.side!.bounds!, rails = model.groups.rails!.bounds!;
  expect(side.x + side.width).toBeLessThanOrEqual(place.x);
  expect(place.y + place.height).toBeLessThanOrEqual(rails.y);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
}, 60000);
