import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton, buildSkeletonGraph, validateSkeletonBands } from '../../src/layout/skeleton.js';
import { createWorkerElkAttempt, ElkDeadlineError, type ElkWorker } from '../../src/layout/elk-worker.js';
const require = createRequire(import.meta.url);
afterEach(() => { vi.useRealTimers(); });
const Worker = require('web-worker') as new (url: string) => ElkWorker;
const createAttempt = () => createWorkerElkAttempt(new Worker(require.resolve('elkjs/lib/elk-worker.min.js')));
const sized = (yaml: string) => sizeNodes(sidesOne(resolve(parse(yaml))));
const golden = () => sized(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8'));
const simple = () => sized(`portograph: 2
groups: {a: {tier: 0}, b: {tier: 1}, empty: {tier: 2}}
nodes: {n: {group: a}, m: {group: b}}
links: [[n, m]]`);

describe('stage 4 skeleton', () => {
  it('withholds lateral links and supplies string-valued options and size floors', () => {
    const model = golden();
    const graph = buildSkeletonGraph(model);
    expect(graph.children?.map(child => child.id)).not.toContain('group:tbr-left');
    expect(graph.edges).toHaveLength(10);
    expect(graph.layoutOptions?.['elk.partitioning.activate']).toBe('true');
    expect(model.groups['tbr-left']?.flank?.proxyPeer).toBe('EAC-01');
    expect(model.groups['tbr-right']?.flank?.proxyPeer).toBe('EAC-02');
  });
  it('lays out the golden, stores primary peers at outer ends, and preserves topology', async () => {
    const model = golden();
    const topology = Object.values(model.nodes).map(node => node.ports.map(port => [port.ref, port.side, port.authorOrder]));
    await skeleton(model, { createAttempt });
    expect(model.stage).toBe('skeleton');
    expect(validateSkeletonBands(model)).toEqual([]);
    expect(model.groups['tbr-left']?.flank?.primaryPeer).toBe('EAC-01');
    expect(model.groups['tbr-right']?.flank?.primaryPeer).toBe('EAC-02');
    expect(model.groups.datacenter?.rowOrder?.[0]).toBe('EAC-01');
    expect(model.groups.datacenter?.rowOrder?.at(-1)).toBe('EAC-02');
    expect({ groups: Object.values(model.groups).map(({ id, bounds, rowOrder, flank }) => ({ id, bounds, rowOrder, flank })),
      nodes: Object.values(model.nodes).map(({ id, bounds }) => ({ id, bounds })), tierBands: model.tierBands }).toMatchSnapshot();
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    expect(Object.values(model.nodes).map(node => node.ports.map(port => [port.ref, port.side, port.authorOrder]))).toEqual(topology);
    for (const node of Object.values(model.nodes)) {
      expect(node.bounds!.width).toBeGreaterThanOrEqual(node.sizeFloor!.width);
      expect(node.bounds!.height).toBeGreaterThanOrEqual(node.sizeFloor!.height);
    }
  });
  it('falls back once per band after exception and includes empty bands', async () => {
    let attempts = 0;
    const model = simple();
    await skeleton(model, { createAttempt: () => ++attempts === 1
      ? { layout: () => Promise.reject(new Error('injected')), terminateWorker() {} } : createAttempt() });
    expect(attempts).toBe(4);
    expect(model.fallbackUsed).toBe(true);
    expect(model.deadlineHit).not.toBe(true);
    expect(validateSkeletonBands(model)).toEqual([]);
  });
  it('ends the command after an injected 25-second stall, with no fallback, without waiting in real time (ticket 141)', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const terminated = vi.fn();
      const factory = () => {
        attempts++;
        return { layout: (graph: ElkNode) => new Promise<ElkNode>(resolve => setTimeout(() => resolve(graph), 25000)), terminateWorker: terminated };
      };
      const model = simple();
      const promise = skeleton(model, { createAttempt: factory });
      const settled = expect(promise).rejects.toBeInstanceOf(ElkDeadlineError);
      await vi.advanceTimersByTimeAsync(10001);
      await settled;
      expect(attempts).toBe(1);
      expect(model.deadlineHit).toBe(true);
      expect(model.fallbackUsed).not.toBe(true);
      expect(terminated).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('rejects successful but invalid partitions and validates fallback output', async () => {
    let attempts = 0;
    const model = simple();
    await skeleton(model, { createAttempt: () => ++attempts === 1
      ? { layout: async graph => positioned(graph), terminateWorker() {} } : createAttempt() });
    expect(model.fallbackUsed).toBe(true);
    expect(validateSkeletonBands(model)).toEqual([]);
    expect(model.diagnostics.some(item => item.code === 'ELK_INVALID_PARTITIONS')).toBe(true);
  });
  it('fails hard if a fallback band is invalid', async () => {
    await expect(skeleton(simple(), { createAttempt: () => ({ layout: async graph => graph, terminateWorker() {} }) })).rejects.toThrow();
  });
});

function positioned(graph: ElkNode): ElkNode {
  const copy = structuredClone(graph);
  const visit = (node: ElkNode, index: number) => {
    node.x = index * 200; node.y = 0; node.width = 150; node.height = 150;
    for (const [i, child] of (node.children ?? []).entries()) visit(child, i);
  };
  visit(copy, 0);
  return copy;
}

describe('flank ordering', () => {
  it('SIMPLE changes compound node placement enough to preserve the golden right proxy', async () => {
    const graph = buildSkeletonGraph(golden());
    const baseline = structuredClone(graph);
    for (const group of baseline.children ?? []) delete group.layoutOptions?.['elk.layered.nodePlacement.strategy'];
    const layout = async (g: ElkNode) => { const attempt = createAttempt(); try { return await attempt.layout(g); } finally { attempt.terminateWorker(); } };
    const before = await layout(baseline), after = await layout(graph);
    const right = (g: ElkNode, id: string) => { const node = g.children!.find(group => group.id === 'group:datacenter')!.children!.find(node => node.id === `node:${id}`)!; return node.x! + node.width!; };
    expect(right(before, 'EBR-02')).toBeGreaterThan(right(before, 'EAC-02'));
    expect(right(after, 'EAC-02')).toBeGreaterThan(right(after, 'EBR-02'));
  });
  it('selects a different final peer and moves it beyond a non-peer while preserving other row order', async () => {
    const model = sized(`portograph: 2
groups: {g: {tier: 0}, f: {align: right, of: g}}
nodes: {a: {group: g}, b: {group: g}, c: {group: g}, fn: {group: f}}
links: [[fn, a], [fn, b]]`);
    await skeleton(model, { createAttempt: () => ({
      async layout(graph) {
        const output = structuredClone(graph), group = output.children![0]!;
        Object.assign(group, { x: 0, y: 0, width: 400, height: 150 });
        for (const node of group.children!) Object.assign(node, { x: { 'node:a': 150, 'node:b': 70, 'node:c': 250 }[node.id], y: 20 });
        return output;
      }, terminateWorker() {},
    }) });
    expect(model.groups.f!.flank).toMatchObject({ proxyPeer: 'b', primaryPeer: 'a' });
    expect(model.groups.g!.rowOrder).toEqual(['b', 'c', 'a']);
    expect(model.nodes.a!.bounds!.x).toBeGreaterThan(model.nodes.c!.bounds!.x);
    expect(validateSkeletonBands(model)).toEqual([]);
  });
  it('preserves valid fallback band geometry while stacking mixed groups and a tall flank', async () => {
    const model = sized(`portograph: 2
groups: {a: {tier: 0}, b: {tier: 0}, empty: {tier: 1}, c: {tier: 2}, f: {align: left, of: a}}
nodes: {na: {group: a}, nb: {group: b}, nc: {group: c}, nf: {group: f, size: {height: 400, width: 50}}}
links: [[nf, na], [na, nc]]`);
    let attempts = 0;
    await skeleton(model, { createAttempt: () => ++attempts === 1 ? { layout: async () => { throw new Error('injected'); }, terminateWorker() {} } : createAttempt() });
    expect(validateSkeletonBands(model)).toEqual([]);
    expect(model.groups.f!.bounds!.y).toBe(model.tierBands[0]!.bounds!.y);
    expect(model.tierBands[1]!.bounds!.y).toBeGreaterThan(model.tierBands[0]!.bounds!.y + model.tierBands[0]!.bounds!.height);
    expect(model.groups.b!.bounds!.x).toBeGreaterThan(model.groups.a!.bounds!.x);
  });
});

describe('tier contract at scale', () => {
  for (const count of [100, 300, 1000]) for (const failFirst of [false, true]) {
    it(`${count} nodes, ${failFirst ? 'injected fallback' : 'partitioning attempted'}`, async () => {
      const nodes = Array.from({ length: count }, (_, i) => `n${i}: {group: g${i % 3}}`).join(', ');
      const model = sized(`portograph: 2\ngroups: {g0: {tier: 0}, g1: {tier: 1}, g2: {tier: 2}}\nnodes: {${nodes}}\nlinks: [[n0, n1], [n1, n2]]`);
      let attempts = 0;
      await skeleton(model, { createAttempt: () => {
        if (++attempts === 1 && failFirst) return { layout: async () => { throw new Error('injected'); }, terminateWorker() {} };
        return createAttempt();
      } });
      expect(validateSkeletonBands(model)).toEqual([]);
      expect(Object.values(model.nodes).every(node => node.bounds !== undefined)).toBe(true);
      expect(model.tierBands.map(band => band.tier)).toEqual([0, 1, 2]);
      if (failFirst) expect(model.fallbackUsed).toBe(true);
    }, 15000);
  }
});

describe('empty input and golden fallback', () => {
  it('keeps an empty document canvas finite and positive', async () => {
    const model = sized('portograph: 2\ngroups: {}\nnodes: {}\nlinks: []');
    await skeleton(model, { createAttempt });
    expect(model.canvas!.width).toBeGreaterThan(0);
    expect(model.canvas!.height).toBeGreaterThan(0);
    expect(validateSkeletonBands(model)).toEqual([]);
  });
  it('keeps golden primary peers and bands after an exception fallback', async () => {
    let attempts = 0;
    const model = golden();
    await skeleton(model, { createAttempt: () => ++attempts === 1
      ? { layout: async () => { throw new Error('injected'); }, terminateWorker() {} } : createAttempt() });
    expect(model.groups['tbr-left']!.flank!.primaryPeer).toBe('EAC-01');
    expect(model.groups['tbr-right']!.flank!.primaryPeer).toBe('EAC-02');
    expect(validateSkeletonBands(model)).toEqual([]);
  });
});

it('includes participating node strokes when stacking tier bands', async () => {
  const model = simple();
  model.nodes.n!.strokeWidth = 200; model.nodes.m!.strokeWidth = 200;
  await skeleton(model, { createAttempt });
  const upper = model.nodes.n!.bounds!, lower = model.nodes.m!.bounds!;
  expect(lower.y - upper.y - upper.height - 200).toBeGreaterThanOrEqual(20);
});

describe('opposite flanks sharing a primary', () => {
  for (const firstSide of ['left', 'right'] as const) for (const fallback of [false, true]) {
    it(`keeps the ${firstSide} flank's first-declared outer position with ${fallback ? 'fallback' : 'normal ELK'}`, async () => {
      const otherSide = firstSide === 'left' ? 'right' : 'left';
      const model = sized(`portograph: 2
groups: {g: {tier: 0}, ${firstSide}: {align: ${firstSide}, of: g}, ${otherSide}: {align: ${otherSide}, of: g}}
nodes: {a: {group: g}, b: {group: g}, l: {group: left}, r: {group: right}}
links: [[l, a], [r, a]]`);
      let attempts = 0;
      await skeleton(model, { createAttempt: () => ++attempts === 1 && fallback
        ? { layout: async () => { throw new Error('injected'); }, terminateWorker() {} } : createAttempt() });
      expect(model.groups.left!.flank!.primaryPeer).toBe('a');
      expect(model.groups.right!.flank!.primaryPeer).toBe('a');
      expect(model.groups.g!.rowOrder).toEqual(firstSide === 'left' ? ['a', 'b'] : ['b', 'a']);
      const warnings = model.diagnostics.filter(item => item.code === 'FLANK_PRIMARY_CONFLICT');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ stage: 'placement', severity: 'warning', owners: [
        { kind: 'group', id: firstSide }, { kind: 'group', id: otherSide }, { kind: 'node', id: 'a' },
      ] });
      expect(warnings[0]!.message).toContain(`${firstSide} keeps`);
      expect(validateSkeletonBands(model)).toEqual([]);
      expect(model.links.every(link => link.path === undefined)).toBe(true);
    });
  }
  it('uses authored group order for integer-like flank IDs', async () => {
    const model = sized(`portograph: 2
groups: {g: {tier: 0}, "2": {align: left, of: g}, "1": {align: right, of: g}}
nodes: {a: {group: g}, b: {group: g}, l: {group: "2"}, r: {group: "1"}}
links: [[l, a], [r, a]]`);
    await skeleton(model, { createAttempt });
    expect(model.groups.g!.rowOrder).toEqual(['a', 'b']);
    expect(model.diagnostics.find(item => item.code === 'FLANK_PRIMARY_CONFLICT')?.owners?.[0]).toEqual({ kind: 'group', id: '2' });
  });
  for (const fallback of [false, true]) it(`does not warn when a single-node row satisfies both flanks, fallback=${fallback}`, async () => {
    const model = sized(`portograph: 2
groups: {g: {tier: 0}, left: {align: left, of: g}, right: {align: right, of: g}}
nodes: {a: {group: g}, l: {group: left}, r: {group: right}}
links: [[l, a], [r, a]]`);
    let attempts = 0;
    await skeleton(model, { createAttempt: () => ++attempts === 1 && fallback
      ? { layout: async () => { throw new Error('injected'); }, terminateWorker() {} } : createAttempt() });
    expect(model.groups.g!.rowOrder).toEqual(['a']);
    expect(model.groups.left!.flank!.primaryPeer).toBe('a');
    expect(model.groups.right!.flank!.primaryPeer).toBe('a');
    expect(model.diagnostics.some(item => item.code === 'FLANK_PRIMARY_CONFLICT')).toBe(false);
    expect(validateSkeletonBands(model)).toEqual([]);
  });
});
