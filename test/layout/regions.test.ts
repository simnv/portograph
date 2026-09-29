import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { LayoutModel } from '../../src/model/layout.js';
import { rows } from '../../src/layout/rows.js';
import { lanes, laneWidth, validateLanes } from '../../src/layout/lanes.js';
import { flanks, flankPair, flankPathCandidate } from '../../src/layout/flanks.js';
import { centre, centreDraft, createCentreBudget, selectAnchorTier } from '../../src/layout/centre.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { bands } from '../../src/layout/bands.js';
import { batchRequest, planRoute } from '../../src/route/plan.js';
import { route } from '../../src/route/index.js';
import { score } from '../../src/score/index.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { right } from '../../src/layout/regions.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { stemPlan } from '../../src/layout/sides-two.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { ALIGNMENT_MAX_GROWTH, ownSideWidth, sizeNodes } from '../../src/layout/size.js';
import { rebuildBands, moveGroup, union } from '../../src/layout/skeleton-geometry.js';
import { rebuildRegionGeometry } from '../../src/layout/region-rebuild.js';
import { findPort } from '../../src/layout/row-paths.js';
import { placed } from './phase-two-fixture.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
function stageInput(model: LayoutModel, edit: (draft: LayoutModel) => void): LayoutModel {
  const draft = copy(model); edit(draft);
  rebuildBands(draft); rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
  draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
  return restoreLayoutModel(JSON.stringify(draft));
}
function ends(model: LayoutModel, index = 0) {
  const link = model.links[index]!;
  return { link, from: findPort(model, link.attachments!.from)!, to: findPort(model, link.attachments!.to)! };
}
const three = `portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: mid}
  c: {group: down, ports: [{name: p, side: top}]}
links: [[a.p, c.p]]`;
const lateral = `portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: left}]}
  b: {group: f, ports: [{name: p, side: right}]}
links: [[b.p, a.p]]`;

describe('real golden region stages', () => {
  it('retains topology, aligns eight primary members, and reserves four EBR-to-bar transits', async () => {
    const input = rows(await placed(golden)), allocated = lanes(input), aligned = flanks(allocated), model = centre(aligned);
    expect(Object.keys(model.nodes)).toHaveLength(12); expect(model.links).toHaveLength(26);
    expect(Object.values(model.nodes).flatMap(node => node.ports)).toHaveLength(52);
    const beforePairs = input.links.map(link => flankPair(input, link)).filter(pair => pair !== undefined);
    expect(beforePairs.filter(pair => pair.group.id === 'tbr-left').map(pair => pair.own.engineOrder)).toEqual([0, 2, 4, 6]);
    expect(beforePairs.filter(pair => pair.group.id === 'tbr-right').map(pair => pair.own.engineOrder)).toEqual([6, 4, 3, 1]);
    for (const id of ['TBR-001', 'TBR-002']) {
      const primaryPorts = new Set(beforePairs.filter(pair => pair.own.ref.node === id).map(pair => pair.own.ref.ordinal));
      const otherOrder = (m: LayoutModel) => [...m.nodes[id]!.ports].filter(port => !primaryPorts.has(port.ref.ordinal)).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref);
      expect(otherOrder(model)).toEqual(otherOrder(input));
    }
    const flankLinks = model.links.filter(link => [link.attachments!.from.node, link.attachments!.to.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank));
    expect(flankLinks).toHaveLength(16);
    const primary = model.links.map(link => flankPair(model, link)).filter(pair => pair !== undefined);
    expect(primary).toHaveLength(8);
    for (const pair of primary) expect(pair.own.anchor!.y).toBe(pair.peer.anchor!.y);
    expect(model.lanes).toHaveLength(4);
    for (const lane of model.lanes) {
      expect(lane.tier).toBe(2); expect(lane.group).toBe('route-reflector');
      const link = model.links.find(link => link.owner.kind === 'link' && link.owner.id === (lane.owner as { id: string }).id)!;
      expect(link.attachments!.from.node).toMatch(/^EBR/); expect(model.document.nodes[link.attachments!.to.node]!.group).toBe('backbone');
    }
    for (const link of model.links.filter(link => link.bundle)) { expect(link.path).toBeUndefined(); expect(link.fixedSegments).toBeUndefined(); }
    expect(model.links.some(link => /^EBR/.test(link.attachments!.from.node) && /^RR/.test(link.attachments!.to.node))).toBe(false);
    expect(model.anchorTier).toBe(1);
    expect(model.lanes.map(lane => [lane.id, lane.x, lane.owner])).toEqual(allocated.lanes.map(lane => [lane.id, lane.x, lane.owner]));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });
});

