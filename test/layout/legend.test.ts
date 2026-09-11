import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { DEFAULT_STROKE_WIDTHS, LEGEND_GEOMETRY, diagramBounds, drawnBoxes, legendBoxes, legendRequired, legendVariants, produceLegend,
  restoreLayoutModel, score } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { rows } from '../../src/layout/rows.js';
import { route } from '../../src/route/index.js';
import { placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { scene } from '../render/fixture.js';

const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const bottom = (box: Rect): number => box.y + box.height;
const right = (box: Rect): number => box.x + box.width;
const overlaps = (a: Rect, b: Rect): boolean => Math.min(right(a), right(b)) > Math.max(a.x, b.x)
  && Math.min(bottom(a), bottom(b)) > Math.max(a.y, b.y);

/** The same model as the diagram drew it, before the legend joined. */
function withoutLegend(model: LayoutModel): LayoutModel {
  const copy = { ...model, labels: model.labels.filter(label => label.role !== 'legend') };
  delete copy.legend;
  return copy;
}

async function golden(): Promise<LayoutModel> {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(goldenYaml))))))));
  return linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
}

const pair = (nodes: { id: string; class?: string; icon?: string }[], links: { class?: string }[]): LayoutModel =>
  scene({
    nodes: nodes.map((node, index) => ({ ...node, bounds: { x: index * 120, y: 0, width: 60, height: 40 },
      ...(node.icon ? { iconBounds: { x: index * 120 + 24, y: 10, width: 12, height: 12 } } : {}) })),
    ports: links.flatMap((_item, index) => [
      { node: nodes[0]!.id, name: `p${index}`, side: 'right' as const, anchor: { x: 60, y: 10 + index * 5 } },
      { node: nodes[1]!.id, name: `p${index}`, side: 'left' as const, anchor: { x: 120, y: 10 + index * 5 } }]),
    links: links.map((link, index) => ({ id: `l${index}`, from: nodes[0]!.id, to: nodes[1]!.id,
      points: [{ x: 60, y: 10 + index * 5 }, { x: 120, y: 10 + index * 5 }], ...link })),
  });

/** Legend symbol IDs for a diagram that draws one class per node, in document order. */
const symbolIds = (values: string[]): string[] => legendVariants(scene({
  nodes: values.map((value, index) => ({ id: `n${index}`, class: value,
    bounds: { x: index * 120, y: 0, width: 60, height: 40 } })),
})).symbols.map(item => item.id);

