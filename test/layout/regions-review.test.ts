import { describe, expect, it } from 'vitest';
import { generateScaleYaml } from '../../scripts/scale-input.mjs';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { rows } from '../../src/layout/rows.js';
import { lanes, validateLanes } from '../../src/layout/lanes.js';
import { alignFlanks, flanks } from '../../src/layout/flanks.js';
import { withLayoutMutation, restoreLayoutModel } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { moveGroup, rebuildBands, union, validateSkeletonBands } from '../../src/layout/skeleton-geometry.js';
import { placed } from './phase-two-fixture.js';

const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
const wideYaml = (port: string) => `portograph: 2
groups: {up: {tier: 0}, outer: {tier: 1}, left: {tier: 1}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  a: {group: up, label: A, ports: [{name: ${port}, side: bottom}]}
  o: {group: outer, label: O}
  l: {group: left, label: L}
  b: {group: mid, label: B}
  c: {group: down, label: C, ports: [{name: p, side: top}]}
links: [[a.${port}, c.p]]`;
const right = (box: {x: number; width: number}) => box.x + box.width;
function checkedMargins(input: LayoutModel, result: LayoutModel): void {
  expect(validateSkeletonBands(result)).toEqual([]);
  validateLanes(result);
  const ordered = (model: LayoutModel) => Object.values(model.groups).filter(group => group.tier === 1).sort((a, b) => a.bounds!.x - b.bounds!.x).map(group => group.id);
  expect(ordered(result)).toEqual(ordered(input));
  expect(result.nodes.a).toEqual(input.nodes.a);
  expect(result.canvas!.width).toBeGreaterThanOrEqual(input.canvas!.width);
}

describe('review: lane expansion preserves occupied group order', () => {
  it('opens a source-aligned wide corridor while preserving occupied group order', async () => {
    const input = rows(await placed(wideYaml('long-port-name-that-requires-a-wide-reserved-corridor')));
    const result = lanes(input); checkedMargins(input, result);
    expect(result.lanes[0]!.bounds.width).toBeGreaterThan(input.groups.mid!.bounds!.width);
    expect(result.groups.mid!.bounds!.x).toBeGreaterThan(input.groups.mid!.bounds!.x);
    expect(result.lanes[0]!.x).toBe(input.nodes.a!.ports[0]!.anchor!.x);
    const boxes = Object.values(result.groups).filter(group => group.tier === 1).map(group => group.bounds!).sort((a, b) => a.x - b.x);
    for (let i = 1; i < boxes.length; i++) expect(right(boxes[i - 1]!)).toBeLessThanOrEqual(boxes[i]!.x);
  });
  it('propagates an occupied-margin push to the next neighbor', async () => {
    const draft = copy(rows(await placed(wideYaml('p'))));
    for (const [id, x, y] of [['up', 136, 0], ['outer', 0, 160], ['left', 100, 160], ['mid', 194, 160], ['down', 136, 340]] as const) {
      const group = draft.groups[id]!; moveGroup(draft, group, x - group.bounds!.x, y - group.bounds!.y);
    }
    draft.groups.outer!.bounds!.width = 95;
    rebuildBands(draft); rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
    draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
    const input = restoreLayoutModel(JSON.stringify(draft)), result = lanes(input); checkedMargins(input, result);
    expect(result.groups.left!.bounds!.x).toBeLessThan(input.groups.left!.bounds!.x);
    expect(result.groups.outer!.bounds!.x).toBeLessThan(input.groups.outer!.bounds!.x);
    const boxes = Object.values(result.groups).filter(group => group.tier === 1).map(group => group.bounds!).sort((a, b) => a.x - b.x);
    for (let i = 1; i < boxes.length; i++) expect(right(boxes[i - 1]!)).toBeLessThanOrEqual(boxes[i]!.x);
  });
  it('opens a direct corridor on the free side without moving another transit source', async () => {
    const yaml = wideYaml('p').replace('down: {tier: 2}', 'down: {tier: 2}, further: {tier: 3}')
      .replace('l: {group: left, label: L}', 'l: {group: left, label: L, ports: [{name: q, side: bottom}]}')
      .replace('links: [[a.p, c.p]]', '  d: {group: further, label: D, ports: [{name: q, side: top}]}\nlinks: [[a.p, c.p], [l.q, d.q]]');
    const draft = copy(rows(await placed(yaml)));
    for (const [id, x, y] of [['up', 176, 0], ['outer', 0, 160], ['left', 100, 160], ['mid', 194, 160], ['down', 176, 340], ['further', 176, 500]] as const) {
      const group = draft.groups[id]!; moveGroup(draft, group, x - group.bounds!.x, y - group.bounds!.y);
    }
    draft.groups.outer!.bounds!.width = 95;
    rebuildBands(draft); rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
    draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
    const input = restoreLayoutModel(JSON.stringify(draft)), result = lanes(input);
    expect(result.nodes.l).toEqual(input.nodes.l); expect(result.nodes.a).toEqual(input.nodes.a);
    expect(result.lanes[0]!.x).toBe(input.nodes.a!.ports[0]!.anchor!.x);
    expect(result.groups.mid!.bounds!.x).toBeGreaterThanOrEqual(right(result.lanes[0]!.bounds));
    expect(validateSkeletonBands(result)).toEqual([]); validateLanes(result);
  });
  it('keeps earlier corridors clear while reserving several wide members', async () => {
    const port = 'long-port-name-that-requires-a-wide-reserved-corridor';
    const input = rows(await placed(wideYaml(port).replace(`links: [[a.${port}, c.p]]`, `links: [[a.${port}, c.p], [a.${port}, c.p], [a.${port}, c.p]]`)));
    const result = lanes(input); checkedMargins(input, result);
    expect(result.lanes).toHaveLength(3);
    expect(new Set(result.lanes.map(lane => lane.owner.kind === 'link' ? lane.owner.id : 'invalid')).size).toBe(3);
    const ordered = [...result.lanes].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.bounds.x).toBeGreaterThanOrEqual(right(ordered[i - 1]!.bounds));
  });
});

