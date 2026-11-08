import type { NormalisedNode } from '../../model/document.js';
import { NETWORK_NODE_CLASSES } from './theme.js';

/**
 * Network profile defaults shared by node measurement and SVG rendering. The glyph, not only the
 * tile colour, has to separate the roles: `quality.md` requires the diagram to read without colour.
 * `tbr` therefore takes the distinct `switch` glyph recommended in `render-theme-notes.md`, which
 * also follows the target JPEG, where the transit border routers carry a different symbol from the
 * red routers. `rr` takes the `server` glyph (ticket 158, spec decision 6): each class in the legend has its own glyph, so a
 * greyscale sheet tells a route reflector from a router.
 */
export const NETWORK_NODE_ICONS: Readonly<Record<string, string>> = {
  provider: 'cloud', internet: 'cloud', wan: 'cloud',
  tbr: 'switch',
  router: 'router', rr: 'server', backbone: 'router', core: 'router',
};

/**
 * The five reusable 24-unit glyphs, transplanted verbatim from d3-fd `src/nodes/mainNode.ts:13-19`.
 * They are stroked, never filled, and the renderer scales them into the measured icon bounds.
 */
export const NETWORK_ICON_PATHS: Readonly<Record<string, string>> = {
  router: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  switch: 'M4 6h16M4 12h16M4 18h16',
  server: 'M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z',
  cloud: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
  default: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
};

/** Every icon the model can name resolves to a glyph; an unknown name falls back to the star. */
export const iconPath = (icon: string): string => NETWORK_ICON_PATHS[icon] ?? NETWORK_ICON_PATHS['default']!;

/** The glyph key an unknown icon name shares, so `<symbol>` reuse stays deterministic. */
export const iconKey = (icon: string): string => Object.hasOwn(NETWORK_ICON_PATHS, icon) ? icon : 'default';

/** An explicit empty icon suppresses the class default. */
export function resolveNodeIcon(node: Pick<NormalisedNode, 'icon' | 'class'>): string | undefined {
  if (node.icon !== undefined) return node.icon === '' ? undefined : node.icon;
  const token = iconClass(node.class);
  return token === undefined ? undefined : NETWORK_NODE_ICONS[token];
}

/**
 * The class token of a node's `class` that gives it its icon: of the tokens that have one, the profile class declared last (the one
 * whose `.icon-tile.<class>` rule wins the cascade, as `washToken` picks the body), else the first in the attribute. So `router extra`
 * draws the router icon, and the order of the tokens changes nothing for two profile classes (drawio-export ticket 8).
 */
export function iconClass(classAttr: string | undefined): string | undefined {
  const rank = (token: string): number => NETWORK_NODE_CLASSES.findIndex(([name]) => name === token);
  const tokens = (classAttr ?? '').split(/\s+/).filter(token => token && Object.hasOwn(NETWORK_NODE_ICONS, token));
  // Last key: the token order of the attribute (a stable sort), for two tokens the theme does not paint.
  return [...tokens].sort((a, b) => rank(b) - rank(a))[0];
}