describe('legend presence', () => {
  it('adds nothing for an empty diagram or a single visual variant', () => {
    const empty = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } }] });
    produceLegend(empty);
    expect(empty.legend).toBeUndefined();
    expect(legendRequired(empty)).toBe(false);

    const single = pair([{ id: 'a', class: 'router' }, { id: 'b', class: 'router' }], [{}]);
    expect(legendRequired(single)).toBe(false);
    produceLegend(single);
    expect(single.legend).toBeUndefined();
    expect(single.labels.filter(label => label.role === 'legend')).toEqual([]);
  });

  it('appears as soon as either set has more than one variant', () => {
    const twoSymbols = pair([{ id: 'a', class: 'router' }, { id: 'b', class: 'tbr' }], [{}]);
    expect(legendRequired(twoSymbols)).toBe(true);
    const twoLines = pair([{ id: 'a', class: 'router' }, { id: 'b', class: 'router' }], [{}, { class: 'dashed' }]);
    expect(legendRequired(twoLines)).toBe(true);
  });

  it('lists known classes in profile order and unknown author classes by first use', () => {
    const model = pair([{ id: 'a', class: 'tbr' }, { id: 'b', class: 'provider' }],
      [{ class: 'zeta' }, { class: 'dashed' }, { class: 'alpha' }, { class: 'zeta' }]);
    const { symbols, lines } = legendVariants(model);
    expect(symbols.map(item => item.id)).toEqual(['symbol:provider', 'symbol:tbr']);
    expect(lines.map(item => item.id)).toEqual(['line:dashed', 'line:zeta', 'line:alpha']);
  });

  it('keeps two classes distinct when one of them contains the ID separator', () => {
    const model = scene({ nodes: [
      { id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 }, class: 'router', icon: 'server',
        iconBounds: { x: 24, y: 10, width: 12, height: 12 } },
      { id: 'b', bounds: { x: 120, y: 0, width: 60, height: 40 }, class: 'router', icon: 'router',
        iconBounds: { x: 144, y: 10, width: 12, height: 12 } },
      { id: 'c', bounds: { x: 240, y: 0, width: 60, height: 40 }, class: 'router:server', icon: 'cloud',
        iconBounds: { x: 264, y: 10, width: 12, height: 12 } }] });
    const symbols = legendVariants(model).symbols;
    // Three classes/icon combinations are drawn, so three entries exist with three distinct IDs.
    expect(symbols.map(item => item.key)).toEqual(['router', 'router', 'router:server']);
    expect(new Set(symbols.map(item => item.id)).size).toBe(3);
    expect(symbols.map(item => item.id)).toContain('symbol:router%3Aserver');
    produceLegend(model);
    expect(model.legend!.entries).toHaveLength(3);
    expect(new Set(model.labels.filter(label => label.role === 'legend').map(label => label.id)).size).toBe(3);
  });

  it('keeps two classes distinct when one of them holds a character XML attributes alter', () => {
    // Class strings are accepted free text, so an identity built from them has to survive both the
    // serializer's substitution for a character XML forbids and an XML parser's folding of literal
    // attribute whitespace. Every one of these classes is distinct in the document.
    // Control characters, the whitespace a parser normalizes to a space, and lone surrogates.
    expect(symbolIds(['a\u0001', 'a\u0002'])).toEqual(['symbol:a%01', 'symbol:a%02']);
    expect(symbolIds(['a\nb', 'a b', 'a\tb', 'a\r\nb']))
      .toEqual(['symbol:a%0Ab', 'symbol:a b', 'symbol:a%09b', 'symbol:a%0D%0Ab']);
    expect(symbolIds(['a\ud800', 'a\udfff'])).toEqual(['symbol:a%uD800', 'symbol:a%uDFFF']);
    // An ordinary class keeps its spelling, and a valid astral pair is one code point XML carries.
    expect(symbolIds(['router', 'edge core', 'a\u{1f600}']))
      .toEqual(['symbol:router', 'symbol:edge core', 'symbol:a\u{1f600}']);
  });

  it('cannot have its identity impersonated by a class that spells an escape', () => {
    // `%` always encodes, so no ordinary class can spell the encoded form of another one.
    for (const both of [['a\u0001', 'a%01'], ['a\nb', 'a%0Ab'], ['a\ud800', 'a%uD800'],
      ['a:b', 'a%3Ab'], ['a%b', 'a%25b'], ['a%0Ab', 'a%250Ab']]) {
      expect([both, new Set(symbolIds(both)).size]).toEqual([both, 2]);
    }
  });

  it('qualifies a class drawn with two different icons and skips a node without a class', () => {
    const model = scene({ nodes: [
      { id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 }, class: 'router', icon: 'router',
        iconBounds: { x: 24, y: 10, width: 12, height: 12 } },
      { id: 'b', bounds: { x: 120, y: 0, width: 60, height: 40 }, class: 'router', icon: 'server',
        iconBounds: { x: 144, y: 10, width: 12, height: 12 } },
      { id: 'c', bounds: { x: 240, y: 0, width: 60, height: 40 } }] });
    expect(legendVariants(model).symbols.map(item => [item.id, item.icon]))
      .toEqual([['symbol:router:router', 'router'], ['symbol:router:server', 'server']]);
  });
});

