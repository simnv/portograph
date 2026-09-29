import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { groupConsumers } from '../../src/score/model.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const holds = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x + 1e-6 && outer.y <= inner.y + 1e-6
  && right(outer) >= right(inner) - 1e-6 && bottom(outer) >= bottom(inner) - 1e-6;
/**
 * The straight runs of a path: consecutive collinear pieces count once. The router never merges pieces
 * across an ownership boundary (a lane, a routed gap), so a link that crosses two sub-tiers is five
 * pieces on one vertical line; the drawn line is one run.
 */
const runs = (link: { path?: { segments: { from: { x: number; y: number }; to: { x: number; y: number } }[] } }): number => {
  const direction = (s: { from: { x: number; y: number }; to: { x: number; y: number } }): string => Math.abs(s.from.x - s.to.x) < 1e-6 ? 'v' : 'h';
  const pieces = link.path!.segments.filter(s => Math.hypot(s.from.x - s.to.x, s.from.y - s.to.y) > 1e-6);
  return pieces.filter((s, i) => i === 0 || direction(s) !== direction(pieces[i - 1]!)).length;
};
const codes = (model: Awaited<ReturnType<typeof run>>): string[] => model.diagnostics.map(diagnostic => diagnostic.code);

describe('transit through a frame', () => {
  it('a link that ends in a leaf child stands beside the parent member and needs no lane', async () => {
    const model = await run('a-link-transits-its-own-frame');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(codes(model)).not.toContain('LANE_MARGIN_EXPANDED');
    // Ticket 28 replaced the rule this test was written for: the leaf child `edge` keeps its depth rank (1) and stands
    // beside the switch of `site#1`, so the link from the second router crosses no cell and owns no lane.
    expect(model.frames!.map(frame => frame.id).sort()).toEqual(['edge', 'site']);
    const frame = model.frames!.find(item => item.id === 'site')!;
    expect(frame.cells).toEqual(['site#0', 'site#1']);
    expect(model.frames!.find(item => item.id === 'edge')!.cells).toEqual(['edge#1']);
    const link = model.links.find(item => item.attachments!.from.node === 'rt2' && item.attachments!.to.node === 'wan')!;
    expect(link.path).toBeDefined();
    expect(runs(link)).toBeLessThanOrEqual(3);
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id)).toEqual([]);
    for (const segment of link.path!.segments) for (const end of [segment.from, segment.to]) {
      expect(end.x).toBeGreaterThanOrEqual(frame.box.x - 1e-6);
      expect(end.x).toBeLessThanOrEqual(right(frame.box) + 1e-6);
    }
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G6', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
    expect(model.links.every(item => item.path !== undefined)).toBe(true);
    expect(model.links.length).toBe(model.document.links.length);
  }, 60000);

  it('a link to a parent member below a child frame runs beside the child, inside the parent', async () => {
    const model = await run('a-link-transits-a-child-frame');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    // Zone 1 is wider than the room between the lane and its feed, so it takes a jog and the placement
    // reports the margin expansion and the non-convergence. The same happens for plain groups; this
    // ticket asserts the transit, not that jog.
    const [parent, child] = [model.frames!.find(item => item.id === 'site')!, model.frames!.find(item => item.id === 'zone')!];
    const link = model.links.find(item => item.attachments!.from.node === 'isp2' && item.attachments!.to.node === 'o')!;
    expect(runs(link)).toBeLessThanOrEqual(3);
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      // Outside the child frame, inside the parent frame.
      expect(lane.bounds.x + lane.bounds.width <= child.box.x + 1e-6 || lane.bounds.x >= right(child.box) - 1e-6).toBe(true);
      expect(lane.bounds.x).toBeGreaterThanOrEqual(parent.box.x - 1e-6);
      expect(right(lane.bounds)).toBeLessThanOrEqual(right(parent.box) + 1e-6);
    }
    // Every part of the run that lies in the child's rows stays outside the child frame; the parent holds it.
    for (const segment of link.path!.segments) {
      const [top, low] = [Math.min(segment.from.y, segment.to.y), Math.max(segment.from.y, segment.to.y)];
      if (low > child.box.y && top < bottom(child.box)) for (const end of [segment.from, segment.to]) {
        expect(end.x <= child.box.x + 1e-6 || end.x >= right(child.box) - 1e-6).toBe(true);
        expect(end.x).toBeGreaterThanOrEqual(parent.box.x - 1e-6);
        expect(end.x).toBeLessThanOrEqual(right(parent.box) + 1e-6);
      }
    }
    expect(holds(parent.box, child.box)).toBe(true);
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G6', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
    expect(model.links.length).toBe(model.document.links.length);
  }, 60000);

  it('a link foreign to a two-rank frame keeps one lane x beside the whole frame', async () => {
    const model = await run('a-foreign-lane-stands-outside-the-frame');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frame = model.frames!.find(item => item.id === 'mid')!;
    expect(frame.cells).toEqual(['mid#0', 'mid#1']);
    const link = model.links.find(item => item.attachments!.from.node === 'u1' && item.attachments!.to.node === 'l0')!;
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    expect(lanes.map(lane => lane.group).sort()).toEqual(['mid#0', 'mid#1']);
    // One x for the whole crossing, outside the frame box by at least the group-edge margin, in every sub-tier.
    expect(new Set(lanes.map(lane => lane.x)).size).toBe(1);
    const x = lanes[0]!.x, outside = x >= right(frame.box) + 10 - 1e-6 || x <= frame.box.x - 10 + 1e-6;
    expect(outside).toBe(true);
    for (const lane of lanes) expect(lane.bounds.x >= right(frame.box) - 1e-6 || right(lane.bounds) <= frame.box.x + 1e-6).toBe(true);
    // Both cells stand on the same side of the lane.
    const cells = frame.cells.map(id => model.groups[id]!.bounds!);
    expect(new Set(cells.map(box => (box.x + box.width / 2 < x ? 'left' : 'right'))).size).toBe(1);
    // The drawn run never enters the frame box.
    for (const segment of link.path!.segments) {
      const [top, low] = [Math.min(segment.from.y, segment.to.y), Math.max(segment.from.y, segment.to.y)];
      if (low > frame.box.y && top < bottom(frame.box)) for (const end of [segment.from, segment.to]) {
        expect(end.x <= frame.box.x - 10 + 1e-6 || end.x >= right(frame.box) + 10 - 1e-6).toBe(true);
      }
    }
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G6', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
    expect(model.links.length).toBe(model.document.links.length);
  }, 60000);

  it('a link foreign to two neighbouring frames runs in the gap between them', async () => {
    const model = await run('two-frames-share-a-transit-between-them');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const [east, west] = [model.frames!.find(item => item.id === 'east')!, model.frames!.find(item => item.id === 'west')!];
    const link = model.links.find(item => item.attachments!.from.node === 'u1' && item.attachments!.to.node === 'l0')!;
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    expect(lanes.length).toBe(3);
    expect(new Set(lanes.map(lane => lane.x)).size).toBe(1);
    const [left, other] = east.box.x < west.box.x ? [east, west] : [west, east];
    // Between the frames, at least the group-edge margin from each, and the frames do not overlap.
    expect(right(left.box)).toBeLessThanOrEqual(other.box.x + 1e-6);
    for (const lane of lanes) {
      expect(lane.x).toBeGreaterThanOrEqual(right(left.box) + 10 - 1e-6);
      expect(lane.x).toBeLessThanOrEqual(other.box.x - 10 + 1e-6);
    }
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G6', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
    expect(model.links.length).toBe(model.document.links.length);
  }, 60000);

  it('a lane exempts its owner from a frame only when the link ends in the frame', async () => {
    const own = await run('a-link-transits-its-own-frame');
    const inside = own.links.find(item => item.attachments!.from.node === 'rt2' && item.attachments!.to.node === 'wan')!;
    expect(groupConsumers(own, 'site')).toContain(inside.id);
    const foreign = await run('a-foreign-lane-stands-outside-the-frame');
    const passing = foreign.links.find(item => item.attachments!.from.node === 'u1' && item.attachments!.to.node === 'l0')!;
    // The link owns a lane beside both cells of `mid`, and it ends in none of its nodes: it stays an obstacle.
    expect(foreign.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === passing.id).length).toBe(2);
    expect(groupConsumers(foreign, 'mid')).not.toContain(passing.id);
    // The feed of the frame does end in it.
    const feed = foreign.links.find(item => item.attachments!.from.node === 'u0' && item.attachments!.to.node === 'a0')!;
    expect(groupConsumers(foreign, 'mid')).toContain(feed.id);
  }, 60000);

  it('an own-frame lane pinned beside a neighbour frame is hosted in a cell of its own frame or its child', async () => {
    const model = await run('an-own-frame-lane-stands-beside-a-neighbour-frame');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const [east, west, edge] = [model.frames!.find(item => item.id === 'east')!, model.frames!.find(item => item.id === 'west')!, model.frames!.find(item => item.id === 'edge')!];
    // Ticket 28: `edge` is not a leaf here (`w-acc` links to `w-host` below it), so it pushes `w-dist` down. The link that
    // skips the rank ends in `west` and crosses the cell of `edge`; the lane stands outside the `edge` frame and only the
    // transit lanes of `west` make the `west` frame hold it.
    const link = model.links.find(item => item.attachments!.from.node === 'w-gw' && item.attachments!.to.node === 'w-dist')!;
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      // The lane's group is a cell of the owning frame or of its child frame, and the owning frame's box holds the lane.
      expect([...west.cells, ...edge.cells]).toContain(lane.group);
      expect(holds(west.box, { ...lane.bounds, y: west.box.y, height: west.box.height })).toBe(true);
      // It stays outside the neighbour frame.
      expect(lane.bounds.x >= right(east.box) - 1e-6 || right(lane.bounds) <= east.box.x + 1e-6).toBe(true);
    }
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
  }, 60000);

  it('a lane push moves every cell of a frame by one dx or is refused, and a frame stays in its column', async () => {
    const model = await run('two-frames-take-two-transits-and-keep-their-columns');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frames = ['east', 'west'].map(id => model.frames!.find(item => item.id === id)!);
    // Every cell of a frame moves by one dx: a frame has all its cells named in the expansion warnings or none.
    const moved = new Set(model.diagnostics.filter(diagnostic => diagnostic.code === 'LANE_MARGIN_EXPANDED').flatMap(diagnostic => (diagnostic.owners ?? []).flatMap(owner => (owner.kind === 'barCross' ? [] : [owner.id]))));
    for (const frame of frames) expect(frame.cells.filter(cell => moved.has(cell)).length % frame.cells.length).toBe(0);
    // Each cell keeps the axis of its column: the centres of a frame's cells are within one column slack.
    for (const frame of frames) {
      const centres = frame.cells.map(cell => model.groups[cell]!.bounds!).map(box => box.x + box.width / 2);
      expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(COLUMN_SLACK + 1e-6);
    }
    expect(right(frames[0]!.box)).toBeLessThanOrEqual(frames[1]!.box.x + 1e-6);
    // The lanes lie between the columns or outside them, never inside a frame box.
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link');
    expect(lanes.length).toBe(6);
    for (const lane of lanes) for (const frame of frames) {
      expect(lane.bounds.x >= right(frame.box) - 1e-6 || right(lane.bounds) <= frame.box.x + 1e-6).toBe(true);
    }
    const first = lanes[0]!.owner;
    expect(new Set(lanes.filter(lane => lane.owner.kind === 'link' && first.kind === 'link' && lane.owner.id === first.id).map(lane => lane.x)).size).toBe(1);
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
  }, 60000);
});
