import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment } from '../../src/index.js';
import { drawio, render } from '../../src/index.js';
import { THEMES } from '../../src/profiles/network/themes.js';
import { ICON_INSET, iconGlyphBox, pathRuns, resolvePaint } from '../../src/render/shared.js';
import { cssRule, paintRules, themeRules } from '../../src/render/theme.js';
import type { PaintRule } from '../../src/render/theme.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { rows } from '../../src/layout/rows.js';
import { route } from '../../src/route/index.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { flatCells } from './drawio-cells.js';

/**
 * drawio-export ticket 13 (audit S-13): the SVG renderer and the draw.io export read one statement of the glyph box, the
 * path runs and the class paint. S-03, S-04 and S-10 were the failures of the private copies.
 */

const stored = readFileSync(new URL('../../goldens/m1-sip-edge.layout.json', import.meta.url), 'utf8');
const model = (change: (m: LayoutModel) => void = () => {}): LayoutModel => {
  const copy = JSON.parse(stored) as LayoutModel;
  change(copy);
  return copy;
};
const base = model();
const nodeId = Object.keys(base.nodes).find(id => base.nodes[id]!.icon && base.nodes[id]!.ports.some(port => port.pill && !port.ref.anonymous))!;
const port = base.nodes[nodeId]!.ports.find(item => item.pill && !item.ref.anonymous)!;

/** The style of the cell `id` in a draw.io file, as key/value pairs. */
function style(xml: string, id: string): Record<string, string> | undefined {
  const tag = flatCells(xml).match(new RegExp(`<mxCell id="${id.replace(/[~.]/g, '\\$&')}"[^>]*>`))?.[0];
  const text = tag?.match(/ style="([^"]*)"/)?.[1];
  return text === undefined ? undefined
    : Object.fromEntries(text.split(';').filter(entry => entry.includes('=')).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
}
const portCell = `pg-port~${nodeId}~${port.ref.name!}~${port.ref.ordinal}`;

describe('icon glyph box', () => {
  it('insets by ICON_INSET, or by the stated inset, at most a quarter of each side', () => {
    expect(iconGlyphBox({ x: 10, y: 20, width: 24, height: 24 })).toEqual({ x: 10 + ICON_INSET, y: 20 + ICON_INSET, width: 21, height: 21 });
    expect(iconGlyphBox({ x: 0, y: 0, width: 2, height: 2 })).toEqual({ x: 0.5, y: 0.5, width: 1, height: 1 });
    expect(iconGlyphBox({ x: 0, y: 0, width: 40, height: 8 }, 4)).toEqual({ x: 2, y: 2, width: 36, height: 4 });
  });

  it('keeps the glyph of a small tile in both renderers (S-10)', () => {
    const tiny = model(m => { m.nodes[nodeId]!.icon!.bounds = { ...m.nodes[nodeId]!.icon!.bounds, width: 2, height: 2 }; });
    const box = iconGlyphBox(tiny.nodes[nodeId]!.icon!.bounds);
    expect(render(tiny)).toContain(`width="1" height="1"`);
    for (const icons of ['profile', 'cisco19'] as const) {
      expect(style(drawio(tiny, { icons }), `pg-icon~${nodeId}`), icons).toBeDefined();
    }
    const xml = flatCells(drawio(tiny, { icons: 'profile' }));
    const geometry = xml.match(new RegExp(`<mxCell id="pg-icon~${nodeId}"[^>]*>\\s*<mxGeometry ([^>]*)`))![1]!;
    expect(geometry).toContain(`width="${box.width}" height="${box.height}"`);
  });
});

