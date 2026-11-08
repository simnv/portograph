/**
 * A document's `css:` as paint rules of the shared rule table (drawio-export ticket 8, audit S-02). The SVG appends the CSS text
 * after the theme and lets the reader apply it; a draw.io cell carries its own colours, so the export reads the same rules here and
 * resolves them with the theme by the CSS cascade (`computePaint` in `render/shared.ts`). The parser has already removed every
 * locked property (`parse/css.ts`); what is left is paint.
 *
 * What draw.io can carry is a subset. A rule outside it is not dropped in silence: it is listed in `unmapped`, and the export names
 * it in one `DRAWIO_CSS_UNMAPPED` warning. The subset:
 * - a selector of class compounds (`.a.b`, `*`), joined by the descendant (space) or child (`>`) combinator; an id, a type, an
 *   attribute, a pseudo-class or another combinator is outside it;
 * - `fill`, `stroke`, `fill-opacity`, `stroke-opacity`, `opacity` and `stroke-dasharray`, with a colour as `#rgb`, `#rrggbb`, a
 *   colour name or `rgb()`, a number or a percentage, a dash list, `none` or `inherit`; a custom property is skipped, since only a
 *   `var()` reads it and a `var()` value is outside the subset;
 * - `@media` with `all`, `screen`, `print` and `(prefers-color-scheme: light | dark)`, joined by `and` or listed with commas. The
 *   modes are those of the theme: light is a screen in the light scheme, dark a screen in the dark scheme, and print a print in
 *   the light scheme, so a dark and a print rule are read on top of the light rules, as a browser reads them.
 */
import postcss from 'postcss';
import type { ChildNode, Rule } from 'postcss';
import type { ThemeMode } from '../profiles/network/theme.js';
import type { PaintRule } from './theme.js';

const MODES: readonly ThemeMode[] = ['light', 'dark', 'print'];

/** The author rules of one document, in sheet order, and the rules (or parts) draw.io cannot carry, as CSS text. */
export interface AuthorRules {
  readonly rules: readonly PaintRule[];
  readonly unmapped: readonly string[];
}

export function authorRules(css: string | undefined): AuthorRules {
  const rules: PaintRule[] = [], unmapped: string[] = [];
  if (css === undefined || !css.trim()) return { rules, unmapped };
  let root: postcss.Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch {
    // The parser refused this text already (`INVALID_CSS`), so a model that holds it was written by hand.
    return { rules, unmapped: ['the whole css: block (malformed)'] };
  }
  const walk = (nodes: readonly ChildNode[], modes: readonly ThemeMode[]): void => {
    for (const node of nodes) {
      if (node.type === 'comment' || node.type === 'decl') continue;
      if (node.type === 'rule') { addRule(node, modes, rules, unmapped); continue; }
      const media = node.name.toLowerCase() === 'media' ? mediaModes(node.params) : undefined;
      if (media === undefined) { unmapped.push(`@${node.name} ${node.params}`.trim()); continue; }
      walk(node.nodes ?? [], modes.filter(mode => media.includes(mode)));
    }
  };
  walk(root.nodes, MODES);
  return { rules, unmapped };
}

/** The theme modes one media query list matches; `undefined` for a query draw.io cannot read. */
function mediaModes(params: string): ThemeMode[] | undefined {
  const modes = new Set<ThemeMode>();
  for (const query of params.toLowerCase().split(',').map(item => item.trim().replace(/\s+/g, ' '))) {
    const match = /^(?:(?:only )?(all|screen|print))?(?: and )?(?:\( ?prefers-color-scheme ?: ?(light|dark) ?\))?$/.exec(query);
    if (match === null || (match[1] === undefined && match[2] === undefined)
      || (match[1] !== undefined && match[2] !== undefined && !/ and /.test(query))) return undefined;
    const media: readonly ThemeMode[] = match[1] === 'print' ? ['print'] : match[1] === 'screen' ? ['light', 'dark'] : MODES;
    const scheme: readonly ThemeMode[] = match[2] === 'dark' ? ['dark'] : match[2] === 'light' ? ['light', 'print'] : MODES;
    for (const mode of media) if (scheme.includes(mode)) modes.add(mode);
  }
  return MODES.filter(mode => modes.has(mode));
}

const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

/** A selector as the rule table states it, or `undefined` for one outside the subset. */
function parseSelector(selector: string): Pick<PaintRule, 'element' | 'tokens' | 'context'> | undefined {
  const parts = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const compounds: { classes: string[]; child: boolean }[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === '>') {
      const before = compounds[compounds.length - 1];
      if (before === undefined || before.child || index === parts.length - 1) return undefined;
      before.child = true;
      continue;
    }
    const names = part.startsWith('*') ? part.slice(1) : part;
    if (names === '' && part !== '*') return undefined;
    const classes = names === '' ? [] : names.split('.');
    if (classes.shift() !== '' && names !== '') return undefined;
    if (!classes.every(name => IDENT.test(name))) return undefined;
    compounds.push({ classes, child: false });
  }
  const subject = compounds.pop();
  if (subject === undefined) return undefined;
  const [element, ...tokens] = subject.classes;
  return { element: element ?? '*', tokens, ...(compounds.length ? { context: compounds } : {}) };
}

