import { NETWORK_LINK_CLASSES, NETWORK_PORT_ROLES, NETWORK_PORT_STATUS, mixHex } from './theme.js';
import type { LinkClassStyle, Modal, PillPaint, PortRoleStyle, PortStatusStyle, ThemeMode, ThemePaint } from './theme.js';

/**
 * The `snack` theme: the default brand of the Snack UI kit (`@snack-uikit/figma-tokens` 19.0.5,
 * `build/css/brand.module.css`; the "gold" brand is not used), in light, dark and print.
 * Ticket 158.
 *
 * - Node and group bodies are neutral (`background1-level`); the page is `background`. The class hue sits on the
 *   icon tile and the pills only.
 * - A border, a link and a pill stroke are `accent-default`. The `decor-*` lines give 1.2:1 to 2:1 and are never used.
 * - Hues, in the order of the profile's node classes: blue, violet, pink, orange. Slate is the hue of a class
 *   the profile does not know. Red, yellow and green are semantic in Snack and are not class hues.
 * - A theme is paint. Nothing here sets a size or a position (the radii are paint too).
 */

const WHITE = '#ffffff', BLACK = '#000000';
const modal = <T>(light: T, dark: T, print: T): Modal<T> => ({ light, dark, print });

/** `sys-neutral-*`, light block and dark block. Print is a greyscale sheet of the same roles. */
const PAGE = modal('#eeeff3', '#1c1c24', WHITE);
const BODY = modal('#fdfdfd', '#242430', WHITE);
const TEXT_MAIN = modal('#41424e', '#e6e8ef', BLACK);
const TEXT_SUPPORT = modal('#6d707f', '#aaaebd', '#4d4d4d');
const ACCENT = modal('#787b8a', '#8b8e9b', '#5c5c5c');
const DECOR = modal('#dde0ea', '#393a46', '#e6e6e6');

/**
 * A class hue. `tile` is `sys-<hue>-accent-default` (light, dark). Orange takes `#a56425` in light, because the brand's
 * `#fb8e42` gives a white glyph 2.32:1; slate is not a Snack hue and replaces green. `wash` is `sys-<hue>-decor-default`
 * (light pill). Print has no hue: the tile is a grey step that keeps a white glyph at 3:1 or more.
 */
interface Hue { tile: Modal<string>; wash: string }
const HUES = {
  blue: { tile: modal('#5388d1', '#749eda', '#7a7a7a'), wash: '#d6e2f4' },
  violet: { tile: modal('#aa6cc1', '#b68bd5', '#5c5c5c'), wash: '#e6dcf3' },
  pink: { tile: modal('#d1668e', '#db85a2', '#8c8c8c'), wash: '#f5d9e1' },
  orange: { tile: modal('#a56425', '#e78940', '#2e2e2e'), wash: '#fed8b8' },
  slate: { tile: modal('#52687a', '#8fa5b6', '#424242'), wash: '#dce3e8' },
} as const satisfies Record<string, Hue>;
export type SnackHue = keyof typeof HUES;

/** The hue of each profile node class, in `NETWORK_NODE_CLASSES` order. */
export const SNACK_CLASS_HUES: Readonly<Record<string, SnackHue>> = { provider: 'blue', router: 'violet', tbr: 'pink', rr: 'orange' };

/** The glyph on a tile: white on a light or print tile; the page colour on a dark tile, which is a light accent. */
const GLYPH = modal(WHITE, PAGE.dark, WHITE);

/** Share of the tile colour mixed into the dark body for a dark pill. */
const DARK_PILL_SHARE = 0.12;

/** The pill of one hue in one mode. Light: the decor wash under `#41424e`. Dark: the tile mixed into the body under `text-main`. Print: a flat light grey. */
export function snackPill(hue: SnackHue, mode: ThemeMode): PillPaint {
  const fill = mode === 'light' ? HUES[hue].wash : mode === 'dark' ? mixHex(BODY.dark, HUES[hue].tile.dark, DARK_PILL_SHARE) : '#f0f0f0';
  return { fill, stroke: ACCENT[mode], text: TEXT_MAIN[mode] };
}

/** The tile, glyph and pill of one hue in one mode. */
export function snackHuePaint(hue: SnackHue, mode: ThemeMode):
{ tile: { fill: string; stroke: string }; glyph: string; pill: PillPaint } {
  const fill = HUES[hue].tile[mode];
  return { tile: { fill, stroke: fill }, glyph: GLYPH[mode], pill: snackPill(hue, mode) };
}

