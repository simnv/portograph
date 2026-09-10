import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment, PortRef, Rect } from '../../src/model/index.js';
import { bars, shapeBars } from '../../src/layout/bars.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rebuildRegionGeometry } from '../../src/layout/region-rebuild.js';
import { rows } from '../../src/layout/rows.js';
import { rebuildBands, union } from '../../src/layout/skeleton-geometry.js';
import { findPort } from '../../src/layout/row-paths.js';
import { equal } from '../../src/model/json-equality.js';
import { score } from '../../src/score/index.js';
import { placed } from './phase-two-fixture.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;

async function throughCentre(yaml: string): Promise<LayoutModel> {
  return centre(flanks(lanes(rows(await placed(yaml)))));
}

function ref(text: string): PortRef {
  const match = /^(.*)\.([^#]+)(?:#(\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid test port ${text}`);
  return { node: match[1]!, name: match[2]!, ordinal: Number(match[3] ?? 1) };
}

function stageInput(model: LayoutModel, boxes: Record<string, [number, number, number, number]>,
  anchors: Record<string, [number, number]>): LayoutModel {
  const draft = copy(model);
  for (const [id, [x, y, width, height]] of Object.entries(boxes)) {
    const node = draft.nodes[id]!;
    node.bounds = { x, y, width, height };
    node.size = { width, height };
  }
  for (const [id, [x, y]] of Object.entries(anchors)) findPort(draft, ref(id))!.anchor = { x, y };
  for (const node of Object.values(draft.nodes)) for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const horizontal = side === 'top' || side === 'bottom';
    node.ports.filter(port => port.side === side).sort((a, b) => {
      const aa = horizontal ? a.anchor!.x : a.anchor!.y, bb = horizontal ? b.anchor!.x : b.anchor!.y;
      return aa - bb || a.ref.ordinal - b.ref.ordinal;
    }).forEach((port, engineOrder) => { port.engineOrder = engineOrder; });
  }
  for (const group of Object.values(draft.groups)) {
    if (!group.nodes.length) continue;
    const box = union(group.nodes.map(id => draft.nodes[id]!.bounds!));
    group.bounds = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
  }
  rebuildBands(draft);
  rebuildRegionGeometry(draft);
  const occupied = union(Object.values(draft.groups).map(group => group.bounds!));
  const old = draft.canvas!;
  const x = Math.min(old.x, occupied.x), y = Math.min(old.y, occupied.y);
  draft.canvas = { x, y, width: Math.max(right(old), right(occupied)) - x, height: Math.max(bottom(old), bottom(occupied)) - y };
  rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
  return restoreLayoutModel(JSON.stringify(draft));
}

function connected(segments: PathSegment[]): boolean {
  return segments.every((segment, index) => index === 0
    || segment.from.x === segments[index - 1]!.to.x && segment.from.y === segments[index - 1]!.to.y);
}

describe('bar geometry and drop reservations', () => {
  it('merges three stacked spans transitively and keeps a distinct owner for every crossed bar', async () => {
    const input = stageInput(await throughCentre(fixture('three-bars')), {
      source: [0, 0, 400, 50],
    }, {
      'source.p#1': [100, 50], 'source.p#2': [160, 50], 'source.p#3': [220, 50],
      'source.p#4': [240, 50], 'source.p#5': [300, 50], 'source.p#6': [360, 50],
    });
    const model = bars(input);
    const nodes = ['first', 'second', 'third'].map(id => model.nodes[id]!);

    expect(nodes.map(node => [node.bounds!.x, right(node.bounds!)])).toEqual([[70, 390], [70, 390], [70, 390]]);
    expect(nodes.map(node => node.bounds!.y)).toEqual([...nodes].map(node => node.bounds!.y).sort((a, b) => a - b));
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    expect(model.barDrops).toHaveLength(8);
    expect(new Set(model.barDrops.map(drop => drop.id)).size).toBe(8);

    const lower = model.links.find(link => link.attachments!.to.node === 'third')!;
    const reservations = model.barDrops.filter(drop => drop.link === lower.id);
    expect(reservations).toHaveLength(2);
    expect(reservations.map(drop => drop.owner)).toEqual([
      { kind: 'barCross', node: 'first', link: lower.id },
      { kind: 'barCross', node: 'second', link: lower.id },
    ]);
    expect(reservations.every(drop => drop.slotX === 220 && drop.span.min === 70 && drop.span.max === 390)).toBe(true);
    expect(reservations.every(drop => JSON.stringify(drop.barCross) === JSON.stringify(['first', 'second']))).toBe(true);
  });

  it('fans sources one pixel apart to pitch-safe slots and pins both mirrored paths', async () => {
    const input = stageInput(await throughCentre(fixture('one-px-sources')), {
      above: [170, 0, 60, 40], below: [171, 300, 60, 40],
    }, {
      'above.p#1': [200, 40], 'below.p#1': [201, 300],
    });
    const model = bars(input);
    const top = findPort(model, ref('bar.p#1'))!, lower = findPort(model, ref('bar.p#2'))!;

    expect([top.anchor!.x, lower.anchor!.x]).toEqual([200, 212]);
    expect(model.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'placement', severity: 'warning', code: 'BAR_SOURCE_FAN' }),
    ]));
    for (const link of model.links) {
      expect(link.path?.fixed).toBe(true);
      expect(connected(link.path!.segments)).toBe(true);
      expect(link.path!.segments[0]!.from).toEqual(findPort(model, link.attachments!.from)!.anchor);
      expect(link.path!.segments.at(-1)!.to).toEqual(findPort(model, link.attachments!.to)!.anchor);
    }
    expect(model.links[1]!.path!.segments).toHaveLength(3);
    expect(model.links[1]!.path!.segments[0]!.to.y).toBeLessThan(model.links[1]!.path!.segments[0]!.from.y);
    expect(model.links[1]!.path!.segments.at(-1)!.from.y).toBeGreaterThan(model.links[1]!.path!.segments.at(-1)!.to.y);
  });

  it('pins mirrored top and bottom feeds and records only their intervening bar', async () => {
    const input = stageInput(await throughCentre(fixture('bar-both-sides')), {
      above: [70, 0, 100, 40], below: [72, 300, 100, 40],
    }, {
      'above.p#1': [100, 40], 'above.p#2': [120, 40],
      'below.p#1': [102, 300], 'below.p#2': [122, 300],
    });
    const model = bars(input);
    const barCross = model.barDrops.filter(drop => drop.owner.kind === 'barCross');

    expect(model.links.every(link => link.path?.fixed === true)).toBe(true);
    expect(barCross).toHaveLength(2);
    expect(new Set(barCross.map(drop => drop.owner.kind === 'barCross' ? drop.owner.node : ''))).toEqual(new Set(['first', 'second']));
    for (const link of model.links) {
      const from = findPort(model, link.attachments!.from)!, to = findPort(model, link.attachments!.to)!;
      expect(link.path!.segments[0]!.from).toEqual(from.anchor);
      expect(link.path!.segments.at(-1)!.to).toEqual(to.anchor);
      const firstDy = link.path!.segments[0]!.to.y - link.path!.segments[0]!.from.y;
      expect(Math.sign(firstDy)).toBe(from.side === 'bottom' ? 1 : -1);
      const last = link.path!.segments.at(-1)!;
      expect(Math.sign(last.from.y - last.to.y)).toBe(to.side === 'bottom' ? 1 : -1);
      expect(Math.abs(link.path!.segments.at(-1)!.to.y - link.path!.segments.at(-1)!.from.y)).toBeGreaterThanOrEqual(15);
    }
    const result = score(model).snapshot;
    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G5.passed).toBe(true);
  });

  it('stitches every immutable lane segment into a complete non-bundle path', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, middle1: {tier: 1}, middle2: {tier: 2}, bars: {tier: 3, shape: bar}}