function addRule(node: Rule, modes: readonly ThemeMode[], rules: PaintRule[], unmapped: string[]): void {
  const selectors = node.selectors.map(item => item.trim());
  const text = selectors.join(', ');
  const normal: [string, string][] = [], important: [string, string][] = [];
  for (const child of node.nodes) {
    if (child.type !== 'decl') continue;
    const property = child.prop.toLowerCase();
    if (property.startsWith('--')) continue;
    const value = paintValue(property, child.value);
    if (value === undefined) { unmapped.push(`${text} { ${property}: ${child.value}${child.important ? ' !important' : ''} }`); continue; }
    (child.important ? important : normal).push([property, value]);
  }
  if (!modes.length || (!normal.length && !important.length)) return;
  for (const selector of selectors) {
    const parsed = parseSelector(selector);
    if (parsed === undefined) { unmapped.push(`${selector} { … }`); continue; }
    const shared = { ...parsed, source: selector, ...(modes.length < MODES.length ? { modes } : {}) };
    if (normal.length) rules.push({ ...shared, declarations: normal });
    if (important.length) rules.push({ ...shared, declarations: important, important: true });
  }
}

const COLOUR_PROPERTIES = new Set(['fill', 'stroke']);
const OPACITY_PROPERTIES = new Set(['fill-opacity', 'stroke-opacity', 'opacity']);

/** A declaration value as draw.io can carry it, or `undefined`. */
function paintValue(property: string, raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'inherit') return OPACITY_PROPERTIES.has(property) || COLOUR_PROPERTIES.has(property) || property === 'stroke-dasharray' ? value : undefined;
  if (COLOUR_PROPERTIES.has(property)) return value === 'none' || value === 'transparent' ? 'none' : cssColour(value);
  if (OPACITY_PROPERTIES.has(property)) {
    const match = /^(\d*\.?\d+(?:e[+-]?\d+)?)(%?)$/.exec(value);
    if (match === null) return undefined;
    return String(Math.min(1, Math.max(0, Number(match[1]) / (match[2] ? 100 : 1))));
  }
  if (property === 'stroke-dasharray') {
    if (value === 'none') return value;
    const lengths = value.split(/[\s,]+/).filter(Boolean);
    if (!lengths.length || !lengths.every(length => /^\d*\.?\d+(?:px)?$/.test(length))) return undefined;
    return lengths.map(length => String(Number(length.replace(/px$/, '')))).join(' ');
  }
  return undefined;
}

/** A CSS colour as `#rrggbb`, or `undefined` for a form draw.io cannot pair into `light-dark()` (alpha below 1, `var()`, `currentColor`). */
export function cssColour(value: string): string | undefined {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex;
    return full.length === 8 && !full.endsWith('ff') ? undefined : `#${full.slice(0, 6)}`;
  }
  const rgb = /^rgba?\(\s*([^)]*)\)$/.exec(value)?.[1];
  if (rgb !== undefined) {
    const parts = rgb.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    if (parts.length === 4 && !/^(1|1\.0*|100%)$/.test(parts[3]!)) return undefined;
    const channels = parts.slice(0, 3).map(part => /^\d*\.?\d+%$/.test(part) ? Number(part.slice(0, -1)) * 2.55
      : /^\d*\.?\d+$/.test(part) ? Number(part) : Number.NaN);
    if (channels.some(channel => !Number.isFinite(channel))) return undefined;
    return `#${channels.map(channel => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
  }
  const named = NAMED.get(value);
  return named === undefined ? undefined : `#${named}`;
}

/** The CSS named colours (CSS Color Module Level 4, section 6.1). */
const NAMED: ReadonlyMap<string, string> = new Map((''
  + 'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 '
  + 'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 '
  + 'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff '
  + 'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 '
  + 'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 '
  + 'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f '
  + 'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 '
  + 'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc '
  + 'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 '
  + 'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa '
  + 'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff '
  + 'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a '
  + 'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de '
  + 'lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa '
  + 'mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee '
  + 'mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa '
  + 'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 '
  + 'orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee '
  + 'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 '
  + 'purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 '
  + 'sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd '
  + 'slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 '
  + 'thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 '
  + 'yellow:ffff00 yellowgreen:9acd32').split(' ').map(entry => entry.split(':') as [string, string]));