const flankYaml = `portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, size: {width: 200, height: 100}, ports: [{name: p, side: left}, {name: top, side: top}, {name: bottom, side: bottom}, {name: right, side: right}]}
  b: {group: f, ports: [{name: p, side: right}, {name: spare, side: top}, {name: bottom, side: bottom}]}
  c: {group: f, ports: [{name: spare, side: top}, {name: free, side: right}]}
links: [[b.p, a.p]]`;
describe('review: flank anchor movement scope', () => {
  it('rejects unused top-anchor changes after valid alignment on the peer and flank', async () => {
    const input = lanes(rows(await placed(flankYaml)));
    for (const id of ['a', 'b', 'c']) expect(() => withLayoutMutation(input, 'flanks', draft => {
      alignFlanks(draft); draft.nodes[id]!.ports.find(port => port.side === 'top')!.anchor!.x += 5;
    })).toThrow(/unrelated anchor/);
    expect(() => withLayoutMutation(input, 'flanks', draft => { alignFlanks(draft); draft.nodes.c!.ports.find(port => port.side === 'right')!.anchor!.y++; })).toThrow(/unrelated anchor/);
  });
  it('accepts common vertical flank translation and rejects movement of only one flank node', async () => {
    const input = lanes(rows(await placed(flankYaml)));
    const moved = withLayoutMutation(input, 'flanks', draft => { moveGroup(draft, draft.groups.f!, 0, 5); });
    for (const id of ['b', 'c']) {
      expect(moved.nodes[id]!.bounds!.y).toBe(input.nodes[id]!.bounds!.y + 5);
      expect(moved.nodes[id]!.ports.find(port => port.side === 'top')!.anchor!.y).toBe(input.nodes[id]!.ports.find(port => port.side === 'top')!.anchor!.y + 5);
    }
    expect(() => withLayoutMutation(input, 'flanks', draft => {
      const node = draft.nodes.c!; node.bounds!.y += 5; for (const port of node.ports) port.anchor!.y += 5;
    })).toThrow(/common vertical translation/);
    const aligned = flanks(input);
    expect(aligned.nodes.b!.bounds!.y - input.nodes.b!.bounds!.y).toBe(aligned.nodes.c!.bounds!.y - input.nodes.c!.bounds!.y);
  });
  it('permits only boundary shifts from actual growth on unrelated sides', async () => {
    const input = lanes(rows(await placed(flankYaml)));
    const grow = (draft: LayoutModel) => {
      const peer = draft.nodes.a!;
      peer.bounds!.width += 10; peer.size!.width += 10; peer.bounds!.height += 10; peer.size!.height += 10;
      peer.ports.find(port => port.side === 'right')!.anchor!.x += 10;
      peer.ports.find(port => port.side === 'bottom')!.anchor!.y += 10;
    };
    const grown = withLayoutMutation(input, 'flanks', grow);
    expect(grown.nodes.a!.ports.find(port => port.side === 'top')!.anchor).toEqual(input.nodes.a!.ports.find(port => port.side === 'top')!.anchor);
    expect(() => withLayoutMutation(input, 'flanks', draft => { grow(draft); draft.nodes.a!.ports.find(port => port.side === 'right')!.anchor!.y++; })).toThrow(/unrelated anchor/);
  });
});

