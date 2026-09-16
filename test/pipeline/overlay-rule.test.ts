import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { OVERLAY_PILL_CLEARANCE } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

const EPS = 1e-6;
const right = (box: Rect): number => box.x + box.width;

/**
 * Whether a segment of any angle reaches inside `box`, rather than only touching its edge: the
 * parameter range that survives clipping against the box's four shrunken slabs. A diagonal needs
 * this — its bounding box overlaps shapes the line itself misses.
 */
function enters(one: Point, two: Point, box: Rect): boolean {
  let low = 0, high = 1;
  const dx = two.x - one.x, dy = two.y - one.y;
  const slabs: [number, number][] = [[-dx, one.x - (box.x + EPS)], [dx, right(box) - EPS - one.x],
    [-dy, one.y - (box.y + EPS)], [dy, box.y + box.height - EPS - one.y]];
  for (const [rate, room] of slabs) {
    if (Math.abs(rate) < 1e-12) { if (room < 0) return false; continue; }
    const at = room / rate;
    if (rate < 0) { if (at > high) return false; if (at > low) low = at; }
    else { if (at < low) return false; if (at < high) high = at; }
  }
  return high - low > EPS;
}

const axisAligned = (one: Point, two: Point): boolean =>
  Math.abs(one.x - two.x) < EPS || Math.abs(one.y - two.y) < EPS;
const span = (one: Point, two: Point): number => Math.hypot(two.x - one.x, two.y - one.y);

const overlayOf = (model: LayoutModel): LayoutLink =>
  model.links.find(link => (link.layer ?? link.family) === 'overlay')!;
const pointsOf = (link: LayoutLink): Point[] =>
  [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];

/** The mask element of a render, which is what keeps a shape the overlay draws through readable. */
const maskOf = (svg: string): string => svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
const rectAttributes = (box: Rect): string =>
  `x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`;

/** The pill boxes of the link's own two ports. */
const endBoxes = (model: LayoutModel, link: LayoutLink): Rect[] =>
  [link.attachments!.from, link.attachments!.to].map(ref => model.nodes[ref.node]!.ports
    .find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal)!.pill!.bounds);

/**
 * Stress ticket 20, the maintainer's decision of 2026-09-16: an overlay link is a short stub out of
 * each port and one straight segment between the two stub ends, at whatever angle. It supersedes the
 * orthogonal staircase of synthetics review ticket 01 for the overlay family only — the routed
 * family is orthogonal still. The SVG draws exactly the polyline the draw.io export draws, because
 * both read the model.
 */