describe('owned lanes and partial reservations', () => {
  it('reserves non-bundle source-to-target runs and rejects corrupt restored claims', async () => {
    const model = lanes(rows(await placed(three)));
    const { link } = ends(model);
    expect(model.lanes).toHaveLength(1); expect(link.path).toBeUndefined(); expect(link.fixedSegments).toHaveLength(1);
    expect(link.fixedSegments![0]!.from.y).toBeLessThan(link.fixedSegments![0]!.to.y);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const corruptions: ((m: LayoutModel) => void)[] = [
      m => { m.lanes[0]!.owner = { kind: 'node', id: 'a' }; },
      m => { m.lanes[0]!.id = 'forged'; },
      m => { m.lanes[0]!.bounds.width = 1; },
      m => { m.links[0]!.fixedSegments![0]!.owner = { kind: 'link', id: 'other' }; },
      m => { m.links[0]!.fixedSegments![0]!.lane = 'other'; },
      m => { const run = m.links[0]!.fixedSegments![0]!; [run.from, run.to] = [run.to, run.from]; },
      m => { delete m.links[0]!.fixedSegments; },
      m => { m.links[0]!.fixedSegments!.push(m.links[0]!.fixedSegments![0]!); },
      m => { m.regions[0]!.bounds!.width += 1; },
    ];
    for (const corrupt of corruptions) { const draft = copy(model); corrupt(draft); expect(() => restoreLayoutModel(JSON.stringify(draft))).toThrow(); }
    expect(() => withLayoutMutation(model, 'flanks', draft => { draft.lanes[0]!.x++; })).toThrow(/Established lane/);
    expect(() => withLayoutMutation(model, 'flanks', draft => { draft.links[0]!.fixedSegments![0]!.to.y++; })).toThrow(/fixed segments/);
  });
  it('orders upward reservations through two intermediate tiers and keeps bundle runs absent', async () => {
    const yaml = three.replace('down: {tier: 2}', 'extra: {tier: 2}, down: {tier: 3}').replace('  c:', '  d: {group: extra}\n  c:').replace('[[a.p, c.p]]', '[[c.p, a.p]]');
    const model = lanes(rows(await placed(yaml)));
    expect(model.lanes).toHaveLength(2);
    const runs = model.links[0]!.fixedSegments!;
    expect(runs).toHaveLength(2); expect(runs[0]!.from.y).toBeGreaterThan(runs[1]!.from.y);
    expect(runs.every(run => run.from.y > run.to.y)).toBe(true);
    const bundled = lanes(rows(await placed(three.replace('links: [[a.p, c.p]]', 'links: [[a.p, c.p], [a.p, c.p]]'))));
    expect(bundled.lanes).toHaveLength(2);
    expect(bundled.links.every(link => !link.path && !link.fixedSegments)).toBe(true);
    const bad = copy(bundled); bad.links[0]!.fixedSegments = runs;
    expect(() => restoreLayoutModel(JSON.stringify(bad))).toThrow(/Fixed lane/);
  });
  it('leaves room for later same-source members instead of wasting a feasible in-span slot', async () => {
    const yaml = `portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  a: {group: up, label: A, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}, {name: r, side: bottom, order: 2}]}
  b: {group: mid, label: B}
  c: {group: down, label: C, ports: [{name: p, side: top}, {name: q, side: top}, {name: r, side: top}]}
links: [[a.p, c.p], [a.q, c.q], [a.r, c.r]]`;
    const input = stageInput(await placed(yaml), draft => {
      const a = draft.nodes.a!, b = draft.nodes.b!;
      a.bounds!.x = 0; a.bounds!.width = 220; a.size!.width = 220;
      a.ports.forEach((port, index) => { port.anchor!.x = 120 + index * a.sidePitch!.bottom!; });
      b.bounds!.x = 112;
      for (const id of ['up', 'mid']) { const box = union(draft.groups[id]!.nodes.map(id => draft.nodes[id]!.bounds!)); draft.groups[id]!.bounds = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 }; }
    });
    const model = lanes(rows(input));
    expect(model.lanes.map(lane => lane.x)).toEqual(input.nodes.a!.ports.map(port => port.anchor!.x));
    expect(model.lanes.every(lane => lane.x >= 0 && lane.x <= 220)).toBe(true);
    expect(model.diagnostics.some(d => d.code === 'LANE_OUTSIDE_SOURCE_SPAN')).toBe(false);
    expect(model.nodes.a).toEqual(input.nodes.a);
  });
  it('ticket 03: takes the column on the side of the transited group the target stands on', async () => {
    // `a.q` is a top port, so 7c never seats `c` under the lane and the x `c` has here is the x it
    // keeps. The lane therefore passes `mid` on the side `c` stands on, and the same staging with
    // `c` on the other side takes the other column. `a.q` stays right of `mid` in both.
    const yaml = `portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  a: {group: up, label: A, ports: [{name: q, side: top}]}
  s: {group: up, label: S}
  b: {group: mid, label: B}
  c: {group: down, label: C, ports: [{name: p, side: top}]}
links: [[a.q, c.p]]`;
    const staged = async (childX: number): Promise<LayoutModel> => stageInput(await placed(yaml), draft => {
      const a = draft.nodes.a!, b = draft.nodes.b!, c = draft.nodes.c!, s = draft.nodes.s!;
      const shift = (node: typeof a, x: number) => { const dx = x - node.bounds!.x; node.bounds!.x = x; for (const port of node.ports) port.anchor!.x += dx; };
      shift(a, 225); shift(s, 320); shift(b, 100); shift(c, childX);
      for (const id of ['up', 'mid', 'down']) { const box = union(draft.groups[id]!.nodes.map(id => draft.nodes[id]!.bounds!)); draft.groups[id]!.bounds = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 }; }
    });
    for (const [childX, side] of [[20, 'left'], [420, 'right']] as const) {
      const input = await staged(childX), model = lanes(rows(input));
      const mid = model.groups.mid!, lane = model.lanes[0]!;
      expect([childX, model.nodes.c!.ports[0]!.anchor!.x < mid.bounds!.x]).toEqual([childX, side === 'left']);
      expect([childX, lane.side]).toEqual([childX, side]);
      expect([childX, side === 'left' ? right(lane.bounds) <= mid.bounds!.x : lane.bounds.x >= right(mid.bounds!)]).toEqual([childX, true]);
      validateLanes(model);
    }
  });
  it('expands both occupied margins with actual translations and stroke-aware capacity', async () => {
    const data = parseYaml(readFileSync(new URL('../../goldens/synthetic/stage-inputs.yaml', import.meta.url), 'utf8')) as Record<string, {
      'group-boxes': Record<string, number[]>; 'node-boxes': Record<string, number[]>; 'port-anchors': Record<string, number[]>;
    }>;
    const pre = data['both-margins-full']!;
    const rect = (v: number[]) => ({ x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! });
    const input = stageInput(await placed(fixture('both-margins-full').replaceAll('group: upper,', 'group: upper, label: S,').replaceAll('group: lower,', 'group: lower, label: T,')), model => {
      for (const [id, box] of Object.entries(pre['group-boxes'])) model.groups[id]!.bounds = rect(box);
      for (const [id, box] of Object.entries(pre['node-boxes'])) {
        const node = model.nodes[id]!; node.bounds = rect(box);
        const width = Math.max(box[2]!, node.sidePitch?.bottom ? node.sidePitch.bottom + 20 : 0);
        node.bounds.x -= (width - box[2]!) / 2; node.bounds.width = width;
        node.size = { width, height: box[3]! };
        for (const port of node.ports) { const point = pre['port-anchors'][`${id}.${port.ref.name}#${port.ref.ordinal}`]!; port.anchor = { x: point[0]!, y: point[1]! }; }
      }
    });
    const before = rows(input), model = lanes(before);
    expect(before.groups.middle!.bounds!.x - (before.groups['left-flank']!.bounds!.x + before.groups['left-flank']!.bounds!.width)).toBe(20);
    expect(before.groups['right-flank']!.bounds!.x - (before.groups.middle!.bounds!.x + before.groups.middle!.bounds!.width)).toBe(20);
    expect(model.nodes['source-left']!.ports[0]!.anchor).toEqual(before.nodes['source-left']!.ports[0]!.anchor);
    expect(model.nodes['source-right']!.ports[0]!.anchor).toEqual(before.nodes['source-right']!.ports[0]!.anchor);
    expect(model.groups['left-flank']!.bounds!.x).toBeLessThan(before.groups['left-flank']!.bounds!.x);
    expect(model.groups['right-flank']!.bounds!.x).toBeGreaterThan(before.groups['right-flank']!.bounds!.x);
    expect(model.canvas!.width).toBeGreaterThan(before.canvas!.width);
    expect(model.lanes.every(lane => lane.bounds.width >= 34)).toBe(true); validateLanes(model);
    const wide = stageInput(await placed(three), draft => { draft.nodes.b!.strokeWidth = 50; });
    expect(laneWidth(wide, wide.links[0]!)).toBe(71.5);
    expect(lanes(rows(wide)).lanes[0]!.bounds.width).toBe(71.5);
  });
});

