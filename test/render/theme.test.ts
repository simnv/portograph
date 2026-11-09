import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { sheetClassWashCss, themeCss, themeRules } from '../../src/render/theme.js';
import { NETWORK_NODE_CLASSES, NETWORK_THEME, WASH_PALETTE, nodeBodyFill, washAssignment, washToken } from '../../src/profiles/network/theme.js';
import { themeById, themeWashFill } from '../../src/profiles/network/themes.js';

/** Every rule as `[at-rule, selector, declarations]`, in source order, comments and spacing aside. */
function rules(css: string): [string, string, string[]][] {
  const out: [string, string, string[]][] = [];
  postcss.parse(css).walkRules(rule => {
    const parent = rule.parent;
    const at = parent && parent.type === 'atrule' ? `@${(parent as postcss.AtRule).name} ${(parent as postcss.AtRule).params}` : '';
    const declarations: string[] = [];
    rule.walkDecls(declaration => { declarations.push(`${declaration.prop}:${declaration.value.replace(/\s+/g, ' ')}`); });
    out.push([at, rule.selector, declarations]);
  });
  return out;
}

describe('the default theme is the designed sheet', () => {
  const handoff = readFileSync(new URL('../../ref/theme-handoff/portograph-theme.css', import.meta.url), 'utf8');

  type Rule = [string, string, string[]];
  const BODY: Record<string, Record<string, string>> = {
    '': { provider: '#e7eaf4', router: '#dbeff1', tbr: '#e8e9f8', rr: '#eeebe5' },
    '@media (prefers-color-scheme: dark)': { provider: '#283448', router: '#1e3945', tbr: '#28324f', rr: '#2f363c' },
    '@media print': { provider: '#f7f7f8', router: '#e2e2e2', tbr: '#e7e7e8', rr: '#d9d9d9' },
  };
  const PRINT = '@media print', DARK = '@media (prefers-color-scheme: dark)';
  const rule = (at: string, selector: string, declarations: string): Rule => [at, selector, declarations.split(';')];

  /**
   * The delivered sheet with every review amendment applied in place, as one ordered sequence.
   * Amendments are recorded in `ref/theme-handoff/README.md`, "Amendments found in review":
   * 1 print restates the class pills and the role text; 2 dark role fills; 3 print role steps;
   * 4 degraded dash per mode; 5 admin-down text; 8 the print tbr tile; 9 the default tile. A rule's position in the cascade matters as much
   * as its declarations — `.pill.mgmt` must follow `.pill.router` for a `router mgmt` pill to be
   * warm — so the whole sequence is compared, duplicates included.
   */
  function amendedHandoff(): Rule[] {
    const replaced: Record<string, Record<string, string>> = {
      '': { '.icon-tile': 'fill:#597ea3;stroke:#416180', '.overlay-line': 'stroke:#7b7fc4;stroke-opacity:0.7', '.overlay-endpoint': 'fill:#7b7fc4;stroke:none', '.pill-label.admin-down': 'fill:#5d5d60', '.pill.degraded': 'stroke:#1d1f20;stroke-dasharray:none' },
      [DARK]: {
        '.icon-tile': 'fill:#597ea3;stroke:#b5d9fd',
        '.overlay-line': 'stroke:#7b7fc4;stroke-opacity:0.7', '.overlay-endpoint': 'fill:#7b7fc4;stroke:none',
        '.pill.uplink': 'fill:#597ea3', '.pill.downlink': 'fill:#2c455d', '.pill.peer': 'fill:#363966',
        '.pill-label.peer': 'fill:#e0e1f6', '.pill.mgmt': 'fill:#46413a', '.pill-label.mgmt': 'fill:#e8e4dc',
        '.pill.lag': 'fill:#20484f', '.pill-label.lag': 'fill:#cfe9ec', '.pill.degraded': 'stroke:#ffffff;stroke-dasharray:none',
      },
      [PRINT]: {
        '.overlay-line': 'stroke:#7a7a7d;stroke-opacity:0.55', '.overlay-endpoint': 'fill:#7a7a7d;stroke:none',
        '.pill.downlink': 'fill:#f5f5f8', '.pill.mgmt': 'fill:#e7e7ea', '.pill.lag': 'fill:#98989b',
        '.pill.degraded': 'stroke:#000000;stroke-dasharray:3 1',
        // Amendment 8 (ticket 158): white on the delivered #98989b tile is 2.88:1; the print tbr tile takes neutral-600 (4.2:1).
        '.icon-tile.tbr': 'fill:#7a7a7d;stroke:#2b2b2d',
      },
    };
    const out: Rule[] = [];
    for (const [at, selector, declarations] of rules(handoff)) {
      // Amendment 7 (architecture 09): a class body takes a wash of the class hue, ahead of its tile rule.
      const tile = /^\.icon-tile\.([a-z]+)$/.exec(selector);
      if (tile) out.push(rule(at, `.node-body:where(.${tile[1]})`, `fill:${BODY[at]![tile[1]!]}`));
      const swap = replaced[at]?.[selector];
      out.push(swap === undefined ? [at, selector, declarations] : rule(at, selector, swap));
      // Amendment 6 (ticket 73, Q104): the `signal` link class states the `dashed` paint, in every mode.
      if (selector === '.link-line.dashed') out.push(rule(at, '.link-line.signal', declarations.join(';')));
      if (at !== PRINT) continue;
      // Amendment 1: after each class glyph rule, the class pill and its text; after each filled
      // role's pill, its text.
      const glyph = /^\.node-icon\.([a-z]+)$/.exec(selector);
      if (glyph) out.push(rule(PRINT, `.pill.${glyph[1]}`, 'fill:#f5f5f8;stroke:#7a7a7d'), rule(PRINT, `.pill-label.${glyph[1]}`, 'fill:#000000'));
      const role = /^\.pill\.(uplink|downlink|peer|mgmt|lag)$/.exec(selector);
      if (role) out.push(rule(PRINT, `.pill-label.${role[1]}`, 'fill:#000000'));
    }
    return out;
  }

  it('emits the delivered sheet with the recorded amendments, as one ordered sequence', () => {
    const actual = rules(themeCss()), expected = amendedHandoff();
    expect(actual).toEqual(expected);
    // The amendments are the whole difference: 24 rules replaced and 28 added against the delivered file.
    const delivered = rules(handoff);
    const same = actual.filter(item => delivered.some(other => other[0] === item[0] && other[1] === item[1] && other[2].join(';') === item[2].join(';')));
    expect(actual.length - same.length).toBe(50);
    expect(actual.length - delivered.length).toBe(28);
  });

  it('states paint only: no geometry property in any mode', () => {
    const geometry = /(^|;)(stroke-width|font-[a-z-]+|width|height|x|y|rx|ry|r|d|transform|letter-spacing):/;
    for (const mode of ['light', 'dark', 'print'] as const) {
      for (const rule of themeRules(mode)) expect(rule, `${mode}: ${rule}`).not.toMatch(geometry);
    }
  });

  it('washes a node body by class and no group box or label', () => {
    expect(themeCss()).not.toMatch(/\.(group-box|node-label|group-label)\.[a-z]/);
    expect(themeCss()).toMatch(/\.node-body:where\(\.router\)\{fill:#dbeff1\}/);
  });

  it('keeps node text at 4.5:1 or better on every class wash, in every mode', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const mode of ['light', 'dark', 'print'] as const) {
      for (const [name, style] of NETWORK_NODE_CLASSES) {
        const fill = nodeBodyFill(style, mode);
        expect(ratio(NETWORK_THEME[mode].node.text, fill), `${mode} ${name} label`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(NETWORK_THEME[mode].node.description, fill), `${mode} ${name} description`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('washes a sheet-defined class by declaration order, at 4.5:1 in every mode', () => {
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    expect(washToken('x-y router')).toBe('router');
    expect(washToken('router tbr')).toBe('tbr');
    expect(washToken('tbr router')).toBe('tbr');
    expect(washToken('a{b} ok')).toBe('ok');
    // Declaration order; the profile's own hues are never given to a sheet class; wrap when they run out.
    const own = WASH_PALETTE.map((_, at) => at).filter(at => at >= NETWORK_NODE_CLASSES.length);
    const names = Array.from({ length: own.length + 3 }, (_, at) => `c${at}`);
    const washes = washAssignment(['router', ...names]);
    expect([...washes.values()]).toEqual(names.map((_, at) => own[at % own.length]));
    expect(washAssignment(['a', 'b']).get('a')).toBe(own[0]);
    expect(new Set(washAssignment(['a', 'b', 'c', 'd', 'e', 'f', 'g']).values()).size).toBe(7);
    for (const name of names) {
      for (const mode of ['light', 'dark', 'print'] as const) {
        const fill = themeWashFill(themeById(undefined), name, mode, washes);
        expect(ratio(NETWORK_THEME[mode].node.text, fill), `${mode} ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(NETWORK_THEME[mode].node.description, fill), `${mode} ${name} description`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(sheetClassWashCss(['router', 'switch', undefined, 'switch', 'bad{x}']))
      .toMatch(/^\.node-body:where\(\.pg-wash-4\)\{fill:#[0-9a-f]{6}\}[\s\S]*prefers-color-scheme: dark[\s\S]*@media print/);
    expect(sheetClassWashCss(['router'])).toBe('');
  });
});
