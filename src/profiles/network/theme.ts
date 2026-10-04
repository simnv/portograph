/**
 * The network profile's visual theme, as data. Every value comes from the maintainer's design pass
 * recorded in `ref/theme-handoff/` (decisions log Q22): the Industry steel ramp plus four analogous
 * hues on one OKLCH lightness scale, assigned to the node classes by legend order. The theme has
 * three modes — light, dark behind `prefers-color-scheme`, and a greyscale print sheet in which the
 * dash patterns carry the link and status meaning.
 *
 * Nothing here decides geometry. Sizes, positions, radii and stroke widths come from the layout model.
 */

export type ThemeMode = 'light' | 'dark' | 'print';

/** A lightness ramp; the key is the design token step (100 lightest, 900 darkest). */
type Steps<K extends number> = Readonly<Record<K, string>>;
/** The two base ramps carry every step. */
export type FullRamp = Steps<100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900>;
/** A class hue carries only the steps the sheet uses. */
export type HueRamp = Steps<200 | 300 | 400 | 500 | 700 | 800>;
export type Ramp = FullRamp | HueRamp;

export const STEEL: FullRamp = { 100: '#eef6ff', 200: '#d6ebff', 300: '#b5d9fd', 400: '#94bce3', 500: '#749dc4', 600: '#597ea3', 700: '#416180', 800: '#2c455d', 900: '#1d2d3d' };
export const NEUTRAL: FullRamp = { 100: '#f5f5f8', 200: '#e7e7ea', 300: '#d4d4d7', 400: '#b7b7ba', 500: '#98989b', 600: '#7a7a7d', 700: '#5d5d60', 800: '#424244', 900: '#2b2b2d' };
export const SLATE: HueRamp = { 200: '#dfe3f0', 300: '#c3cadf', 400: '#a3adc7', 500: '#7f8aa9', 700: '#4c5573', 800: '#353c55' };
export const TEAL: HueRamp = { 200: '#cfe9ec', 300: '#a9d6db', 400: '#7dbcc4', 500: '#4f9aa6', 700: '#2f6670', 800: '#20484f' };
export const INDIGO: HueRamp = { 200: '#e0e1f6', 300: '#c4c6ea', 400: '#a2a5d9', 500: '#7b7fc4', 700: '#4d5190', 800: '#363966' };
export const WARM: HueRamp = { 200: '#e8e4dc', 300: '#d3cdc1', 400: '#b8b0a2', 500: '#9a9184', 700: '#625b50', 800: '#46413a' };

const WHITE = '#ffffff', BLACK = '#000000', INK = '#1d1f20';

/** A per-mode value. */
export type Modal<T> = Readonly<Record<ThemeMode, T>>;
const modal = <T>(light: T, dark: T, print: T): Modal<T> => ({ light, dark, print });

/** Paint of a pill: the fill, the stroke and the label text. */
export interface PillPaint { fill: string; stroke: string; text: string }

/**
 * Role colours, keyed by node class. The light values are the documented API; `hue` is the ramp
 * the dark sheet derives its steps from, and `print` the greyscale tile and glyph.
 */
export interface NodeClassStyle {
  /** Icon tile fill (light). */
  fill: string;
  /** Icon tile stroke (light). */
  stroke: string;
  /** Icon glyph (light). */
  foreground: string;
  /** The pill of a port on a node of this class (light). */
  pill: PillPaint;
  label: string;
  hue: HueRamp;
  print: { fill: string; glyph: string };
}

const classStyle = (hue: HueRamp, label: string, print: { fill: string; glyph: string }): NodeClassStyle => ({
  fill: hue[500], stroke: hue[700], foreground: WHITE,
  pill: { fill: hue[200], stroke: hue[500], text: hue[800] }, label, hue, print,
});