describe('stored flank primary and capacity', () => {
  it('pins only stored primary pairs and retains secondary links', async () => {
    const model = flanks(lanes(rows(await placed(fixture('flank-two-peers')))));
    expect(model.groups['flank-group']!.flank!.primaryPeer).toBe('primary');
    expect(flankPair(model, model.links[2]!)).toBeUndefined(); expect(model.links[2]!.path).toBeUndefined();
    expect(model.links.slice(0, 2).every(link => flankPair(model, link))).toBe(true);
  });
  it('equalises a valid larger pitch, grows capacity, and retains it in sizing', async () => {
    const input = stageInput(await placed(lateral), draft => {
      const a = draft.nodes.a!; a.sidePitch!.left = 24; a.bounds!.height = Math.max(a.bounds!.height, 44); a.size!.height = a.bounds!.height;
      a.ports[0]!.anchor!.y = a.bounds!.y + a.bounds!.height / 2;
      draft.groups.g!.bounds!.height = a.bounds!.height + 24;
    });
    expect(input.nodes.a!.sidePitch!.left).toBe(24); expect(input.nodes.b!.sidePitch!.right).toBe(14);
    const model = flanks(lanes(rows(input)));
    expect(model.nodes.a!.sidePitch!.left).toBe(24); expect(model.nodes.b!.sidePitch!.right).toBe(24);
    expect(ends(model).from.anchor!.y).toBe(ends(model).to.anchor!.y);
    expect(model.nodes.b!.bounds!.height).toBeGreaterThanOrEqual(44);
    const resized = copy(model); sizeNodes(resized); expect(resized.nodes.b!.sidePitch!.right).toBe(24);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });
  it('retains an authored inversion and rejects unrelated facing-side reorders', async () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: left, order: 0}, {name: q, side: left, order: 1}]}
  b: {group: f, ports: [{name: p, side: right, order: 0}, {name: q, side: right, order: 1}, {name: free, side: top}, {name: other, side: top}]}