nodes:
  source: {group: upper, ports: [{name: p, side: bottom}]}
  obstacle1: {group: middle1}
  obstacle2: {group: middle2}
  target: {group: bars, ports: [{name: p, side: top}]}
links: [[source.p, target.p, {route: orthogonal}]]`;
    const before = await throughCentre(yaml), reserved = before.links[0]!.fixedSegments!.map(segment => copy(segment));
    const lane = before.lanes[0]!, model = bars(before), link = model.links[0]!;

    expect(link.path?.fixed).toBe(true);
    expect(reserved.every(run => link.path!.segments.some(segment => equal(segment, run)))).toBe(true);
    expect(reserved).toHaveLength(2);
    const reservedOrder = reserved.map(run => link.path!.segments.findIndex(segment => equal(segment, run)));
    expect(reservedOrder[0]).toBeLessThan(reservedOrder[1]!);
    expect(model.lanes[0]).toMatchObject({ id: lane.id, x: lane.x, owner: lane.owner });
    expect(link.path!.segments.some(segment => segment.lane === lane.id)).toBe(true);
    expect(connected(link.path!.segments)).toBe(true);
  });

  it('hands bundle members lane slots, hints, and crossed-bar owners to stage 7e without paths', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, middle: {tier: 1}, bars: {tier: 2, shape: bar, label: Bars}}
nodes:
  source: {group: upper, size: {width: 240, height: 50}, ports: {side: bottom, list: [p, p, p, p]}}
  obstacle: {group: middle}
  first: {group: bars, label: A deliberately wide upper bar, ports: {side: top, list: [p, p]}}
  second: {group: bars, ports: {side: top, list: [p, p]}}
links:
  - [source.p#1, first.p#1]
  - [source.p#2, first.p#2]
  - [source.p#3, second.p#1]
  - [source.p#4, second.p#2]`;
    const before = await throughCentre(yaml), laneIds = before.lanes.map(lane => lane.id);
    const model = bars(before), lower = model.links.filter(link => link.attachments!.to.node === 'second');

    expect(model.links.every(link => link.bundle && link.path === undefined && link.fixedSegments === undefined)).toBe(true);
    expect(model.lanes.map(lane => lane.id)).toEqual(laneIds);
    for (const link of lower) {
      const drops = model.barDrops.filter(drop => drop.link === link.id);
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ owner: { kind: 'barCross', node: 'first', link: link.id }, barCross: ['first'] });
      expect(drops[0]!.hint!.length).toBeGreaterThan(2);
      expect(drops[0]!.hint!.some(point => model.lanes.some(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && point.x === lane.x))).toBe(true);
    }
  });

  it('preserves authored relative order when an upward feed wants the reverse x order', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, bars: {tier: 1, shape: bar}}