/** Declaration order is the legend's stable order for known classes, and decides each class's hue. */
export const NETWORK_NODE_CLASSES: readonly (readonly [string, NodeClassStyle])[] = [
  ['provider', classStyle(SLATE, 'Provider', { fill: NEUTRAL[300], glyph: NEUTRAL[900] })],
  ['router', classStyle(TEAL, 'Router', { fill: NEUTRAL[700], glyph: WHITE })],
  ['tbr', classStyle(INDIGO, 'Transit border router', { fill: NEUTRAL[500], glyph: WHITE })],
  ['rr', classStyle(WARM, 'Route reflector', { fill: NEUTRAL[900], glyph: WHITE })],
];

/**
 * The icon tile, glyph and pill of one node class in one mode. In print the pill collapses to the
 * base greyscale pill: a `@media` block adds no specificity, so without a print rule of its own the
 * light `.pill.<class>` rule would keep its hue on paper (handoff amendment 1, `ref/theme-handoff/`).
 */
export function nodeClassPaint(style: NodeClassStyle, mode: ThemeMode):
{ tile: { fill: string; stroke: string }; glyph: string; pill: PillPaint } {
  if (mode === 'print') return { tile: { fill: style.print.fill, stroke: NEUTRAL[900] }, glyph: style.print.glyph, pill: NETWORK_THEME.print.pill };
  const light = mode === 'light', hue = style.hue;
  return {
    tile: { fill: hue[500], stroke: light ? hue[700] : hue[300] },
    glyph: WHITE,
    pill: { fill: light ? hue[200] : hue[800], stroke: light ? hue[500] : hue[400], text: light ? hue[800] : hue[200] },
  };
}

/** Linear mix of two `#rrggbb` colours: `amount` of `over` on top of `base`. */
export function mixHex(base: string, over: string, amount: number): string {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
  return '#' + [0, 1, 2].map(at => Math.round(channel(base, at) * (1 - amount) + channel(over, at) * amount)
    .toString(16).padStart(2, '0')).join('');
}

/**
 * The body fill of a node of one class in one mode: a faint wash of the class hue (paint only; the
 * icon tile keeps the full role colour). Light mixes the hue's 200 step into white, dark mixes the
 * 800 step into the dark body, print a light grey of the class's greyscale tile. A class the profile
 * does not know keeps the plain body. Labels keep at least 4.5:1 on every wash (a test checks it).
 */
export function nodeBodyFill(style: NodeClassStyle | undefined, mode: ThemeMode): string {
  const plain = NETWORK_THEME[mode].node.fill;
  if (!style) return plain;
  if (mode === 'print') return mixHex(plain, style.print.fill, 0.18);
  return mode === 'light' ? mixHex(plain, style.hue[200], 0.75) : mixHex(plain, style.hue[800], 0.45);
}

/**
 * The wash of a node class the profile does not know (a class the sheet defines). The sheet states
 * no colour for such a class, so a stable FNV-1a hash of its name picks one of eight hues. Only the
 * two steps a wash needs are held: the light 200 and the dark 800, plus a grey for print.
 */
export const WASH_PALETTE: readonly { light: string; dark: string; print: string }[] = [
  { light: SLATE[200], dark: SLATE[800], print: NEUTRAL[300] },
  { light: TEAL[200], dark: TEAL[800], print: NEUTRAL[700] },
  { light: INDIGO[200], dark: INDIGO[800], print: NEUTRAL[500] },
  { light: WARM[200], dark: WARM[800], print: NEUTRAL[900] },
  { light: '#d9ecd6', dark: '#2c4a2b', print: NEUTRAL[400] },
  { light: '#f3dce0', dark: '#5a2c36', print: NEUTRAL[600] },
  { light: '#f1e6cc', dark: '#563f12', print: NEUTRAL[800] },
  { light: STEEL[200], dark: STEEL[800], print: NEUTRAL[300] },
];

export function classHash(name: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < name.length; at += 1) hash = Math.imul(hash ^ name.charCodeAt(at), 0x01000193) >>> 0;
  return hash;
}

const SAFE_TOKEN = /^[A-Za-z_][\w-]*$/;