links: [[b.p, a.q], [b.q, a.p]]`;
    const input = lanes(rows(await placed(yaml))), result = flanks(input);
    expect(result.nodes.a!.ports.map(port => port.engineOrder)).toEqual(input.nodes.a!.ports.map(port => port.engineOrder));
    expect(result.nodes.b!.ports.map(port => port.engineOrder)).toEqual(input.nodes.b!.ports.map(port => port.engineOrder));
    expect(result.diagnostics.some(d => d.code === 'FLANK_PAIR_INCOMPATIBLE')).toBe(true);
    expect(result.links.every(link => !link.path)).toBe(true);
    expect(() => withLayoutMutation(input, 'flanks', draft => {
      const a = draft.nodes.b!.ports[2]!, b = draft.nodes.b!.ports[3]!;
      [a.engineOrder, b.engineOrder] = [b.engineOrder!, a.engineOrder!]; rebuildNodeGeometry(draft, ['b'], 'from-slots');
    })).toThrow(/primary bundle block/);
    expect(restoreLayoutModel(JSON.stringify(result))).toEqual(result);
  });
  it('uses the unequal-pitch fixture with a valid retained pitch and capacity', async () => {
    const base = await placed(fixture('unequal-pitch'));
    const input = stageInput(base, draft => {
      const peer = draft.nodes.peer!, height = Math.max(peer.bounds!.height, 92);
      peer.sidePitch!.left = 24; peer.bounds!.height = height; peer.size!.height = height;
      rebuildNodeGeometry(draft, ['peer'], 'from-slots');
      draft.groups['tier-group']!.bounds!.height = height + 24;
    });
    expect(input.nodes.peer!.sidePitch!.left).toBe(24); expect(input.nodes.flank!.sidePitch!.right).toBe(17.5);
    const result = flanks(lanes(rows(input)));
    for (const [id, side] of [['peer', 'left'], ['flank', 'right']] as const) {
      expect(result.nodes[id]!.sidePitch![side]).toBe(24); expect(result.nodes[id]!.bounds!.height).toBeGreaterThanOrEqual(92);
    }
    for (const link of result.links) { const pair = flankPair(result, link)!; expect(pair.own.anchor!.y).toBe(pair.peer.anchor!.y); }
    const resized = copy(result); sizeNodes(resized); expect(resized.nodes.flank!.sidePitch!.right).toBe(24);
  });
  it('keeps the losing opposite flank primary but rejects its blocked corridor', async () => {
    const model = flanks(lanes(rows(await placed(`portograph: 2