nodes:
  source: {group: upper, size: {width: 260, height: 50}, ports: [{name: p, side: bottom}, {name: p, side: bottom}]}
  bar: {group: bars, ports: [{name: p, side: top, order: 2}, {name: p, side: top, order: 1}]}
links:
  - [bar.p#1, source.p#1, {route: orthogonal}]
  - [bar.p#2, source.p#2, {route: orthogonal}]`;
    const input = stageInput(await throughCentre(yaml), { source: [70, 0, 260, 50] }, {
      'source.p#1': [100, 50], 'source.p#2': [300, 50],
    });
    const model = bars(input), ports = model.nodes.bar!.ports;

    expect(ports.map(port => port.authorOrder)).toEqual([2, 1]);
    expect(ports.find(port => port.ref.ordinal === 2)!.anchor!.x).toBeLessThan(ports.find(port => port.ref.ordinal === 1)!.anchor!.x);
    expect(model.links.every(link => link.path!.segments[0]!.to.y < link.path!.segments[0]!.from.y)).toBe(true);
    expect(model.links.every(link => connected(link.path!.segments))).toBe(true);
    expect(model.barDrops.every(drop => JSON.stringify(drop.source) === JSON.stringify(model.links.find(link => link.id === drop.link)!.attachments!.from)
      && JSON.stringify(drop.port) === JSON.stringify(model.links.find(link => link.id === drop.link)!.attachments!.to))).toBe(true);
  });

  it('uses the group label as the extra portless floor while retaining a longer node-content floor', async () => {
    const groupFloorYaml = `portograph: 2
groups: {bars: {tier: 0, shape: bar, label: A deliberately long group label}}
nodes: {bar: {group: bars, label: ''}}
links: []`;
    const groupFloor = bars(await throughCentre(groupFloorYaml));
    const contentFloorYaml = `portograph: 2
groups: {bars: {tier: 0, shape: bar, label: B}}
nodes: {bar: {group: bars, label: A deliberately long node label}}
links: []`;
    const contentFloor = bars(await throughCentre(contentFloorYaml));

    expect(groupFloor.nodes.bar!.bounds!.width).toBeGreaterThan(150);
    expect(contentFloor.nodes.bar!.bounds!.width).toBeGreaterThanOrEqual(contentFloor.nodes.bar!.sizeFloor!.width);
    expect(contentFloor.barDrops).toEqual([]);
  });

  it('validates restored claims and replaces stale paths from stable owners', async () => {
    const model = bars(await throughCentre(fixture('bar-both-sides'))), ids = model.barDrops.map(drop => drop.id);
    const corrupted = copy(model);
    corrupted.barDrops[0]!.span.max--;
    expect(() => restoreLayoutModel(JSON.stringify(corrupted))).toThrow(/bar drop/i);

    const rebuilt = copy(model), group = rebuilt.groups.bars!;
    group.bounds!.y += 20;
    for (const id of group.nodes) {
      const node = rebuilt.nodes[id]!;
      node.bounds!.y += 20;
      for (const port of node.ports) port.anchor!.y += 20;
    }
    rebuildBands(rebuilt);
    rebuildRegionGeometry(rebuilt);
    expect(rebuilt.barDrops.map(drop => drop.id)).toEqual(ids);
    expect(rebuilt.links.every(link => link.path!.segments.at(-1)!.to.y === findPort(rebuilt, link.attachments!.to)!.anchor!.y)).toBe(true);
  });

  it('reshapes and restores stable bar claims after a checked bands-stage source move', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, bars: {tier: 1, shape: bar}}