/**
 * The one token of a node's `class` attribute that washes its body: the first the profile knows, else
 * the first plain identifier (a token that needs escaping in a selector washes nothing).
 */
export function washToken(classAttr: string | undefined): string | undefined {
  const tokens = (classAttr ?? '').split(/\s+/).filter(Boolean);
  return tokens.find(token => nodeClassStyle(token) !== undefined) ?? tokens.find(token => SAFE_TOKEN.test(token));
}

/** Body fill for one class token in one mode; no token, the plain body. */
export function washFill(token: string | undefined, mode: ThemeMode): string {
  const known = nodeClassStyle(token);
  if (known || token === undefined) return nodeBodyFill(known, mode);
  const plain = NETWORK_THEME[mode].node.fill, entry = WASH_PALETTE[classHash(token) % WASH_PALETTE.length]!;
  if (mode === 'print') return mixHex(plain, entry.print, 0.18);
  return mode === 'light' ? mixHex(plain, entry.light, 0.75) : mixHex(plain, entry.dark, 0.45);
}

export interface LinkClassStyle {
  /** Stroke colour (light). */
  stroke: string;
  /** SVG `stroke-dasharray`; absent means solid. */
  dash?: string;
  /** SVG `stroke-linecap`; absent means the default butt cap. */
  cap?: 'round';
  label: string;
  strokes: Modal<string>;
}

/** The class key a link without an authored `class:` contributes to the legend. */
export const LEGEND_DEFAULT_CLASS = 'default';

const linkStyle = (strokes: Modal<string>, label: string, rest: Pick<LinkClassStyle, 'dash' | 'cap'> = {}): LinkClassStyle =>
  ({ stroke: strokes.light, ...rest, label, strokes });

/** Declaration order is the legend's stable order for known link classes. */
export const NETWORK_LINK_CLASSES: readonly (readonly [string, LinkClassStyle])[] = [
  [LEGEND_DEFAULT_CLASS, linkStyle(modal(STEEL[800], STEEL[300], BLACK), 'Default link')],
  ['dotted', linkStyle(modal(TEAL[700], TEAL[400], NEUTRAL[700]), 'Dotted link', { dash: '1 3', cap: 'round' })],
  ['dashed', linkStyle(modal(INDIGO[700], INDIGO[400], NEUTRAL[700]), 'Dashed link', { dash: '4 4' })],
  ['signal', linkStyle(modal(INDIGO[700], INDIGO[400], NEUTRAL[700]), 'Signal link', { dash: '4 4' })],
];

/**
 * A `port.class` role: it drives the pill fill and names a legend entry. A filled role states a
 * fill and a text colour per mode; the one outlined role, `loopback`, states a stroke per mode and
 * no text rule.
 */
export type PortRoleStyle =
  | { kind: 'filled'; fill: Modal<string>; text: Modal<string>; label: string }
  | { kind: 'outlined'; stroke: Modal<string>; label: string };

const role = (fill: Modal<string>, text: Modal<string>, label: string): PortRoleStyle => ({ kind: 'filled', fill, text, label });

/**
 * Declaration order is the legend's stable order for known port roles and the sheet's rule order.
 * Light is the handoff. Dark keeps the five filled roles apart the way the class pills do — a dark
 * step of each role's own hue (steel-600 for uplink, steel-800 for downlink, hue-800 for the three
 * hued roles) under a light step of the same hue — where the handoff collapsed them all to
 * steel-700 (amendment 2). Print spreads the roles over five distinct neutral steps; the handoff
 * gave peer and lag one step and mgmt the base pill's own white (amendment 3). Print text is black
 * (amendment 1).
 */
