import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { themeCss, themeRules } from '../../src/render/theme.js';

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
  const PRINT = '@media print', DARK = '@media (prefers-color-scheme: dark)';
  const rule = (at: string, selector: string, declarations: string): Rule => [at, selector, declarations.split(';')];

  /**
   * The delivered sheet with every review amendment applied in place, as one ordered sequence.
   * Amendments are recorded in `ref/theme-handoff/README.md`, "Amendments found in review":
   * 1 print restates the class pills and the role text; 2 dark role fills; 3 print role steps;
   * 4 degraded dash per mode; 5 admin-down text. A rule's position in the cascade matters as much
   * as its declarations — `.pill.mgmt` must follow `.pill.router` for a `router mgmt` pill to be
   * warm — so the whole sequence is compared, duplicates included.
   */
  function amendedHandoff(): Rule[] {
    const replaced: Record<string, Record<string, string>> = {
      '': { '.pill-label.admin-down': 'fill:#5d5d60', '.pill.degraded': 'stroke:#1d1f20;stroke-dasharray:none' },
      [DARK]: {
        '.pill.uplink': 'fill:#597ea3', '.pill.downlink': 'fill:#2c455d', '.pill.peer': 'fill:#363966',
        '.pill-label.peer': 'fill:#e0e1f6', '.pill.mgmt': 'fill:#46413a', '.pill-label.mgmt': 'fill:#e8e4dc',
        '.pill.lag': 'fill:#20484f', '.pill-label.lag': 'fill:#cfe9ec', '.pill.degraded': 'stroke:#ffffff;stroke-dasharray:none',
      },
      [PRINT]: {
        '.pill.downlink': 'fill:#f5f5f8', '.pill.mgmt': 'fill:#e7e7ea', '.pill.lag': 'fill:#98989b',
        '.pill.degraded': 'stroke:#000000;stroke-dasharray:3 1',
      },
    };
    const out: Rule[] = [];
    for (const [at, selector, declarations] of rules(handoff)) {
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
    // The amendments are the whole difference: 15 rules replaced and 16 added against the delivered file.
    const delivered = rules(handoff);
    const same = actual.filter(item => delivered.some(other => other[0] === item[0] && other[1] === item[1] && other[2].join(';') === item[2].join(';')));
    expect(actual.length - same.length).toBe(31);
    expect(actual.length - delivered.length).toBe(16);
  });

  it('states paint only: no geometry property in any mode', () => {
    const geometry = /(^|;)(stroke-width|font-[a-z-]+|width|height|x|y|rx|ry|r|d|transform|letter-spacing):/;
    for (const mode of ['light', 'dark', 'print'] as const) {
      for (const rule of themeRules(mode)) expect(rule, `${mode}: ${rule}`).not.toMatch(geometry);
    }
  });

  it('fills no node body or group box by class', () => {
    expect(themeCss()).not.toMatch(/\.(node-body|group-box|node-label|group-label)\.[a-z]/);
  });
});