nodes:
  source: {group: upper, ports: [{name: p, side: bottom}]}
  bar: {group: bars, ports: [{name: p, side: top}]}
links: [[source.p, bar.p, {route: orthogonal}]]`;
    const shaped = bars(await throughCentre(yaml));
    const bundled = withLayoutMutation(shaped, 'bundles', () => {});
    const ids = bundled.barDrops.map(drop => drop.id), oldSlot = bundled.barDrops[0]!.slotX;
    const moved = withLayoutMutation(bundled, 'bands', draft => {
      draft.groups.upper!.bounds!.x += 20;
      draft.nodes.source!.bounds!.x += 20;
      for (const port of draft.nodes.source!.ports) port.anchor!.x += 20;
    });

    expect(moved.barDrops.map(drop => drop.id)).toEqual(ids);
    expect(moved.barDrops[0]!.slotX).toBe(oldSlot + 20);
    expect(findPort(moved, ref('bar.p'))!.anchor!.x).toBe(oldSlot + 20);
    expect(restoreLayoutModel(JSON.stringify(moved)).barDrops).toEqual(moved.barDrops);
  });

  it.each([
    ['bottom', false], ['bottom', true], ['top', false], ['top', true],
  ] as const)('routes around an opposite-side %s bar in authored reverse=%s traversal', async (barSide, reverse) => {
    const barAbove = barSide === 'top';
    const first = reverse ? 'bar.p' : 'source.p', second = reverse ? 'source.p' : 'bar.p';
    const yaml = `portograph: 2
groups: {source-group: {tier: ${barAbove ? 1 : 0}}, bars: {tier: ${barAbove ? 0 : 1}, shape: bar}}
nodes:
  source: {group: source-group, ports: [{name: p, side: ${barAbove ? 'top' : 'bottom'}}]}
  bar: {group: bars, ports: [{name: p, side: ${barSide}}]}