groups: {g: {tier: 0}, left: {align: left, of: g}, right: {align: right, of: g}}
nodes: {a: {group: g}, b: {group: g}, l: {group: left}, r: {group: right}}
links: [[l, a], [r, a]]`))));
    expect(model.groups.right!.flank!.primaryPeer).toBe('a');
    expect(model.groups.g!.rowOrder).toEqual(['a', 'b']);
    const pair = flankPair(model, model.links[1]!)!;
    expect(pair.own.anchor!.y).toBe(pair.peer.anchor!.y); expect(pair.link.path).toBeUndefined();
    expect(model.links[0]!.path).toBeDefined();
  });
  it('counts distinct port demand and deduplicates exact pairs', async () => {
    const shared = lateral.replace('ports: [{name: p, side: right}]', 'ports: [{name: p, side: right}, {name: q, side: right}]').replace('links: [[b.p, a.p]]', 'links: [[b.p, a.p], [b.q, a.p]]');
    const model = flanks(lanes(rows(await placed(shared))));
    expect(model.diagnostics.filter(d => d.code === 'FLANK_CAPACITY')).toHaveLength(1);
    expect(model.nodes.b!.ports[0]!.anchor!.y).not.toBe(model.nodes.b!.ports[1]!.anchor!.y);
    expect(model.links.every(link => !link.path)).toBe(true);
    const repeated = flanks(lanes(rows(await placed(lateral.replace('links: [[b.p, a.p]]', 'links: [[b.p, a.p], [b.p, a.p]]')))));
    expect(repeated.diagnostics.some(d => d.code === 'FLANK_CAPACITY')).toBe(false);
    expect(repeated.links.every(link => !link.path)).toBe(true);
  });
  it('pins an unobstructed non-bundle pair and validates its replacement after movement', async () => {
    const model = flanks(lanes(rows(await placed(lateral))));
    expect(model.links[0]!.path!.segments).toHaveLength(1); expect(flankPathCandidate(model, model.links[0]!)).toBe(true);
    const bad = copy(model); bad.links[0]!.path!.segments[0]!.from.x++;
    expect(() => restoreLayoutModel(JSON.stringify(bad))).toThrow(/Flank path/);
    expect(() => withLayoutMutation(model, 'centre', draft => { delete draft.links[0]!.path; })).toThrow(/derived/);
  });
});

describe('parents-authoritative bounded centering', () => {
  it('selects main-node count with bar inclusion and lowest-tier tie, omitting empty layouts', async () => {
    const model = flanks(lanes(rows(await placed(fixture('parent-two-children')))));
    const before = ends(model).from.anchor!, result = centre(model);
    expect(selectAnchorTier(model)).toBe(0); expect(result.anchorTier).toBe(0);
    expect(ends(result).from.anchor).toEqual(before);
    const ordered = result.links.map((link, i) => ends(result, i)).sort((a, b) => model.nodes[a.to.ref.node]!.bounds!.x - model.nodes[b.to.ref.node]!.bounds!.x);
    expect(ordered[0]!.to.anchor!.x).toBe(before.x); expect(ordered[1]!.to.anchor!.x).not.toBe(before.x);
    expect(result.junctions).toHaveLength(0); expect(result.links.every(link => !link.path)).toBe(true);
    const bad = copy(result); bad.anchorTier = 1; expect(() => restoreLayoutModel(JSON.stringify(bad))).toThrow(/Anchor tier/);
    const counts = copy(model); counts.groups.children!.flank = { align: 'right', of: 'parents' }; expect(selectAnchorTier(counts)).toBe(0);
    const empty = centre(flanks(lanes(rows(await placed('portograph: 2\ngroups: {}\nnodes: {}\nlinks: []')))));
    expect(empty.anchorTier).toBeUndefined();
  });
  it('mirrors authority above the anchor and chooses one winner across child groups', async () => {
    const yaml = fixture('parent-two-children').replace('parents: { tier: 0 }', 'parents: { tier: 1 }').replace('children: { tier: 1 }', 'children: { tier: 0 }')
      .replace('side: bottom', 'side: top').replaceAll('side: top }]', 'side: bottom }]');
    // Explicit replacement preserves the parent top normal.
    const mirrored = yaml.replace('parent: { group: parents, ports: [{ name: p, side: bottom }]', 'parent: { group: parents, ports: [{ name: p, side: top }]');
    const input = flanks(lanes(rows(await placed(mirrored.replace('  spare:', '  extra: { group: parents }\n  spare:')))));
    const result = centre(input); expect(result.anchorTier).toBe(1);
    expect(ends(result).from.anchor).toEqual(ends(input).from.anchor);
    expect(result.links.filter((_, i) => ends(result, i).to.anchor!.x === ends(result, i).from.anchor!.x)).toHaveLength(1);
  });
  it('chooses the first attachment across two child groups and does not drift the fan group', async () => {
    const yaml = fixture('parent-two-children').replace('children: { tier: 1 }', 'children: { tier: 1 }\n  other: { tier: 1 }').replace('second: { group: children', 'second: { group: other');
    const input = flanks(lanes(rows(await placed(yaml)))), model = centre(input);
    expect(model.links.filter((_, i) => ends(model, i).from.anchor!.x === ends(model, i).to.anchor!.x)).toHaveLength(1);
    expect(ends(model).from.anchor).toEqual(ends(input).from.anchor);
    expect(model.nodes.first!.bounds!.width).toBeLessThan(200);
  });
  it('bounds incompatible author-order alignment at eight passes and keeps structural validation', async () => {
    const yaml = `portograph: 2
