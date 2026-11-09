import { describe, expect, it } from 'vitest';
import { NETWORK_NODE_CLASSES, WASH_PALETTE, portRolePaint } from '../../src/profiles/network/theme.js';
import type { ThemeMode } from '../../src/profiles/network/theme.js';
import { THEMES, themeLinkClass, themeById } from '../../src/profiles/network/themes.js';
import type { Theme } from '../../src/profiles/network/themes.js';

/**
 * The contrast rules, run on every theme in every mode (ticket 158):
 *   text            4.5:1 on its fill, washes included;
 *   glyph           3:1 on its tile;
 *   tile            3:1 on the body, or its stroke is;
 *   stroke          3:1 on what it crosses (a border, a link, a pill stroke), an overlay stroke as composited.
 * WCAG relative luminance. A pair is named, so a failure says which one.
 */

const channels = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const ratio = (a: string, b: string): number => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
/** `over` painted at `opacity` on `under`. */
const composite = (over: string, under: string, opacity: number): string =>
  '#' + channels(over).map((value, at) => Math.round(value * opacity + channels(under)[at]! * (1 - opacity)).toString(16).padStart(2, '0')).join('');
/** A fill that is `none` shows what is under it. */
const solid = (fill: string, under: string, opacity = 1): string => fill === 'none' ? under : composite(fill, under, opacity);

type Rule = 'text' | 'glyph' | 'tile' | 'stroke';
interface Pair { rule: Rule; name: string; a: string; b: string; need: number }

/** Every pair the rules name, for one theme in one mode. */
export function pairs(theme: Theme, mode: ThemeMode): Pair[] {
  const paint = theme.paint[mode];
  const page = paint.background, body = paint.node.fill;
  const group = solid(paint.group.fill, page, paint.group.fillOpacity);
  const out: Pair[] = [];
  const text = (name: string, a: string, b: string): number => out.push({ rule: 'text', name, a, b, need: 4.5 });
  const stroke = (name: string, a: string, ...under: [string, string][]): void => {
    for (const [what, colour] of under) out.push({ rule: 'stroke', name: `${name} on ${what}`, a, b: colour, need: 3 });
  };
  const surfaces: [string, string][] = [['page', page], ['group', group], ['body', body]];

  // Text.
  text('group title on group', paint.group.text, group);
  for (const [what, colour] of [['page', page], ['group', group]] as const) {
    text(`link label on ${what}`, paint.link.label, colour);
    text(`multiplicity on ${what}`, paint.link.multiplicity, colour);
  }
  text('legend on page', paint.legend.text, page);
  text('title on body', paint.node.text, body);
  text('subtitle on body', paint.node.description, body);
  text('pill text on pill', paint.pill.text, paint.pill.fill);

  // Glyph, tile, pill and body of the default tile and of each profile class.
  const tiles: [string, { tile: { fill: string; stroke: string }; glyph: string; pill: { fill: string; stroke: string; text: string }; body: string }][] = [
    ['default', { tile: paint.tile, glyph: paint.glyph, pill: paint.pill, body }],
    ...NETWORK_NODE_CLASSES.map(([name]) => [name, theme.classPaint(name, mode)!] as [string, NonNullable<ReturnType<Theme['classPaint']>>]),
  ];
  for (const [name, tile] of tiles) {
    out.push({ rule: 'glyph', name: `${name} glyph on tile`, a: tile.glyph, b: tile.tile.fill, need: 3 });
    // The tile fill or its stroke separates the tile from the body.
    const fill = ratio(tile.tile.fill, tile.body), edge = ratio(tile.tile.stroke, tile.body);
    out.push({ rule: 'tile', name: `${name} tile or tile stroke on body`, a: fill >= edge ? tile.tile.fill : tile.tile.stroke, b: tile.body, need: 3 });
    text(`${name} title on its body`, paint.node.text, tile.body);
    text(`${name} subtitle on its body`, paint.node.description, tile.body);
    text(`${name} pill text`, tile.pill.text, tile.pill.fill);
    stroke(`${name} pill stroke`, tile.pill.stroke, ['body', tile.body]);
  }

  // Strokes.
  stroke('node border', paint.node.stroke, ...surfaces);
  stroke('group border', paint.group.stroke, ['page', page], ['group', group]);
  stroke('pill stroke', paint.pill.stroke, ['body', body], ['page', page]);
  stroke('link', paint.link.stroke, ...surfaces);
  for (const [name] of theme.linkClasses) {
    const style = themeLinkClass(theme, name);
    stroke(`${name} link`, style.strokes[mode], ...surfaces);
  }
  for (const [what, colour] of surfaces) {
    stroke(`overlay`, composite(paint.overlay.stroke, colour, paint.overlay.opacity), [what, colour]);
  }

  // Port roles and statuses.
  for (const [name, style] of theme.portRoles) {
    const role = portRolePaint(style, mode);
    if (role.stroke !== undefined) { stroke(`${name} role`, role.stroke, ['body', body], ['page', page]); continue; }
    text(`${name} role text`, role.text, role.fill);
    stroke(`${name} role pill stroke`, paint.pill.stroke, ['body', body]);
  }
  for (const [name, style] of theme.portStatus) {
    if (style.kind === 'fade') continue;
    stroke(`${name} status`, style.stroke[mode], ['body', body]);
    if (style.fill && style.text) text(`${name} status text`, style.text[mode], style.fill[mode]);
  }
  return out;
}