describe('an overlay link is a stub and one diagonal, in both renderers', () => {
  /** The `d` of the one path element of the SVG's overlay layer. */
  const overlayLine = (svg: string): string => {
    const layer = svg.slice(svg.indexOf('class="overlay-links"'), svg.indexOf('class="links"'));
    return /<path class="link-line overlay-line[^"]*" d="([^"]+)"/.exec(layer)![1]!;
  };

  /** How far a point sits outside a box; 0 anywhere inside it. */
  const clearOf = (at: Point, box: Rect): number => Math.hypot(
    Math.max(0, box.x - at.x, at.x - right(box)), Math.max(0, box.y - at.y, at.y - (box.y + box.height)));

  /**
   * The shape of the rule, measured on a published path: a stub out of each port, one segment
   * between the two stub ends, and each stub exactly `OVERLAY_PILL_CLEARANCE` beyond its own pill.
   */
  const stubAndOne = (model: LayoutModel, link: LayoutLink): Point[] => {
    const points = pointsOf(link);
    expect(points).toHaveLength(4);
    const [head, tail] = endBoxes(model, link) as [Rect, Rect];
    expect(axisAligned(points[0]!, points[1]!)).toBe(true);
    expect(axisAligned(points[2]!, points[3]!)).toBe(true);
    expect(clearOf(points[1]!, head)).toBeCloseTo(OVERLAY_PILL_CLEARANCE, 9);
    expect(clearOf(points[2]!, tail)).toBeCloseTo(OVERLAY_PILL_CLEARANCE, 9);
    return points;
  };

  it('draws one diagonal between the stub ends of a pair that does not line up, on drawio-direct-lines', async () => {
    // The maintainer's 2026-09-15 remark asked the `b.lo`–`c.lo` overlay not to be a bare diagonal
    // from anchor to anchor; ticket 01 answered it with a staircase, and the 2026-09-16 decision
    // replaces the staircase with a stub at each end and one straight segment between them. The two
    // ports are a bottom pill and a top pill 120 px apart on x, so that segment is angled.
    const model = await run(fixture('drawio-direct-lines'));
    const link = overlayOf(model), points = stubAndOne(model, link);
    expect(span(points[0]!, points[1]!)).toBeCloseTo(16, 9);
    expect(span(points[2]!, points[3]!)).toBeCloseTo(16, 9);
    expect(axisAligned(points[1]!, points[2]!)).toBe(false);
    // The diagonal draws through what is in its way — two node bodies here — and the mask carries
    // them. Making it dodge is stress ticket 21, which moves the nodes instead.
    const bodies = Object.values(model.nodes).map(node => node.bounds!);
    expect(bodies.filter(box => enters(points[1]!, points[2]!, box))).toHaveLength(2);
    const mask = maskOf(render(model));
    for (const box of bodies) expect(mask).toContain(rectAttributes(box));
    // Review finding 3 of ticket 01, unchanged: one drawn label crosses the run and the mask cuts
    // the overlay under it. A label that is drawn beats a line that is whole.
    const labels = model.labels.filter(label => label.role === 'link' && !label.omitted && label.bounds);
    expect(labels).toHaveLength(1);
    expect(enters(points[1]!, points[2]!, labels[0]!.bounds!)).toBe(true);
    expect(labels[0]!.bounds!.height).toBeLessThan(12);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('stays one straight segment for a pair that lines up, and turns nowhere', async () => {
    // Stress ticket 20, question 2. `goldens/synthetic/overlay-ports-that-line-up.yaml`: two `sync`
    // ports facing each other on one x. Both stubs are collinear with the segment between them, so
    // `straighten` drops them and the path is the single segment the orthogonal derivation drew —
    // measured against it, the polyline, the canvas and Q are identical to the last digit.
    const model = await run(fixture('overlay-ports-that-line-up'));
    const points = pointsOf(overlayOf(model));
    expect(points).toEqual([{ x: 57.336669921875, y: 107 }, { x: 57.336669921875, y: 232 }]);
    expect(score(model).snapshot.Q).toBe(0.8335929892966935);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('is a stub and one diagonal for a pair that does not line up', async () => {
    // The same pair with the target on a second node, 75.51 px away on x.
    // `goldens/synthetic/overlay-ports-that-do-not-line-up.yaml` is the shape the maintainer chose.
    const model = await run(fixture('overlay-ports-that-do-not-line-up'));
    const link = overlayOf(model), points = stubAndOne(model, link);
    expect(span(points[0]!, points[1]!)).toBeCloseTo(16, 9);
    expect(span(points[2]!, points[3]!)).toBeCloseTo(16, 9);
    expect(span(points[1]!, points[2]!)).toBeCloseTo(119.7948, 3);
    expect(axisAligned(points[1]!, points[2]!)).toBe(false);
    expect(score(model).snapshot.Q).toBe(0.8391492903118092);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('answers "line is not very visible" on drawio-overlay-sides', async () => {
    const model = await run(fixture('drawio-overlay-sides'));
    const link = overlayOf(model), points = stubAndOne(model, link);
    expect(axisAligned(points[1]!, points[2]!)).toBe(false);
    // What the remark was about: the straight line was 65 px of which the mask left 9.5 px. A left
    // port and a top port make the drawn path longer than the straight one, and all of it outside
    // the two pills is visible.
    const straight = span(points[0]!, points.at(-1)!);
    const drawn = points.slice(1).reduce((total, point, index) => total + span(points[index]!, point), 0);
    expect(straight).toBeCloseTo(61.5067, 3);
    expect(drawn).toBeCloseTo(90.0250, 3);
    expect(drawn).toBeGreaterThan(straight);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('gives up its stubs rather than double back, on overlay-blocked-by-a-body', async () => {
    // Two ports on the same side of two nodes standing side by side: each stub points away from the
    // other end. On two different lines the rule keeps both stubs and the segment between them
    // doubles back as a diagonal, drawing through the body between them — which is what the mask is
    // for, and what the fixture was built to hold.
    const model = await run(fixture('overlay-blocked-by-a-body'));
    const link = overlayOf(model), points = stubAndOne(model, link);
    expect(axisAligned(points[1]!, points[2]!)).toBe(false);
    const bodies = Object.values(model.nodes).map(node => node.bounds!);
    expect(bodies.some(box => enters(points[1]!, points[2]!, box))).toBe(true);
    const mask = maskOf(render(model));
    for (const box of bodies) expect(mask).toContain(rectAttributes(box));
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('lets a described overlay link ride its diagonal, and diagnoses the room it cannot reserve', async () => {
    // Stress ticket 20, question 4. `reserveLinkLabelRoom` measures an overlay link's room along the
    // longest run of the derived path. With one diagonal that run is the diagonal, and 7f grows room
    // on one axis only — so it reserves nothing, says so, and the stage 9 ladder places the label.
    // The label still rides the run: upright text centred on the diagonal's own midpoint.
    const model = await run(fixture('labelled-overlay-run'));
    const link = overlayOf(model), points = stubAndOne(model, link);
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === link.id)!;
    expect(label.omitted).toBeUndefined();
    expect(label.text).toBe('time synchronisation from the site clock');
    expect(label.textRotation ?? 0).toBe(0);
    expect(model.diagnostics.map(item => item.code)).not.toContain('LINK_LABEL_OMITTED');
    expect(model.diagnostics.map(item => item.code)).toContain('LINK_LABEL_ROOM_UNRESERVED');
    // The longest run is the diagonal, and the label box is centred on it, one normal gap above.
    const runs = link.path!.segments.map(segment => ({ segment, length: span(segment.from, segment.to) }));
    const longest = runs.reduce((best, item) => item.length > best.length ? item : best).segment;
    expect(axisAligned(longest.from, longest.to)).toBe(false);
    expect(label.bounds!.x + label.bounds!.width / 2).toBeCloseTo((longest.from.x + longest.to.x) / 2, 9);
    expect(label.bounds!.y + label.bounds!.height).toBeCloseTo(
      (longest.from.y + longest.to.y) / 2 - LINK_LABEL_GEOMETRY.normalGap - 0.75, 9);
    // And clear of the source pill it used to overhang, by more than one shorten margin.
    expect(label.bounds!.x - right(endBoxes(model, link)[0]!)).toBeGreaterThan(LINK_LABEL_GEOMETRY.shortenMargin);
    expect(points[1]!.y).toBeCloseTo(points[0]!.y, 9);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('states one polyline for a pair of ports, whichever end the author wrote first', async () => {
    // Review finding 1, through the whole pipeline. A route that turned back on itself by a quarter
    // of a pixel used to survive here, and which end it turned back at depended on the order the
    // author wrote the two ports in — so one diagram had two polylines and draw.io got two waypoints
    // 0.25 px apart. `route/validate` now reads `retraces` over an overlay path as well.
    const both = `portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  a: {group: upper, ports: [{name: d1, side: bottom}, {name: lo, side: left}]}
  b: {group: lower, ports: [{name: u1, side: top}, {name: lo, side: left}]}
  c: {group: lower, ports: [{name: lo, side: left}]}
links:
  - [a.d1, b.u1]
  - [b.lo, c.lo, {route: overlay}]
  - [REVERSIBLE, {route: overlay}]`;
    const forward = await run(both.replace('REVERSIBLE', 'b.lo, a.lo'));
    const backward = await run(both.replace('REVERSIBLE', 'a.lo, b.lo'));
    // `link-3` is the third declaration, the one written both ways round.
    const pick = (model: LayoutModel): Point[] => pointsOf(model.links.find(link => link.id === 'link-3')!);
    expect(pick(forward)).toEqual([...pick(backward)].reverse());
    for (const model of [forward, backward]) {
      for (const link of model.links.filter(item => (item.layer ?? item.family) === 'overlay')) {
        const points = pointsOf(link);
        const steps = points.slice(1).map((point, index) =>
          ({ x: Math.sign(point.x - points[index]!.x), y: Math.sign(point.y - points[index]!.y) }));
        expect(steps.slice(1).some((one, index) =>
          one.x === -steps[index]!.x && one.y === -steps[index]!.y)).toBe(false);
      }
      expect(score(model).snapshot.passed).toBe(true);
    }
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