describe('legend geometry', () => {
  it('takes newly reserved space below everything the diagram draws', async () => {
    const model = await golden();
    const legend = model.legend!;
    const diagram = diagramBounds(withoutLegend(model))!;
    // The gap is *visible* separation, so it is measured between painted edges: the diagram's
    // bottom already includes its outer half stroke, and so does the legend's topmost paint.
    const painted = Math.min(...legendBoxes(model).map(box => box.y));
    expect(painted).toBe(bottom(diagram) + LEGEND_GEOMETRY.gap);
    expect(legend.bounds.y).toBe(painted);
    // Entries begin at the diagram's left edge; the first tile's outline reaches half a stroke
    // further, and `bounds` is the painted region, so it starts there.
    expect(legend.entries[0]!.swatch.x).toBe(diagram.x);
    expect(legend.bounds.x).toBe(diagram.x - DEFAULT_STROKE_WIDTHS.pill / 2);
    for (const entry of legend.entries) {
      expect(entry.swatch.y).toBeGreaterThanOrEqual(legend.bounds.y);
      expect(overlaps(entry.swatch, diagram)).toBe(false);
    }
    for (const label of model.labels.filter(item => item.role === 'legend')) {
      expect(overlaps(label.bounds!, diagram)).toBe(false);
    }
    // Every legend box is inside the published canvas, and every entry has its label.
    const canvas = model.canvas!;
    for (const box of [legend.bounds, ...legend.entries.map(entry => entry.swatch),
      ...model.labels.filter(item => item.role === 'legend').map(item => item.bounds!)]) {
      expect([box, box.x >= canvas.x && box.y >= canvas.y && right(box) <= right(canvas) && bottom(box) <= bottom(canvas)])
        .toEqual([box, true]);
    }
    expect(legend.entries.map(entry => entry.label).sort())
      .toEqual(model.labels.filter(item => item.role === 'legend').map(item => item.id).sort());
  }, 60000);

  it('measures the reserved gap from what a wide line sample really paints', () => {
    // A line sample is stroked along its box's centreline, so its paint is exactly its own width —
    // counting the box *and* half the stroke would reserve a gap far larger than the ruling.
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 }, class: 'router' },
        { id: 'b', bounds: { x: 300, y: 0, width: 40, height: 40 }, class: 'tbr' }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 10 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 300, y: 10 } },
        { node: 'a', name: 'q', side: 'right', anchor: { x: 40, y: 30 } },
        { node: 'b', name: 'q', side: 'left', anchor: { x: 300, y: 30 } }],
      links: [{ id: 'fat', from: 'a', to: 'b', class: 'flow', layer: 'overlay', strokeWidth: 100,
        points: [{ x: 40, y: 10 }, { x: 300, y: 10 }] },
      { id: 'thin', from: 'a', to: 'b', class: 'dotted', layer: 'overlay',
        points: [{ x: 40, y: 30 }, { x: 300, y: 30 }] }],
    });
    produceLegend(model);
    const diagram = diagramBounds(withoutLegend(model))!;
    const painted = Math.min(...legendBoxes(model).map(box => box.y),
      ...model.labels.filter(label => label.role === 'legend').map(label => label.bounds!.y));
    expect(painted).toBe(bottom(diagram) + LEGEND_GEOMETRY.gap);
    // The wide sample's painted box is its own width tall, not its box plus another stroke.
    const fat = model.legend!.entries.find(entry => entry.key === 'flow')!;
    expect(fat.strokeWidth).toBe(100);
    const box = legendBoxes(model)[model.legend!.entries.indexOf(fat) + 1]!;
    expect(box.height).toBe(100);
    expect(box.y + box.height / 2).toBe(fat.swatch.y + fat.swatch.height / 2);
  });

  it('covers the painted cap of a segment at any angle', () => {
    // A square or round cap extends a stroke along its own direction as well as across it, so a
    // diagonal overlay's paint reaches further on both axes than half its width.
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 }, class: 'router' },
        { id: 'b', bounds: { x: 200, y: 200, width: 40, height: 40 }, class: 'tbr' }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 220 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', class: 'flow', layer: 'overlay', strokeWidth: 20,
        points: [{ x: 40, y: 20 }, { x: 200, y: 220 }] }],
    });
    // The cap corner reaches (stroke / 2) · (|dx| + |dy|) / length on each axis.
    const reach = 10 * (160 + 200) / Math.hypot(160, 200);
    expect(reach).toBeGreaterThan(10);
    const diagonal = drawnBoxes(model, false)
      .find(box => Math.abs(box.width - (160 + 2 * reach)) < 1e-9 && Math.abs(box.height - (200 + 2 * reach)) < 1e-9)!;
    expect(diagonal).toBeDefined();
    expect(diagonal.x).toBeCloseTo(40 - reach, 9);
    expect(diagonal.y).toBeCloseTo(20 - reach, 9);
    // An axis-aligned run is unaffected: its cap extends only half a stroke.
    const flat = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
      { id: 'b', bounds: { x: 200, y: 0, width: 40, height: 40 } }],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
      { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 20 } }],
    links: [{ id: 'l', from: 'a', to: 'b', strokeWidth: 20, points: [{ x: 40, y: 20 }, { x: 200, y: 20 }] }] });
    expect(drawnBoxes(flat, false).some(box => box.x === 30 && box.y === 10 && box.width === 180)).toBe(true);
  });

  it('moves no frozen placement and no group label', async () => {
    const model = await golden();
    const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(goldenYaml))))))));
    expect(model.freeze!.placement).toEqual(before.freeze!.placement);
    expect(model.labels.filter(label => label.role === 'group'))
      .toEqual(before.labels.filter(label => label.role === 'group'));
    expect(model.labelBands).toEqual(before.labelBands);
  }, 120000);

  it('records the stroke width score measures for each line entry', async () => {
    const model = await golden();
    for (const entry of model.legend!.entries.filter(item => item.kind === 'line')) {
      const link = model.links.find(item => (model.document.links[item.sourceIndex]!.class ?? 'default') === entry.key)!;
      expect([entry.key, entry.strokeWidth]).toEqual([entry.key, link.path!.strokeWidth ?? 1.5]);
    }
  }, 60000);

  it('does not enter the scored diagram bounding box', async () => {
    const model = await golden();
    const without = withoutLegend(model);
    expect(score(model).snapshot.metrics.aspectRatio).toBe(score(without).snapshot.metrics.aspectRatio);
    expect(score(model).snapshot.Q).toBe(score(without).snapshot.Q);
    // The canvas, which render and score share, does contain it.
    expect(bottom(model.canvas!)).toBeGreaterThanOrEqual(bottom(model.legend!.bounds));
  }, 60000);
});

