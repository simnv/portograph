import { describe, expect, it } from 'vitest';
import type { LayoutLink, LayoutModel, PathSegment } from '../../src/model/layout.js';
import { runClearance } from '../../src/score/sheaf.js';
import { segmentDistance } from '../../src/score/geometry.js';

/**
 * The sheaf zone (dense-16x9 ticket 04, owner ruling 2026-11-15): two chords of one solid block that share a node are excused for
 * `min(max(body.width, body.height), lengthA / 2, lengthB / 2)` from their ports on it; each remainder is measured against the whole other chord.
 */
const hub = { bounds: { x: 0, y: -40, width: 100, height: 40 } };
const port = (node: string, name: string, x: number, y: number) => ({ ref: { node, name }, anchor: { x, y } });
function model(): LayoutModel {
  return { nodes: {
    hub: { ...hub, ports: [port('hub', 'p1', 40, 0), port('hub', 'p2', 46, 0)] },
    far1: { bounds: { x: 0, y: 400, width: 100, height: 40 }, ports: [port('far1', 'q', 40, 400)] },
    far2: { bounds: { x: 200, y: 400, width: 100, height: 40 }, ports: [port('far2', 'q', 46 + 60, 400)] },
  } } as unknown as LayoutModel;
}
const link = (id: string, to: string, name: string, family = 'block:a'): LayoutLink =>
  ({ id, solidBlock: true, fanFamily: family, attachments: { from: { node: 'hub', name }, to: { node: to, name: 'q' } } }) as unknown as LayoutLink;
const run = (item: LayoutLink, from: { x: number; y: number }, to: { x: number; y: number }) =>
  ({ link: item, stroke: 1.5, segment: { from, to, owner: { kind: 'link', id: item.id }, straight: true } as PathSegment });

describe('runClearance: the sheaf zone of a solid block', () => {
  const a = link('a', 'far1', 'p1'), b = link('b', 'far2', 'p2');
  const ra = run(a, { x: 40, y: 0 }, { x: 40, y: 400 }), rb = run(b, { x: 46, y: 0 }, { x: 106, y: 400 });
  it('excuses the near-node stretches and measures each remainder against the whole other chord', () => {
    const whole = segmentDistance(ra.segment, rb.segment) - 1.5;
    expect(whole).toBeLessThan(10);
    // The zone is min(max(100, 40), 200, 201.1) = 100 px from the ports: past it the chords stand 6 + 100 * 60 / 404.5 px apart.
    const clearance = runClearance(model(), ra, rb);
    expect(clearance).toBeGreaterThan(whole);
    const remainder = { ...rb.segment, from: { x: 46 + 60 * 100 / Math.hypot(60, 400), y: 400 * 100 / Math.hypot(60, 400) } };
    expect(clearance).toBeCloseTo(Math.min(segmentDistance(remainder, ra.segment), segmentDistance({ ...ra.segment, from: { x: 40, y: 100 } }, rb.segment)) - 1.5, 9);
  });
  it('excuses nothing for two blocks, a link that is no block member, or a run that is not the whole chord', () => {
    const whole = segmentDistance(ra.segment, rb.segment) - 1.5;
    expect(runClearance(model(), ra, run(link('b', 'far2', 'p2', 'block:other'), rb.segment.from, rb.segment.to))).toBeCloseTo(whole, 9);
    const plain = { ...link('b', 'far2', 'p2'), solidBlock: undefined } as unknown as LayoutLink;
    expect(runClearance(model(), ra, run(plain, rb.segment.from, rb.segment.to))).toBeCloseTo(whole, 9);
    expect(runClearance(model(), ra, run(b, { x: 46, y: 10 }, { x: 106, y: 400 }))).toBeCloseTo(segmentDistance(ra.segment, { ...rb.segment, from: { x: 46, y: 10 } }) - 1.5, 9);
  });
  it('never excuses parallel chords, collinear overlap included', () => {
    const c = { ...link('c', 'far1', 'p2'), attachments: { from: { node: 'hub', name: 'p2' }, to: { node: 'far1', name: 'q2' } } } as unknown as LayoutLink, m = model();
    m.nodes.far1!.ports.push(port('far1', 'q2', 46, 400) as never);
    const rc = run(c, { x: 46, y: 0 }, { x: 46, y: 400 });
    expect(runClearance(m, ra, rc)).toBeCloseTo(6 - 1.5, 9);
  });
});