links: [[${first}, ${second}, {route: orthogonal}]]`;
    const model = bars(await throughCentre(yaml)), result = score(model).snapshot;
    const box = model.nodes.bar!.bounds!, path = model.links[0]!.path!.segments;

    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G5.passed).toBe(true);
    expect(path.some(segment => barSide === 'bottom'
      ? Math.max(segment.from.y, segment.to.y) >= bottom(box) + 15
      : Math.min(segment.from.y, segment.to.y) <= box.y - 15)).toBe(true);
  });

  it.each([
    ['bottom', false], ['bottom', true], ['top', false], ['top', true],
  ] as const)('keeps a stacked opposite-side %s approach clear in authored reverse=%s traversal', async (barSide, reverse) => {
    const targetFirst = barSide === 'bottom';
    const sourceTier = targetFirst ? 0 : 1, barTier = targetFirst ? 1 : 0;
    const sourceSide = targetFirst ? 'bottom' : 'top';
    const nodes = targetFirst
      ? `  bar: {group: bars, ports: [{name: p, side: bottom}]}
  other: {group: bars, ports: [{name: p, side: top}]}`
      : `  other: {group: bars, ports: [{name: p, side: bottom}]}
  bar: {group: bars, ports: [{name: p, side: top}]}`;
    const first = reverse ? 'bar.p' : 'source.p#1', second = reverse ? 'source.p#1' : 'bar.p';
    const yaml = `portograph: 2
groups: {source-group: {tier: ${sourceTier}}, bars: {tier: ${barTier}, shape: bar}}
nodes:
  source: {group: source-group, ports: [{name: p, side: ${sourceSide}}, {name: p, side: ${sourceSide}}]}
${nodes}
links: [[${first}, ${second}, {route: orthogonal}], [source.p#2, other.p, {route: orthogonal}]]`;
    const model = bars(await throughCentre(yaml)), result = score(model).snapshot;
    const target = model.nodes.bar!.bounds!, other = model.nodes.other!.bounds!;
    const approachY = barSide === 'bottom' ? bottom(target) + 15 : target.y - 15;

    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G5.passed).toBe(true);
    expect(result.gates.G6.passed).toBe(true);
    expect(model.links[0]!.path!.segments.some(segment => segment.from.y === approachY && segment.to.y === approachY)).toBe(true);
    expect(barSide === 'bottom' ? other.y - approachY : approachY - bottom(other)).toBeGreaterThan(10);
  });

  it('preserves the tier gap by translating a lower tier by actual bar-band growth', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, bars: {tier: 1, shape: bar}, lower: {tier: 2}}
nodes:
  above: {group: upper, ports: [{name: p, side: bottom}]}
  first: {group: bars, ports: [{name: p, side: bottom}]}
  second: {group: bars, ports: [{name: p, side: top}]}
  below: {group: lower, ports: [{name: p, side: top}]}
links: [[above.p, first.p, {route: orthogonal}], [below.p, second.p, {route: orthogonal}]]`;
    const input = await throughCentre(yaml), oldBarBand = input.tierBands.find(band => band.tier === 1)!.bounds!;
    const oldLowerBand = input.tierBands.find(band => band.tier === 2)!.bounds!;
    const oldLowerY = input.groups.lower!.bounds!.y, oldGap = oldLowerBand.y - bottom(oldBarBand);
    const model = bars(input), barBand = model.tierBands.find(band => band.tier === 1)!.bounds!;
    const lowerBand = model.tierBands.find(band => band.tier === 2)!.bounds!;
    const growth = barBand.height - oldBarBand.height;
    const result = score(model).snapshot;

    expect(growth).toBeGreaterThan(0);
    expect(model.groups.lower!.bounds!.y - oldLowerY).toBeCloseTo(growth);
    expect(lowerBand.y - bottom(barBand)).toBeCloseTo(oldGap);
    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G5.passed).toBe(true);
    expect(result.gates.G6.passed).toBe(true);
    expect(restoreLayoutModel(JSON.stringify(model)).groups.lower).toEqual(model.groups.lower);

    const replayed = copy(model), replayedLowerY = replayed.groups.lower!.bounds!.y;
    rebuildRegionGeometry(replayed);
    expect(replayed.groups.lower!.bounds!.y).toBe(replayedLowerY);
    expect(replayed.barDrops).toEqual(model.barDrops);

    const corrupted = copy(model);
    corrupted.groups.lower!.bounds!.y++;
    expect(() => restoreLayoutModel(JSON.stringify(corrupted))).toThrow();
  });

  it('moves an attached flank with its downstream tier and rejects callback-authored movement', async () => {
    const yaml = `portograph: 2
