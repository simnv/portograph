import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { OVERLAY_PILL_CLEARANCE } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

const EPS = 1e-6;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
/** Whether an axis-aligned segment reaches inside `box`, rather than only touching its edge. */
const enters = (one: Point, two: Point, box: Rect): boolean =>
  Math.max(one.x, two.x) > box.x + EPS && Math.min(one.x, two.x) < right(box) - EPS
  && Math.max(one.y, two.y) > box.y + EPS && Math.min(one.y, two.y) < bottom(box) - EPS;

const overlayOf = (model: LayoutModel): LayoutLink =>
  model.links.find(link => (link.layer ?? link.family) === 'overlay')!;
const pointsOf = (link: LayoutLink): Point[] =>
  [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];

/** Every node body and every drawn pill of the diagram, which is what the rule goes round. */
function shapes(model: LayoutModel): Rect[] {
  const boxes: Rect[] = [];
  for (const node of Object.values(model.nodes)) {
    if (node.bounds) boxes.push(node.bounds);
    for (const port of node.ports) if (port.pill && port.ref.anonymous !== true) boxes.push(port.pill.bounds);
  }
  return boxes;
}

/** The pill boxes of the link's own two ports. */
const endBoxes = (model: LayoutModel, link: LayoutLink): Rect[] =>
  [link.attachments!.from, link.attachments!.to].map(ref => model.nodes[ref.node]!.ports
    .find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal)!.pill!.bounds);

/**
 * Synthetics review ticket 01, the maintainer's two remarks of 2026-09-15. An overlay link is an
 * orthogonal path that leaves each port outward and goes round the shapes it would otherwise cross,
 * and the SVG draws exactly the polyline the draw.io export draws, because both read the model.
 */
describe('an overlay link is orthogonal in both renderers', () => {
  /** The `d` of the one path element of the SVG's overlay layer. */
  const overlayLine = (svg: string): string => {
    const layer = svg.slice(svg.indexOf('class="overlay-links"'), svg.indexOf('class="links"'));
    return /<path class="link-line overlay-line[^"]*" d="([^"]+)"/.exec(layer)![1]!;
  };

  it('answers "lo ports should be connected by orthogonal routed line?" on drawio-direct-lines', async () => {
    const model = await run(fixture('drawio-direct-lines'));
    const link = overlayOf(model), points = pointsOf(link);
    // The diagonal is gone: five runs, each on one axis, from anchor to anchor.
    expect(points).toHaveLength(6);
    for (const [index, point] of points.slice(1).entries()) {
      const before = points[index]!;
      expect(Math.abs(point.x - before.x) < EPS || Math.abs(point.y - before.y) < EPS).toBe(true);
    }
    // Nothing between the two cleared ends reaches inside any node body or any pill, so the mask
    // has nothing of this link to cut except the stub inside its own two pills.
    for (const [index, point] of points.slice(2, -1).entries()) {
      for (const box of shapes(model)) expect(enters(points[index + 1]!, point, box)).toBe(false);
    }
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('answers "line is not very visible" on drawio-overlay-sides', async () => {
    const model = await run(fixture('drawio-overlay-sides'));
    const link = overlayOf(model), points = pointsOf(link);
    expect(points).toHaveLength(5);
    for (const [index, point] of points.slice(2, -1).entries()) {
      for (const box of shapes(model)) expect(enters(points[index + 1]!, point, box)).toBe(false);
    }
    // What the remark was about: the straight line was 65 px of which the mask left 9.5 px. The
    // drawn path is longer than the straight one now, and all of it but the two stubs is visible.
    const straight = Math.hypot(points.at(-1)!.x - points[0]!.x, points.at(-1)!.y - points[0]!.y);
    const drawn = points.slice(1).reduce((total, point, index) =>
      total + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
    expect(drawn).toBeGreaterThan(straight);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('falls back to the way that clears its own two pills when a body blocks every one', async () => {
    const model = await run(fixture('overlay-blocked-by-a-body'));
    const link = overlayOf(model), points = pointsOf(link);
    const middle = points.slice(2, -1).map((point, index) => [points[index + 1]!, point] as const);
    // Clear of both pill boxes — the principle that survives — and across a body the mask cuts.
    for (const [one, two] of middle) {
      for (const box of endBoxes(model, link)) expect(enters(one, two, box)).toBe(false);
    }
    const bodies = Object.values(model.nodes).map(node => node.bounds!);
    expect(middle.some(([one, two]) => bodies.some(box => enters(one, two, box)))).toBe(true);
    const svg = render(model);
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    for (const box of bodies) {
      expect(mask).toContain(`x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`);
    }
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('draws one geometry in both renderers, and states none of its own in either', async () => {
    const model = await run(fixture('drawio-direct-lines'));
    const link = overlayOf(model), points = pointsOf(link), canvas = model.canvas!;
    // The SVG paints the model's polyline verbatim, as one chain from anchor to anchor.
    const drawn = [...overlayLine(render(model)).matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)]
      .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(drawn).toEqual(points);
    // The draw.io connector states the same interior points, in page space. Its two ends are pinned
    // to the pill heads the first and last runs pass through, so the whole drawn polyline is the
    // model's with those two stubs shortened — never a line the exporter invented.
    const file = drawio(model);
    const cell = new RegExp(`<mxCell id="pg-link~${link.id}"[^>]*>([\\s\\S]*?)</mxCell>`).exec(file)![1]!;
    expect([...cell.matchAll(/<mxPoint x="([-\d.]+)" y="([-\d.]+)"/g)].map(match =>
      ({ x: Number(match[1]), y: Number(match[2]) })))
      .toEqual(points.slice(1, -1).map(point => ({ x: point.x - canvas.x, y: point.y - canvas.y })));
    // And the one number the rule introduces is the endpoint mark's own diameter, nothing new: the
    // source is a top-side pill, so the first turn sits exactly one clearance above its head.
    const head = endBoxes(model, link)[0]!;
    expect(head.y - points[1]!.y).toBeCloseTo(OVERLAY_PILL_CLEARANCE, 9);
  }, 60000);
});
