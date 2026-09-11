import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../src/index.js';
import type { GateId, LayoutLabel, LayoutModel, PathSegment, Rect } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { LINK_LABEL_GEOMETRY, OVERLAY_LABEL_DENSITY, overlayDensity, overlayLabelsSuppressed, produceLinkLabels, validateLinkLabels } from '../../src/layout/link-labels.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { rows } from '../../src/layout/rows.js';
import { RectangleIndex } from '../../src/layout/rectangle-index.js';
import { route } from '../../src/route/index.js';
import { score } from '../../src/score/index.js';
import { measureText } from '../../src/text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../../src/theme/geometry.js';
import { bench, nodeLabel, type BenchLink, type BenchNode } from './link-label-fixture.js';
import { placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const GATES: GateId[] = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const measure = (text: string) => measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
const overlaps = (a: Rect, b: Rect): boolean => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
  && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** The rulings this ticket implements, restated here so a changed constant fails a test. */
const NORMAL_GAP = 4, SHORTEN_MARGIN = 8, ELLIPSIS = '...';
it('keeps the theme and spacing rulings stage 9 was given', () => {
  expect(LINK_LABEL_GEOMETRY).toEqual({ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9,
    fontWeight: 400, normalGap: NORMAL_GAP, ellipsis: ELLIPSIS, shortenMargin: SHORTEN_MARGIN });
  expect(OVERLAY_LABEL_DENSITY).toBe(3);
});

/** An independent restatement of the placement ruling: midpoint, 4 px beyond the stroke edge. */
function candidate(segment: PathSegment, text: string, second: boolean, stroke = DEFAULT_STROKE_WIDTHS.path): Rect {
  const size = measure(text), gap = NORMAL_GAP + stroke / 2;
  const midX = (segment.from.x + segment.to.x) / 2, midY = (segment.from.y + segment.to.y) / 2;
  if (Math.abs(segment.to.x - segment.from.x) >= Math.abs(segment.to.y - segment.from.y)) {
    return { x: midX - size.width / 2, y: second ? midY + gap : midY - gap - size.height, width: size.width, height: size.height };
  }
  return { x: second ? midX - gap - size.width : midX + gap, y: midY - size.height / 2, width: size.width, height: size.height };
}

async function throughRoute(yaml: string): Promise<LayoutModel> {
  const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return route(placedModel, { createAttempt: createAvoidAttempt });
}
function run(model: LayoutModel): LayoutModel {
  expect('linkLabels' in api).toBe(true);
  return (api as typeof api & { linkLabels: (input: LayoutModel) => LayoutModel }).linkLabels(model);
}
const linkLabelsOf = (model: LayoutModel): LayoutLabel[] => model.labels.filter(label => label.role === 'link');

const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const fittingYaml = readFileSync(new URL('../../goldens/synthetic/fitting-link-label.yaml', import.meta.url), 'utf8');

/** goldens/synthetic/unfittable-link-label.yaml, with its stage-9 precondition from stage-inputs.yaml. */
const UNFITTABLE_TEXT = 'This link label must survive in its tooltip even when every visible placement collides';
function unfittableBench(foreign: Rect[]): LayoutModel {
  return bench(
    [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
      { id: 'target', bounds: { x: 130, y: 80, width: 100, height: 40 } },
      { id: 'above', bounds: { x: 80, y: 0, width: 70, height: 60 } },
      { id: 'below', bounds: { x: 80, y: 140, width: 70, height: 60 } }],
    [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
      points: [{ x: 100, y: 100 }, { x: 130, y: 100 }], label: UNFITTABLE_TEXT }],
    foreign.map((box, index) => nodeLabel(`foreign-${index}`, box, index === 0 ? 'above' : 'below')));
}