describe('legend claims', () => {
  it('rejects a forged, moved or removed legend on restore', async () => {
    const model = await golden();
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const tamper = (edit: (value: LayoutModel) => void): void => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      edit(copy);
      expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow();
    };
    tamper(copy => { delete copy.legend; });
    tamper(copy => { copy.legend!.bounds.y += 40; });
    tamper(copy => { copy.legend!.entries.splice(0, 1); });
    tamper(copy => { copy.legend!.entries[0]!.key = 'invented'; });
    tamper(copy => { copy.legend!.entries[0]!.swatch.width += 10; });
    tamper(copy => { copy.labels = copy.labels.filter(label => label.role !== 'legend'); });
    tamper(copy => { copy.labels.find(label => label.role === 'legend')!.text = 'Something else'; });
    tamper(copy => { copy.canvas!.height -= 40; });
  }, 60000);

  it('cannot exist before stage 9', async () => {
    const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(goldenYaml))))))));
    const premature = JSON.parse(JSON.stringify(before)) as LayoutModel;
    premature.legend = { id: 'legend', owner: { kind: 'legend', id: 'legend' }, layer: 'routed',
      bounds: { x: 0, y: 0, width: 10, height: 10 }, entries: [] };
    expect(() => restoreLayoutModel(JSON.stringify(premature))).toThrow(/Claim validator/);
  }, 60000);
});
