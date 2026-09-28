import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
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
  it('a link that ends in the last rank of its frame runs inside the frame', async () => {
    const model = await run('a-link-transits-its-own-frame');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(codes(model)).not.toContain('LANE_MARGIN_EXPANDED');
    expect(codes(model)).not.toContain('PLACEMENT_NON_CONVERGENCE');
    expect(model.frames!.map(frame => frame.id)).toEqual(['site']);
    expect(model.frames![0]!.cells).toEqual(['site#0', 'site#1', 'site#2']);
    const frame = model.frames![0]!;
    const link = model.links.find(item => item.attachments!.from.node === 'rt2' && item.attachments!.to.node === 'wan')!;
    expect(link.path).toBeDefined();
    expect(runs(link)).toBeLessThanOrEqual(3);
    // The run crosses the sub-tier of the switch's cell, so it has a lane beside that cell, inside the frame.
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    expect(lanes.map(lane => lane.group)).toEqual(['site#1']);
    expect(holds(frame.box, { ...lanes[0]!.bounds, y: frame.box.y, height: frame.box.height })).toBe(true);
    for (const segment of link.path!.segments) for (const end of [segment.from, segment.to]) {
      expect(end.x).toBeGreaterThanOrEqual(frame.box.x - 1e-6);
      expect(end.x).toBeLessThanOrEqual(right(frame.box) + 1e-6);
    }
    const gates = score(model).snapshot.gates;
    for (const gate of ['G2', 'G6', 'G9'] as const) expect(gates[gate].violations).toEqual([]);
    expect(model.links.every(item => item.path !== undefined)).toBe(true);
    expect(model.removedLinks ?? []).toEqual([]);
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
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);
});
