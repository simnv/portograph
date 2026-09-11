import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import type { LayoutModel } from '../../src/model/index.js';
import { rows } from '../../src/layout/rows.js';
import { lanes } from '../../src/layout/lanes.js';
import { flanks } from '../../src/layout/flanks.js';
import { centre } from '../../src/layout/centre.js';
import { bars } from '../../src/layout/bars.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { score } from '../../src/score/index.js';
import { intersection, samePoint } from '../../src/score/geometry.js';
import { placed } from './phase-two-fixture.js';

export const throughBars = async (yaml: string): Promise<LayoutModel> => bars(centre(flanks(lanes(rows(await placed(yaml))))));
const run = (model: LayoutModel): LayoutModel => {
  expect('bundles' in api).toBe(true);
  return (api as typeof api & { bundles: (m: LayoutModel) => LayoutModel }).bundles(model);
};
export function strictCrossings(model: LayoutModel): number {
  const points = new Set<string>();
  for (let i = 0; i < model.links.length; i++) for (const b of model.links.slice(i + 1)) {
    const a = model.links[i]!;
    if (!a.bundle || a.bundle !== b.bundle) continue;
    for (const x of a.path!.segments) for (const y of b.path!.segments) {
      const p = intersection(x, y);
      if (p && ![x.from, x.to, y.from, y.to].some(end => samePoint(end, p))) points.add(JSON.stringify([a.id, b.id, p]));
    }
  }
  return points.size;
}
export const reversed = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}, {name: r, side: bottom, order: 2}]}
  b: {group: gb, ports: [{name: p, side: top, order: 2}, {name: q, side: top, order: 1}, {name: r, side: top, order: 0}]}
