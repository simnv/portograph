import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import type { LayoutModel, Rect } from '../../src/model/index.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes, transitTiers } from '../../src/layout/lanes.js';
import { bandEntryConflicts, groupLabelObstacles, routerEntryPoints } from '../../src/layout/bands.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rows } from '../../src/layout/rows.js';
import { rebuildBands, union } from '../../src/layout/skeleton-geometry.js';
import { score } from '../../src/score/index.js';
import { FONT_FAMILY, measureText } from '../../src/text/index.js';
import { placed } from './phase-two-fixture.js';

const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
/** 15 px outward stem plus the routed half stroke and the strict-outside tolerance. */
const ORDINARY_CLEARANCE = 16;

async function throughBundles(yaml: string): Promise<LayoutModel> {
  return bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;
}

/** Independent expectation: a top-side routed port needs its outward reach plus stroke and tolerance. */
function expectedClearance(model: LayoutModel, groupId: string): number {
  const members = new Set(model.groups[groupId]!.nodes);
  const reach = Math.max(0, ...routerEntryPoints(model)
    .filter(entry => entry.side === 'top' && members.has(entry.node)).map(entry => entry.outward));
  return reach > 0 ? Math.max(12, reach + 0.75 + 0.25) : 12;
}

function run(model: LayoutModel): LayoutModel {
  expect('bands' in api).toBe(true);
  return (api as typeof api & { bands: (input: LayoutModel) => LayoutModel }).bands(model);
}

