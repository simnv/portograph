import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point, Rect } from '../../src/index.js';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import { crossableText, DIAGONAL_MIN_DEGREES, diagonalMayCross, GROUP_TITLE, isDiagonal, LINK_LABEL } from '../../src/layout/diagonal-text.js';
import { backdropColour, mixHex } from '../../src/profiles/network/theme.js';
import { themeById } from '../../src/profiles/network/themes.js';
import { boxesBehind, groupShapes } from '../../src/render/frame-order.js';
import { effectiveLayer } from '../../src/score/model.js';
import { linkStrokeWidth } from '../../src/theme/geometry.js';
import { HALO_CLASS, haloCss, haloDepthClass } from '../../src/render/theme.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { flatCells } from '../render/drawio-cells.js';

/**
 * Ticket 162 (ADR-0023, the owner's rule of 2026-10-31): a diagonal may cross a group title or a link label. One predicate says so
 * (`diagonalMayCross`); the text keeps its readability through a halo in the colour behind it.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const TITLE = 'a-straight-chord-crosses-a-group-title';
const LABEL = 'a-diagonal-crosses-a-link-label';
const gates = (model: LayoutModel): void => {
  for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
};
const centre = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Whether the segment from a to b meets the rectangle (Liang-Barsky). */
function meets(a: Point, b: Point, box: Rect): boolean {
  let lo = 0, hi = 1;
  for (const [p, q] of [[a.x - b.x, a.x - box.x], [b.x - a.x, box.x + box.width - a.x], [a.y - b.y, a.y - box.y], [b.y - a.y, box.y + box.height - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
  }
  return lo <= hi;
}

describe('the predicate: a diagonal may cross a group title or a link label', () => {
  const slanted = { from: { x: 0, y: 0 }, to: { x: 40, y: 90 } };
  const vertical = { from: { x: 10, y: 0 }, to: { x: 10, y: 90 } };
  const horizontal = { from: { x: 0, y: 5 }, to: { x: 90, y: 5 } };

  it('reads a segment with no axis as a diagonal, and an axis segment, or one off its axis by less than the placement tolerance, as none', () => {
    expect(isDiagonal(slanted)).toBe(true);
    expect(isDiagonal(vertical)).toBe(false);
    expect(isDiagonal(horizontal)).toBe(false);
    expect(isDiagonal({ from: { x: 10, y: 0 }, to: { x: 10.0000001, y: 90 } })).toBe(false);
  });

  it(`reads a segment nearer than ${DIAGONAL_MIN_DEGREES} degrees to either axis as that axis`, () => {
    const at = (degrees: number) => ({ from: { x: 0, y: 0 }, to: { x: 100 * Math.cos(degrees * Math.PI / 180), y: 100 * Math.sin(degrees * Math.PI / 180) } });
    for (const degrees of [5, 9.9, 80.1, 85]) expect(isDiagonal(at(degrees)), `${degrees}`).toBe(false);
    for (const degrees of [10, 30, 45, 60, 80]) expect(isDiagonal(at(degrees)), `${degrees}`).toBe(true);
  });

  it('lets a diagonal cross a group title and a link\'s own label, and keeps every other text and every axis segment under their rules', () => {
    expect(crossableText(GROUP_TITLE)).toBe(true);
    expect(crossableText(LINK_LABEL)).toBe(true);
    // A multiplicity label is a bundle's, a bus label a bus's: they keep their rules, as node, pill and legend labels do.
    expect(crossableText({ role: 'link', owner: { kind: 'bundle' } })).toBe(false);
    expect(crossableText({ role: 'link', owner: { kind: 'bus' } })).toBe(false);
    for (const role of ['node', 'pill', 'description', 'mesh-bus', 'legend'] as const) expect(crossableText({ role })).toBe(false);
    expect(diagonalMayCross(slanted, GROUP_TITLE)).toBe(true);
    expect(diagonalMayCross(slanted, LINK_LABEL)).toBe(true);
    expect(diagonalMayCross(vertical, GROUP_TITLE)).toBe(false);
    expect(diagonalMayCross(horizontal, LINK_LABEL)).toBe(false);
    expect(diagonalMayCross(slanted, { role: 'node' })).toBe(false);
  });
});

describe('a straight chord crosses a group title (ticket 162)', () => {
  it('draws each crossed feed as one straight segment, lets the title stand over them, and passes every gate', async () => {
    const model = await run(fixture(TITLE));
    expect(model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED')).toEqual([]);
    const feeds = model.links.filter(link => link.attachments!.from.node.startsWith('c'));
    expect(feeds).toHaveLength(3);
    for (const link of feeds) {
      expect(link.path!.segments).toHaveLength(1);
      expect(isDiagonal(link.path!.segments[0]!)).toBe(true);
    }
    // The point of the rule: the title stands over at least one of them, and G3 does not count it.
    const title = model.labels.find(label => label.role === 'group' && label.text === 'Distribution east wing')!.bounds!;
    expect(feeds.some(link => meets(link.path!.segments[0]!.from, link.path!.segments[0]!.to, title))).toBe(true);
    gates(model);
  }, 120000);
});

describe('a diagonal crosses a link label (ticket 162)', () => {
  it('places the label on its own line across the other chord, and passes every gate', async () => {
    const model = await run(fixture(LABEL));
    const labelled = model.links.find(link => link.attachments!.from.node === 'a' && link.attachments!.to.node === 'd')!;
    const other = model.links.find(link => link.attachments!.from.node === 'b' && link.attachments!.to.node === 'c')!;
    for (const link of [labelled, other]) {
      expect(link.path!.segments).toHaveLength(1);
      expect(isDiagonal(link.path!.segments[0]!)).toBe(true);
    }
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === labelled.id)!;
    expect(label.text).toBe('Primary transit to the far server');
    expect(label.support?.kind).toBe('link-segment');
    const [crossing] = other.path!.segments;
    expect(meets(crossing!.from, crossing!.to, label.bounds!)).toBe(true);
    gates(model);
  }, 120000);

  it('gives every text outside node bodies a halo in the colour behind it, in each theme and mode, and the draw.io label a backdrop of that colour', async () => {
    const model = await run(fixture(LABEL));
    const svg = render(model);
    expect(svg).toContain(`.${HALO_CLASS}{paint-order:stroke fill;`);
    // The text of an SVG label is in its spans: the element is found by its class and owner.
    const classes = (kind: string, owner: string): string[] =>
      svg.match(new RegExp(`<text class="(${kind} [^"]*)" data-owner="${owner}"`))?.[1]!.split(' ') ?? [];
    const label = model.labels.find(item => item.text === 'Primary transit to the far server')!;
    const owner = (label.owner as { id: string }).id;
    for (const [kind, id] of [['group-label', 'upper'], ['group-label', 'lower'], ['link-label', owner]] as const) expect(classes(kind, id), id).toContain(HALO_CLASS);
    // A node label stands on its body and takes no halo.
    expect(classes('node-label', 'a')).not.toContain(HALO_CLASS);
    // The label lies in the tier gap or on a group: its halo has the colour behind its centre, in every mode.
    const depth = boxesBehind(groupShapes(model), centre(label.bounds!));
    expect(classes('link-label', owner)).toContain(haloDepthClass(depth));
    for (const id of [undefined, 'snack'] as const) {
      const theme = themeById(id);
      const css = haloCss([depth], theme);
      for (const mode of ['light', 'dark', 'print'] as const) expect(css).toContain(`{stroke:${backdropColour(theme.paint[mode], depth)}}`);
      expect(css).toContain('@media (prefers-color-scheme: dark){');
      expect(css).toContain('@media print{');
    }
    const theme = themeById(undefined);
    const cell = flatCells(drawio(model)).match(/<mxCell\b[^>]*value="Primary transit to the far server"[^>]*>/)![0];
    const style = /style="([^"]*)"/.exec(cell)![1]!;
    expect(style).toContain(`labelBackgroundColor=light-dark(${backdropColour(theme.paint.light, depth)},${backdropColour(theme.paint.dark, depth)})`);
  }, 120000);
});