links: [[a.p, b.p], [b.q, a.q], [a.r, b.r]]`;

describe('bundle stage', () => {
  it('creates the real golden bundle paths only at stage 11, with stroke-aware straight blocks', async () => {
    const before = await throughBars(readFileSync('goldens/m1-sip-edge.yaml', 'utf8'));
    expect(before.bundles.map(b => b.members.length).sort()).toEqual([2, 4, 4, 4, 4]);
    expect(before.links.filter(l => l.bundle).every(l => !l.path)).toBe(true);
    const model = run(before), subset = { ...model, links: model.links.filter(l => l.path) };
    expect(model.stage).toBe('bundles');
    expect(model.links.filter(l => l.bundle).every(l => l.path?.segments.length === 1)).toBe(true);
    expect(model.bundles.every(b => b.memberGap === 16 && b.memberPitch! >= 17.5 && b.inversions === 0)).toBe(true);
    expect(strictCrossings({ ...model, links: model.links.filter(l => l.bundle) })).toBe(0);
    for (const gate of ['G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(subset).snapshot.gates[gate], gate).toMatchObject({ passed: true });
    expect(score(subset).snapshot.metrics.crossings.count).toBe(0);
    expect(model.lanes.map(l => [l.id, l.x, l.owner])).toEqual(before.lanes.map(l => [l.id, l.x, l.owner]));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    expect(() => score(model)).toThrow('requires final path');
  });
  for (const count of [2, 4]) it(`creates an explicit ${count}-member comb at a shared port`, async () => {
    const names = Array.from({ length: count }, (_, i) => `p${i}`);
    const yaml = `portograph: 2\ngroups: {ga: {tier: 0}, gb: {tier: 1}}\nnodes:\n  a: {group: ga, ports: [{name: p, side: bottom}]}\n  b: {group: gb, ports: [${names.map(name => `{name: ${name}, side: top}`).join(', ')}]}\nlinks: [${names.map((name, i) => i % 2 ? `[b.${name}, a.p]` : `[a.p, b.${name}]`).join(', ')}]`;
    const model = run(await throughBars(yaml));
    expect(model.junctions).toHaveLength(count - 1);
    expect(model.junctions[0]!.links).toHaveLength(count);
    expect(model.junctions.slice(1).every(j => j.parent)).toBe(true);
    expect(strictCrossings(model)).toBe(0);
    for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });
  it('draws exactly three isolated crossings for reversed author order and mixed authored directions', async () => {
    const before = await throughBars(reversed), model = run(before);
    expect(model.bundles[0]!.inversions).toBe(3);
    expect(strictCrossings(model)).toBe(3);
    const scored = score(model);
    for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(scored.snapshot.gates[gate], gate).toMatchObject({ passed: true });
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    expect(before.links.every(l => !l.path)).toBe(true);
  });
});

it('merges only selected members and publishes exact shared-run counts for labels and rendering', async () => {
  const yaml = reversed.replaceAll('order: 2}', 'order: 0}').replaceAll('order: 1}', 'order: 0}')
    .replace('links: [[a.p, b.p], [b.q, a.q], [a.r, b.r]]', 'links: [{from: a.p, to: b.p, route: merge}, {from: b.q, to: a.q, route: merge}, [a.r, b.r]]');
  const model = run(await throughBars(yaml)), bundle = model.bundles[0]!;
  expect(bundle.mergeRuns?.length).toBeGreaterThan(0);
  expect(bundle.mergeRuns!.every(r => r.count === 2 && r.members.length === 2 && !r.members.includes(model.links[2]!.id))).toBe(true);
  expect(score(model).snapshot.gates.G4).toMatchObject({ passed: true });
  expect(score(model).snapshot.gates.G6).toMatchObject({ passed: true });
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  expect(model.labels.every(label => label.role !== 'link')).toBe(true);
});

it('consumes final lane/bar hints and preserves every barCross owner', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gb: {tier: 2, shape: bar}}
nodes:
  a: {group: ga, size: {width: 240, height: 50}, ports: [{name: p, side: bottom}, {name: q, side: bottom}, {name: u, side: bottom}]}
  m: {group: gm}
  upper: {group: gb, label: A deliberately wide upper bar, ports: [{name: up, side: top}], size: {width: 400, height: 35}}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [a.q, b.q], [a.u, upper.up]]`;
  const before = await throughBars(yaml), model = run(before);
  expect(model.lanes.map(l => [l.id, l.owner, l.x])).toEqual(before.lanes.map(l => [l.id, l.owner, l.x]));
  for (const lane of model.lanes) expect(model.links.find(l => l.id === (lane.owner as { id: string }).id)!.path!.segments.some(s => s.lane === lane.id && s.from.x === lane.x)).toBe(true);
  expect(model.barDrops.map(d => d.owner)).toEqual(before.barDrops.map(d => d.owner));

  expect(model.links.filter(l => l.bundle).every(l => l.path!.segments.some(s => s.barCross?.includes('upper')))).toBe(true);

  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('counts the true one-crossing minimum of a shared-port K2,2', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [a.p, b.q], [a.q, b.p], [a.q, b.q]]`;
  const model = run(await throughBars(yaml));
  expect(model.bundles[0]!.inversions).toBe(1);
  expect(api.optimizeBundleOrder(model, model.bundles[0]!)).toMatchObject({ inversions: 1, proved: true, examined: 4 });
  expect(api.optimizeBundleOrder(model, model.bundles[0]!, 1)).toMatchObject({ inversions: 1, proved: false, examined: 1 });
  expect(strictCrossings(model)).toBe(1);
  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
});

it('shares one port across two bundles and gives the pathless remainder its exact shared-run handoff', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  d: {group: gb, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [b.q, a.p], [a.p, c.p], [c.q, a.p], [a.p, d.p]]`;
  const model = run(await throughBars(yaml));
  const roots = model.junctions.filter(j => j.port.node === 'a' && !j.parent);
  expect(roots).toHaveLength(1);
  expect(roots[0]!.links).toHaveLength(5);
  expect(model.links.at(-1)!.sharedRuns?.from?.length).toBeGreaterThan(0);
  expect(model.links.at(-1)!.path).toBeUndefined();
  const completed = structuredClone(model), remainder = completed.links.at(-1)!;
  const runs = remainder.sharedRuns!.from!, target = completed.nodes.d!.ports[0]!.anchor!;
  remainder.path = { owner: remainder.owner, layer: 'routed', fixed: false, segments: [...runs, { from: runs.at(-1)!.to, to: target, owner: remainder.owner }] };

  for (const gate of ['G4', 'G5', 'G6', 'G7'] as const) expect(score(completed).snapshot.gates[gate], gate).toMatchObject({ passed: true });
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('replays growth with one shared budget and replaces claims without moving fixed lanes', async () => {
  const model = run(await throughBars(readFileSync('goldens/m1-sip-edge.yaml', 'utf8')));
  const draft = structuredClone(model), budget = api.createCentreBudget();
  api.rebuildRegionGeometry(draft, budget);
  const first = structuredClone(draft);
  api.rebuildRegionGeometry(draft, budget);
  expect(draft).toEqual(first);
  expect(draft.lanes.map(l => [l.id, l.owner, l.x])).toEqual(model.lanes.map(l => [l.id, l.owner, l.x]));
  expect(budget.passes).toBeLessThanOrEqual(8);
  expect(restoreLayoutModel(JSON.stringify(draft))).toEqual(draft);
  const moved = api.bands(model);
  expect(moved.stage).toBe('bands');
  expect(moved.lanes.map(l => [l.id, l.owner, l.x])).toEqual(model.lanes.map(l => [l.id, l.owner, l.x]));
  expect(moved.bundles.map(bundle => bundle.id)).toEqual(model.bundles.map(bundle => bundle.id));
  expect(restoreLayoutModel(JSON.stringify(moved))).toEqual(moved);
});

