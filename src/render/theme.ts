import { LEGEND_DEFAULT_CLASS, NETWORK_NODE_CLASSES, backdropColour, washAssignment, washToken, portRolePaint } from '../profiles/network/theme.js';
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
 * One paint rule of the theme sheet: the structural class it paints, the further classes the element must carry, and its
 * declarations in order. `where` puts the further classes inside `:where()`, which adds no specificity. The SVG writes each
 * rule as CSS (`cssRule`); the draw.io export resolves the same rules as the CSS cascade does (`resolvePaint` in
 * `render/shared.ts`), so the two renderers read one table (R1).
 */
export interface PaintRule {
  readonly element: string;
  readonly tokens: readonly string[];
  readonly where?: true;
  readonly declarations: readonly (readonly [property: string, value: string | number])[];
}

const rule = (element: string, tokens: readonly string[], declarations: PaintRule['declarations'], where?: true): PaintRule =>
  where ? { element, tokens, where, declarations } : { element, tokens, declarations };

/** One rule as CSS text: `.element.token{property:value;…}`, or `.element:where(.token){…}`. */
export function cssRule(paintRule: PaintRule): string {
  const tokens = paintRule.tokens.map(name => `.${name}`).join('');
  const selector = `.${paintRule.element}${paintRule.where ? `:where(${tokens})` : tokens}`;
  return `${selector}{${paintRule.declarations.map(([property, value]) => `${property}:${value}`).join(';')}}`;
}

/**
 * The paint rules of one theme mode. Colour, fill, dash and opacity only: every rule here is at
 * the same specificity a document `css:` rule can reach, and the document's filtered CSS is
 * appended after the whole theme, so an author still owns the palette. The order and the
 * declarations are those of `ref/theme-handoff/portograph-theme.css` plus its recorded amendments,
 * which a test compares against.
 */
export function paintRules(mode: ThemeMode, theme: Theme = themeById(undefined)): PaintRule[] {
  const paint = theme.paint[mode];
  const rules: PaintRule[] = [
    rule('pg-canvas', [], [['fill', paint.background]]),
    rule('group-box', [], [['fill', paint.group.fill], ['fill-opacity', paint.group.fillOpacity], ['stroke', paint.group.stroke], ['stroke-dasharray', paint.group.dash]]),
    rule('group-label', [], [['fill', paint.group.text]]),
    rule('node-body', [], [['fill', paint.node.fill], ['stroke', paint.node.stroke]]),
    rule('node-label', [], [['fill', paint.node.text]]),
    rule('node-description', [], [['fill', paint.node.description], ['fill-opacity', 1]]),
    // Defaults for a class the profile does not know; the class rules below are more specific.
    rule('icon-tile', [], [['fill', paint.tile.fill], ['stroke', paint.tile.stroke]]),
    rule('node-icon', [], [['fill', 'none'], ['stroke', paint.glyph], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]),
    rule('pill', [], [['fill', paint.pill.fill], ['stroke', paint.pill.stroke]]),
    rule('pill-label', [], [['fill', paint.pill.text]]),
    rule('link-line', [], [['fill', 'none'], ['stroke', paint.link.stroke]]),
    rule('link-label', [], [['fill', paint.link.label]]),
    rule('multiplicity-label', [], [['fill', paint.link.multiplicity]]),
    rule('legend-label', [], [['fill', paint.legend.text]]),
    rule('overlay-line', [], [['stroke', paint.overlay.stroke], ['stroke-opacity', paint.overlay.opacity],
      ...(paint.overlay.dash ? [['stroke-dasharray', paint.overlay.dash] as const] : [])]),
    rule('overlay-endpoint', [], [['fill', paint.overlay.mark], ['stroke', 'none']]),
  ];
  // The role colour lives on the icon tile; the pill takes the class hue. The body takes a faint wash of the class hue.
  for (const [name] of NETWORK_NODE_CLASSES) {
    const { tile, glyph, pill, body } = theme.classPaint(name, mode)!;
    // `:where()` keeps the wash at the specificity of `.node-body`, so a document `css:` rule on the body wins.
    rules.push(rule('node-body', [name], [['fill', body]], true));
    rules.push(rule('icon-tile', [name], [['fill', tile.fill], ['stroke', tile.stroke]]));
    rules.push(rule('node-icon', [name], [['stroke', glyph]]));
    rules.push(rule('pill', [name], [['fill', pill.fill], ['stroke', pill.stroke]]));
    rules.push(rule('pill-label', [name], [['fill', pill.text]]));
  }
  for (const [name, style] of theme.linkClasses) {
    if (name === LEGEND_DEFAULT_CLASS) continue;
    rules.push(rule('link-line', [name], [['stroke', style.strokes[mode]],
      ...(style.dash ? [['stroke-dasharray', style.dash] as const] : []), ...(style.cap ? [['stroke-linecap', style.cap] as const] : [])]));
  }
  // A `port.class` role drives the pill fill (the outlined role its stroke); a status drives the
  // stroke; `unused` fades the whole port.
  for (const [name, style] of theme.portRoles) {
    const rolePaint = portRolePaint(style, mode);
    if (rolePaint.stroke !== undefined) { rules.push(rule('pill', [name], [['fill', 'none'], ['stroke', rolePaint.stroke]])); continue; }
    rules.push(rule('pill', [name], [['fill', rolePaint.fill]]));
    rules.push(rule('pill-label', [name], [['fill', rolePaint.text]]));
  }
  for (const [name, style] of theme.portStatus) {
    if (style.kind === 'fade') { rules.push(rule('port', [name], [['opacity', style.opacity]])); continue; }
    rules.push(rule('pill', [name], [['stroke', style.stroke[mode]],
      ...(style.dash ? [['stroke-dasharray', style.dash[mode]] as const] : []), ...(style.fill ? [['fill', style.fill[mode]] as const] : [])]));
    if (style.text) rules.push(rule('pill-label', [name], [['fill', style.text[mode]]]));
  }
  // The overlay mask is internal render structure, not an author styling surface, so its paint is
  // not stated here at all: a rule in this sheet is reachable by an accepted `css:` rule of the same
  // specificity and importance, which then wins by source order. The mask states its own paint on
  // its elements, inline and important, where no author style sheet can reach it.
  return rules;
}

