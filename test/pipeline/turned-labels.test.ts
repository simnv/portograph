import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { areaSegmentDistance, orientedBounds, type OrientedBox } from '../../src/geometry/oriented.js';
import { rectOverlap } from '../../src/geometry/planar.js';
import { LINK_LABEL_GEOMETRY, labelRunWindows, type LinkRun } from '../../src/layout/link-labels.js';
import { labelCrossesBorder } from '../../src/score/model.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** A small deterministic generator (mulberry32), so the property test is the same on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('the windows of a diagonal run agree with labelCrossesBorder and the G3 segment distance on random boxes and links (ticket 20, R1)', () => {
  const next = random(20);
  const owner = { kind: 'link' as const, id: 'link-1' };
  const { halo, borderMargin, shortenMargin } = LINK_LABEL_GEOMETRY;
  let inside = 0, outside = 0;
  for (let trial = 0; trial < 150; trial++) {
    const from = { x: next() * 200, y: next() * 200 }, to = { x: 200 + next() * 300, y: 250 + next() * 300 * (next() < 0.5 ? -1 : 1) };
    const segment = { from, to, owner }, length = Math.hypot(to.x - from.x, to.y - from.y);
    const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length, degrees = Math.atan2(uy, ux) * 180 / Math.PI;
    const boxes = Array.from({ length: 3 }, () => ({ x: next() * 450, y: next() * 450, width: 20 + next() * 150, height: 20 + next() * 150 }));
    const links: LinkRun[] = Array.from({ length: 2 }, () => ({ segment: { from: { x: next() * 500, y: next() * 500 }, to: { x: next() * 500, y: next() * 500 } }, clearance: 0.75 }));
    const across = 15, windows = labelRunWindows(boxes, segment, across, links)!;
    // The turned box of a text from `a` to `b` along the run, its halo on, grown by `grow` at each end along the run.
    const box = (a: number, b: number, grow: number): OrientedBox => ({ centre: { x: from.x + ux * (a + b) / 2, y: from.y + uy * (a + b) / 2 },
      width: b - a + 2 * halo + 2 * grow, height: across, degrees });
    for (let sample = 0; sample < 40; sample++) {
      const width = 10 + next() * 60, start = shortenMargin + next() * (length - 2 * shortenMargin - width);
      if (start < shortenMargin) continue;
      const end = start + width;
      const inWindow = windows.some(window => start >= window.from - 1e-9 && end <= window.to + 1e-9);
      // In a window: the halo box crosses no border by the border margin along the run, and stays the clearance off every link.
      const crossing = (grow: number) => boxes.some(item => labelCrossesBorder(box(start, end, grow), item));
      const touching = links.some(link => areaSegmentDistance({ ...link.segment, owner }, box(start, end, 0)) < link.clearance + 1e-9);
      if (inWindow) {
        inside++;
        expect(crossing(borderMargin - 1e-6)).toBe(false);
        expect(touching).toBe(false);
      } else {
        // Out of every window: the halo box grown by the border margin crosses a border, or the halo box comes near a link.
        outside++;
        expect(crossing(borderMargin + 1e-6) || links.some(link => areaSegmentDistance({ ...link.segment, owner }, box(start, end, 1e-6)) < link.clearance + 1e-6)).toBe(true);
      }
    }
  }
  expect(inside).toBeGreaterThan(100);
  expect(outside).toBeGreaterThan(100);
});

it('G3 reads a turned label by its turned rectangle: a real overlap with a node and a routed segment fails, a corner of the upright box does not (ticket 20)', async () => {
  const model = await run(fixture('a-diagonal-label-rises-past-a-third-group'));
  const node = model.nodes['u']!.bounds!, drop = model.links.find(link => link.id === 'link-3')!.path!.segments[0]!;
  const turned = (id: string, centre: { x: number; y: number }, degrees: number) => {
    const area = { centre, width: 60, height: 10, degrees };
    return { id, owner: { kind: 'link' as const, id: 'link-3' }, layer: 'routed' as const, role: 'link' as const, text: 'x',
      textRotation: degrees, turnedSize: { width: 60, height: 10 }, bounds: orientedBounds(area) };
  };
  const hits = (label: ReturnType<typeof turned>): string[] => {
    const copy = structuredClone(model);
    copy.labels.push(label);
    return score(copy).snapshot.gates.G3.violations.filter(item => item.elements[0] === label.id).map(item => item.elements[1]!);
  };
  // Across the node's middle and across the drop: both are hits, and G3 fails.
  expect(hits(turned('label:test:node', { x: node.x + node.width / 2, y: node.y + node.height / 2 }, 30))).toContain('u');
  expect(hits(turned('label:test:drop', { x: drop.from.x, y: (drop.from.y + drop.to.y) / 2 }, 30))).toContain('link-3');
  // Turned by 45° off the node's top-left corner: the upright box reaches into the node, the turned rectangle stays outside it.
  const beside = turned('label:test:corner', { x: node.x - 22, y: node.y - 22 }, -45);
  expect(rectOverlap(beside.bounds, node)).toBe(true);
  expect(hits(beside)).not.toContain('u');
}, 120000);
