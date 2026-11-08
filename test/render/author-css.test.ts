import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Diagnostic, LayoutModel } from '../../src/index.js';
import { drawio, render } from '../../src/index.js';
import { THEMES, themeById } from '../../src/profiles/network/themes.js';
import { authorRules, cssColour } from '../../src/render/author-css.js';
import { PaintSheet, computePaint } from '../../src/render/shared.js';
import { paintRules } from '../../src/render/theme.js';
import type { PaintRule } from '../../src/render/theme.js';
import { lineKey, legendLineOverlay, symbolKey } from '../../src/layout/legend.js';
import { resolveNodeIcon } from '../../src/profiles/network/icons.js';
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
 * draw.io ticket 8 (audit S-02, A1-16): the document's `css:` reaches the draw.io export through the rule table the SVG writes, by
 * the cascade a browser applies, and what draw.io cannot carry is named in one warning.
 */

const values = (map: ReadonlyMap<string, { value: string }>): Record<string, string> =>
  Object.fromEntries([...map].map(([property, resolved]) => [property, resolved.value]));

describe('author rules', () => {
  it('read class selectors, combinators, media, importance and the paint values draw.io can carry', () => {
    const { rules, unmapped } = authorRules([
      '.node.access .pill, .links > .link-line { stroke: Teal; stroke-dasharray: 4px, 2px }',
      '@media (prefers-color-scheme: dark) { .pill { fill: rgb(255 0 0) } }',
      '@media screen and (prefers-color-scheme: light), print { .pill { fill: #ABC !important } }',
      '.port { opacity: 30%; --brand: red }',
      '.pill:hover, rect.pill { fill: #000 }',
      '.pill { fill: var(--brand); stroke-linecap: round }',
      '@supports (display: grid) { .pill { fill: red } }',
      '@media (min-width: 100px) { .pill { fill: red } }',
    ].join('\n'));
    expect(rules.map(({ element, tokens, context, modes, important, declarations }) => ({ element, tokens, context, modes, important, declarations }))).toEqual([
      { element: 'pill', tokens: [], context: [{ classes: ['node', 'access'], child: false }], modes: undefined, important: undefined,
        declarations: [['stroke', '#008080'], ['stroke-dasharray', '4 2']] },
      { element: 'link-line', tokens: [], context: [{ classes: ['links'], child: true }], modes: undefined, important: undefined,
        declarations: [['stroke', '#008080'], ['stroke-dasharray', '4 2']] },
      { element: 'pill', tokens: [], context: undefined, modes: ['dark'], important: undefined, declarations: [['fill', '#ff0000']] },
      { element: 'pill', tokens: [], context: undefined, modes: ['light', 'print'], important: true, declarations: [['fill', '#aabbcc']] },
      { element: 'port', tokens: [], context: undefined, modes: undefined, important: undefined, declarations: [['opacity', '0.3']] },
    ]);
    expect(unmapped).toEqual([
      '.pill:hover { … }', 'rect.pill { … }',
      '.pill { fill: var(--brand) }', '.pill { stroke-linecap: round }',
      '@supports (display: grid)', '@media (min-width: 100px)',
    ]);
  });

  it('turn CSS colours into #rrggbb, and refuse a colour draw.io cannot pair', () => {
    expect(['#AbC', '#a1b2c3', '#a1b2c3ff', 'rgb(10, 20, 30)', 'rgba(10 20 30 / 1)', 'rgb(100%, 0%, 50%)', 'rebeccapurple'].map(cssColour))
      .toEqual(['#aabbcc', '#a1b2c3', '#a1b2c3', '#0a141e', '#0a141e', '#ff0080', '#663399']);
    expect(['#a1b2c380', 'rgba(1, 2, 3, 0.5)', 'currentcolor', 'var(--x)', 'hsl(0 0% 0%)'].map(cssColour)).toEqual(Array(5).fill(undefined));
  });
});

