import { CORNER_RADII } from '../../theme/geometry.js';
import { SNACK_CLASS_HUES, SNACK_LINK_CLASSES, SNACK_PAINT, SNACK_PORT_ROLES, SNACK_PORT_STATUS, SNACK_RADII, snackHuePaint } from './snack.js';
import { LEGEND_DEFAULT_CLASS, NETWORK_LINK_CLASSES, NETWORK_PORT_ROLES, NETWORK_PORT_STATUS, NETWORK_THEME, nodeBodyFill, nodeClassPaint, nodeClassStyle, washFillAt } from './theme.js';
import type { LinkClassStyle, Modal, PillPaint, PortRoleStyle, PortStatusStyle, ThemeMode, ThemePaint, WashAssignment } from './theme.js';

/**
 * Themes by id (ticket 158). A theme is a render input: it paints and decides no size, no position and no route. The
 * layout never reads it (the layout JSON is the same with and without `theme:`; a test pins that). The document names one
 * with `theme:`; the CLI `--theme` picks a mode of it.
 */

/** The tile, glyph, pill and body of one profile node class in one mode. */
export interface ClassPaint {
  tile: { fill: string; stroke: string };
  glyph: string;
  pill: PillPaint;
  /** The body fill of a node of this class. */
  body: string;
}

export interface Theme {
  readonly id: string;
  readonly paint: Modal<ThemePaint>;
  /** Corner radii in px. Paint only: a pill's radius is the layout's (`CORNER_RADII.pill`) and is the same in every theme. */
  readonly radii: { readonly node: number; readonly group: number; readonly tile: number };
  /** Paint of a profile node class; `undefined` for a class the profile does not know. */
  classPaint(name: string | undefined, mode: ThemeMode): ClassPaint | undefined;
  /** Body fill of the palette entry a sheet-defined class took; `undefined` when the theme keeps a sheet class's body plain. */
  sheetWash(at: number, mode: ThemeMode): string | undefined;
  readonly linkClasses: readonly (readonly [string, LinkClassStyle])[];
  readonly portRoles: readonly (readonly [string, PortRoleStyle])[];
  readonly portStatus: readonly (readonly [string, PortStatusStyle])[];
}

const NETWORK: Theme = {
  id: 'network',
  paint: NETWORK_THEME,
  radii: { node: CORNER_RADII.node, group: CORNER_RADII.group, tile: CORNER_RADII.tile },
  classPaint(name, mode) {
    const style = nodeClassStyle(name);
    return style && { ...nodeClassPaint(style, mode), body: nodeBodyFill(style, mode) };
  },
  sheetWash: (at, mode) => washFillAt(at, mode),
  linkClasses: NETWORK_LINK_CLASSES,
  portRoles: NETWORK_PORT_ROLES,
  portStatus: NETWORK_PORT_STATUS,
};

const SNACK: Theme = {
  id: 'snack',
  paint: SNACK_PAINT,
  radii: SNACK_RADII,
  classPaint(name, mode) {
    const hue = name !== undefined && Object.hasOwn(SNACK_CLASS_HUES, name) ? SNACK_CLASS_HUES[name] : undefined;
    return hue && { ...snackHuePaint(hue, mode), body: SNACK_PAINT[mode].node.fill };
  },
  // The class hue goes on the tile and the pills only; a sheet class keeps the neutral body.
  sheetWash: () => undefined,
  linkClasses: SNACK_LINK_CLASSES,
  portRoles: SNACK_PORT_ROLES,
  portStatus: SNACK_PORT_STATUS,
};

/** Every theme, in the order the error message lists them. The first is the default. */
export const THEMES: readonly Theme[] = [NETWORK, SNACK];
export const THEME_IDS: readonly string[] = THEMES.map(theme => theme.id);
export const DEFAULT_THEME_ID = 'network';

/** The theme of an id; `undefined` for an id no theme has. The parser and stage 1 report that; render throws. */
export const findTheme = (id: string | undefined): Theme | undefined =>
  THEMES.find(theme => theme.id === (id ?? DEFAULT_THEME_ID));

/** The theme of an id, or an error that lists the known ids. */
export function themeById(id: string | undefined): Theme {
  const theme = findTheme(id);
  if (theme === undefined) throw new Error(unknownThemeMessage(id!));
  return theme;
}

export const unknownThemeMessage = (id: string): string => `Theme ${id} is not known; use ${THEME_IDS.join(', ')}`;

/**
 * The body fill for one class token in one mode: a profile class takes its theme body, a sheet class the wash its
 * palette entry gives (a theme may give none), any other body the plain one. The one resolution the SVG and the draw.io
 * export share.
 */
export function themeWashFill(theme: Theme, token: string | undefined, mode: ThemeMode, assignment: WashAssignment): string {
  const known = theme.classPaint(token, mode);
  if (known) return known.body;
  const at = token === undefined ? undefined : assignment.get(token);
  return (at === undefined ? undefined : theme.sheetWash(at, mode)) ?? theme.paint[mode].node.fill;
}

/** The link class a theme paints for an authored class; an unknown class, or none, takes the default link. */
export const themeLinkClass = (theme: Theme, value: string | undefined): LinkClassStyle =>
  theme.linkClasses.find(([key]) => key === (value ?? LEGEND_DEFAULT_CLASS))?.[1] ?? theme.linkClasses[0]![1];

/** The port role a theme paints for a `port.class` token; `undefined` for a token that is no role. */
export const themePortRole = (theme: Theme, value: string | undefined): PortRoleStyle | undefined =>
  theme.portRoles.find(([key]) => key === value)?.[1];