/** The mask rectangles that cut, of the mask a `<g>` with this data-id names; empty when the group has no mask of its own. */
function lineCutouts(svg: string, id: string): Rect[] {
  const mask = new RegExp(`<g class="link[^"]*" data-id="${id}" mask="url\\(#([^)]+)\\)"`).exec(svg)?.[1];
  if (mask === undefined) return [];
  const body = svg.slice(svg.indexOf(`<mask id="${mask}"`), svg.indexOf('</mask>', svg.indexOf(`<mask id="${mask}"`)));
  return [...body.matchAll(/<rect class="pg-mask-hide"[^>]*>/g)].map(item => {
    const value = (name: string): number => Number(new RegExp(` ${name}="([^"]*)"`).exec(item[0])![1]);
    return { x: value('x'), y: value('y'), width: value('width'), height: value('height') };
  });
}

describe('the mask of a line under text (ticket 162)', () => {
  it('cuts a label out of its own line only: a foreign diagonal, routed or overlay, is not masked and runs on under the halo', async () => {
    // Routed: the two chords of the fixture. Overlay: the unlabelled chord drawn as overlay, which takes another port and still
    // crosses the label beside the labelled vertical line.
    for (const overlay of [false, true]) {
      const yaml = overlay ? fixture(LABEL).replace('{ from: b, to: c, class: dashed }', '{ from: b, to: c, class: dashed, route: overlay }') : fixture(LABEL);
      const model = await run(yaml);
      const labelled = model.links.find(link => link.attachments!.from.node === 'a')!;
      const other = model.links.find(link => link.attachments!.from.node === 'b')!;
      expect(effectiveLayer(other) === 'overlay').toBe(overlay);
      expect(isDiagonal(other.path!.segments[0]!)).toBe(true);
      const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === labelled.id)!;
      // The other line crosses the label, and nothing masks it there: its stroke is whole, the halo alone breaks it.
      expect(meets(other.path!.segments[0]!.from, other.path!.segments[0]!.to, label.bounds!)).toBe(true);
      const svg = render(model);
      expect(lineCutouts(svg, other.id)).toEqual([]);
      // The label's own line is cut under the label where the label lies on it, and nowhere else.
      expect(lineCutouts(svg, labelled.id)).toHaveLength(label.onLine ? 1 : 0);
      if (overlay) {
        // The overlay layer's common mask cuts bodies and pills, and no link label.
        const common = svg.slice(svg.indexOf('<mask id="pg-overlay-mask'), svg.indexOf('</mask>', svg.indexOf('<mask id="pg-overlay-mask')));
        const boxes = [...common.matchAll(/<rect class="pg-mask-hide"[^>]*>/g)];
        const shapes = Object.values(model.nodes).reduce((count, node) => count + 1 + node.ports.filter(port => port.pill).length, 0);
        expect(boxes).toHaveLength(shapes);
      }
    }
  }, 120000);

  it('cuts a group title out of an orthogonal overlay run where the run meets it, and leaves a diagonal overlay uncut', async () => {
    const model = structuredClone(await run(fixture('an-overlay-chord-runs-under-a-title'))) as LayoutModel;
    const [slanted, level] = model.links.filter(link => effectiveLayer(link) === 'overlay');
    const title = model.labels.find(label => label.role === 'group' && label.text === 'Site')!.bounds!;
    const middle = centre(title);
    // Both overlay lines are redrawn through the title: one at 45 degrees, one level along the title's middle.
    slanted!.path!.segments = [{ from: { x: middle.x - 30, y: middle.y - 30 }, to: { x: middle.x + 30, y: middle.y + 30 }, owner: slanted!.path!.segments[0]!.owner }];
    level!.path!.segments = [{ from: { x: title.x - 20, y: middle.y }, to: { x: title.x + title.width + 20, y: middle.y }, owner: level!.path!.segments[0]!.owner }];
    const svg = render(model);
    expect(lineCutouts(svg, slanted!.id)).toEqual([]);
    const half = linkStrokeWidth(level!) / 2;
    const cuts = lineCutouts(svg, level!.id);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.x).toBeCloseTo(title.x, 6);
    expect(cuts[0]!.width).toBeCloseTo(title.width, 6);
    expect(cuts[0]!.y).toBeCloseTo(middle.y - half, 6);
    expect(cuts[0]!.height).toBeCloseTo(2 * half, 6);
  }, 120000);
});