describe('stage 9 golden', () => {
  it('invents no label and preserves the routed golden exactly', async () => {
    const routed = await throughRoute(goldenYaml);
    const model = run(routed);
    expect(model.stage).toBe('link-labels');
    // The approved JPEG YAML authors no link label and no route: merge, so stage 9 has no subject.
    expect(model.document.links.every(link => link.label === undefined)).toBe(true);
    expect(model.bundles.every(bundle => bundle.mergeRuns === undefined)).toBe(true);
    expect(linkLabelsOf(model)).toEqual([]);
    // Ticket 16 adds the generated legend to this same transaction. Nothing the diagram already
    // drew moves: only legend labels join, below everything, with the canvas reserved for them.
    expect(model.labels.filter(label => label.role !== 'legend')).toEqual(routed.labels);
    expect(model.legend!.entries.map(entry => entry.id)).toEqual(['symbol:provider', 'symbol:router',
      'symbol:tbr', 'symbol:rr', 'line:default', 'line:dotted', 'line:dashed']);
    expect(model.links).toEqual(routed.links);
    expect(model.freeze!.placement).toEqual(routed.freeze!.placement);
    // The canvas now also holds the outer half of every stroke, so it grows on every side rather
    // than only downward: a rectangle is drawn on its centreline.
    const canvas = model.canvas!, before = routed.canvas!;
    expect(canvas.x).toBeLessThan(before.x);
    expect(canvas.y).toBeLessThanOrEqual(before.y);
    expect(canvas.x + canvas.width).toBeGreaterThanOrEqual(before.x + before.width);
    expect(canvas.y + canvas.height).toBeGreaterThanOrEqual(model.legend!.bounds.y + model.legend!.bounds.height);
    expect(canvas.height).toBeGreaterThan(before.height);
    // Nothing the diagram paints lies outside it, strokes included.
    for (const box of api.drawnBoxes(model, true)) {
      expect([box, box.x >= canvas.x && box.y >= canvas.y
        && box.x + box.width <= canvas.x + canvas.width
        && box.y + box.height <= canvas.y + canvas.height]).toEqual([box, true]);
    }

    const report = score(model, { golden: true }).snapshot;
    for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
    expect(report.counters).toMatchObject({ labelHits: 0, labelsOmitted: 0, barCross: 3, lanesUsed: 4, overlaps: 0 });
    expect(report.metrics.crossings.count).toBe(0);
    expect(report.Q).toBeCloseTo(0.8424281545245618, 12);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);
});

describe('stage 9 authored labels', () => {
  it('does not prune a stroke collision when a large negative bound loses its padding to rounding', () => {
    const right = -(2 ** 51), middle = right + 2.5, left = middle - 180, end = middle + 180;
    const model = bench([
      { id: 'a', bounds: { x: left - 20, y: 350, width: 40, height: 40 } },
      { id: 'b', bounds: { x: end - 20, y: 350, width: 40, height: 40 } },
      { id: 'blocker', bounds: { x: -(2 ** 52), y: 271, width: 2 ** 51, height: 35 } },
    ], [{ id: 'l', from: 'a', to: 'b', sides: ['top', 'top'], label: 'x',
      points: [{ x: left, y: 350 }, { x: left, y: 320 }, { x: end, y: 320 }, { x: end, y: 350 }] }]);
    model.nodes.blocker!.strokeWidth = 1;
    for (const node of Object.values(model.nodes)) node.owner = { kind: 'group', id: 'row-group' };
    for (const id of GATES) expect(score(model).snapshot.gates[id].violations).toEqual([]);
    produceLinkLabels(model);
    for (const id of GATES) expect(score(model).snapshot.gates[id].violations).toEqual([]);
    expect(linkLabelsOf(model)[0]!.support).not.toEqual({ kind: 'link-segment', link: 'l', segment: 1 });
  });

  it('bounds actual producer work for shared stems and wide disjoint labels', () => {
    const original = RectangleIndex.prototype.some;
    const work = { nodes: 0, items: 0 };
    const spy = vi.spyOn(RectangleIndex.prototype, 'some').mockImplementation(function (this: RectangleIndex<unknown>, bounds, predicate, _work, padding) {
      return original.call(this, bounds, predicate, work, padding);
    });
    try {
      const count = 500;
      const shared = bench([{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
        { id: 'b', bounds: { x: 0, y: 400, width: 40, height: 40 } }],
      Array.from({ length: count }, (_, i) => ({ id: `s${i}`, from: 'a', to: 'b', label: 'x',
        points: [{ x: 20, y: 40 }, { x: 20, y: 400 }] })));
      produceLinkLabels(shared);
      expect(spy).toHaveBeenCalled();
      expect(work.nodes).toBeLessThan(count * 40);
      expect(work.items).toBeLessThan(count * 8);
      spy.mockClear(); work.nodes = 0; work.items = 0;
      const nodes: BenchNode[] = [], links: BenchLink[] = [];
      for (let i = 0; i < count; i++) {
        nodes.push({ id: `a${i}`, bounds: { x: 0, y: i * 200, width: 40, height: 40 } },
          { id: `b${i}`, bounds: { x: 700000, y: i * 200, width: 40, height: 40 } });
        links.push({ id: `l${i}`, from: `a${i}`, to: `b${i}`, sides: ['right', 'left'], label: 'W'.repeat(65000),
          points: [{ x: 40, y: i * 200 + 20 }, { x: 700000, y: i * 200 + 20 }] });
      }
      const wide = bench(nodes, links);
      produceLinkLabels(wide);
      expect(spy).toHaveBeenCalledTimes(count);
      expect(work.nodes).toBeLessThan(count * 100);
      expect(work.items).toBe(0);
      expect(linkLabelsOf(wide).every(label => !label.omitted)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('places two labels beside a declared shared stem and omits its other members without collisions', () => {
    const model = bench([{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
      { id: 'b', bounds: { x: 0, y: 400, width: 40, height: 40 } }],
    Array.from({ length: 64 }, (_, i) => ({ id: `shared-${i}`, from: 'a', to: 'b', label: 'x',
      points: [{ x: 20, y: 40 }, { x: 20, y: 400 }] })));
    const from = model.nodes.a!.ports[0]!.ref, to = model.nodes.b!.ports[0]!.ref;
    for (const name of ['a', 'b']) {
      model.nodes[name]!.owner = { kind: 'group', id: 'row-group' };
      model.nodes[name]!.ports = model.nodes[name]!.ports.slice(0, 1);
      model.document.nodes[name]!.ports = model.document.nodes[name]!.ports.slice(0, 1);
    }
    for (const link of model.links) {
      link.from = from; link.to = to; link.attachments = { from, to };
      link.path!.segments[0]!.owner = { kind: 'shared-stem', id: 'j' };
      model.document.links[link.sourceIndex]!.from = from;
      model.document.links[link.sourceIndex]!.to = to;
    }
    const stem = model.links[0]!.path!.segments[0]!;
    model.junctions.push({ id: 'j', owner: { kind: 'shared-stem', id: 'j' }, layer: 'routed',
      port: from, links: model.links.map(link => link.id), point: stem.to, stem });
    produceLinkLabels(model);
    expect(linkLabelsOf(model).filter(label => !label.omitted)).toHaveLength(2);
    expect(linkLabelsOf(model).filter(label => label.omitted)).toHaveLength(62);
    const report = score(model).snapshot;
    for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
  });

  it('places a fitting label beside the longest segment and leaves every gate clean', async () => {
    const routed = await throughRoute(fittingYaml);
    const model = run(routed);
    const label = linkLabelsOf(model);
    expect(label).toHaveLength(1);

    const path = model.links[0]!.path!.segments;
    const longest = path.reduce((best, segment, index) =>
      Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)
        > Math.hypot(path[best]!.to.x - path[best]!.from.x, path[best]!.to.y - path[best]!.from.y) ? index : best, 0);
    expect(label[0]).toEqual({
      id: 'label:link:link-1', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', role: 'link',
      text: 'uplink', fontFamily: LINK_LABEL_GEOMETRY.fontFamily, fontSize: 9, fontWeight: 400,
      textRotation: 0, support: { kind: 'link-segment', link: 'link-1', segment: longest },
      lines: ['uplink'], lineHeight: measure('uplink').lineHeight,
      bounds: candidate(path[longest]!, 'uplink', false),
    });
    // No tooltip: the full authored text is drawn.
    expect(label[0]!.tooltip).toBeUndefined();
    expect(model.diagnostics.some(item => item.code.startsWith('LINK_LABEL'))).toBe(false);

    const report = score(model).snapshot;
    for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
    expect(report.counters).toMatchObject({ labelHits: 0, labelsOmitted: 0 });
    // Placement and every fixed path survive; only labels and the canvas extent changed.
    expect(model.freeze!.placement).toEqual(routed.freeze!.placement);
    expect(model.links).toEqual(routed.links);
    expect(model.labels.filter(item => item.role !== 'link')).toEqual(routed.labels);
    expect(model.canvas!.x).toBe(routed.canvas!.x);
    expect(model.canvas!.width).toBeGreaterThanOrEqual(routed.canvas!.width);
    expect(model.canvas!.x + model.canvas!.width).toBeGreaterThanOrEqual(label[0]!.bounds!.x + label[0]!.bounds!.width);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);

  it('labels every drawn member of an expanded group endpoint, each under its own id', async () => {
    const expanded = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb}
  c: {group: gb}
links: [{from: a.p, to: {group: gb}, label: feed}]`;
    const model = run(await throughRoute(expanded));
    // M1 draws the members of an expanded endpoint, so each drawn link carries the authored label.
    expect(linkLabelsOf(model).map(label => [label.id, label.text, label.omitted ?? false]))
      .toEqual([['label:link:link-1-1', 'feed', false], ['label:link:link-1-2', 'feed', false]]);
    expect(linkLabelsOf(model).every(label => label.owner.kind === 'link')).toBe(true);
    // The two members share one port with no declared junction, which G4 reports; the labels do not.
    const report = score(model).snapshot;
    expect(report.gates.G3.violations).toEqual([]);
    expect(report.counters).toMatchObject({ labelHits: 0, labelsOmitted: 0 });
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);

  it('omits the unfittable label, keeps its tooltip and reports one omission', () => {
    const model = unfittableBench([{ x: 90, y: 60, width: 50, height: 40 }, { x: 90, y: 100, width: 50, height: 40 }]);
    const segment = model.links[0]!.path!.segments[0]!;
    // Collision evidence: both full-text sides and both ellipsis sides hit an occupied label box.
    const shortened = 'Thi' + LINK_LABEL_GEOMETRY.ellipsis;
    for (const text of [UNFITTABLE_TEXT, shortened]) for (const second of [false, true]) {
      expect([text, second, model.labels.some(item => overlaps(item.bounds!, candidate(segment, text, second)))])
        .toEqual([text, second, true]);
    }
    produceLinkLabels(model);

    expect(linkLabelsOf(model)).toEqual([{
      id: 'label:link:link-1', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', role: 'link',
      text: UNFITTABLE_TEXT, fontFamily: LINK_LABEL_GEOMETRY.fontFamily, fontSize: 9, fontWeight: 400,
      textRotation: 0, tooltip: UNFITTABLE_TEXT, omitted: true,
    }]);
    expect(model.diagnostics.map(item => item.code)).toEqual(['LINK_LABEL_OMITTED']);
    const report = score(model).snapshot;
    expect(report.counters.labelsOmitted).toBe(1);
    // The omitted label is not drawn, so it can hit nothing; only the injected boxes collide.
    expect(report.gates.G3.violations.every(item => !item.elements.includes('label:link:link-1'))).toBe(true);
  });

  it('shortens with the measured ellipsis when only the full text collides', () => {
    // The same geometry, with the occupied areas pulled off the short candidate boxes.
    const model = unfittableBench([{ x: -80, y: 80, width: 100, height: 16 }, { x: -80, y: 104, width: 100, height: 16 }]);
    const segment = model.links[0]!.path!.segments[0]!;
    const limit = 30 - SHORTEN_MARGIN;
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;

    expect(label.omitted).toBeUndefined();
    expect(label.text.endsWith(ELLIPSIS)).toBe(true);
    expect(label.tooltip).toBe(UNFITTABLE_TEXT);
    expect(label.lines).toEqual([label.text]);
    // Exactly the longest measured prefix that fits `segment length - 8`.
    const prefix = label.text.slice(0, -ELLIPSIS.length);
    expect(UNFITTABLE_TEXT.startsWith(prefix)).toBe(true);
    expect(measure(label.text).width).toBeLessThanOrEqual(limit);
    expect(measure(UNFITTABLE_TEXT.slice(0, prefix.length + 1) + ELLIPSIS).width).toBeGreaterThan(limit);
    // Evidence that the full text really had no candidate and the shortened one took the first side.
    for (const second of [false, true]) {
      expect(model.labels.some(item => item.role !== 'link' && overlaps(item.bounds!, candidate(segment, UNFITTABLE_TEXT, second)))).toBe(true);
    }
    expect(label.bounds).toEqual(candidate(segment, label.text, false));
    expect(label.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 0 });
    expect(model.diagnostics.map(item => item.code)).toEqual(['LINK_LABEL_SHORTENED']);
  });

  it('keeps the longest fitting prefix when a line break inside it narrows the box', () => {
    // A line break moves the ellipsis onto a new line, so the measured width can *fall* as the
    // prefix grows: `MMM...` is 29.993 px but the longer `MMMM\nWW...` is 29.988 px.
    const text = 'MMMM\nWWWWWWWWWWWW';
    const model = bench(
      [{ id: 'source', bounds: { x: 60, y: 80, width: 40, height: 40 } },
        { id: 'target', bounds: { x: 138, y: 80, width: 40, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
        points: [{ x: 100, y: 100 }, { x: 138, y: 100 }], label: text }]);
    const segment = model.links[0]!.path!.segments[0]!, limit = 38 - SHORTEN_MARGIN;
    expect(measure('MMM...').width).toBeLessThanOrEqual(limit);
    expect(measure('MMMM\nWW...').width).toBeLessThanOrEqual(limit);
    expect(measure('MMMM\nWW...').width).toBeLessThan(measure('MMM...').width);
    expect(measure('MMMM\nWWW...').width).toBeGreaterThan(limit);
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;
    expect(label.text).toBe('MMMM\nWW...');
    expect(label.lines).toEqual(['MMMM', 'WW...']);
    expect(label.tooltip).toBe(text);
    expect(label.bounds).toEqual(candidate(segment, 'MMMM\nWW...', false));
  });

  it('indexes an obstacle at an unsafe coordinate instead of stepping through its cells', () => {
    // 2**66 / 128 leaves the safe-integer range, where `x++` cannot advance: the cell loop would
    // never end. Such a rectangle belongs on the linear list, and the run must still finish.
    const model = bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
        { id: 'target', bounds: { x: 300, y: 80, width: 100, height: 40 } },
        { id: 'huge', bounds: { x: 2 ** 66, y: 0, width: 1, height: 10000 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
        points: [{ x: 100, y: 100 }, { x: 300, y: 100 }], label: 'uplink' }]);
    produceLinkLabels(model);
    expect(linkLabelsOf(model)[0]!.bounds).toEqual(candidate(model.links[0]!.path!.segments[0]!, 'uplink', false));
  }, 5000);

  it('keeps long runs apart whether they are disjoint across or along their length', () => {
    // 1,000 runs of 600,000 px. Side by side they share every row; stacked they share one column.
    // A single cell size makes one of the two quadratic, which is minutes rather than milliseconds.
    const build = (stacked: boolean): LayoutModel => {
      const nodes: BenchNode[] = [], links: BenchLink[] = [];
      for (let i = 0; i < 1000; i++) {
        const x = stacked ? 20 : 50 + 100 * i, y = stacked ? i * 600100 : 0;
        nodes.push({ id: `a${i}`, bounds: { x: x - 20, y, width: 40, height: 40 } });
        nodes.push({ id: `b${i}`, bounds: { x: x - 20, y: y + 600000, width: 40, height: 40 } });
        links.push({ id: `link-${i}`, from: `a${i}`, to: `b${i}`,
          points: [{ x, y: y + 40 }, { x, y: y + 600000 }], label: 'x' });
      }
      return bench(nodes, links);
    };
    for (const stacked of [false, true]) {
      const model = build(stacked), started = Date.now();
      produceLinkLabels(model);
      expect([stacked, linkLabelsOf(model).filter(label => label.omitted).length]).toEqual([stacked, 0]);
      expect([stacked, Date.now() - started < 3000]).toEqual([stacked, true]);
    }
  }, 30000);

  it('still sees a blocker under a label too wide for any bucket cell range', () => {
    // 65,000 characters measure about 552,000 px, far more cells than the small-node grid can be
    // walked over, so the query takes the square pyramid instead. It must still find the blocker.
    const text = 'W'.repeat(65000);
    const build = (blocker: Rect | undefined): LayoutModel => bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 40, height: 40 } },
        { id: 'target', bounds: { x: 700000, y: 80, width: 40, height: 40 } },
        ...(blocker ? [{ id: 'blocker', bounds: blocker }] : [])],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
        points: [{ x: 40, y: 100 }, { x: 700000, y: 100 }], label: text }]);
    const segment = build(undefined).links[0]!.path!.segments[0]!;
    const above = candidate(segment, text, false);
    expect(measure(text).width).toBeGreaterThan(500000);

    const open = build(undefined);
    produceLinkLabels(open);
    expect(linkLabelsOf(open)[0]!.bounds).toEqual(above);

    const blocked = build({ x: above.x + 200000, y: above.y + 2, width: 40, height: 6 });
    produceLinkLabels(blocked);
    expect(linkLabelsOf(blocked)[0]!.bounds).toEqual(candidate(segment, text, true));
  }, 20000);

  it('finds a collision with an obstacle far too long for the finest index level', () => {
    // 200,000 px of vertical run: it cannot live in the 128 px grid, and must still be found.
    const model = bench(
      [{ id: 'source', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'target', bounds: { x: 0, y: 200040, width: 60, height: 40 } },
        { id: 'near', bounds: { x: 200, y: 0, width: 60, height: 40 } },
        { id: 'far', bounds: { x: 200, y: 200040, width: 60, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', points: [{ x: 30, y: 40 }, { x: 30, y: 200040 }] },
        { id: 'link-2', from: 'near', to: 'far', points: [{ x: 230, y: 40 }, { x: 230, y: 200040 }],
          label: 'uplink' }]);
    const long = model.links[1]!.path!.segments[0]!;
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;
    // link-2's own first side is free; put a blocker exactly there and the long run still governs.
    expect(label.bounds).toEqual(candidate(long, 'uplink', false));

    const blocked = bench(
      [{ id: 'source', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'target', bounds: { x: 0, y: 200040, width: 60, height: 40 } },
        { id: 'near', bounds: { x: 200, y: 0, width: 60, height: 40 } },
        { id: 'far', bounds: { x: 200, y: 200040, width: 60, height: 40 } }],
      // A third long run sits exactly where link-2's first-side box would go.
      [{ id: 'link-1', from: 'source', to: 'target',
        points: [{ x: 240, y: 40 }, { x: 240, y: 200040 }] },
        { id: 'link-2', from: 'near', to: 'far', points: [{ x: 230, y: 40 }, { x: 230, y: 200040 }],
          label: 'uplink' }]);
    produceLinkLabels(blocked);
    const forced = linkLabelsOf(blocked)[0]!;
    expect(forced.bounds).toEqual(candidate(blocked.links[1]!.path!.segments[0]!, 'uplink', true));
  });
});

describe('stage 9 repair ladder order', () => {
  const text = 'uplink';
  /** Three segments of descending length: 130 horizontal, 80 vertical, 70 horizontal. */
  const points = [{ x: 100, y: 100 }, { x: 230, y: 100 }, { x: 230, y: 180 }, { x: 300, y: 180 }];
  function ladder(blocked: [number, boolean][]): LayoutModel {
    const skeleton = bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
        { id: 'target', bounds: { x: 300, y: 160, width: 100, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'], points, label: text }]);
    const segments = skeleton.links[0]!.path!.segments;
    return bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
        { id: 'target', bounds: { x: 300, y: 160, width: 100, height: 40 } },
        { id: 'holder', bounds: { x: 600, y: 80, width: 40, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'], points, label: text }],
      blocked.map(([index, second], at) => nodeLabel(`block-${at}`, candidate(segments[index]!, text, second), 'holder')));
  }

  it('walks the whole length order on the first side before trying the other side', () => {
    const model = ladder([[0, false], [1, false]]);
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;
    const segments = model.links[0]!.path!.segments;
    // Segment 2 is the shortest, so only the first-side pass across every segment reaches it.
    expect(label.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 2 });
    expect(label.bounds).toEqual(candidate(segments[2]!, text, false));
    expect(label.text).toBe(text);
    expect(model.diagnostics).toEqual([]);
  });

  it('returns to the longest segment for the opposite side once every first side collides', () => {
    const model = ladder([[0, false], [1, false], [2, false]]);
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;
    const segments = model.links[0]!.path!.segments;
    expect(label.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 0 });
    expect(label.bounds).toEqual(candidate(segments[0]!, text, true));
  });

  it('breaks an equal-length tie on the source-to-target index', () => {
    // Two 100 px horizontal segments of the same length; only the earlier index may win.
    const equal = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 140 }, { x: 300, y: 140 }];
    const nodes: BenchNode[] = [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
      { id: 'target', bounds: { x: 300, y: 120, width: 100, height: 40 } },
      { id: 'holder', bounds: { x: 600, y: 80, width: 40, height: 40 } }];
    const link: BenchLink = { id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
      points: equal, label: text };
    const segments = bench(nodes, [link]).links[0]!.path!.segments;
    expect(segments[0]!.to.x - segments[0]!.from.x).toBe(segments[2]!.to.x - segments[2]!.from.x);

    const open = bench(nodes, [link]);
    produceLinkLabels(open);
    expect(linkLabelsOf(open)[0]!.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 0 });
    // With the earlier index blocked, the same-length later one is the next first-side candidate.
    const later = bench(nodes, [link], [nodeLabel('block', candidate(segments[0]!, text, false), 'holder')]);
    produceLinkLabels(later);
    expect(linkLabelsOf(later)[0]!.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 2 });
    expect(linkLabelsOf(later)[0]!.bounds).toEqual(candidate(segments[2]!, text, false));
  });

  it('ignores zero-length segments and never places text on one', () => {
    const model = bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
        { id: 'target', bounds: { x: 300, y: 160, width: 100, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
        points: [{ x: 100, y: 100 }, { x: 100, y: 100 }, ...points.slice(1)], label: text }]);
    produceLinkLabels(model);
    const label = linkLabelsOf(model)[0]!;
    expect(label.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 1 });
    expect(label.bounds).toEqual(candidate(model.links[0]!.path!.segments[1]!, text, false));
  });

  it('makes an accepted label an obstacle for the next one, in source order', () => {
    const model = bench(
      [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 0, y: 120, width: 60, height: 40 } },
        { id: 'c', bounds: { x: -50, y: 75, width: 60, height: 40 } },
        { id: 'd', bounds: { x: 70, y: 75, width: 60, height: 40 } }],
      // A vertical link, then a horizontal one whose "above" box lands on the first label's box.
      [{ id: 'link-1', from: 'a', to: 'b', points: [{ x: 20, y: 40 }, { x: 20, y: 120 }], label: text },
        { id: 'link-2', from: 'c', to: 'd', sides: ['right', 'left'],
          points: [{ x: 10, y: 95 }, { x: 70, y: 95 }], label: text }]);
    const vertical = model.links[0]!.path!.segments[0]!, horizontal = model.links[1]!.path!.segments[0]!;
    produceLinkLabels(model);
    const [first, second] = linkLabelsOf(model);
    expect(first!.id).toBe('label:link:link-1');
    expect(first!.bounds).toEqual(candidate(vertical, text, false));
    // link-2's own first side would land on link-1's accepted box, so it takes the other side.
    expect(overlaps(first!.bounds!, candidate(horizontal, text, false))).toBe(true);
    expect(second!.id).toBe('label:link:link-2');
    expect(second!.bounds).toEqual(candidate(horizontal, text, true));
    expect(model.diagnostics).toEqual([]);
  });
});

describe('stage 9 multiplicity labels', () => {
  const merged = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 0}, {name: r, side: bottom, order: 0}]}
  b: {group: gb, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 0}, {name: r, side: top, order: 0}]}
links: [{from: a.p, to: b.p, route: merge}, {from: b.q, to: a.q, route: merge}, [a.r, b.r]]`;

  it('measures one count label per counted run, owned by its bundle, clearing every member segment', async () => {
    const routed = await throughRoute(merged);
    const bundle = routed.bundles[0]!;
    expect(bundle.mergeRuns).toHaveLength(1);
    const model = run(routed);
    const label = linkLabelsOf(model);
    expect(label).toHaveLength(1);
    expect(label[0]).toEqual({
      id: `label:multiplicity:${bundle.mergeRuns![0]!.id}`, owner: { ...bundle.owner }, layer: 'routed',
      role: 'link', text: '2', fontFamily: LINK_LABEL_GEOMETRY.fontFamily, fontSize: 9, fontWeight: 400,
      textRotation: 0, support: { kind: 'merge-run', bundle: bundle.id, run: bundle.mergeRuns![0]!.id },
      lines: ['2'], lineHeight: measure('2').lineHeight,
      bounds: candidate(bundle.mergeRuns![0]!.path.segments[0]!, '2', false),
    });
    // A merge label gets no segment exemption at all, and still passes G3 on its own clearance.
    const report = score(model).snapshot;
    for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
    expect(report.counters).toMatchObject({ labelHits: 0, labelsOmitted: 0 });
    expect(model.freeze!.placement).toEqual(routed.freeze!.placement);
    expect(model.links).toEqual(routed.links);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);

  it('creates no count label for ordinary parallel bundles or a singleton merge member', async () => {
    const singleton = merged.replace('{from: b.q, to: a.q, route: merge}', '[b.q, a.q]');
    const model = run(await throughRoute(singleton));
    expect(model.bundles[0]!.mergeRuns).toBeUndefined();
    expect(linkLabelsOf(model)).toEqual([]);
    const parallelOnly = merged.replace(/^links:.*$/m, 'links: [[a.p, b.p], [b.q, a.q], [a.r, b.r]]');
    const plain = run(await throughRoute(parallelOnly));
    expect(plain.bundles.every(item => item.mergeRuns === undefined)).toBe(true);
    expect(linkLabelsOf(plain)).toEqual([]);
  }, 60000);

  it('rejects a merge run whose count, membership or trunk ownership is forged', async () => {
    const routed = await throughRoute(merged);
    const run0 = routed.bundles[0]!.mergeRuns![0]!;
    const forge = (edit: (model: LayoutModel) => void): LayoutModel => {
      const draft = copy(routed); edit(draft); return draft;
    };
    for (const [reason, edit] of [
      ['count', (model: LayoutModel) => { model.bundles[0]!.mergeRuns![0]!.count = 3; }],
      ['membership', (model: LayoutModel) => { model.bundles[0]!.mergeRuns![0]!.members = [run0.members[0]!, 'link-3']; }],
      ['duplicate member', (model: LayoutModel) => { model.bundles[0]!.mergeRuns![0]!.members = [run0.members[0]!, run0.members[0]!]; }],
      ['trunk owner', (model: LayoutModel) => { model.bundles[0]!.mergeRuns![0]!.path.owner = { kind: 'link', id: 'link-1' }; }],
    ] as [string, (model: LayoutModel) => void][]) {
      expect(() => produceLinkLabels(forge(edit)), reason).toThrow(/Merge run merge:bundle-1:0/);
    }
  }, 60000);
});

describe('stage 9 overlay suppression', () => {
  const overlayYaml = (count: number): string => `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [${Array.from({ length: count }, (_, i) => `{name: p${i}, side: bottom}`).join(', ')}]}
  b: {group: gb, ports: [${Array.from({ length: count }, (_, i) => `{name: p${i}, side: top}`).join(', ')}]}
links: [${Array.from({ length: count }, (_, i) => `{from: a.p${i}, to: b.p${i}, route: overlay, label: flow${i}}`).join(', ')}]`;

  it('keeps overlay labels at the threshold and suppresses them above it', async () => {
    const atThreshold = await throughRoute(overlayYaml(OVERLAY_LABEL_DENSITY * 2));
    expect(overlayDensity(atThreshold)).toBe(OVERLAY_LABEL_DENSITY);
    expect(overlayLabelsSuppressed(atThreshold)).toBe(false);
    const kept = run(atThreshold);
    expect(linkLabelsOf(kept)).toHaveLength(OVERLAY_LABEL_DENSITY * 2);
    expect(linkLabelsOf(kept).every(label => label.layer === 'overlay')).toBe(true);
    expect(kept.diagnostics.some(item => item.code === 'LINK_LABELS_OVERLAY_SUPPRESSED')).toBe(false);
    expect(restoreLayoutModel(JSON.stringify(kept))).toEqual(kept);

    const above = await throughRoute(overlayYaml(OVERLAY_LABEL_DENSITY * 2 + 1));
    expect(overlayDensity(above)).toBeGreaterThan(OVERLAY_LABEL_DENSITY);
    expect(overlayLabelsSuppressed(above)).toBe(true);
    const suppressed = run(above);
    // Suppressed is not omitted: no record at all, so `labelsOmitted` stays at zero.
    expect(linkLabelsOf(suppressed)).toEqual([]);
    expect(score(suppressed).snapshot.counters.labelsOmitted).toBe(0);
    expect(suppressed.diagnostics.filter(item => item.code === 'LINK_LABELS_OVERLAY_SUPPRESSED')).toHaveLength(1);
    expect(restoreLayoutModel(JSON.stringify(suppressed))).toEqual(suppressed);
  }, 60000);

  it('divides by one node on an empty diagram', () => {
    const model = bench([], []);
    expect(overlayDensity(model)).toBe(0);
    expect(overlayLabelsSuppressed(model)).toBe(false);
  });
});

describe('stage 9 transaction', () => {
  it('rejects a callback that authors labels and a link label before stage 9', async () => {
    const routed = await throughRoute(fittingYaml);
    expect(() => withLayoutMutation(routed, 'link-labels', draft => {
      draft.labels.push({ id: 'forged', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', role: 'link',
        text: 'x', bounds: { x: 0, y: 0, width: 4, height: 4 } });
    })).toThrow('Link-label callback cannot author labels');
    const early = copy(routed);
    early.labels.push({ id: 'forged', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', role: 'link',
      text: 'x', bounds: { x: 0, y: 0, width: 4, height: 4 } });
    expect(() => restoreLayoutModel(JSON.stringify(early))).toThrow('Claim validator is not implemented');
  }, 60000);

  it('rejects forged, moved, stale and missing link labels on restore', async () => {
    const model = run(await throughRoute(fittingYaml));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const forge = (edit: (draft: LayoutModel) => void): string => {
      const draft = copy(model); edit(draft); return JSON.stringify(draft);
    };
    const cases: [string, (draft: LayoutModel) => void][] = [
      ['moved', draft => { draft.labels.at(-1)!.bounds!.x += 12; }],
      ['retexted', draft => { draft.labels.at(-1)!.text = 'downlink'; }],
      ['stale support', draft => { draft.labels.at(-1)!.support = { kind: 'link-segment', link: 'link-1', segment: 0 }; }],
      ['dropped support', draft => { delete draft.labels.at(-1)!.support; }],
      ['removed', draft => { draft.labels = draft.labels.filter(label => label.role !== 'link'); }],
      ['duplicated', draft => { draft.labels.push({ ...draft.labels.at(-1)!, id: 'label:link:extra' }); }],
      ['forged omission', draft => { const label = draft.labels.at(-1)!; delete label.bounds; label.omitted = true; }],
    ];
    for (const [reason, edit] of cases) {
      expect(() => restoreLayoutModel(forge(edit)), reason).toThrow('Link labels contradict measured post-route placement');
    }
    expect(() => restoreLayoutModel(forge(draft => { draft.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'LINK_LABEL_OMITTED', message: 'x' }); })))
      .toThrow('Link-label diagnostics contradict measured post-route placement');
    // Clipping the label, and shrinking to the label alone, are both clipped drawn geometry.
    expect(() => restoreLayoutModel(forge(draft => { draft.canvas = { ...draft.canvas!, width: draft.labels.at(-1)!.bounds!.x + draft.labels.at(-1)!.bounds!.width - draft.canvas!.x - 1 }; })))
      .toThrow('Canvas does not contain the published diagram');
    expect(() => restoreLayoutModel(forge(draft => { draft.canvas = { ...draft.labels.at(-1)!.bounds! }; })))
      .toThrow('Canvas does not contain the published diagram');
    // The groups start at x = 12, so a shift past them is a real exclusion, label box or not.
    expect(() => restoreLayoutModel(forge(draft => { draft.canvas = { ...draft.canvas!, x: draft.canvas!.x + 16 }; })))
      .toThrow('Canvas does not contain the published diagram');
  }, 60000);

  it('expands the canvas over a path that leaves its group, and rejects one that clips it', () => {
    // The route bulges out past the group box, which is exactly what groups and lanes do not cover.
    const bulge = () => bench(
      [{ id: 'source', bounds: { x: 0, y: 80, width: 100, height: 40 } },
        { id: 'target', bounds: { x: 300, y: 160, width: 100, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'],
        points: [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 180 }, { x: 400, y: 180 }] }]);
    const model = bulge();
    const group = model.groups['row-group']!.bounds!;
    expect(group.x + group.width).toBeLessThan(500);

    // Publication settles the canvas, so a route the earlier stages never covered is not rejected.
    model.canvas = { ...group };
    produceLinkLabels(model);
    expect(model.canvas.x + model.canvas.width).toBeGreaterThanOrEqual(500);
    model.stage = 'link-labels';
    expect(() => validateLinkLabels(model)).not.toThrow();

    const clipped = bulge();
    clipped.stage = 'link-labels';
    clipped.canvas = { ...group };
    expect(() => validateLinkLabels(clipped)).toThrow('Canvas does not contain the published diagram');
  });

  it('leaves group label bands and group labels untouched by a new link label', async () => {
    const routed = await throughRoute(fittingYaml);
    const model = run(routed);
    expect(model.labelBands).toEqual(routed.labelBands);
    expect(model.labels.filter(label => label.role === 'group')).toEqual(routed.labels.filter(label => label.role === 'group'));
    // The validator agrees when run directly on the published model.
    expect(() => validateLinkLabels(model)).not.toThrow();
  }, 60000);
});