const failures = (theme: Theme, mode: ThemeMode): { label: string; detail: string }[] =>
  pairs(theme, mode).filter(pair => ratio(pair.a, pair.b) < pair.need - 1e-9)
    .map(pair => ({ label: `${pair.rule}: ${pair.name}`, detail: `${pair.rule}: ${pair.name} ${pair.a} on ${pair.b} ${ratio(pair.a, pair.b).toFixed(2)} < ${pair.need}` }));

/**
 * The `network` theme is the delivered design. Its borders, pill strokes and overlay are steel and
 * neutral steps chosen before these rules existed, and several are under 3:1. They are pinned here by label so none grows
 * and a fix removes its line; the rules say what a redesign of the network sheet must reach. The shortfall the rules found
 * in a glyph on a class tile, the print tbr tile (2.88:1), is fixed (now 4.2:1) and is not in the list. The `snack` theme
 * has no entry: it keeps every rule.
 */
const NETWORK_SHORTFALLS: Record<ThemeMode, readonly string[]> = {
  light: [
    'stroke: default pill stroke on body', 'stroke: provider pill stroke on body', 'stroke: router pill stroke on body', 'stroke: rr pill stroke on body',
    'stroke: node border on page', 'stroke: node border on group', 'stroke: node border on body',
    'stroke: group border on page', 'stroke: group border on group',
    'stroke: pill stroke on body', 'stroke: pill stroke on page',
    'stroke: overlay on page', 'stroke: overlay on group', 'stroke: overlay on body',
    'stroke: uplink role pill stroke on body', 'stroke: downlink role pill stroke on body', 'stroke: peer role pill stroke on body',
    'stroke: mgmt role pill stroke on body', 'stroke: lag role pill stroke on body',
    'stroke: loopback role on body', 'stroke: loopback role on page',
    'stroke: admin-down status on body',
  ],
  dark: [
    'stroke: group border on group',
    'stroke: overlay on page', 'stroke: overlay on group', 'stroke: overlay on body',
    'text: uplink role text',
  ],
  print: [
    'stroke: group border on page', 'stroke: group border on group',
    'stroke: overlay on page', 'stroke: overlay on group', 'stroke: overlay on body',
    'stroke: loopback role on body', 'stroke: loopback role on page',
    'text: admin-down status text',
  ],
};

/**
 * The overlay rule: an overlay link is told from a routed link by hue or by dash, since a stroke 1.2:1 from the link in lightness
 * is the same line to the eye (ticket 158 review). A hue is told apart when the overlay has a colour (chroma 30 or more) and the
 * link has none, or the two hues are 25 degrees or more apart. A dash is told apart when the overlay states one and the link is
 * solid. Colour alone cannot carry a greyscale print, so a grey overlay there needs the dash.
 */