export const NETWORK_PORT_ROLES: readonly (readonly [string, PortRoleStyle])[] = [
  ['uplink', role(modal(STEEL[400], STEEL[600], NEUTRAL[400]), modal(STEEL[800], STEEL[100], BLACK), 'Uplink')],
  ['downlink', role(modal(STEEL[200], STEEL[800], NEUTRAL[100]), modal(STEEL[800], STEEL[100], BLACK), 'Downlink')],
  ['peer', role(modal(INDIGO[300], INDIGO[800], NEUTRAL[300]), modal(INDIGO[800], INDIGO[200], BLACK), 'Peer')],
  ['mgmt', role(modal(WARM[300], WARM[800], NEUTRAL[200]), modal(WARM[800], WARM[200], BLACK), 'Mgmt')],
  ['lag', role(modal(TEAL[300], TEAL[800], NEUTRAL[500]), modal(TEAL[800], TEAL[200], BLACK), 'Lag')],
  ['loopback', { kind: 'outlined', stroke: modal(STEEL[400], STEEL[500], NEUTRAL[500]), label: 'Loopback' }],
];

/**
 * The outlined role on its own, as ticket 32 exported it before `loopback` joined `NETWORK_PORT_ROLES`
 * (ticket 33). Kept for consumers of that shape; the roles table is the source of truth.
 * @deprecated Read `NETWORK_PORT_ROLES` instead.
 */
export const NETWORK_PORT_LOOPBACK: { readonly name: 'loopback'; readonly stroke: Modal<string> } = {
  name: 'loopback',
  stroke: (NETWORK_PORT_ROLES.find(([name]) => name === 'loopback')![1] as { stroke: Modal<string> }).stroke,
};

/** The pill paint of a role in one mode: a fill and a label text, or `none` and a stroke for the outlined one. */
export function portRolePaint(style: PortRoleStyle, mode: ThemeMode):
{ fill: string; text: string; stroke?: never } | { fill: 'none'; stroke: string; text?: never } {
  if (style.kind === 'outlined') return { fill: 'none', stroke: style.stroke[mode] };
  return { fill: style.fill[mode], text: style.text[mode] };
}

/**
 * A `port.class` status. A status paints the stroke in steel or ink and never the hue: `admin-down`
 * also greys the pill and its text, and `unused` fades the whole port group instead. A dash is
 * stated per mode: `degraded` is a plain ink stroke on screen but a dense `3 1` dash on paper, where
 * black on black would equal `up` (amendment 4). `admin-down` text is neutral-700 in light, the
 * handoff's neutral-600 fell to 3.5:1 on the greyed pill at 8 px (amendment 5).
 */
export type PortStatusStyle =
  | { kind: 'stroke'; stroke: Modal<string>; dash?: Modal<string>; fill?: Modal<string>; text?: Modal<string> }
  | { kind: 'fade'; opacity: number };

/** Declaration order is the emission order of the status rules. */
export const NETWORK_PORT_STATUS: readonly (readonly [string, PortStatusStyle])[] = [
  ['up', { kind: 'stroke', stroke: modal(STEEL[800], STEEL[200], BLACK) }],
  ['down', { kind: 'stroke', stroke: modal(STEEL[600], STEEL[400], NEUTRAL[700]), dash: modal('2 2', '2 2', '2 2') }],
  ['admin-down', { kind: 'stroke', stroke: modal(NEUTRAL[500], STEEL[500], NEUTRAL[600]), dash: modal('2 2', '2 2', '2 2'),
    fill: modal(NEUTRAL[200], STEEL[900], WHITE), text: modal(NEUTRAL[700], STEEL[400], NEUTRAL[600]) }],
  ['degraded', { kind: 'stroke', stroke: modal(INK, WHITE, BLACK), dash: modal('none', 'none', '3 1') }],
  ['unused', { kind: 'fade', opacity: 0.45 }],
];

/** Colours shared by every class, per mode. */
export interface ThemePaint {
  background: string;
  group: { fill: string; fillOpacity: number; stroke: string; dash: 'none'; text: string };
  node: { fill: string; stroke: string; text: string; description: string };
  /** An author class the profile does not know falls back to this tile. */
  tile: { fill: string; stroke: string };
  glyph: string;
  pill: PillPaint;
  link: { stroke: string; label: string; multiplicity: string };
  legend: { text: string };
  overlay: { stroke: string; opacity: number; mark: string };
}