describe('path runs', () => {
  const at = (x: number, y: number) => ({ x, y });
  const segment = (from: { x: number; y: number }, to: { x: number; y: number }): PathSegment => ({ from, to }) as PathSegment;

  it('splits where a segment does not start at the end of the one before, at the planar tolerance', () => {
    expect(pathRuns([])).toEqual([]);
    expect(pathRuns([segment(at(0, 0), at(10, 0)), segment(at(10, 0), at(10, 10))])).toEqual([{ first: 0, last: 1 }]);
    // 5e-8 is within the planar EPS (1e-7); 1e-6 is not, although it was within the old draw.io EPS.
    expect(pathRuns([segment(at(0, 0), at(10, 0)), segment(at(10 + 5e-8, 0), at(10, 10))])).toEqual([{ first: 0, last: 1 }]);
    expect(pathRuns([segment(at(0, 0), at(10, 0)), segment(at(10 + 1e-6, 0), at(10, 10)), segment(at(10, 10), at(0, 10))]))
      .toEqual([{ first: 0, last: 0 }, { first: 1, last: 2 }]);
  });

  it('gives one subpath in the SVG per connector in draw.io', () => {
    const link = base.links.find(item => (item.path?.segments.length ?? 0) >= 2)!;
    const split = model(m => {
      const segments = m.links.find(item => item.id === link.id)!.path!.segments;
      segments[1] = { ...segments[1]!, from: { x: segments[1]!.from.x + 1e-6, y: segments[1]!.from.y } };
    });
    const svg = render(split);
    const d = svg.match(new RegExp(`data-id="${link.id.replace(/[.>]/g, '\\$&')}"[\\s\\S]*?<path [^>]*d="([^"]*)"`))?.[1];
    expect(d?.match(/M/g)).toHaveLength(2);
    const connectors = [...flatCells(drawio(split)).matchAll(/<mxCell id="pg-link~[^"]*"[^>]*pg-kind="link"/g)].length;
    const before = [...flatCells(drawio(base)).matchAll(/<mxCell id="pg-link~[^"]*"[^>]*pg-kind="link"/g)].length;
    expect(connectors).toBe(before + 1);
  });
});

describe('paint rules', () => {
  it('serialise to the theme sheet', () => {
    for (const theme of THEMES) {
      for (const mode of ['light', 'dark', 'print'] as const) expect(paintRules(mode, theme).map(cssRule)).toEqual(themeRules(mode, theme));
    }
  });

  it('resolve as the CSS cascade: specificity first, then sheet order', () => {
    const rules: PaintRule[] = [
      { element: 'pill', tokens: ['a'], declarations: [['fill', 'red']] },
      { element: 'pill', tokens: [], declarations: [['fill', 'blue'], ['stroke', 'blue']] },
      { element: 'pill', tokens: ['b'], declarations: [['fill', 'green']] },
      { element: 'pill', tokens: ['c'], where: true, declarations: [['stroke', 'black']] },
    ];
    expect(Object.fromEntries(resolvePaint(rules, 'pill a'))).toEqual({ fill: 'red', stroke: 'blue' });
    expect(Object.fromEntries(resolvePaint(rules, 'pill', 'b a'))).toEqual({ fill: 'green', stroke: 'blue' });
    expect(Object.fromEntries(resolvePaint(rules, 'pill c'))).toEqual({ fill: 'blue', stroke: 'black' });
    expect(Object.fromEntries(resolvePaint(rules, 'link-line a'))).toEqual({});
  });

  it('keep the known paint of a class with a further token (S-03)', () => {
    const plain = drawio(model(m => { m.document.nodes[nodeId]!.class = 'router'; }));
    const extra = drawio(model(m => { m.document.nodes[nodeId]!.class = 'router extra'; }));
    expect(style(plain, `pg-iconTile~${nodeId}`)).toBeDefined();
    expect(style(extra, `pg-iconTile~${nodeId}`)).toEqual(style(plain, `pg-iconTile~${nodeId}`));
    expect(style(extra, portCell)!['fillColor']).toBe(style(plain, portCell)!['fillColor']);
    const link = (klass: string): string => drawio(model(m => { m.document.links[0]!.class = klass; }));
    const first = (xml: string): Record<string, string> =>
      Object.fromEntries((flatCells(xml).match(/<mxCell id="pg-link~[^"]*" style="([^"]*)"[^>]*pg-kind="link"/)![1]!)
        .split(';').filter(entry => entry.includes('=')).map(entry => entry.split('=') as [string, string]));
    expect(first(link('dashed extra'))['dashPattern']).toBe('4 4');
    expect(first(link('dashed extra'))).toEqual(first(link('dashed')));
  });

  it('do not depend on the order of the port tokens (S-04)', () => {
    const portClass = (tokens: string): string => drawio(model(m => {
      m.nodes[nodeId]!.ports.find(item => item.ref.name === port.ref.name && item.ref.ordinal === port.ref.ordinal)!.class = tokens;
    }));
    const upDown = style(portClass('up down'), portCell)!, downUp = style(portClass('down up'), portCell)!;
    expect(upDown).toEqual(downUp);
    // The SVG sheet states `.pill.down` after `.pill.up`, so both orders take the `down` stroke and dash.
    expect(upDown['dashPattern']).toBe('2 2');
  });
});

describe('fixture drawio-class-tokens', () => {
  it('paints a class with a further token, and port tokens in either order, as the SVG cascade does', async () => {
    const yaml = readFileSync(new URL('../../goldens/synthetic/drawio-class-tokens.yaml', import.meta.url), 'utf8');
    const laid = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))), { createAttempt: createAvoidAttempt }));
    for (const theme of ['auto', 'light', 'dark'] as const) {
      const xml = drawio(laid, { theme });
      const pill = (node: string, name: string): Record<string, string> => {
        const { fillColor, strokeColor, dashPattern, fontColor } = style(xml, `pg-port~${node}~${name}~1`)!;
        return { fillColor: fillColor!, strokeColor: strokeColor!, dashPattern: dashPattern!, fontColor: fontColor! };
      };
      expect(pill('extra-router', 'down'), theme).toEqual(pill('plain-router', 'down'));
      expect(pill('border', 'one'), theme).toEqual(pill('border', 'two'));
      expect(pill('border', 'one').dashPattern, theme).toBe('2 2');
      const links = [...flatCells(xml).matchAll(/<mxCell id="pg-link~[^"]*" style="([^"]*)"[^>]*pg-kind="link"/g)]
        .map(match => match[1]!.split(';').filter(entry => /^(strokeColor|dashPattern|dashed)=/.test(entry)).join(';'));
      expect(links, theme).toHaveLength(2);
      expect(links[0], theme).toBe(links[1]);
      expect(links[0], theme).toContain('dashPattern=4 4');
    }
  });
});
