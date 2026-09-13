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

  it('emits the handoff rules, in order, in the light, dark and print blocks, plus the print amendment', () => {
    const expected = rules(handoff);
    const key = (rule: [string, string, string[]]): string => JSON.stringify([rule[0], rule[1]]);
    const known = new Set(expected.map(key));
    const actual = rules(themeCss());
    // Amendment 1: a `@media` block adds no specificity, so print must restate every class-pill
    // and role-text rule the light sheet colours, or those keep their hue on paper.
    const amendment = actual.filter(rule => !known.has(key(rule)));
    expect(amendment.map(rule => `${rule[1]}{${rule[2].join(';')}}`)).toEqual([
      ...['provider', 'router', 'tbr', 'rr'].flatMap(name =>
        [`.pill.${name}{fill:#f5f5f8;stroke:#7a7a7d}`, `.pill-label.${name}{fill:#000000}`]),
      ...['uplink', 'downlink', 'peer', 'mgmt', 'lag'].map(name => `.pill-label.${name}{fill:#000000}`),
    ]);
    expect(amendment.every(rule => rule[0] === '@media print')).toBe(true);
    expect(actual.filter(rule => known.has(key(rule)))).toEqual(expected);
  });

  it('restates every light selector with the same properties in dark and in print', () => {
    // A `@media` block adds no specificity, so a light declaration that the dark or print block
    // does not restate stays in force there. Parity of selectors alone is not enough: a light-only
    // `stroke` on a selector both blocks name would still leak, so the property sets must match.
    const declared = (mode: 'light' | 'dark' | 'print'): [string, string[]][] => rules(themeRules(mode).join('\n'))
      .map(rule => [rule[1], rule[2].map(declaration => declaration.slice(0, declaration.indexOf(':'))).sort()]);
    const light = declared('light');
    expect(light.length).toBe(51);
    expect(new Set(light.map(([selector]) => selector)).size).toBe(light.length);
    expect(declared('dark')).toEqual(light);
    expect(declared('print')).toEqual(light);
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