groups: {parents: {tier: 0}, children: {tier: 1}}
nodes:
  parent: {group: parents, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}]}
  spare: {group: parents}
  child: {group: children, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 1}]}
links: [[parent.p, child.q], [parent.q, child.p]]`;
    const input = flanks(lanes(rows(await placed(yaml)))), budget = createCentreBudget();
    const model = withLayoutMutation(input, 'centre', draft => centreDraft(draft, budget));
    expect(budget).toEqual({ remaining: 0, passes: 8 });
    expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(1);
    expect(model.nodes.parent).toEqual(input.nodes.parent);
    expect(model.nodes.child!.ports.map(port => port.engineOrder)).toEqual(input.nodes.child!.ports.map(port => port.engineOrder));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    for (const mutate of [(m: LayoutModel) => { m.nodes.child!.ports[0]!.side = 'left'; }, (m: LayoutModel) => { m.nodes.child!.sizeFloor!.width = 1; }]) {
      const bad = copy(model); mutate(bad); expect(() => restoreLayoutModel(JSON.stringify(bad))).toThrow();
    }
  });
  it('keeps fixed lanes and authoritative anchors when a child cannot cross its corridor', async () => {
    const yaml = `portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  a: {group: up, label: A, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}]}
  spare: {group: up, label: S}
  b: {group: mid, label: B, ports: [{name: p, side: top}]}
  c: {group: down, label: C, ports: [{name: p, side: top}]}