describe('group label bands', () => {
  it('places all six real golden labels left-first with measured final geometry', async () => {
    const before = await throughBundles(golden), model = run(before);
    const groupIds = Object.keys(model.document.groups);

    expect(model.stage).toBe('bands');
    expect(model.obstacles).toEqual([]);
    expect(model.labelBands.map(band => band.id)).toEqual(groupIds.map(id => `label-band:${id}`));
    expect(model.labels.filter(label => label.role === 'group').map(label => label.id))
      .toEqual(groupIds.map(id => `label:group:${id}`));
    for (const id of groupIds) {
      const group = model.groups[id]!, band = model.labelBands.find(item => item.group === id)!;
      const label = model.labels.find(item => item.id === `label:group:${id}`)!;
      const measured = measureText(model.document.groups[id]!.label, { fontSize: 12, weight: 700 });
      expect(band).toEqual({ id: `label-band:${id}`, group: id, owner: group.owner, layer: 'routed',
        bounds: { x: group.bounds!.x, y: group.bounds!.y, width: group.bounds!.width, height: measured.height + 8 },
        clearance: expectedClearance(model, id) });
      expect(label).toMatchObject({ owner: group.owner, layer: 'routed', role: 'group', text: model.document.groups[id]!.label,
        fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: 700, lineHeight: measured.lineHeight,
        lines: measured.lines, textRotation: 0 });
      expect(label.bounds!.y).toBe(group.bounds!.y + 4);
      expect(label.bounds!.x).toBeGreaterThanOrEqual(group.bounds!.x + 8);
      expect(right(label.bounds!)).toBeLessThanOrEqual(right(group.bounds!) - 8 + 1e-6);
      for (const nodeId of group.nodes) expect(model.nodes[nodeId]!.bounds!.y)
        .toBeGreaterThanOrEqual(bottom(band.bounds) + band.clearance - 1e-6);
      expect(Math.min(...group.nodes.map(nodeId => model.nodes[nodeId]!.bounds!.y - bottom(band.bounds))))
        .toBeCloseTo(band.clearance, 9);
    }
    // Only the two groups with top-side routed ports need more than the ordinary padding.
    expect(Object.fromEntries(model.labelBands.map(band => [band.group, band.clearance])))
      .toEqual({ providers: 12, datacenter: ORDINARY_CLEARANCE, 'tbr-left': 12, 'tbr-right': 12,
        'route-reflector': 12, backbone: ORDINARY_CLEARANCE });

    const produced = { ...model, links: model.links.filter(link => link.path !== undefined) };
    const snapshot = score(produced).snapshot;
    expect(produced.links).toHaveLength(24);
    expect(model.links.filter(link => link.path === undefined).map(link => link.id)).toEqual(['link-1', 'link-2']);
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]))
      .toEqual(before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]));
    expect(model.lanes.some((lane, index) => lane.bounds.y !== before.lanes[index]!.bounds.y)).toBe(true);
    expect(model.barDrops.map(drop => [drop.id, drop.owner, drop.barCross]))
      .toEqual(before.barDrops.map(drop => [drop.id, drop.owner, drop.barCross]));
    expect(model.bundles.map(bundle => [bundle.id, bundle.owner, bundle.members, bundle.mergeRuns?.map(run => run.id)]))
      .toEqual(before.bundles.map(bundle => [bundle.id, bundle.owner, bundle.members, bundle.mergeRuns?.map(run => run.id)]));
    expect(model.links.some((link, index) => link.path && JSON.stringify(link.path) !== JSON.stringify(before.links[index]!.path))).toBe(true);
    const barBand = model.labelBands.find(item => item.group === 'backbone')!;
    expect(model.nodes['EBB-01']!.bounds!.y).toBe(bottom(barBand.bounds) + ORDINARY_CLEARANCE);
    expect(snapshot.counters.labelHits).toBe(0);
    expect(snapshot.gates.G3.passed).toBe(true);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('keeps every required router entry point outside the stroke-aware label band obstacles', async () => {
    const model = run(await throughBundles(golden));
    const remainders = model.links.filter(link => !link.path).map(link => link.id);
    expect(remainders).toEqual(['link-1', 'link-2']);

    // The proven conflict: EAC-01/EAC-02 top anchors need a 15 px outward checkpoint.
    const datacenter = model.labelBands.find(band => band.group === 'datacenter')!;
    const entries = routerEntryPoints(model).filter(entry => remainders.includes(entry.link) && entry.side === 'top');
    expect(entries.map(entry => [entry.node, entry.kind, entry.point.y]))
      .toEqual([['EAC-01', 'stem', bottom(datacenter.bounds) + 1], ['EAC-02', 'stem', bottom(datacenter.bounds) + 1]]);
    expect(entries.every(entry => entry.point.y > bottom(datacenter.bounds) + 0.75)).toBe(true);
    expect(bandEntryConflicts(model)).toEqual([]);

    // Publication and restore certify the same reservation, and a route stage cannot relax it.
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(bandEntryConflicts(restored)).toEqual([]);
    const routed = withLayoutMutation(model, 'route', draft => {
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'info', code: 'ROUTE_INFO', message: 'legal' });
    });
    expect(routed.labelBands).toEqual(model.labelBands);
    expect(bandEntryConflicts(routed)).toEqual([]);
  });

  it('widens a blocked group, pushes its neighbour, and recentres the neighbour child through one replay', async () => {
    const yaml = `portograph: 2
groups:
  parents: {tier: 0}
  blocked: {tier: 1, label: A deliberately long reserved group label that cannot fit the initial band}
  neighbour: {tier: 1}
  child-group: {tier: 2}
nodes:
  parent: {group: parents, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  blocked-node: {group: blocked, ports: [{name: p, side: top}, {name: q, side: top}]}
  neighbour-node: {group: neighbour, ports: [{name: p, side: bottom}]}
  child: {group: child-group, ports: [{name: p, side: top}]}
links:
  - [parent.p, blocked-node.p]
  - [parent.q, blocked-node.q]
  - [neighbour-node.p, child.p]`;
    const before = await throughBundles(yaml);
    const blockedWidth = before.groups.blocked!.bounds!.width;
    const neighbourX = before.groups.neighbour!.bounds!.x;
    const childX = before.groups['child-group']!.bounds!.x;
    const laneIdentity = before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]);
    const bundleIds = before.bundles.map(bundle => bundle.id);
    const model = run(before), label = model.labels.find(item => item.id === 'label:group:blocked')!;

    expect(model.groups.blocked!.bounds!.width).toBeGreaterThan(blockedWidth);
    expect(model.groups.neighbour!.bounds!.x).toBeGreaterThan(neighbourX);
    expect(model.groups['child-group']!.bounds!.x).toBeGreaterThan(childX);
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width])).toEqual(laneIdentity);
    expect(model.bundles.map(bundle => bundle.id)).toEqual(bundleIds);
    expect(model.links.filter(link => link.bundle).every(link => link.path?.segments.length)).toBe(true);
    expect(label.bounds!.x).toBeGreaterThan(model.groups.blocked!.bounds!.x + 8);
    const rightmostBlockingPath = Math.max(...model.links.filter(link => link.bundle)
      .flatMap(link => link.path!.segments).filter(segment => segment.from.x === segment.to.x
        && Math.min(segment.from.y, segment.to.y) <= label.bounds!.y
        && Math.max(segment.from.y, segment.to.y) >= bottom(label.bounds!)).map(segment => segment.from.x));
    expect(label.bounds!.x).toBeCloseTo(rightmostBlockingPath + 0.75 + 1e-6, 8);
    expect(model.groups.blocked!.bounds!.width).toBeGreaterThan(label.bounds!.width + 16);
    expect(right(label.bounds!)).toBeLessThanOrEqual(right(model.groups.blocked!.bounds!) - 8 + 1e-6);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('treats the reserved shared runs of a pathless remainder as label obstacles', async () => {
    const yaml = `portograph: 2
groups: {ga: {tier: 1, label: A moderately long label for the shared group}, gb: {tier: 0}}
nodes:
  a: {group: ga, size: {width: 500, height: 50}, ports: [{name: p, side: top}]}
  b: {group: gb, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  c: {group: gb, ports: [{name: p, side: bottom}]}
links: [[a.p, b.p], [a.p, b.q], [a.p, c.p]]`;
    const model = run(await throughBundles(yaml));
    const remainder = model.links.find(link => link.id === 'link-3')!;
    const member = model.links.find(link => link.id === 'link-1')!;
    expect(remainder.path).toBeUndefined();
    expect(remainder.sharedRuns!.from).toHaveLength(3);
    expect(member.path!.segments.slice(0, 3)).toEqual(member.sharedRuns!.from);

    // Every reserved run of the pathless remainder is an obstacle with its own stable ID, while the
    // member's identical copies inside its complete path collapse to the path entries.
    const obstacles = groupLabelObstacles(model);
    expect(obstacles.filter(item => item.id.startsWith('link-3:')).map(item => item.id))
      .toEqual(['link-3:shared:from:0', 'link-3:shared:from:1', 'link-3:shared:from:2']);
    expect(obstacles.filter(item => item.id.startsWith('link-1:')).map(item => item.id))
      .toEqual(['link-1:path:0', 'link-1:path:1', 'link-1:path:2', 'link-1:path:3']);
    for (const [index, segment] of remainder.sharedRuns!.from!.entries()) {
      expect(obstacles.find(item => item.id === `link-3:shared:from:${index}`)!.bounds).toEqual({
        x: Math.min(segment.from.x, segment.to.x) - 0.75, y: Math.min(segment.from.y, segment.to.y) - 0.75,
        width: Math.abs(segment.to.x - segment.from.x) + 1.5, height: Math.abs(segment.to.y - segment.from.y) + 1.5 });
    }
    const label = model.labels.find(item => item.id === 'label:group:ga')!;
    for (const item of obstacles) expect([item.id, overlaps(label.bounds!, item.bounds)]).toEqual([item.id, false]);

    // The three-link fan reaches 67.5 px outward, so the band reserves that plus stroke and tolerance.
    const band = model.labelBands.find(item => item.group === 'ga')!;
    expect(band.clearance).toBe(68.5);
    expect(model.nodes.a!.bounds!.y).toBe(bottom(band.bounds) + 68.5);
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);

    // A forged smaller reservation, even one consistent with the frozen projection, is rejected.
    const shrunk = copy(model);
    for (const bands of [shrunk.labelBands, shrunk.freeze!.placement!.labelBands]) {
      bands.find(item => item.group === 'ga')!.clearance = 12;
    }
    expect(() => restoreLayoutModel(JSON.stringify(shrunk)))
      .toThrow(/Group label bands contradict final group geometry/);

    // The reservation cannot be retired by dropping the runs it was derived from.
    const dropped = copy(model);
    delete dropped.links.find(link => link.id === 'link-3')!.sharedRuns;
    dropped.freeze!.placement!.sharedRuns = dropped.freeze!.placement!.sharedRuns.filter(item => item.link !== 'link-3');
    expect(() => restoreLayoutModel(JSON.stringify(dropped))).toThrow(/Shared runs contradict port incidence/);

    // Deduplication keys ownership by its semantic fields, not by JSON property order.
    const reordered = copy(model);
    for (const link of reordered.links) for (const end of ['from', 'to'] as const) {
      for (const segment of link.sharedRuns?.[end] ?? []) {
        const owner = segment.owner;
        if (owner.kind !== 'barCross') segment.owner = { id: owner.id, kind: owner.kind };
      }
    }
    expect(restoreLayoutModel(JSON.stringify(reordered))).toEqual(model);
    expect(groupLabelObstacles(reordered).map(item => item.id)).toEqual(obstacles.map(item => item.id));
  });

  it('lengthens the reserved checkpoint when a wide node stroke expands its routing obstacle', async () => {
    const yaml = `portograph: 2
groups: {up: {tier: 0}, low: {tier: 1, label: Lower}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`;
    const draft = copy(await placed(yaml));
    draft.nodes.b!.strokeWidth = 20;
    rebuildBands(draft);
    rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
    draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
    const model = run(bundles(bars(centre(flanks(lanes(rows(restoreLayoutModel(JSON.stringify(draft)))))))));

    // 10 + (20 + 1.5) / 2 reaches past the 15 px stem, so the checkpoint and the band both move.
    const band = model.labelBands.find(item => item.group === 'low')!;
    expect(band.clearance).toBe(22);
    expect(model.labelBands.find(item => item.group === 'up')!.clearance).toBe(12);
    expect(model.nodes.b!.bounds!.y).toBe(bottom(band.bounds) + 22);
    const stem = routerEntryPoints(model).find(entry => entry.node === 'b' && entry.kind === 'stem')!;
    expect(stem.outward).toBe(21);
    expect(stem.point.y).toBe(bottom(band.bounds) + 1);
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);

    // The default 16 px reservation is too short here and must not survive restore.
    const short = copy(model);
    for (const bands of [short.labelBands, short.freeze!.placement!.labelBands]) {
      bands.find(item => item.group === 'low')!.clearance = ORDINARY_CLEARANCE;
    }
    expect(() => restoreLayoutModel(JSON.stringify(short)))
      .toThrow(/Group label bands contradict final group geometry/);
  });

  it('stops repeated collision growth at the shared eight-pass bound with coherent claims', async () => {
    const pairs = [0, 1, 2, 3, 4];
    const yaml = `portograph: 2
groups:
${pairs.map(i => `  parents-${i}: {tier: 0}\n  blocked-${i}: {tier: 1, label: A deliberately long reserved group label ${i} that cannot fit the initial band}`).join('\n')}
nodes:
${pairs.map(i => `  parent-${i}: {group: parents-${i}, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}\n  child-${i}: {group: blocked-${i}, ports: [{name: p, side: top}, {name: q, side: top}]}`).join('\n')}
links:
${pairs.flatMap(i => [`  - [parent-${i}.p, child-${i}.p]`, `  - [parent-${i}.q, child-${i}.q]`]).join('\n')}`;
    const before = await throughBundles(yaml);
    expect(before.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);
    const model = run(before);

    // Four collision repairs fit inside the one shared budget; the fifth has no pass left. A fresh
    // budget per replay would have slid all five instead.
    const placedLeftFirst = pairs.filter(i => model.labels.find(item => item.id === `label:group:blocked-${i}`)!.bounds!.x
      > model.groups[`blocked-${i}`]!.bounds!.x + 8 + 1e-6);
    expect(placedLeftFirst).toEqual([0, 1, 2, 3]);
    const stalled = model.labels.find(item => item.id === 'label:group:blocked-4')!;
    expect(stalled.bounds!.x).toBe(model.groups['blocked-4']!.bounds!.x + 8);
    expect(groupLabelObstacles(model).some(item => overlaps(stalled.bounds!, item.bounds))).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([{
      stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE',
      message: 'Group-label growth exhausted the shared eight-pass budget; final gates decide the retained geometry.',
      owners: [{ kind: 'group', id: 'blocked-4' }],
    }]);

    // The diagnosed state still carries one coherent claim set and survives restore.
    expect(model.labelBands.map(band => band.group)).toEqual(Object.keys(model.document.groups));
    expect(model.labels.filter(item => item.role === 'group')).toHaveLength(pairs.length * 2);
    for (const band of model.labelBands) {
      expect(band.clearance).toBe(model.groups[band.group]!.nodes.some(id =>
        model.nodes[id]!.ports.some(port => port.side === 'top')) ? ORDINARY_CLEARANCE : 12);
      for (const nodeId of model.groups[band.group]!.nodes) {
        expect(model.nodes[nodeId]!.bounds!.y).toBeGreaterThanOrEqual(bottom(band.bounds) + band.clearance - 1e-6);
      }
    }
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]))
      .toEqual(before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]));
    expect(model.bundles.map(bundle => bundle.id)).toEqual(before.bundles.map(bundle => bundle.id));
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('bounds label growth for node-free input even when centring has no anchor tier', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {empty: {tier: 0, label: A node-free group label wider than its initial group}}
nodes: {}
links: []`));
    const label = model.labels.find(item => item.role === 'group')!;
    expect(model.groups.empty!.bounds!.width).toBeGreaterThanOrEqual(label.bounds!.width + 16);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);
  });

  it('rejects stale or forged group claims on restore and freezes placement before route output', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`));
    for (const corrupt of [
      (draft: LayoutModel) => { draft.labelBands[0]!.bounds.width++; },
      (draft: LayoutModel) => { draft.labels.find(label => label.role === 'group')!.bounds!.x++; },
      (draft: LayoutModel) => { draft.labels.find(label => label.role === 'group')!.fontWeight = 400; },
      (draft: LayoutModel) => { draft.labelBands.push(copy(draft.labelBands[0]!)); },
      (draft: LayoutModel) => {
        for (const bands of [draft.labelBands, draft.freeze!.placement!.labelBands]) bands[0]!.clearance = 8;
      },
    ]) {
      const draft = copy(model); corrupt(draft);
      expect(() => restoreLayoutModel(JSON.stringify(draft))).toThrow();
    }

    const routed = withLayoutMutation(model, 'route', draft => {
      draft.runtime.totalMs = 12;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'info', code: 'ROUTE_INFO', message: 'legal' });
    });
    expect(routed.runtime.totalMs).toBe(12);
    expect(() => withLayoutMutation(model, 'route', draft => { draft.groups.g!.bounds!.x++; })).toThrow(/cannot change placement/);
  });

  it('rejects callback-authored group claims instead of replacing them silently', async () => {
    const before = await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`);
    expect(() => withLayoutMutation(before, 'bands', draft => {
      draft.labelBands.push({ id: 'forged', group: 'g', owner: draft.groups.g!.owner,
        layer: 'routed', bounds: { ...draft.groups.g!.bounds! }, clearance: 12 });
    })).toThrow(/claim validator/);
    expect(before.labelBands).toEqual([]);
    const legal = withLayoutMutation(before, 'bands', draft => {
      draft.runtime.totalMs = 4;
      draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'BANDS_INFO', message: 'legal' });
    });
    expect(legal.runtime.totalMs).toBe(4);
    expect(legal.diagnostics.some(item => item.code === 'BANDS_INFO')).toBe(true);
  });

  it('restores structurally equal claims regardless of JSON object key order', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`));
    const draft = copy(model), band = draft.labelBands[0]!, label = draft.labels.find(item => item.role === 'group')!;
    draft.labelBands[0] = { clearance: band.clearance, layer: band.layer, bounds: { height: band.bounds.height,
      width: band.bounds.width, y: band.bounds.y, x: band.bounds.x }, owner: band.owner, group: band.group, id: band.id };
    const index = draft.labels.indexOf(label);
    draft.labels[index] = { bounds: label.bounds!, textRotation: label.textRotation!, lines: label.lines!,
      lineHeight: label.lineHeight!, fontWeight: label.fontWeight!, fontSize: label.fontSize!,
      fontFamily: label.fontFamily!, text: label.text, role: label.role!, layer: label.layer,
      owner: label.owner, id: label.id };
    expect(() => restoreLayoutModel(JSON.stringify(draft))).not.toThrow();
  });
});