/** The paint rules of one theme mode as CSS text, in sheet order. */
export const themeRules = (mode: ThemeMode, theme: Theme = themeById(undefined)): string[] =>
  paintRules(mode, theme).map(cssRule);

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
  // A theme that keeps a sheet class's body plain (snack) has no `sheetWash` and states no wash.
  const wash = theme.sheetWash;
  if (!used.length || wash === undefined) return '';
  const rules = (mode: ThemeMode): string[] => used.map(at =>
    `.node-body:where(.pg-wash-${at}){fill:${wash(at, mode)}}`);
  return [...rules('light'),
    '@media (prefers-color-scheme: dark){', ...rules('dark').map(rule => `  ${rule}`), '}',
    '@media print{', ...rules('print').map(rule => `  ${rule}`), '}'].join('\n');
}

/** The class every text outside a node body carries: its halo (ticket 162). */
export const HALO_CLASS = 'pg-halo';
/** The class that gives a halo the colour behind its text, by the count of group boxes behind it (`boxesBehind`). */
export const haloDepthClass = (depth: number): string => `pg-halo-${depth}`;
/**
 * The halo's width. The stroke is painted under the fill (`paint-order`), so half of it shows round each glyph: the clear space stage 9
 * keeps round a label on its line (`LINK_LABEL_GEOMETRY.halo`, 2 px), so a line that crosses the text breaks under its letters.
 */
export const HALO_WIDTH = 4;

/**
 * The halo of the text outside node bodies (ticket 162, ADR-0023): an outline in the colour behind the text (`backdropColour`), painted
 * under the glyphs. One rule per depth of group fills the sheet uses, in every mode of the theme, as the theme's own sheet states its modes.
 */
export function haloCss(depths: readonly number[], theme: Theme = themeById(undefined)): string {
  if (!depths.length) return '';
  const used = [...new Set(depths)].sort((a, b) => a - b);
  const rules = (mode: ThemeMode): string[] => used.map(depth =>
    `.${HALO_CLASS}.${haloDepthClass(depth)}{stroke:${backdropColour(theme.paint[mode], depth)}}`);
  return [`.${HALO_CLASS}{paint-order:stroke fill;stroke-width:${HALO_WIDTH}px;stroke-linejoin:round;stroke-opacity:1;stroke-dasharray:none}`,
    ...rules('light'),
    '@media (prefers-color-scheme: dark){', ...rules('dark').map(rule => `  ${rule}`), '}',
    '@media print{', ...rules('print').map(rule => `  ${rule}`), '}'].join('\n');
}