links: [[a.p, c.p], [a.q, b.p]]`;
    const input = stageInput(await placed(yaml), draft => {
      const a = draft.nodes.a!, b = draft.nodes.b!, c = draft.nodes.c!, spare = draft.nodes.spare!;
      const shift = (node: typeof a, x: number) => { const dx = x - node.bounds!.x; node.bounds!.x = x; for (const port of node.ports) port.anchor!.x += dx; };
      shift(a, 0); a.bounds!.width = 320; a.size!.width = 320; a.ports[0]!.anchor!.x = 250; a.ports[1]!.anchor!.x = 250 + a.sidePitch!.bottom!;
      shift(spare, 360); shift(b, 100);
      // The transit target stands under the corridor its link owns, so 7a's target-side rule reads
      // the same side the source does and the corridor keeps `mid`'s right margin (ticket 03).
      shift(c, 250 - (c.ports[0]!.anchor!.x - c.bounds!.x));
      draft.groups.up!.rowOrder = ['a', 'spare'];
      for (const id of ['up', 'mid', 'down']) { const box = union(draft.groups[id]!.nodes.map(id => draft.nodes[id]!.bounds!)); draft.groups[id]!.bounds = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 }; }
    });
    const ready = flanks(lanes(rows(input))), model = centre(ready);
    expect(model.lanes[0]!.x).toBe(250);
    expect(model.nodes.a).toEqual(ready.nodes.a);
    expect(model.lanes.map(lane => [lane.owner, lane.x])).toEqual(ready.lanes.map(lane => [lane.owner, lane.x]));
    expect(model.nodes.b!.bounds!.x + model.nodes.b!.bounds!.width).toBeLessThan(model.lanes[0]!.bounds.x);
    // Ticket 75: the child stays where the corridor holds it on every pass, which is a fixed point and not a stall.
    expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });
  it('stress ticket 14: union reaches the edge it was built from', () => {
    // `hub-t3-p3-f1-s2` measured: the canvas keeps its right edge while 7c widens a group to the
    // left, and `right - x` over that span rounds down, so `expandCanvas` emitted a canvas one ULP
    // inside the canvas it was built from and `Canvas may only expand` refused it.
    const wide = { x: -229.88997395833337, y: -3.5, width: 345.05664062500006, height: 7 };
    const far = { x: 13.666666666666671, y: -1.25, width: 283, height: 2.5 };
    expect(wide.x + (right(far) - wide.x)).toBeLessThan(right(far));
    const box = union([wide, far]);
    expect(box.x).toBe(wide.x);
    expect(right(box)).toBeGreaterThanOrEqual(right(far));
    expect(box.y).toBe(wide.y);
    expect(box.y + box.height).toBeGreaterThanOrEqual(wide.y + wide.height);
  });
  it('stress ticket 14: keeps the exact width of a node whose centring moves neither edge', async () => {
    const input = flanks(lanes(rows(await placed(fixture('centring-keeps-a-width-it-recomputes')))));
    // Every leaf port lands inside its own node box, so centring aligns the three feeds without
    // moving an edge. Recovering the width through the right edge threw `Centring cannot shrink
    // width` on `leaf-b`, whose box starts below 1024 and ends above it.
    const model = centre(input);
    for (const id of Object.keys(model.nodes)) {
      expect(model.nodes[id]!.size!.width).toBe(input.nodes[id]!.size!.width);
      expect(model.nodes[id]!.bounds!.width).toBe(input.nodes[id]!.size!.width);
    }
    const box = model.nodes['leaf-b']!.bounds!;
    expect(box.x).toBeLessThan(1024);
    expect(right(box)).toBeGreaterThan(1024);
    expect(right(box) - box.x).not.toBe(box.width);
  });
  it('ticket 01: packs the tier when a widened child swallows the group beside it', async () => {
    const input = flanks(lanes(rows(await placed(fixture('widened-child-packs-tier')))));
    const model = bands(bundles(bars(centre(input))));
    const tier = Object.values(model.groups).filter(group => group.tier === 1).sort((a, b) => a.bounds!.x - b.bounds!.x);
    expect(tier.map(group => group.id)).toEqual(['wide', 'middle', 'edge']);
    // `wide` really grows over the x ELK gave `middle`. `middle` cannot centre in what is left.
    expect(model.nodes.w1!.bounds!.width).toBeGreaterThan(input.nodes.w1!.bounds!.width + 100);
    expect(right(model.groups.wide!.bounds!)).toBeGreaterThan(input.groups.middle!.bounds!.x);
    // Ticket 75: the blocked group holds its place on every pass; that is settled, not a stall.
    expect(model.diagnostics.map(d => d.code)).toEqual([]);
    // No foreign group obstacle contains an attachment shape. Every group keeps the band gap.
    const plan = planRoute(model);
    for (const batch of plan.batches) expect(() => batchRequest(plan, batch, [])).not.toThrow();
    for (const [index, group] of tier.slice(1).entries()) {
      expect(group.bounds!.x - right(tier[index]!.bounds!)).toBeGreaterThanOrEqual(60);
    }
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);

    // Stress ticket 08: `m1|top` carries the two links, 12 px apart, and `link-3` travels over
    // `link-4`'s port. Rule 1 nests the two stems, so the earlier batch's route no longer covers
    // the later link's reserved turn, and the diagram publishes.
    // Ticket 50: both links are planned parts, so their stems are claimed and no batch reserves them (`plan.stems` is empty); the nesting
    // is read from the stem plan that placed the tips.
    const depth = (link: string): number => {
      const ref = model.links.find(item => item.id === link)!.attachments!;
      const port = [ref.from, ref.to].map(end => model.nodes[end.node]!.ports.find(item => JSON.stringify(item.ref) === JSON.stringify(end))!).find(item => item.ref.node === 'm1')!;
      return stemPlan(model, port).depth;
    };
    expect(plan.stems.filter(stem => stem.node === 'm1')).toEqual([]);
    expect(depth('link-3')).toBeGreaterThan(depth('link-4') + 17);
    const routed = await route(model, { createAttempt: createAvoidAttempt });
    for (const link of routed.links) expect(link.path, link.id).toBeDefined();
    const report = score(routed).snapshot;
    expect(Object.values(report.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);
  it('ticket 29: a body is not stretched across the sheet to reach two feeds at its ends', async () => {
    const input = flanks(lanes(rows(await placed(fixture('two-feeds-at-opposite-ends')))));
    const model = bands(bundles(bars(centre(input))));
    const node = model.nodes.target!, side = 'top' as const;
    // Its two feeds are 1 017 px apart and its own width is 50 px, so seating a port under each
    // needs a body twenty times what the node is. The allowance declines both, and the body keeps
    // the width its own content and its two ports need.
    const own = ownSideWidth(node, side);
    expect(node.bounds!.width).toBeLessThanOrEqual(ALIGNMENT_MAX_GROWTH * own);
    expect(node.bounds!.width).toBe(input.nodes.target!.bounds!.width);
    const feeds = ['feed-left', 'feed-right'].map(id => model.nodes[id]!.ports[0]!.anchor!.x);
    expect(Math.max(...feeds) - Math.min(...feeds)).toBeGreaterThan(20 * own);
    // Both feeds are reported, and the links are routed rather than pinned.
    expect(model.diagnostics.filter(d => d.code === 'CENTRE_ALIGNMENT_INFEASIBLE')
      .map(d => d.owners?.[0]).map(owner => owner && 'id' in owner ? owner.id : undefined))
      .toEqual(['link-1', 'link-2']);
    const routed = await route(model, { createAttempt: createAvoidAttempt });
    for (const link of routed.links) expect(link.path, link.id).toBeDefined();
    const report = score(routed).snapshot;
    expect(Object.values(report.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);
  it('ticket 01: keeps the packed tier clear of the flanks beside it', async () => {
    // The same widening with a flank on each side: the window is finite here, and the final clamp
    // may not put the group back across the left flank.
    const yaml = fixture('widened-child-packs-tier')
      .replace('nodes:', '  lf: { align: left, of: wide }\n  rf: { align: right, of: edge }\nnodes:')
      .replace('links:', '  l: { group: lf }\n  r: { group: rf }\nlinks:')
      .concat('  - [e1, a3]\n  - [l, w1]\n  - [e1, r]\n');
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
    const boxes = Object.values(model.groups).filter(group => group.tier === 1).map(group => group.bounds!);
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue;
      expect(Math.min(right(a), right(b)) - Math.max(a.x, b.x)).toBeLessThanOrEqual(0);
    }
    const plan = planRoute(model);
    for (const batch of plan.batches) expect(() => batchRequest(plan, batch, [])).not.toThrow();
  });
  it('replaces flank claims after a permitted peer translation and rebuilds content once', async () => {
    const yaml = lateral.replace('g: {tier: 0}', 'anchor: {tier: 0}, g: {tier: 1}').replace('nodes:', 'nodes:\n  extra: {group: anchor}\n  spare: {group: anchor}');
    const input = flanks(lanes(rows(await placed(yaml)))), old = input.links[0]!.path!;
    const model = withLayoutMutation(input, 'centre', draft => { moveGroup(draft, draft.groups.g!, 30, 0); });
    expect(model.links[0]!.path!.segments).toHaveLength(1);
    expect(model.links[0]!.path!.segments[0]!.to.x).toBe(old.segments[0]!.to.x + 30);
    expect(model.links[0]!.path!.segments[0]!.from).toEqual(old.segments[0]!.from);
    expect(model.labels.filter(label => label.id === 'node:"a":node')).toHaveLength(1);
    const draft = copy(model); rebuildRegionGeometry(draft); expect(draft.links[0]!.path).toEqual(model.links[0]!.path);
  });
  it('rebuilds lane extents with a shared producer and never reallocates x', async () => {
    const model = centre(flanks(lanes(rows(await placed(three))))), draft = copy(model);
    const x = draft.lanes[0]!.x, oldY = draft.lanes[0]!.bounds.y;
    moveGroup(draft, draft.groups.mid!, 0, 10); rebuildRegionGeometry(draft);
    expect(draft.lanes[0]!.x).toBe(x); expect(draft.lanes[0]!.bounds.y).toBe(oldY + 10);
    expect(draft.links[0]!.fixedSegments![0]!.from.y).toBe(oldY + 10);
    const budget = createCentreBudget(); centreDraft(draft, budget); expect(budget.passes).toBeLessThanOrEqual(8);
    expect(() => centreDraft(draft, { remaining: 9, passes: 0 })).toThrow(/eight-pass budget/);
  });
});