function hueAndChroma(hex: string): { hue: number; chroma: number } {
  const [r, g, b] = channels(hex), max = Math.max(r!, g!, b!), min = Math.min(r!, g!, b!), chroma = max - min;
  if (chroma === 0) return { hue: 0, chroma };
  const hue = max === r ? ((g! - b!) / chroma + 6) % 6 : max === g ? (b! - r!) / chroma + 2 : (r! - g!) / chroma + 4;
  return { hue: hue * 60, chroma };
}
export function overlayApartFromLink(theme: Theme, mode: ThemeMode): boolean {
  const { overlay, link } = theme.paint[mode];
  if (overlay.dash !== undefined && overlay.dash !== 'none') return true;
  const one = hueAndChroma(overlay.stroke), other = hueAndChroma(link.stroke);
  if (one.chroma < 30) return false;
  const apart = Math.abs(one.hue - other.hue);
  return other.chroma < 30 || Math.min(apart, 360 - apart) >= 25;
}
/** The one theme and mode that tells no overlay from a link: the delivered network print (a grey overlay of neutral-600 beside a black link). */
const NETWORK_OVERLAY_SHORTFALLS: readonly string[] = ['network print'];

describe('every theme keeps the contrast rules in every mode', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark', 'print'] as const) {
      it(`${theme.id} ${mode}`, () => {
        const expected = theme.id === 'network' ? NETWORK_SHORTFALLS[mode] : [];
        const found = failures(theme, mode);
        expect(found.map(item => item.label), found.map(item => item.detail).join('\n')).toEqual([...expected]);
      });
    }
  }

  it('tells an overlay link from a routed link by hue or by dash, in every theme and mode', () => {
    const apart = THEMES.flatMap(theme => (['light', 'dark', 'print'] as const).filter(mode => !overlayApartFromLink(theme, mode)).map(mode => `${theme.id} ${mode}`));
    expect(apart).toEqual([...NETWORK_OVERLAY_SHORTFALLS]);
    expect(themeById('snack').paint.print.overlay.dash).toBeDefined();
  });

  it('keeps 4.5:1 for title and subtitle on every wash a theme gives a sheet class', () => {
    for (const theme of THEMES) {
      for (const mode of ['light', 'dark', 'print'] as const) {
        const paint = theme.paint[mode];
        // A theme with no sheetWash keeps the plain body, which the pairs above check.
        for (let at = 0; theme.sheetWash !== undefined && at < WASH_PALETTE.length; at += 1) {
          const fill = theme.sheetWash(at, mode);
          expect(ratio(paint.node.text, fill), `${theme.id} ${mode} wash ${at} title`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(paint.node.description, fill), `${theme.id} ${mode} wash ${at} subtitle`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(themeById('network').sheetWash).toBeDefined();
    expect(themeById('snack').sheetWash).toBeUndefined();
  });

  it('gives a white glyph 3:1 on every tile of the snack print sheet', () => {
    const snack = themeById('snack');
    expect(ratio('#ffffff', snack.paint.print.tile.fill), 'default').toBeGreaterThanOrEqual(3);
    for (const [name] of NETWORK_NODE_CLASSES) {
      const tile = snack.classPaint(name, 'print')!;
      expect(tile.glyph).toBe('#ffffff');
      expect(ratio(tile.glyph, tile.tile.fill), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives the network print tile of every class a glyph at 3:1, white or not (ticket 158 fixed tbr)', () => {
    const network = themeById('network');
    for (const [name] of NETWORK_NODE_CLASSES) {
      const tile = network.classPaint(name, 'print')!;
      expect(ratio(tile.glyph, tile.tile.fill), name).toBeGreaterThanOrEqual(3);
    }
    expect(network.classPaint('tbr', 'print')!.tile.fill).toBe('#7a7a7d');
  });

  it('names the pairs it checks: the snack theme has more than sixty in each mode', () => {
    for (const mode of ['light', 'dark', 'print'] as const) expect(pairs(themeById('snack'), mode).length).toBeGreaterThan(60);
  });
});
