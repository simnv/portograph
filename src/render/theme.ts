import { LEGEND_DEFAULT_CLASS, NETWORK_NODE_CLASSES, washAssignment, washToken, portRolePaint } from '../profiles/network/theme.js';
import type { ThemeMode } from '../profiles/network/theme.js';
import { themeById } from '../profiles/network/themes.js';
import type { Theme } from '../profiles/network/themes.js';

/**
 * Locked geometry properties. `schema.md` forbids a document from changing these, the parser strips
 * them from `css:`, and the theme states them with `!important` so an accepted declaration cannot
 * reach them by another route either. Every value comes from the layout model, never from the theme.
 */
export class GeometryLocks {
  private readonly strokes = new Map<number, string>();
  private readonly fonts = new Map<string, { name: string; family: string; size: number; weight: number }>();

  /** Class that pins one element's stroke width to the width `score` measures for it. */
  stroke(width: number): string {
    if (!Number.isFinite(width) || width < 0) throw new Error('Render requires a finite, nonnegative stroke width');
    const known = this.strokes.get(width);
    if (known) return known;
    const name = `pg-w-${token(width)}`;
    this.strokes.set(width, name);
    return name;
  }

  /** Class that pins one label's stored typography; the renderer measures no text of its own. */
  font(family: string, size: number, weight: number): string {
    if (!Number.isFinite(size) || size <= 0) throw new Error('Render requires a finite, positive font size');
    if (/[{}<>;\\]/.test(family)) throw new Error(`Font family ${family} cannot be locked in a style sheet`);
    const key = `${family}|${size}|${weight}`;
    const known = this.fonts.get(key);
    if (known) return known.name;
    const base = `pg-f-${token(size)}-${token(weight)}`;
    const taken = new Set([...this.fonts.values()].map(entry => entry.name));
    const name = taken.has(base) ? `${base}-${this.fonts.size}` : base;
    this.fonts.set(key, { name, family, size, weight });
    return name;
  }

  css(): string {
    const rules: string[] = [];
    for (const [width, name] of this.strokes) rules.push(`.${name}{stroke-width:${width}px!important}`);
    for (const { name, family, size, weight } of this.fonts.values()) {
      rules.push(`.${name}{font-family:${family}!important;font-size:${size}px!important;`
        + `font-weight:${weight}!important;letter-spacing:normal!important;font-stretch:normal!important;`
        + `text-transform:none!important;word-spacing:normal!important;`
        + `writing-mode:horizontal-tb!important;dominant-baseline:auto!important}`);
    }
    return rules.join('\n');
  }
}

/** A CSS-safe class-name fragment for a numeric value. */
const token = (value: number): string => String(value).replace(/\./g, '_').replace(/-/g, 'm').replace(/\+/g, 'p');

/**
 * The paint rules of one theme mode. Colour, fill, dash and opacity only: every rule here is at
 * the same specificity a document `css:` rule can reach, and the document's filtered CSS is
 * appended after the whole theme, so an author still owns the palette. The order and the
 * declarations are those of `ref/theme-handoff/portograph-theme.css` plus its recorded amendments,
 * which a test compares against.
 */
