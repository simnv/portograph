import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, parseWithDiagnostics, render, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolveNodeIcon } from '../../src/profiles/network/icons.js';
import { NETWORK_NODE_CLASSES, classDisplayLabel } from '../../src/profiles/network/theme.js';
import { DEFAULT_THEME_ID, THEMES, THEME_IDS, findTheme, themeById } from '../../src/profiles/network/themes.js';
import { resolve } from '../../src/resolve/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-theme-paints-and-moves-nothing.yaml', import.meta.url), 'utf8');
const without = fixture.replace('theme: snack\n', '');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** The layout JSON without the echoed document, which carries the theme id itself, and without the wall-clock timings. */
const geometry = (model: LayoutModel): string => JSON.stringify({ ...model, document: undefined, runtime: undefined });

describe('the document field theme', () => {
  it('lists the known ids in the error for an unknown id', () => {
    const result = parseWithDiagnostics(without.replace('title:', 'theme: nope\ntitle:'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'UNKNOWN_THEME', path: '$.theme', severity: 'error', message: `Theme nope is not known; use ${THEME_IDS.join(', ')}`,
    })]);
    expect(THEME_IDS).toEqual(['network', 'snack']);
  });

  it('refuses a theme that is not a string', () => {
    expect(parseWithDiagnostics(without.replace('title:', 'theme: [snack]\ntitle:')).diagnostics.map(d => d.code)).toEqual(['INVALID_TYPE']);
  });

  it('stores an id other than the default and leaves the default absent', () => {
    expect(parse(fixture).theme).toBe('snack');
    expect(parse(without).theme).toBeUndefined();
    expect(parse(without.replace('title:', 'theme: network\ntitle:'))).toEqual(parse(without));
    expect(DEFAULT_THEME_ID).toBe('network');
  });

  it('is checked again by stage 1 for a document built by hand', () => {
    expect(() => resolve({ ...parse(without), theme: 'nope' })).toThrow(/Theme nope is not known; use network, snack/);
  });

  it('looks a theme up by id; an absent id is the default and an unknown one throws', () => {
    expect(themeById(undefined).id).toBe('network');
    expect(themeById('snack').id).toBe('snack');
    expect(findTheme('nope')).toBeUndefined();
    expect(() => themeById('nope')).toThrow(/use network, snack/);
  });
});

describe('a theme is a render input and moves nothing', () => {
  it('gives the same layout and the same score with and without theme: snack', async () => {
    const [on, off] = await Promise.all([run(fixture), run(without)]);
    expect(geometry(on)).toBe(geometry(off));
    expect(JSON.stringify(score(on).snapshot)).toBe(JSON.stringify(score(off).snapshot));
    // The echoed document is the one difference.
    expect({ ...on.document, theme: undefined }).toEqual({ ...off.document, theme: undefined });
  });

  it('paints the snack sheet and keeps every position and size of the network sheet', async () => {
    const [on, off] = await Promise.all([run(fixture), run(without)]);
    const snack = render(on), network = render(off);
    // The same boxes: every x, y, width and height attribute is shared; only the paint and the radii differ.
    const boxes = (svg: string): string[] => [...svg.matchAll(/ (?:x|y|width|height)="[^"]*"/g)].map(match => match[0]);
    expect(boxes(snack)).toEqual(boxes(network));
    expect(snack).toContain('.icon-tile.provider{fill:#5388d1');
    expect(snack).toContain('.pg-canvas{fill:#eeeff3}');
    expect(network).toContain('.pg-canvas{fill:#f2f2f3}');
    expect(snack).toMatch(/<rect class="node-body[^>]*rx="8" ry="8"/);
    expect(snack).toMatch(/<rect class="icon-tile[^>]*rx="4" ry="4"/);
    expect(snack).toMatch(/<rect class="group-box[^>]*rx="8" ry="8"/);
    expect(network).toMatch(/<rect class="node-body[^>]*rx="4" ry="4"/);
    expect(network).toMatch(/<rect class="icon-tile[^>]*rx="2" ry="2"/);
    // The pill radius is the layout's, in every theme.
    const pills = (svg: string): string[] => [...svg.matchAll(/<rect class="pill[^>]*>/g)].map(match => match[0].replace(/ class="[^"]*"/, ''));
    expect(pills(snack)).toEqual(pills(network));
    expect(pills(snack).length).toBeGreaterThan(0);
  });

  it('keeps the body neutral and puts the hue on the tile and the pills only', async () => {
    const css = render(await run(fixture));
    expect(css).toContain('.node-body:where(.router){fill:#fdfdfd}');
    expect(css).toContain('.icon-tile.router{fill:#aa6cc1;stroke:#aa6cc1}');
    expect(css).toContain('.pill.router{fill:#e6dcf3;stroke:#787b8a}');
    expect(css).toContain('.icon-tile.rr{fill:#a56425');
    // A sheet class takes no wash.
    expect(css).not.toContain('.node-body:where(.pg-wash');
  });

  it('states the radii in the draw.io file and the paint of the same theme', async () => {
    const [on, off] = await Promise.all([run(fixture), run(without)]);
    const xml = drawio(on, { theme: 'light' }), other = drawio(off, { theme: 'light' });
    expect(xml).toContain('arcSize=16');
    expect(xml).toContain('fillColor=#aa6cc1');
    expect(other).not.toContain('fillColor=#aa6cc1');
    const geometries = (text: string): string[] => [...text.matchAll(/<mxGeometry [^>]*>/g)].map(match => match[0]);
    expect(geometries(xml)).toEqual(geometries(other));
  });
});

describe('every profile class has its own glyph and legend name', () => {
  const classes = NETWORK_NODE_CLASSES.map(([name]) => name);
  it('has a glyph for each; the router and the route reflector share one (a finding for the maintainer)', () => {
    const icons = classes.map(name => resolveNodeIcon({ class: name }));
    expect(icons.every(icon => icon !== undefined)).toBe(true);
    // Ticket 158 step 5 asks for one glyph per class. `rr` keeps the router glyph (`NETWORK_NODE_ICONS`, decided with the JPEG
    // target), and the approved golden's layout JSON carries the icon name of every node, so a new glyph for `rr` is a
    // golden change that the maintainer approves by hand. Until then the pairs below are the only ones that share a glyph; a new
    // class that shares one fails here.
    const shared = classes.flatMap((a, at) => classes.slice(at + 1).filter(b => resolveNodeIcon({ class: a }) === resolveNodeIcon({ class: b })).map(b => `${a}+${b}`));
    expect(shared).toEqual(['router+rr']);
  });
  it('has a distinct legend name for each', () => {
    const names = classes.map(name => classDisplayLabel('symbol', name));
    expect(new Set(names).size).toBe(classes.length);
    expect(names).not.toContain('');
  });
  it('has a distinct print tile for each, in every theme', () => {
    for (const theme of THEMES) {
      const tiles: [string, string][] = [['default', theme.paint.print.tile.fill], ...classes.map(name => [name, theme.classPaint(name, 'print')!.tile.fill] as [string, string])];
      const shared = tiles.flatMap(([a, fillA], at) => tiles.slice(at + 1).filter(([, fillB]) => fillA === fillB).map(([b]) => `${a}+${b}`));
      // The network print tbr tile (neutral-600, the fix of ticket 158) is the colour of the tile of a class the profile does not know;
      // the glyph (switch against the star) tells them apart on paper.
      expect(shared, theme.id).toEqual(theme.id === 'network' ? ['default+tbr'] : []);
    }
  });
});