describe('review: fixed-segment structural equality', () => {
  const reordered = (run: PathSegment): PathSegment => ({ lane: run.lane!, owner: { id: (run.owner as {id: string}).id, kind: 'link' }, to: {y: run.to.y, x: run.to.x}, from: {y: run.from.y, x: run.from.x} });
  it('restores object-key permutations and still rejects changed values', async () => {
    const input = lanes(rows(await placed(wideYaml('p')))), draft = copy(input);
    draft.links[0]!.fixedSegments = draft.links[0]!.fixedSegments!.map(reordered);
    expect(restoreLayoutModel(JSON.stringify(draft))).toEqual(input);
    draft.links[0]!.fixedSegments![0]!.to.y++;
    expect(() => restoreLayoutModel(JSON.stringify(draft))).toThrow(/Fixed lane segments/);
  });
  it('preserves the required traversal order after object-key normalization', async () => {
    const yaml = wideYaml('p').replace('down: {tier: 2}', 'extra: {tier: 2}, down: {tier: 3}')
      .replace('links: [[a.p, c.p]]', '  e: {group: extra, label: E}\nlinks: [[a.p, c.p]]');
    const input = lanes(rows(await placed(yaml))), draft = copy(input);
    draft.links[0]!.fixedSegments = draft.links[0]!.fixedSegments!.map(reordered);
    expect(draft.links[0]!.fixedSegments).toHaveLength(2);
    expect(restoreLayoutModel(JSON.stringify(draft))).toEqual(input);
    draft.links[0]!.fixedSegments!.reverse();
    expect(() => restoreLayoutModel(JSON.stringify(draft))).toThrow(/Fixed lane segments/);
  });
  it('uses structural equality for complete-path reservation containment', async () => {
    const draft = copy(lanes(rows(await placed(wideYaml('p'))))), link = draft.links[0]!;
    link.path = {owner: link.owner, layer: 'routed', fixed: false, segments: link.fixedSegments!.map(reordered)};
    expect(() => validateLanes(draft)).not.toThrow();
    link.path.segments[0]!.to.y++;
    expect(() => validateLanes(draft)).toThrow(/omits an immutable/);
  });
});

it('publishes exact common translations after repeated degree-64 corridor pushes', async () => {
  const input = rows(await placed(generateScaleYaml({ nodes: 300, shape: 'hub', degree: 61 }).yaml));
  const result = lanes(input);
  expect(result.lanes).toHaveLength(24);
  for (const group of Object.values(result.groups)) {
    const dx = group.bounds!.x - input.groups[group.id]!.bounds!.x;
    for (const id of group.nodes) {
      const before = input.nodes[id]!, after = result.nodes[id]!;
      expect(after.bounds).toEqual({ ...before.bounds!, x: before.bounds!.x + dx });
      for (const [i, port] of after.ports.entries()) {
        expect(port.anchor).toEqual({ x: before.ports[i]!.anchor!.x + dx, y: before.ports[i]!.anchor!.y });
      }
    }
  }
  validateLanes(result);
  expect(restoreLayoutModel(JSON.stringify(result))).toEqual(result);
}, 30000);
