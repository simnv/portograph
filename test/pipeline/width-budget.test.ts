import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score, serializeLayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const source = readFileSync(new URL('../../goldens/synthetic/a-wide-card-row-staggers-under-a-budget.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

it('accepts a positive finite width budget and rejects invalid budgets', () => {
  expect(parse(source).layout?.maxWidth).toBe(1500);
  for (const value of ['0', '-1', '.inf', '.nan', 'wide']) {
    expect(() => parse(source.replace('maxWidth: 1500', `maxWidth: ${value}`))).toThrow();
  }
});

it('automatically staggers wide snack card rows with clear vertical drops', async () => {
  const document = parse(source);
  const model = await layout(document, options);
  const report = score(model).snapshot;
  expect(model.canvas!.width, JSON.stringify(model.diagnostics.filter(note => note.code.includes('STAGGER')))).toBeLessThanOrEqual(1500);
  expect(Object.values(report.gates).filter(gate => !gate.passed)).toEqual([]);
  expect(report.counters.removedLinks).toBe(0);
  expect(report.metrics.crossings.count).toBe(0);
  const staggered = Object.values(model.groups).filter(group => new Set(group.nodes.map(id => model.nodes[id]!.bounds!.y)).size === 2);
  expect(staggered.length).toBeGreaterThan(0);
  for (const group of staggered) {
    const order = group.rowOrder!;
    const ys = order.map(id => model.nodes[id]!.bounds!.y);
    expect(ys[0]).not.toBe(ys[1]);
    expect(ys[0]).toBe(ys[2]);
    for (const link of model.links.filter(link => link.attachments && [link.attachments.from.node, link.attachments.to.node].some(id => order.includes(id)))) {
      for (const segment of link.path!.segments) expect(segment.from.x).toBeCloseTo(segment.to.x, 6);
    }
  }
}, 60000);

const stable = (model: Awaited<ReturnType<typeof layout>>): string => serializeLayoutModel({ ...model, runtime: { stages: [] } });

it('keeps already-fitting output byte-identical to the normal output', async () => {
  const normal = parse(source);
  delete normal.layout!.maxWidth;
  const before = await layout(normal, options);
  const fitting = parse(source);
  fitting.layout!.maxWidth = before.canvas!.width;
  expect(stable(await layout(fitting, options))).toBe(stable(before));
  expect(fitting.layout!.maxWidth).toBe(before.canvas!.width);
});

it('publishes the narrowest valid result with a diagnostic when the budget is unattainable', async () => {
  const document = parse(source);
  document.layout!.maxWidth = 1;
  const model = await layout(document, options);
  // D-Q4: `clients` (hubs feed 4 and 2 members) is no fan for stage 5, so the width-budget search gives the rows, in its own order.
  expect(model.staggerRows?.map(row => row.group)).toEqual(['sensors', 'clients']);
  expect(model.diagnostics.filter(note => note.code === 'WIDTH_BUDGET_UNMET')).toHaveLength(1);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
  expect(model.canvas!.width).toBeLessThan(1500);
});

const downward = `portograph: 2
layout: {nodeContent: card, maxWidth: 500}
theme: snack
groups:
  sources: {tier: 0}
  destination: {tier: 1, shape: bar}
nodes:
  a: {group: sources, label: Source A, size: {width: 180, height: 50}}
  b: {group: sources, label: Source B, size: {width: 180, height: 50}}
  c: {group: sources, label: Source C, size: {width: 180, height: 50}}
  hub: {group: destination, label: Collector}
links: [[a, hub], [b, hub], [c, hub]]
`;

it('moves alternate members above their neighbours when links leave downward', async () => {
  const model = await layout(parse(downward), options);
  expect(model.canvas!.width).toBeLessThanOrEqual(500);
  const order = model.groups.sources!.rowOrder!;
  expect(model.nodes[order[1]!]!.bounds!.y).toBeLessThan(model.nodes[order[0]!]!.bounds!.y);
  expect(model.nodes[order[0]!]!.bounds!.y).toBe(model.nodes[order[2]!]!.bounds!.y);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});

it('leaves rows of fewer than three members alone and diagnoses the unmet budget', async () => {
  const document = parse(downward);
  delete document.nodes.c;
  document.links.pop();
  document.layout!.maxWidth = 1;
  const model = await layout(document, options);
  expect(model.staggerRows).toBeUndefined();
  expect(model.diagnostics.some(note => note.code === 'WIDTH_BUDGET_UNMET')).toBe(true);
});

it.each(['left', 'right'] as const)('clears the stroke-expanded %s pill beside the passing vertical', async side => {
  const document = parse(downward);
  document.layout!.maxWidth = 550;
  const id = side === 'left' ? 'c' : 'a';
  document.nodes[id]!.ports.push({ name: 'LongInterfaceNameForStaggerClearanceReserve', ordinal: 1, side });
  const model = await layout(document, options);
  expect(model.staggerRows).toHaveLength(1);
  const row = model.staggerRows![0]!;
  const odd = model.nodes[row.order[1]!]!;
  const pillNode = model.nodes[id]!;
  const pill = pillNode.ports.find(port => port.ref.name === 'LongInterfaceNameForStaggerClearanceReserve')!.pill!.bounds;
  const x = odd.ports.find(port => port.side === 'bottom')!.anchor!.x;
  const gap = side === 'left' ? pill.x - x : x - pill.x - pill.width;
  expect(gap).toBeGreaterThanOrEqual(1.25 - 1e-6);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});

it('keeps a feeding parent right-side port on its face when the reserved span grows', async () => {
  const document = parse(downward);
  document.groups.destination!.shape = 'row';
  document.nodes.hub!.ports.push({ name: 'spare', ordinal: 1, side: 'right' });
  const model = await layout(document, options);
  expect(model.canvas!.width, JSON.stringify(model.diagnostics.filter(note => note.code.includes('STAGGER')))).toBeLessThanOrEqual(500);
  const hub = model.nodes.hub!;
  expect(hub.ports.find(port => port.side === 'right')!.anchor!.x).toBe(hub.bounds!.x + hub.bounds!.width);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});

it('stops after the widest row when that stagger already meets the budget', async () => {
  const document = parse(source);
  document.layout!.maxWidth = 1800;
  // Ticket 51: without this, stage 5 staggers both rows itself before the search starts. `autoArrange: false` leaves the search its own.
  document.layout!.autoArrange = false;
  const model = await layout(document, options);
  expect(model.canvas!.width).toBeLessThanOrEqual(1800);
  expect(model.staggerRows?.map(row => row.group)).toEqual(['clients']);
  expect(new Set(model.groups.sensors!.nodes.map(id => model.nodes[id]!.bounds!.y)).size).toBe(1);
});

it('leaves a row with mixed exit faces on one line', async () => {
  const document = parse(downward);
  document.layout!.maxWidth = 1;
  document.nodes.b!.ports[0]!.side = 'top';
  const model = await layout(document, options);
  expect(model.staggerRows).toBeUndefined();
  expect(new Set(model.groups.sources!.nodes.map(id => model.nodes[id]!.bounds!.y)).size).toBe(1);
  expect(model.diagnostics.some(note => note.code === 'WIDTH_BUDGET_UNMET')).toBe(true);
});
