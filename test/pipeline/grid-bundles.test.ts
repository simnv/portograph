import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve, restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { checkChainPair, checkStackedChannel, members, prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { gridCells, gridRowGaps, groupShape } from '../../src/layout/grid.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture ticket 23: a bundle in a grid turns to follow the stack. */
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const box = (model: LayoutModel, id: string) => model.nodes[id]!.bounds!;
const side = (model: LayoutModel, link: number, end: 'from' | 'to') => findPort(model, model.links.find(item => item.id === `link-${link}`)!.attachments![end])!.side;
const counts = (model: LayoutModel) => score(model).snapshot.counts;
const codes = (model: LayoutModel, code: string) => model.diagnostics.filter(item => item.code === code);
const gatesHold = (model: LayoutModel) => Object.values(score(model).snapshot.gates).every(gate => gate.passed);

const STACKED = [
  'a-bundle-in-a-grid-stands-as-a-grid',
  'a-grid-stacks-a-chain-of-three',
  'a-grid-bundle-written-upward-stands-by-its-exits',
  'a-grid-bundle-between-nodes-of-different-widths-stays-straight',
];

describe('a grid that stands its bundles vertically', () => {
  it.each(STACKED)('%s: one GRID_BUNDLE_STACKED per chain, straight members, no declined shape, the guard silent, all gates', async name => {
    const model = await run(name);
    expect(groupShape(model, 'farm')).toBe('grid');
    expect(codes(model, 'GRID_BUNDLE_STACKED')).toHaveLength(1);
    expect(codes(model, 'GROUP_SHAPE_DECLINED')).toEqual([]);
    expect(codes(model, 'GRID_BUNDLE_CHANNEL_SHORT')).toEqual([]);
    expect(counts(model).routed).toMatchObject({ bent: 0, turns: 0, crossings: 0 });
    expect(gatesHold(model)).toBe(true);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);

  it('a chain of three stands in one column and three consecutive rows, a on top', async () => {
    const model = await run('a-grid-stacks-a-chain-of-three');
    expect(['a', 'b', 'c'].map(id => box(model, id).x)).toEqual([box(model, 'a').x, box(model, 'a').x, box(model, 'a').x]);
    expect(box(model, 'a').y).toBeLessThan(box(model, 'b').y);
    expect(box(model, 'b').y).toBeLessThan(box(model, 'c').y);
    // The rows of the grid are consecutive: the three stand in the three rows the grid has.
    expect(gridCells(model, model.groups.farm!)).toHaveLength(3);
    expect(side(model, 3, 'from')).toBe('bottom');
    expect(side(model, 3, 'to')).toBe('top');
    expect(side(model, 5, 'from')).toBe('bottom');
    expect(side(model, 5, 'to')).toBe('top');
  }, 60000);

  it('a bundle written lower to upper stands by its exits: the end that leaves upward is on top', async () => {
    const model = await run('a-grid-bundle-written-upward-stands-by-its-exits');
    expect(box(model, 'a').y).toBeLessThan(box(model, 'b').y);
    expect(side(model, 2, 'from')).toBe('top');
    expect(side(model, 2, 'to')).toBe('bottom');
  }, 60000);

  it('two chain nodes of different widths share the wider width, so the members are straight', async () => {
    const model = await run('a-grid-bundle-between-nodes-of-different-widths-stays-straight');
    expect(box(model, 'b').width).toBe(box(model, 'a').width);
    expect(box(model, 'a').width).toBeGreaterThan(box(model, 'c').width);
    expect(box(model, 'b').x).toBe(box(model, 'a').x);
  });
});

describe('a grid that cannot stand its bundles declines, and says why', () => {
  it.each([
    ['a-grid-declines-a-bundle-whose-ends-both-exit-upward', 'exits'],
    ['a-grid-declines-a-chain-beside-a-node-that-exits-both-ways', 'rows'],
    ['a-group-holds-both-ends-of-a-bundle', 'authored-side'],
  ])('%s: reason %s, one row', async (name, reason) => {
    const model = await run(name);
    const found = codes(model, 'GROUP_SHAPE_DECLINED');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(`(reason: ${reason})`);
    expect(codes(model, 'GRID_BUNDLE_STACKED')).toEqual([]);
    const group = Object.keys(model.groups).find(id => model.document.groups[id]?.shape === 'grid')!;
    expect(groupShape(model, group)).toBe('row');
    expect(gridCells(model, model.groups[group]!)).toHaveLength(1);
    expect(gatesHold(model)).toBe(true);
  });
});

describe('GRID_BUNDLE_CHANNEL_SHORT', () => {
  it('fires once when the faces stand closer than the members need, and is silent on the packed gap', async () => {
    const model = await run('a-bundle-in-a-grid-stands-as-a-grid');
    const draft = JSON.parse(JSON.stringify(model)) as LayoutModel, bundle = draft.bundles[0]!;
    const check = () => checkStackedChannel(draft, bundle, draft.nodes.s2!, draft.nodes.s3!);
    check();
    expect(codes(draft, 'GRID_BUNDLE_CHANNEL_SHORT')).toEqual([]);
    // Shrink the row gap to 5 px and slide the lower port block off the upper one: the members now have to turn.
    const lower = draft.nodes.s3!;
    const dy = lower.bounds!.y - (draft.nodes.s2!.bounds!.y + draft.nodes.s2!.bounds!.height) - 5;
    lower.bounds!.y -= dy;
    for (const port of lower.ports) { port.anchor!.y -= dy; port.anchor!.x += 7; }
    check(); check();
    const found = codes(draft, 'GRID_BUNDLE_CHANNEL_SHORT');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
  });
});

describe('review findings of ticket 23', () => {
  const clone = async () => JSON.parse(JSON.stringify(await run('a-bundle-in-a-grid-stands-as-a-grid'))) as LayoutModel;

  it('the row gap under a chain link grows when the port blocks are not aligned, and stays the band gap when they are', async () => {
    const draft = await clone(), cells = gridCells(draft, draft.groups.farm!);
    expect(gridRowGaps(draft, draft.groups.farm!, cells)).toEqual([bandGap(draft)]);
    for (const port of draft.nodes.s3!.ports) port.anchor!.x += 7;
    const [gap] = gridRowGaps(draft, draft.groups.farm!, cells) as number[];
    expect(gap).toBeGreaterThan(bandGap(draft));
  }, 60000);

  it('a body widened leftwards still stands over its partner: the ports are straight, so nothing is named', async () => {
    const draft = await clone(), bundle = draft.bundles[0]!;
    // Centring widens a body leftwards; the column x splits (`gridCells`), but the port blocks stay where they were.
    draft.nodes.s2!.bounds!.x -= 30; draft.nodes.s2!.bounds!.width += 30;
    checkChainPair(draft, bundle);
    expect(codes(draft, 'GRID_BUNDLE_CHAIN_LOST')).toEqual([]);
    prepareBundleGeometry(draft);
    expect(codes(draft, 'GRID_BUNDLE_CHAIN_LOST')).toEqual([]);
    expect(codes(draft, 'GRID_BUNDLE_CHANNEL_SHORT')).toEqual([]);
    const list = members(draft, bundle);
    expect(list.map(item => Math.abs(item.a.anchor!.x - item.b.anchor!.x))).toEqual([0, 0]);
  }, 60000);

  it('a pair whose port blocks moved apart is named once, by the check and by the planner', async () => {
    const draft = await clone(), bundle = draft.bundles[0]!;
    for (const port of draft.nodes.s3!.ports) port.anchor!.x += 7;
    checkChainPair(draft, bundle); checkChainPair(draft, bundle);
    expect(codes(draft, 'GRID_BUNDLE_CHAIN_LOST')).toHaveLength(1);
    expect(codes(draft, 'GRID_BUNDLE_CHAIN_LOST')[0]!.severity).toBe('error');
    // The planner calls the check: a lower body that no longer faces the upper one is named when 7e runs.
    const faulty = await clone();
    for (const port of faulty.nodes.s3!.ports) port.side = 'bottom';
    try { prepareBundleGeometry(faulty); } catch { /* the planner may refuse a broken pair after the check has spoken */ }
    expect(codes(faulty, 'GRID_BUNDLE_CHAIN_LOST')).toHaveLength(1);
  }, 60000);

  it('a member port that also carries an outside link declines the grid, and stage 1 says so', () => {
    const model = resolve(parse(`
portograph: 2
profile: network
groups:
  top: { tier: 0 }
  farm: { tier: 1, shape: grid }
nodes:
  core: { group: top, class: router }
  a: { group: farm, class: server, ports: [{ name: p }, { name: q }] }
  b: { group: farm, class: server, ports: [{ name: p }] }
  c: { group: farm, class: server }
links:
  - [b.p, a.p]
  - [b.p, a.p]
  - [core, a.p]
  - [core, c]
`));
    expect(codes(model, 'GROUP_SHAPE_DECLINED')[0]!.message).toContain('(reason: shared-port)');
    expect(groupShape(model, 'farm')).toBe('row');
  });

  it('a chain with merge members declines (merge), and stage 1 does not throw', () => {
    const model = resolve(parse(`
portograph: 2
profile: network
groups:
  top: { tier: 0 }
  farm: { tier: 1, shape: grid }
nodes:
  core: { group: top, class: router }
  a: { group: farm, class: server }
  b: { group: farm, class: server }
links:
  - [core, a]
  - { from: a, to: b, route: merge }
  - { from: a, to: b, route: merge }
`));
    expect(codes(model, 'GROUP_SHAPE_DECLINED')[0]!.message).toContain('(reason: merge)');
    expect(groupShape(model, 'farm')).toBe('row');
  });

  it('a lower body that overlaps the upper one is a lost pair even when sides and port blocks hold', async () => {
    const draft = await clone(), bundle = draft.bundles[0]!;
    // Slide the lower body up into the upper one; its ports go with it, so the sides read bottom/top and the blocks coincide in x.
    const upper = draft.nodes.s2!, lower = draft.nodes.s3!, dy = lower.bounds!.y - upper.bounds!.y - 10;
    lower.bounds!.y -= dy;
    for (const port of lower.ports) port.anchor!.y -= dy;
    checkChainPair(draft, bundle);
    expect(codes(draft, 'GRID_BUNDLE_CHAIN_LOST')).toHaveLength(1);
  }, 60000);
});