export const NETWORK_THEME: Modal<ThemePaint> = {
  light: {
    background: '#f2f2f3',
    group: { fill: STEEL[100], fillOpacity: 0.55, stroke: STEEL[400], dash: 'none', text: STEEL[700] },
    node: { fill: WHITE, stroke: STEEL[500], text: INK, description: NEUTRAL[700] },
    tile: { fill: STEEL[500], stroke: STEEL[700] },
    glyph: WHITE,
    pill: { fill: STEEL[200], stroke: STEEL[500], text: STEEL[800] },
    link: { stroke: STEEL[800], label: NEUTRAL[700], multiplicity: STEEL[700] },
    legend: { text: NEUTRAL[800] },
    overlay: { stroke: INDIGO[400], opacity: 0.5, mark: INDIGO[400] },
  },
  dark: {
    background: STEEL[900],
    group: { fill: STEEL[800], fillOpacity: 0.55, stroke: STEEL[600], dash: 'none', text: STEEL[300] },
    node: { fill: STEEL[900], stroke: STEEL[400], text: STEEL[100], description: STEEL[300] },
    tile: { fill: STEEL[500], stroke: STEEL[300] },
    glyph: WHITE,
    pill: { fill: STEEL[800], stroke: STEEL[400], text: STEEL[200] },
    link: { stroke: STEEL[300], label: STEEL[300], multiplicity: STEEL[200] },
    legend: { text: STEEL[200] },
    overlay: { stroke: INDIGO[500], opacity: 0.5, mark: INDIGO[500] },
  },
  print: {
    background: WHITE,
    group: { fill: 'none', fillOpacity: 1, stroke: NEUTRAL[500], dash: 'none', text: NEUTRAL[700] },
    node: { fill: WHITE, stroke: NEUTRAL[800], text: BLACK, description: NEUTRAL[700] },
    tile: { fill: NEUTRAL[600], stroke: NEUTRAL[900] },
    glyph: WHITE,
    pill: { fill: NEUTRAL[100], stroke: NEUTRAL[600], text: BLACK },
    link: { stroke: BLACK, label: NEUTRAL[700], multiplicity: BLACK },
    legend: { text: BLACK },
    overlay: { stroke: NEUTRAL[500], opacity: 0.55, mark: NEUTRAL[500] },
  },
};

export const nodeClassStyle = (value: string | undefined): NodeClassStyle | undefined =>
  NETWORK_NODE_CLASSES.find(([key]) => key === value)?.[1];

export const linkClassStyle = (value: string | undefined): LinkClassStyle =>
  NETWORK_LINK_CLASSES.find(([key]) => key === (value ?? LEGEND_DEFAULT_CLASS))?.[1]
  ?? NETWORK_LINK_CLASSES[0]![1];

export const portRoleStyle = (value: string | undefined): PortRoleStyle | undefined =>
  NETWORK_PORT_ROLES.find(([key]) => key === value)?.[1];

/** Display label for a legend entry; an unknown author class falls back to its literal name. */
export function classDisplayLabel(kind: 'symbol' | 'line' | 'port', key: string): string {
  const known = kind === 'symbol' ? nodeClassStyle(key)?.label
    : kind === 'line' ? NETWORK_LINK_CLASSES.find(([name]) => name === key)?.[1].label
      : portRoleStyle(key)?.label;
  return known ?? key;
}

/** Profile declaration index, or `undefined` for an author class the profile does not know. */
export function classOrder(kind: 'symbol' | 'line' | 'port', key: string): number | undefined {
  const table = kind === 'symbol' ? NETWORK_NODE_CLASSES : kind === 'line' ? NETWORK_LINK_CLASSES : NETWORK_PORT_ROLES;
  const index = table.findIndex(([name]) => name === key);
  return index < 0 ? undefined : index;
}