export function themeRules(mode: ThemeMode, theme: Theme = themeById(undefined)): string[] {
  const paint = theme.paint[mode];
  const rules: string[] = [
    `.pg-canvas{fill:${paint.background}}`,
    `.group-box{fill:${paint.group.fill};fill-opacity:${paint.group.fillOpacity};stroke:${paint.group.stroke};stroke-dasharray:${paint.group.dash}}`,
    `.group-label{fill:${paint.group.text}}`,
    `.node-body{fill:${paint.node.fill};stroke:${paint.node.stroke}}`,
    `.node-label{fill:${paint.node.text}}`,
    `.node-description{fill:${paint.node.description};fill-opacity:1}`,
    // Defaults for a class the profile does not know; the class rules below are more specific.
    `.icon-tile{fill:${paint.tile.fill};stroke:${paint.tile.stroke}}`,
    `.node-icon{fill:none;stroke:${paint.glyph};stroke-linecap:round;stroke-linejoin:round}`,
    `.pill{fill:${paint.pill.fill};stroke:${paint.pill.stroke}}`,
    `.pill-label{fill:${paint.pill.text}}`,
    `.link-line{fill:none;stroke:${paint.link.stroke}}`,
    `.link-label{fill:${paint.link.label}}`,
    `.multiplicity-label{fill:${paint.link.multiplicity}}`,
    `.legend-label{fill:${paint.legend.text}}`,
    `.overlay-line{stroke:${paint.overlay.stroke};stroke-opacity:${paint.overlay.opacity}}`,
    `.overlay-endpoint{fill:${paint.overlay.mark};stroke:none}`,
  ];
  // The role colour lives on the icon tile; the pill takes the class hue. The body takes a faint wash of the class hue.
  for (const [name] of NETWORK_NODE_CLASSES) {
    const { tile, glyph, pill, body } = theme.classPaint(name, mode)!;
    // `:where()` keeps the wash at the specificity of `.node-body`, so a document `css:` rule on the body wins.
    rules.push(`.node-body:where(.${name}){fill:${body}}`);
    rules.push(`.icon-tile.${name}{fill:${tile.fill};stroke:${tile.stroke}}`);
    rules.push(`.node-icon.${name}{stroke:${glyph}}`);
    rules.push(`.pill.${name}{fill:${pill.fill};stroke:${pill.stroke}}`);
    rules.push(`.pill-label.${name}{fill:${pill.text}}`);
  }
  for (const [name, style] of theme.linkClasses) {
    if (name === LEGEND_DEFAULT_CLASS) continue;
    rules.push(`.link-line.${name}{stroke:${style.strokes[mode]}`
      + `${style.dash ? `;stroke-dasharray:${style.dash}` : ''}${style.cap ? `;stroke-linecap:${style.cap}` : ''}}`);
  }
  // A `port.class` role drives the pill fill (the outlined role its stroke); a status drives the
  // stroke; `unused` fades the whole port.
  for (const [name, style] of theme.portRoles) {
    const paint = portRolePaint(style, mode);
    if (paint.stroke !== undefined) { rules.push(`.pill.${name}{fill:none;stroke:${paint.stroke}}`); continue; }
    rules.push(`.pill.${name}{fill:${paint.fill}}`);
    rules.push(`.pill-label.${name}{fill:${paint.text}}`);
  }
  for (const [name, style] of theme.portStatus) {
    if (style.kind === 'fade') { rules.push(`.port.${name}{opacity:${style.opacity}}`); continue; }
    rules.push(`.pill.${name}{stroke:${style.stroke[mode]}`
      + `${style.dash ? `;stroke-dasharray:${style.dash[mode]}` : ''}${style.fill ? `;fill:${style.fill[mode]}` : ''}}`);
    if (style.text) rules.push(`.pill-label.${name}{fill:${style.text[mode]}}`);
  }
  // The overlay mask is internal render structure, not an author styling surface, so its paint is
  // not stated here at all: a rule in this sheet is reachable by an accepted `css:` rule of the same
  // specificity and importance, which then wins by source order. The mask states its own paint on
  // its elements, inline and important, where no author style sheet can reach it.
  return rules;
}

/**
 * The paint sheet of one theme (the default is `network`): the light sheet, then the dark sheet behind `prefers-color-scheme`
 * and the greyscale print sheet behind `print`. A reader that honours neither sees light.
 */
export function themeCss(theme: Theme = themeById(undefined)): string {
  return [
    ...themeRules('light', theme),
    '@media (prefers-color-scheme: dark){', ...themeRules('dark', theme).map(rule => `  ${rule}`), '}',
    '@media print{', ...themeRules('print', theme).map(rule => `  ${rule}`), '}',
  ].join('\n');
}

/**
 * Wash rules for the node classes a sheet defines and the profile does not know. A body carries one
 * `pg-wash-<n>` class (`washClass`), so a node with several class tokens takes the one hue the draw.io
 * export takes. `:where()` keeps the rule at the specificity of `.node-body`, and the rules come ahead
 * of the document's own `css:`, so an author rule on the body wins. Same three modes as the theme.
 */
export function sheetClassWashCss(classAttrs: readonly (string | undefined)[], theme: Theme = themeById(undefined)): string {
  const assignment = washAssignment(classAttrs);
  const used = [...new Set(classAttrs.map(attr => washToken(attr)).filter((token): token is string => token !== undefined)
    .map(token => assignment.get(token)).filter((at): at is number => at !== undefined))].sort((a, b) => a - b);
  // A theme that keeps a sheet class's body plain (snack) states no wash.
  if (!used.length || theme.sheetWash(used[0]!, 'light') === undefined) return '';
  const rules = (mode: ThemeMode): string[] => used.map(at =>
    `.node-body:where(.pg-wash-${at}){fill:${theme.sheetWash(at, mode)}}`);
  return [...rules('light'),
    '@media (prefers-color-scheme: dark){', ...rules('dark').map(rule => `  ${rule}`), '}',
    '@media print{', ...rules('print').map(rule => `  ${rule}`), '}'].join('\n');
}
