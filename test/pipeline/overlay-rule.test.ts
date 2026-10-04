import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { LINK_LABEL_GEOMETRY, lineAngle } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
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

/**
 * Whether a segment of any angle reaches inside `box`, rather than only touching its edge: the
 * parameter range that survives clipping against the box's four shrunken slabs. A diagonal needs
 * this — its bounding box overlaps shapes the line itself misses.
 */
function crosses(one: Point, two: Point, box: Rect): boolean {
  let low = 0, high = 1;
  const slabs: [number, number][] = [[one.x - two.x, one.x - (box.x + EPS)], [two.x - one.x, right(box) - EPS - one.x],
    [one.y - two.y, one.y - (box.y + EPS)], [two.y - one.y, bottom(box) - EPS - one.y]];
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
 * Synthetics review ticket 01, the maintainer's two remarks of 2026-09-15, and stress ticket 20,
 * his rule of 2026-09-16: **straight by default, orthogonal by exception, and the exception is a
 * node in the way.** An overlay link is a stub out of each port and one straight segment between the
 * two stub ends; where a node body or a pill stands on that segment it is the orthogonal path these
 * cases were written for, unchanged. The SVG draws exactly the polyline the draw.io export draws,
 * because both read the model.
 */
describe('an overlay link is straight, or orthogonal round a node', () => {
  /** The `d` of the one path element of the SVG's overlay layer. */
  const overlayLine = (svg: string): string => {
    const layer = svg.slice(svg.indexOf('class="overlay-links"'), svg.indexOf('class="links"'));
    return /<path class="link-line overlay-line[^"]*" d="([^"]+)"/.exec(layer)![1]!;
  };

  /** How far a point sits outside a box; 0 anywhere inside it. */
  const clearOf = (at: Point, box: Rect): number => Math.hypot(
    Math.max(0, box.x - at.x, at.x - right(box)), Math.max(0, box.y - at.y, at.y - bottom(box)));

  /**
   * The straight branch, measured on a published path: **one segment, face to face**. Two points and
   * nothing between them — no stub (maintainer, 2026-09-16, *"no point in stub then"*, stress
   * ticket 30) — and each end sitting exactly on its own pill's outward edge, not beyond it.
   */
  const faceToFace = (model: LayoutModel, link: LayoutLink): Point[] => {
    const points = pointsOf(link);
    expect(points).toHaveLength(2);
    const [head, tail] = endBoxes(model, link) as [Rect, Rect];
    expect(clearOf(points[0]!, head)).toBeCloseTo(0, 9);
    expect(clearOf(points[1]!, tail)).toBeCloseTo(0, 9);
    return points;
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
    // Nothing between the two cleared ends reaches inside any node body or any pill.
    for (const [index, point] of points.slice(2, -1).entries()) {
      for (const box of shapes(model)) expect(enters(points[index + 1]!, point, box)).toBe(false);
    }
    // Review finding 3, stated rather than claimed away: one drawn label does cross the run, and the
    // mask cuts the overlay under it. The `peer` label has nowhere else to go — the descent crosses
    // the run it names at its midpoint, so both of the ladder's sides are covered — and a label that
    // is drawn beats a line that is whole. Stage 9 moves a label off an overlay run wherever it can;
    // `test/layout/link-labels.test.ts` holds that rule.
    const labels = model.labels.filter(label => label.role === 'link' && !label.omitted && label.bounds);
    expect(labels).toHaveLength(1);
    const cut = points.slice(2, -1).filter((point, index) =>
      enters(points[index + 1]!, point, labels[0]!.bounds!));
    expect(cut).toHaveLength(1);
    expect(labels[0]!.bounds!.height).toBeLessThan(12);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('answers "line is not very visible" on drawio-overlay-sides', async () => {
    const model = await run(fixture('drawio-overlay-sides'));
    const link = overlayOf(model), points = pointsOf(link);
    expect(points).toHaveLength(5);
    for (const [index, point] of points.slice(2, -1).entries()) {
      for (const box of shapes(model)) expect(enters(points[index + 1]!, point, box)).toBe(false);
      for (const label of model.labels) {
        if (!label.omitted && label.bounds) expect(enters(points[index + 1]!, point, label.bounds)).toBe(false);
      }
    }
    // What the remark was about: the straight line was 65 px of which the mask left 9.5 px. The
    // drawn path is longer than the straight one now, and all of it but the two stubs is visible.
    const straight = Math.hypot(points.at(-1)!.x - points[0]!.x, points.at(-1)!.y - points[0]!.y);
    const drawn = points.slice(1).reduce((total, point, index) =>
      total + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
    expect(drawn).toBeGreaterThan(straight);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('goes over the top of the bodies when the pill-relative ways are all blocked (ticket 86)', async () => {
    const model = await run(fixture('overlay-blocked-by-a-body'));
    const link = overlayOf(model), points = pointsOf(link);
    const middle = points.slice(2, -1).map((point, index) => [points[index + 1]!, point] as const);
    // Clear of both pill boxes and, since ticket 86, of every body: the run goes outside the hull.
    for (const [one, two] of middle) {
      for (const box of endBoxes(model, link)) expect(enters(one, two, box)).toBe(false);
    }
    const bodies = Object.values(model.nodes).map(node => node.bounds!);
    expect(middle.some(([one, two]) => bodies.some(box => enters(one, two, box)))).toBe(false);
    const svg = render(model);
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    for (const box of bodies) {
      expect(mask).toContain(`x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`);
    }
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('stays one straight segment for a pair that lines up, and turns nowhere', async () => {
    // Stress ticket 20, question 2. `goldens/synthetic/overlay-ports-that-line-up.yaml`: two `sync`
    // ports facing each other on one x, with nothing between them. Both stubs are collinear with the
    // segment between them, `straighten` drops them, and the path is one segment. Stress ticket 30
    // shortened that segment by a pill half-depth at each end — it now runs face to face, 119 to
    // 220, where it ran anchor to anchor, 107 to 232 — and the 12 px it lost at each end were the
    // 12 px the overlay mask cut out of the pill. Canvas and Q are identical to the last digit.
    const model = await run(fixture('overlay-ports-that-line-up'));
    const points = pointsOf(overlayOf(model));
    expect(points).toEqual([{ x: 57.336669921875, y: 119 }, { x: 57.336669921875, y: 220 }]);
    expect(score(model).snapshot.Q).toBe(0.8335929892966935);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('is one diagonal, face to face, for a pair that does not line up and has a clear line', async () => {
    // `goldens/synthetic/overlay-ports-that-do-not-line-up.yaml`: the same pair with the target on a
    // second node, 75.51 px away on x. Nothing stands on the segment between the two pill faces, so
    // it is drawn as it is, at its own angle — the shape the maintainer chose, and since
    // *"no point in stub then"* (2026-09-16, stress ticket 30) the whole of the link.
    const model = await run(fixture('overlay-ports-that-do-not-line-up'));
    const link = overlayOf(model), points = faceToFace(model, link);
    // One run of 126.11 px from (80.01, 119) to (155.52, 220). It was a 16 px stub, a 119.79 px
    // diagonal and a 16 px stub: 12 px of each stub was pill the mask cut away and 4 px was drawn.
    expect(span(points[0]!, points[1]!)).toBeCloseTo(126.1063, 3);
    expect(axisAligned(points[0]!, points[1]!)).toBe(false);
    // And it really is clear: the segment enters no node body and no drawn pill — its own two pills
    // included, which it leaves outward at both ends and so only touches.
    for (const box of shapes(model)) expect(crosses(points[0]!, points[1]!, box)).toBe(false);
    // Q is unchanged to the last digit, through both the endpoint move and the stub's removal.
    expect(score(model).snapshot.Q).toBe(0.8391492903118092);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('lets a described overlay link ride its diagonal, and reserves the room that run needs', async () => {
    // Ticket 04 B's fixture under the new rule. `goldens/synthetic/labelled-overlay-run.yaml`: the
    // two ports face each other but are not level, nothing stands between them, so the path is one
    // 173.18 px diagonal from pill face to pill face and nothing else.
    //
    // 7f reserves for it, which stress ticket 30 is what made possible. While a stub ran from the
    // anchor it was 33 px, the longest run of a pair standing this close, so 7f reserved about the
    // *stub's* midpoint — inside the source pill, a run no label follows — overshot to a 199.17 px
    // diagonal, and then warned `LINK_LABEL_ROOM_UNRESERVED` once the push had made the diagonal the
    // longest run. Now there is one run, it is the whole link, it has reach on the axis 7f grows,
    // and the room it needs is the text and its two shortening margins: the run is measured between
    // the two faces and so is the room, so the reservation is exact and needs no allowance of its
    // own. 173.06 px of run on x for 157.06 px of text.
    const model = await run(fixture('labelled-overlay-run'));
    const link = overlayOf(model), points = faceToFace(model, link);
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === link.id)!;
    expect(label.omitted).toBeUndefined();
    expect(label.text).toBe('time synchronisation from the site clock');
    // Architecture ticket 16: the label lies on the diagonal, its text at the diagonal's own angle.
    expect(label.textRotation).toBeCloseTo(lineAngle(link.path!.segments[0]!), 9);
    expect(label.textRotation).not.toBe(0);
    expect(model.diagnostics.map(item => item.code)).toEqual([]);
    // 7f grows one axis, so the room it reserved is the diagonal's reach on x, not its length.
    const textWidth = measureText(label.text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width;
    expect(Math.abs(points[1]!.x - points[0]!.x))
      .toBeCloseTo(textWidth + 2 * LINK_LABEL_GEOMETRY.shortenMargin, 6);
    // The link is one run, it is the diagonal, and the label box is centred on its midpoint.
    expect(link.path!.segments).toHaveLength(1);
    const longest = link.path!.segments[0]!;
    expect(axisAligned(longest.from, longest.to)).toBe(false);
    expect(label.bounds!.x + label.bounds!.width / 2).toBeCloseTo((longest.from.x + longest.to.x) / 2, 9);
    expect(label.bounds!.y + label.bounds!.height / 2).toBeCloseTo((longest.from.y + longest.to.y) / 2, 9);
    // And one shortening margin clear of the source pill, less the halo (2 px) and the half-extent the
    // slight turn adds to the stored box: the halo sits inside the margin 7f reserved.
    const clear = label.bounds!.x - right(endBoxes(model, link)[0]!);
    expect(clear).toBeLessThanOrEqual(LINK_LABEL_GEOMETRY.shortenMargin - LINK_LABEL_GEOMETRY.halo + 1e-9);
    expect(clear).toBeGreaterThan(LINK_LABEL_GEOMETRY.shortenMargin - LINK_LABEL_GEOMETRY.halo - 1);
    expect(score(model).snapshot.Q).toBe(0.7913523029318137);
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