describe('the keep-out of 7f that breaks a hard separation (ticket 162)', () => {
  it('is undone and named: the canton column keeps its band gap to the flank, and G9 finds nothing', async () => {
    const model = await run(fixture('a-canton-column-is-not-pulled-into-a-flank'));
    const undone = model.diagnostics.filter(item => item.code === 'KEEP_OUT_UNDONE');
    expect(undone).toHaveLength(1);
    expect(undone[0]!.severity).toBe('warning');
    expect(undone[0]!.message).toMatch(/separation-root-frame-group:frame:town\|/);
    expect(undone[0]!.owners!.length).toBeGreaterThan(0);
    expect(score(model).snapshot.gates.G9.violations).toEqual([]);
  }, 120000);
});

describe('the colour behind a text', () => {
  it('is the page with each group fill laid over it at its opacity; a fill that is no colour leaves the page', () => {
    const network = themeById(undefined).paint, snack = themeById('snack').paint;
    expect(backdropColour(network.light, 0)).toBe(network.light.background);
    expect(backdropColour(network.light, 1)).toBe(mixHex(network.light.background, network.light.group.fill, network.light.group.fillOpacity));
    expect(backdropColour(network.light, 2)).toBe(mixHex(backdropColour(network.light, 1), network.light.group.fill, network.light.group.fillOpacity));
    // Snack fills its groups opaque: the colour behind a title on a group is the group's own fill.
    expect(backdropColour(snack.light, 1).toLowerCase()).toBe(snack.light.group.fill.toLowerCase());
    expect(backdropColour(network.print, 2)).toBe(network.print.background);
  });
});