describe('author rules draw.io cannot carry (review of draw.io ticket 8)', () => {
  it('lists a rule whose subject has no class: it also matches the text spans and the glyph paths, which no cell is', () => {
    const { rules, unmapped } = authorRules('* { fill: #ff0000 }\n.x * { fill: #ff0000 }\n.node-label * { fill: #ff0000 }\n*.pill { fill: #00ff00 }\n.node * > .pill { stroke: #0000ff }');
    expect(rules.map(rule => rule.source)).toEqual(['*.pill', '.node * > .pill']);
    expect(unmapped).toEqual(['* { … }', '.x * { … }', '.node-label * { … }']);
  });

  it('lists a nested rule or at-rule (CSS nesting), and keeps the declarations of the rule around it', () => {
    const { rules, unmapped } = authorRules([
      '.node.access { stroke: #111111; .pill { fill: #ff00ff } }',
      '.group { & .group-box { stroke: #00ffff } }',
      '.pill { @media print { fill: #ff0000 } }',
    ].join('\n'));
    expect(rules.map(rule => [rule.source, rule.declarations])).toEqual([['.node.access', [['stroke', '#111111']]]]);
    expect(unmapped).toEqual(['.node.access { .pill { … } }', '.group { & .group-box { … } }', '.pill { @media print { … } }']);
  });

  it('lists a media query that matches no mode', () => {
    expect(authorRules('@media print and (prefers-color-scheme: dark) { .pill { fill: #ff0000 } }').unmapped)
      .toEqual(['@media print and (prefers-color-scheme: dark) (matches no mode)']);
    expect(authorRules('@media print { @media (prefers-color-scheme: dark) { .pill { fill: #ff0000 } } }').unmapped)
      .toEqual(['@media (prefers-color-scheme: dark) (matches no mode)']);
  });

  it('refuses a value a browser refuses, so the earlier valid value stays in force', () => {
    for (const value of ['rgb(255,0,0,)', 'rgb(100%,0,0)', 'rgb(1 2)', 'rgb(1, 2 3)', 'rgb(1 2 3 / )']) expect(cssColour(value), value).toBeUndefined();
    expect([cssColour('rgb(100% 0 50%)'), cssColour('rgb(255, 0, 0, 1)'), cssColour('rgb(1 2 3 / 100%)')]).toEqual(['#ff0080', '#ff0000', '#010203']);
    const { rules, unmapped } = authorRules('.pill { fill: #00ff00; fill: rgb(255,0,0,); stroke-dasharray: 2 2; stroke-dasharray: 1,,2 }');
    expect(rules[0]!.declarations).toEqual([['fill', '#00ff00'], ['stroke-dasharray', '2 2']]);
    expect(unmapped).toEqual(['.pill { fill: rgb(255,0,0,) }', '.pill { stroke-dasharray: 1,,2 }']);
    expect(authorRules('.pill { stroke-dasharray: 1, 2 3 }').rules[0]!.declarations).toEqual([['stroke-dasharray', '1 2 3']]);
    for (const value of ['1,', ',1', '1 ,, 2']) expect(authorRules(`.pill { stroke-dasharray: ${value} }`).rules, value).toEqual([]);
  });

  it('reads a long run of digits or spaces in linear time (R4)', () => {
    const digits = '1'.repeat(300_000), spaces = ' '.repeat(300_000);
    const css = [`.pill { opacity: ${digits}x; fill-opacity: .${digits}; stroke-dasharray: ${digits}x }`,
      `.pill { fill: rgb(${digits}x); stroke: rgb(${spaces}x }`, `.a${spaces}.b { fill: #000 }`].join('\n');
    const start = performance.now();
    authorRules(css);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('the cascade on a path', () => {
  const rule = (element: string, declarations: PaintRule['declarations'], extra: Partial<PaintRule> = {}): PaintRule =>
    ({ element, tokens: [], declarations, ...extra });

  it('inherits paint from the ancestors, but not opacity', () => {
    const rules = [rule('node', [['stroke', 'red'], ['opacity', '0.5'], ['stroke-dasharray', '4 4']]), rule('pill', [['stroke', 'blue']])];
    const [, node, pill] = computePaint(rules, ['portograph', 'node', 'pill']);
    expect(values(node!)).toEqual({ stroke: 'red', opacity: '0.5', 'stroke-dasharray': '4 4' });
    expect(values(pill!)).toEqual({ stroke: 'blue', 'stroke-dasharray': '4 4' });
  });

  it('matches descendant and child compounds, and counts their classes in the specificity', () => {
    const rules = [
      rule('pill', [['fill', 'deep']], { context: [{ classes: ['nodes'], child: false }, { classes: ['node', 'a'], child: false }] }),
      rule('pill', [['fill', 'child']], { context: [{ classes: ['nodes'], child: true }] }),
      rule('pill', [['fill', 'plain'], ['stroke', 'plain']]),
    ];
    expect(values(computePaint(rules, ['nodes', 'node a', 'port', 'pill']).at(-1)!)).toEqual({ fill: 'deep', stroke: 'plain' });
    expect(values(computePaint(rules, ['nodes', 'pill']).at(-1)!)).toEqual({ fill: 'child', stroke: 'plain' });
    expect(values(computePaint(rules, ['nodes', 'node b', 'pill']).at(-1)!)).toEqual({ fill: 'plain', stroke: 'plain' });
  });

  it('lets an important declaration beat a more specific normal one, and `inherit` take the parent value', () => {
    const rules = [
      rule('pill', [['fill', 'important']], { important: true }),
      rule('pill', [['fill', 'specific'], ['stroke', 'inherit']], { tokens: ['uplink'] }),
      rule('port', [['stroke', 'from-port']]),
    ];
    expect(values(computePaint(rules, ['port', 'pill uplink']).at(-1)!)).toEqual({ fill: 'important', stroke: 'from-port' });
  });
});

describe('the mode rule', () => {
  // A browser keeps the light (unconditional) rules in force under dark and print and reads the matching media block on top of them.
  // The draw.io export reads a mode the same way: a light rule that the mode's rules do not restate stays in force.
  const theme = themeById(undefined);
  const css = [
    '.pill { stroke-dasharray: 3 1 }',
    '@media (prefers-color-scheme: dark) { .pill { fill: #000000 } }',
    '@media print { .pill { stroke: #111111 } }',
    '@media (prefers-color-scheme: light) { .pill { stroke-opacity: 0.5 } }',
  ].join('\n');
  const sheet = new PaintSheet(theme, [], css);
  const pill = ['portograph network', 'nodes', 'node', 'port', 'pill'];

  it('reads dark and print on top of light', () => {
    const light = sheet.rules('light'), dark = sheet.rules('dark'), print = sheet.rules('print');
    expect(dark.slice(0, 5)).toEqual(light.slice(0, 5));
    expect(print.slice(0, 5)).toEqual(light.slice(0, 5));
    const at = (mode: 'light' | 'dark' | 'print', property: string): string | undefined => sheet.at(mode, pill).get(property);
    expect([at('light', 'stroke-dasharray'), at('dark', 'stroke-dasharray'), at('print', 'stroke-dasharray')]).toEqual(['3 1', '3 1', '3 1']);
    expect(at('dark', 'fill')).toBe('#000000');
    expect(at('light', 'fill')).not.toBe('#000000');
    expect(at('print', 'stroke')).toBe('#111111');
    expect(at('dark', 'stroke')).not.toBe('#111111');
    // A print is a print in the light scheme.
    expect([at('light', 'stroke-opacity'), at('dark', 'stroke-opacity'), at('print', 'stroke-opacity')]).toEqual(['0.5', undefined, '0.5']);
  });

  it('resolves the theme alone as each mode sheet alone resolved it before, since every mode sheet restates its properties', () => {
    const paths = [pill, ['portograph network', 'overlay-links', 'link overlay flow', 'link-line overlay-line flow'],
      ['portograph network', 'links', 'link dashed', 'link-line dashed'], ['portograph network', 'nodes', 'node router', 'port router unused']];
    for (const each of THEMES) {
      for (const mode of ['dark', 'print'] as const) {
        for (const path of paths) {
          expect(values(computePaint([...paintRules('light', each), ...paintRules(mode, each)], path).at(-1)!), `${each.id} ${mode} ${path.at(-1)}`)
            .toEqual(values(computePaint(paintRules(mode, each), path).at(-1)!));
        }
      }
    }
  });
});

describe('legend keys and icons of a class with several tokens', () => {
  it('take the profile class that paints the node or the line', () => {
    expect(symbolKey('router extra')).toBe('router');
    expect(symbolKey('extra router tbr')).toBe('tbr');
    expect(symbolKey('access')).toBe('access');
    expect(symbolKey('access edge')).toBe('access edge');
    expect(resolveNodeIcon({ class: 'router extra' })).toBe('router');
    expect(resolveNodeIcon({ class: 'extra core' })).toBe('router');
    expect(resolveNodeIcon({ class: 'tbr router' })).toBe(resolveNodeIcon({ class: 'router tbr' }));
    const model = { document: { links: [{ class: 'dashed extra' }, { class: 'flow' }, {}] } } as unknown as LayoutModel;
    const link = (sourceIndex: number) => ({ sourceIndex }) as LayoutModel['links'][number];
    expect([0, 1, 2].map(index => lineKey(model, link(index)))).toEqual(['dashed', 'flow', 'default']);
  });
});

describe('fixture drawio-author-css', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/drawio-author-css.yaml', import.meta.url), 'utf8');
  const laid = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))), { createAttempt: createAvoidAttempt }));
  const style = (xml: string, id: string): Record<string, string> => {
    const tag = flatCells(xml).match(new RegExp(`<mxCell id="${id.replace(/[~.]/g, '\\$&')}"[^>]*>`))?.[0];
    expect(tag, id).toBeDefined();
    const text = tag?.match(/ style="([^"]*)"/)?.[1] ?? '';
    return Object.fromEntries(text.split(';').filter(entry => entry.includes('=')).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
  };
  const linkCell = (xml: string, from: string): Record<string, string> => {
    const id = flatCells(xml).match(new RegExp(`<mxCell id="(pg-link~${from}[^"]*)"`))![1]!;
    // The id as the file spells it (`&gt;` for the `>` of a stable link id).
    return style(xml, id);
  };

  it('paints the draw.io cells with the author rules, as the SVG cascade does', () => {
    const warnings: Diagnostic[] = [];
    const auto = drawio(laid, { onDiagnostic: diagnostic => warnings.push(diagnostic) });
    expect(style(auto, 'pg-node~core-1')['fillColor']).toBe('light-dark(#fde68a,#78350f)');
    expect(style(drawio(laid, { theme: 'print' }), 'pg-node~core-1')['fillColor']).toBe('#fde68a');
    expect(style(auto, 'pg-port~access-1~up~1')['strokeColor']).toBe('light-dark(#b91c1c,#b91c1c)');
    expect(style(auto, 'pg-port~border-1~up~1')['strokeColor']).not.toContain('#b91c1c');
    expect(style(auto, 'pg-port~border-1~up~1')['fontColor']).toBe('light-dark(#1e3a8a,#1e3a8a)');
    const unused = style(auto, 'pg-port~core-1~spare~1');
    expect([unused['opacity'], unused['textOpacity']]).toEqual(['30', '30']);
    expect(linkCell(auto, 'core-2:down')['dashPattern']).toBe('6 3');
    expect(linkCell(auto, 'core-1:down')['dashPattern']).toBeUndefined();
    // The 10G label turns with its run, so it is a child label cell of the connector.
    expect(style(auto, 'pg-linkLabel~core-1:down-&gt;access-1:up')['fontColor']).toBe('light-dark(#1e40af,#1e40af)');
    const overlay = linkCell(auto, 'access-1:alt');
    expect([overlay['strokeColor'], overlay['opacity']]).toEqual(['light-dark(#008080,#008080)', '50']);
    expect(style(drawio(laid, { theme: 'print' }), 'pg-group~core')['dashPattern']).toBe('2 2');
    expect(style(auto, 'pg-group~core')['dashPattern']).toBeUndefined();

    expect(warnings.map(item => [item.code, item.severity])).toEqual([['DRAWIO_CSS_UNMAPPED', 'warning']]);
    const message = warnings[0]!.message;
    for (const part of ['.node-icon { stroke-linecap: square }', '.pill:hover { … }', '@supports (display: grid)', '.node-icon { fill: none } on node-icon']) {
      expect(message).toContain(part);
    }
    expect(message).toContain('4 part(s)');
  });

  it('names a rule that paints a merge trunk unlike its members, and only then', () => {
    // A forged merge run of two routed links: the SVG paints the shared run under `.merge-run`, draw.io inside each member's connector.
    const routed = laid.links.filter(link => link.path && link.layer !== 'overlay').slice(0, 2);
    const forged = (css: string): string[] => {
      const warnings: string[] = [];
      const model = { ...laid, document: { ...laid.document, css }, bundles: [{ ...laid.bundles[0]!, id: 'forged', members: routed.map(link => link.id),
        mergeRuns: [{ id: 'trunk', count: 2, members: routed.map(link => link.id), path: routed[0]!.path! }] }] } as LayoutModel;
      drawio(model, { theme: 'light', onDiagnostic: diagnostic => warnings.push(diagnostic.message) });
      return warnings;
    };
    expect(forged('.link .link-line { stroke: #ff0000 }')[0]).toContain('.link .link-line { stroke: #ff0000 } on link-line (a merge trunk painted unlike its members)');
    expect(forged('.merge-run .link-line { stroke: #ff0000 }')[0]).toContain('.merge-run .link-line { stroke: #ff0000 } on link-line (a merge trunk');
    expect(forged('.link-line { stroke: #ff0000 }')).toEqual([]);
  });

  it('draws the flow legend row as an overlay sample in both renderers (A1-16)', () => {
    expect(legendLineOverlay(laid, 'flow')).toBe(true);
    expect(legendLineOverlay(laid, 'default')).toBe(false);
    const svg = render(laid);
    expect(svg).toMatch(/<g class="legend-entry legend-line flow" data-id="line:flow"><line class="link-line overlay-line flow /);
    const swatch = style(drawio(laid), 'pg-legendSwatch~line:flow');
    expect([swatch['strokeColor'], swatch['opacity']]).toEqual(['light-dark(#008080,#008080)', '50']);
  });
});