it('rejects stale paths, forged shared runs and merge counts during restore', async () => {
  const model = run(await throughBars(reversed));
  for (const corrupt of [
    (m: LayoutModel) => { m.links[0]!.path!.segments[0]!.from.x++; },
    (m: LayoutModel) => { m.bundles[0]!.inversions = 0; },
    (m: LayoutModel) => { m.bundles[0]!.memberGap = 0; },
    (m: LayoutModel) => { m.bundles[0]!.envelope!.width++; },
    (m: LayoutModel) => { m.bundles[0]!.mergeRuns = [{ id: 'forged', count: 2, members: m.bundles[0]!.members.slice(0, 2), path: m.links[0]!.path! }]; },
    (m: LayoutModel) => { m.links[0]!.sharedRuns = { from: m.links[0]!.path!.segments }; },
  ]) {
    const invalid = structuredClone(model); corrupt(invalid);
    expect(() => restoreLayoutModel(JSON.stringify(invalid))).toThrow();
  }
});

it('warns for a singleton selected merge member without recruiting parallel members or inventing a count', async () => {
  const yaml = reversed.replace('links: [[a.p, b.p], [b.q, a.q], [a.r, b.r]]', 'links: [{from: a.p, to: b.p, route: merge}, [b.q, a.q], [a.r, b.r]]');
  const model = run(await throughBars(yaml));
  expect(model.links[0]!.technique).toBe('merge');
  expect(model.bundles[0]!.mergeRuns).toBeUndefined();
  expect(model.diagnostics.some(d => d.code === 'MERGE_SINGLE_MEMBER')).toBe(true);
  expect(strictCrossings(model)).toBe(3);
});

it('merges in reserved free space before distinct immutable member lanes', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gb: {tier: 2}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  m: {group: gm}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [{from: a.p, to: b.p, route: merge}, {from: b.q, to: a.q, route: merge}]`;
  const before = await throughBars(yaml), model = run(before);
  expect(model.bundles[0]!.mergeRuns?.length).toBeGreaterThan(0);
  expect(model.lanes.map(l => [l.id, l.owner, l.x])).toEqual(before.lanes.map(l => [l.id, l.owner, l.x]));
  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('rejects contradictory fixed lane order before committing any member geometry', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gb: {tier: 2}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}]}
  m: {group: gm}
  b: {group: gb, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 1}]}
links: [[a.p, b.p], [a.q, b.q]]`;
  const before = await throughBars(yaml), adapter = structuredClone(before);
  const [first, second] = adapter.lanes;
  [first!.x, second!.x] = [second!.x, first!.x];
  [first!.bounds.x, second!.bounds.x] = [second!.bounds.x, first!.bounds.x];
  const frozen = restoreLayoutModel(JSON.stringify(adapter));
  expect(() => run(frozen)).toThrow('BUNDLE_RESERVATION_ORDER_CONFLICT');
  expect(frozen.links.every(l => !l.path)).toBe(true);
});

it('keeps shared-port junction ownership when selected members also merge', async () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [{from: a.p, to: b.p, route: merge}, {from: b.q, to: a.p, route: merge}]`;
  const model = run(await throughBars(yaml));
  expect(model.bundles[0]!.mergeRuns?.length).toBeGreaterThan(0);
  expect(model.junctions).toHaveLength(1);
  expect(model.links[0]!.path!.segments[0]!.owner).toEqual(model.junctions[0]!.owner);
  expect(model.links[1]!.path!.segments.at(-1)!.owner).toEqual(model.junctions[0]!.owner);
  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('reserves horizontal crossover length before drawing an authored permutation', async () => {
  const yaml = reversed.replace('gb: {tier: 1}', 'gb: {tier: 0}').replaceAll('side: bottom', 'side: right').replaceAll('side: top', 'side: left');
  const model = run(await throughBars(yaml));
  expect(strictCrossings(model)).toBe(3);
  for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
});