describe('derived containing-box tolerance', () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1, shape: bar}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [b.q, a.p]]`;

  it('keeps exact adjacent-tier bounds when lane allocation only adds its region', async () => {
    const before = rows(await placed(yaml)), after = lanes(before);
    expect(after.stage).toBe('lanes');
    expect(after.links.every(link => transitTiers(after, link).length === 0)).toBe(true);
    expect(after.lanes).toEqual([]);
    expect(after.links.every(link => link.fixedSegments === undefined)).toBe(true);
    expect(Object.fromEntries(Object.entries(after.groups).map(([id, group]) => [id, group.bounds])))
      .toEqual(Object.fromEntries(Object.entries(before.groups).map(([id, group]) => [id, group.bounds])));
    expect(Object.fromEntries(Object.entries(after.nodes).map(([id, node]) => [id, node.bounds])))
      .toEqual(Object.fromEntries(Object.entries(before.nodes).map(([id, node]) => [id, node.bounds])));
    expect(after.regions.map(region => region.id)).toContain('tiers:0:1');
  });

  it('still rejects a one-pixel lane-stage translation on a tier with no transit', async () => {
    const before = rows(await placed(yaml));
    expect(() => withLayoutMutation(before, 'lanes', draft => {
      draft.groups.gb!.bounds!.x += 1;
      draft.nodes.b!.bounds!.x += 1;
      for (const port of draft.nodes.b!.ports) port.anchor!.x += 1;
    })).toThrow(/Lanes may expand only occupied intermediate tiers/);
  });
});