/** Port roles take a hue wash too, so a role reads in colour as well as by its legend row. `loopback` stays an outline. */
const ROLE_HUES: Readonly<Record<string, SnackHue | undefined>> = { uplink: 'blue', downlink: 'slate', peer: 'violet', mgmt: 'orange', lag: 'pink' };
/** Print spreads the filled roles over five grey steps, as the network sheet does; the text is black. */
const ROLE_PRINT: Readonly<Record<string, string>> = { uplink: '#d0d0d0', downlink: '#f7f7f7', peer: '#e2e2e2', mgmt: '#ececec', lag: '#bdbdbd' };

export const SNACK_PORT_ROLES: readonly (readonly [string, PortRoleStyle])[] = NETWORK_PORT_ROLES.map(([name, style]) => {
  const hue = ROLE_HUES[name];
  if (style.kind === 'outlined' || hue === undefined) return [name, { kind: 'outlined', stroke: ACCENT, label: style.label }] as const;
  return [name, {
    kind: 'filled', label: style.label,
    fill: modal(snackPill(hue, 'light').fill, snackPill(hue, 'dark').fill, ROLE_PRINT[name]!),
    text: TEXT_MAIN,
  }] as const;
});

/** A status paints the stroke (and, for `admin-down`, the fill and the text); `unused` fades the port. */
export const SNACK_PORT_STATUS: readonly (readonly [string, PortStatusStyle])[] = NETWORK_PORT_STATUS.map(([name, style]) => {
  switch (name) {
    case 'up': return [name, { kind: 'stroke', stroke: TEXT_MAIN }] as const;
    case 'down': return [name, { kind: 'stroke', stroke: ACCENT, dash: modal('2 2', '2 2', '2 2') }] as const;
    case 'admin-down': return [name, { kind: 'stroke', stroke: ACCENT, dash: modal('2 2', '2 2', '2 2'), fill: DECOR, text: TEXT_MAIN }] as const;
    case 'degraded': return [name, { kind: 'stroke', stroke: TEXT_MAIN, dash: modal('none', 'none', '3 1') }] as const;
    default: return [name, style] as const;
  }
});

/** Every link class draws in the one neutral stroke; the dash and the cap carry the class. */
export const SNACK_LINK_CLASSES: readonly (readonly [string, LinkClassStyle])[] = NETWORK_LINK_CLASSES.map(([name, style]) =>
  [name, { ...style, stroke: ACCENT.light, strokes: ACCENT }] as const);

/**
 * An overlay link must differ from a routed link. In colour it takes the Snack blue (`sys-blue-accent-default`, the hue of the
 * first class), as the network sheet gives it its indigo: `#5388d1` is 3.15:1 on the light page and `#749eda` 5.6:1 on the dark
 * body. It is solid: at 0.8 opacity the light blue falls to 2.4:1 on the page, under the 3:1 a stroke keeps. A print has no hue, so
 * the overlay is a grey line with its own dash (`8 2 2 2`), apart from the dashed (`4 4`) and dotted (`1 3`) link classes.
 */
const overlay = (mode: ThemeMode): ThemePaint['overlay'] => {
  const stroke = mode === 'print' ? '#707070' : HUES.blue.tile[mode];
  return { stroke, opacity: 1, mark: stroke, ...(mode === 'print' ? { dash: '8 2 2 2' } : {}) };
};

const paint = (mode: ThemeMode): ThemePaint => {
  const slate = snackHuePaint('slate', mode);
  return {
    background: PAGE[mode],
    group: { fill: BODY[mode], fillOpacity: 1, stroke: ACCENT[mode], dash: 'none', text: TEXT_MAIN[mode] },
    node: { fill: BODY[mode], stroke: ACCENT[mode], text: TEXT_MAIN[mode], description: TEXT_SUPPORT[mode] },
    tile: slate.tile,
    glyph: slate.glyph,
    pill: slate.pill,
    // A link label sits on the page or on a group, and `text-support` gives 4.3:1 on the page; the label takes `text-main`.
    link: { stroke: ACCENT[mode], label: TEXT_MAIN[mode], multiplicity: TEXT_MAIN[mode] },
    legend: { text: TEXT_MAIN[mode] },
    overlay: overlay(mode),
  };
};

export const SNACK_PAINT: Modal<ThemePaint> = { light: paint('light'), dark: paint('dark'), print: paint('print') };

/** Corner radii of the `snack` theme: `radius-card-container` 8, `radius-card-picture` 4. Paint only; the pill radius stays the layout's. */
export const SNACK_RADII = { node: 8, group: 8, tile: 4 } as const;
