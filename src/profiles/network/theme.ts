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
];

/**
 * A `port.class` role: it drives the pill fill and names a legend entry. The light fill and text
 * are the documented API; dark pills are all steel, and print has its own greyscale steps.
 */
export interface PortRoleStyle {
  fill: string;
  text: string;
  label: string;
  print: string;
}

const role = (fill: string, text: string, label: string, print: string): PortRoleStyle => ({ fill, text, label, print });

/** Declaration order is the legend's stable order for known port roles. */
export const NETWORK_PORT_ROLES: readonly (readonly [string, PortRoleStyle])[] = [
  ['uplink', role(STEEL[400], STEEL[800], 'Uplink', NEUTRAL[400])],
  ['downlink', role(STEEL[200], STEEL[800], 'Downlink', NEUTRAL[200])],
  ['peer', role(INDIGO[300], INDIGO[800], 'Peer', NEUTRAL[300])],
  ['mgmt', role(WARM[300], WARM[800], 'Mgmt', NEUTRAL[100])],
  ['lag', role(TEAL[300], TEAL[800], 'Lag', NEUTRAL[300])],
];

/**
 * The pill fill and label text of a role in one mode. Print states the text too, or the light role
 * text would keep its hue on paper (handoff amendment 1).
 */
export function portRolePaint(style: PortRoleStyle, mode: ThemeMode): { fill: string; text: string } {
  if (mode === 'print') return { fill: style.print, text: NETWORK_THEME.print.pill.text };
  return mode === 'light' ? { fill: style.fill, text: style.text } : { fill: STEEL[700], text: STEEL[100] };
}

/** The `loopback` role: an outlined, unfilled pill. It has no legend label of its own. */
export const NETWORK_PORT_LOOPBACK = { name: 'loopback', stroke: modal(STEEL[400], STEEL[500], NEUTRAL[500]) } as const;

/**
 * A `port.class` status. Status is stroke only and steel only; `admin-down` also greys the pill and
 * its text, and `unused` fades the whole port group instead of restyling the pill.
 */
export type PortStatusStyle =
  | { kind: 'stroke'; stroke: Modal<string>; dash?: string; fill?: Modal<string>; text?: Modal<string> }
  | { kind: 'fade'; opacity: number };

/** Declaration order is the emission order of the status rules. */
export const NETWORK_PORT_STATUS: readonly (readonly [string, PortStatusStyle])[] = [
  ['up', { kind: 'stroke', stroke: modal(STEEL[800], STEEL[200], BLACK) }],
  ['down', { kind: 'stroke', stroke: modal(STEEL[600], STEEL[400], NEUTRAL[700]), dash: '2 2' }],
  ['admin-down', { kind: 'stroke', stroke: modal(NEUTRAL[500], STEEL[500], NEUTRAL[600]), dash: '2 2',
    fill: modal(NEUTRAL[200], STEEL[900], WHITE), text: modal(NEUTRAL[600], STEEL[400], NEUTRAL[600]) }],
  ['degraded', { kind: 'stroke', stroke: modal(INK, WHITE, BLACK) }],
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
    overlay: { stroke: INDIGO[500], opacity: 0.6, mark: INDIGO[500] },
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
    overlay: { stroke: INDIGO[400], opacity: 0.6, mark: INDIGO[400] },
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
    overlay: { stroke: NEUTRAL[600], opacity: 0.7, mark: NEUTRAL[600] },
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