groups: {upper: {tier: 0}, bars: {tier: 1, shape: bar}, lower: {tier: 2}, wing: {align: left, of: lower}}
nodes:
  above: {group: upper, ports: [{name: p, side: bottom}]}
  first: {group: bars, ports: [{name: p, side: bottom}]}
  second: {group: bars, ports: [{name: p, side: top}]}
  below: {group: lower, ports: [{name: top, side: top}, {name: side, side: left}]}
  flank: {group: wing, ports: [{name: p, side: right}]}
links: [[above.p, first.p, {route: orthogonal}], [below.top, second.p, {route: orthogonal}], [flank.p, below.side]]`;
    const input = await throughCentre(yaml), oldLowerY = input.groups.lower!.bounds!.y, oldFlankY = input.groups.wing!.bounds!.y;
    const oldBarHeight = input.tierBands.find(band => band.tier === 1)!.bounds!.height;
    const model = bars(input), growth = model.tierBands.find(band => band.tier === 1)!.bounds!.height - oldBarHeight;

    expect(model.groups.lower!.bounds!.y - oldLowerY).toBeCloseTo(growth);
    expect(model.groups.wing!.bounds!.y - oldFlankY).toBeCloseTo(growth);
    expect(() => withLayoutMutation(input, 'bars', draft => {
      shapeBars(draft);
      draft.groups.lower!.bounds!.y++;
      draft.nodes.below!.bounds!.y++;
      for (const port of draft.nodes.below!.ports) port.anchor!.y++;
    })).toThrow(/Bars cannot move another group/);
  });

  it('rejects callback-authored claims, missing reservations, and an early bundle member path', async () => {
    const input = await throughCentre(fixture('three-bars'));
    expect(() => withLayoutMutation(input, 'bars', draft => {
      draft.barDrops.push({ id: 'invented', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', link: 'link-1',
        source: draft.links[0]!.attachments!.from, port: draft.links[0]!.attachments!.to, slotX: 0,
        span: { min: 0, max: 1 }, hint: [], barCross: [] });
    })).toThrow(/claim validator/);

    const model = bars(input), missing = copy(model);
    missing.barDrops.pop();
    expect(() => restoreLayoutModel(JSON.stringify(missing))).toThrow(/bar drop/i);
    const early = copy(model), member = early.links[0]!;
    member.path = { owner: member.owner, layer: 'routed', fixed: true,
      segments: [{ from: findPort(early, member.attachments!.from)!.anchor!, to: findPort(early, member.attachments!.to)!.anchor!, owner: member.owner }] };
    expect(() => restoreLayoutModel(JSON.stringify(early))).toThrow(/bar path/i);
  });

  it('shapes the real golden and lets gates inspect produced paths while bundle paths remain absent', async () => {
    const model = bars(await throughCentre(golden));
    const barNodes = model.groups.backbone!.nodes.map(id => model.nodes[id]!);
    expect(() => score(model)).toThrow(/requires final path/);
    // Ticket 11 owns the absent bundle paths. Keep all foreign geometry while scoring produced links.
    const produced = copy(model);
    produced.links = produced.links.filter(link => link.path !== undefined);
    produced.bundles = [];
    const result = score(produced).snapshot;

    expect(Object.keys(model.nodes)).toHaveLength(12);
    expect(model.links).toHaveLength(26);
    expect(Object.values(model.nodes).flatMap(node => node.ports)).toHaveLength(52);
    expect(barNodes[0]!.bounds!.y).toBeLessThan(barNodes[1]!.bounds!.y);
    expect(model.barDrops.filter(drop => drop.owner.kind === 'barCross')).toHaveLength(3);
    expect(model.barDrops.every(drop => drop.span.min === model.nodes[drop.port.node]!.bounds!.x
      && drop.span.max === right(model.nodes[drop.port.node]!.bounds!))).toBe(true);
    for (const node of barNodes) {
      const xs = node.ports.map(port => port.anchor!.x);
      expect(node.bounds!.x).toBeLessThanOrEqual(Math.min(...xs) - 30);
      expect(right(node.bounds!)).toBeGreaterThanOrEqual(Math.max(...xs) + 30);
    }
    expect(model.links.filter(link => link.bundle).every(link => link.path === undefined)).toBe(true);
    expect(result.counters.barCross).toBe(3);
    expect(result.gates.G2.passed).toBe(true);
    expect(result.gates.G5.passed).toBe(true);
  });
});
