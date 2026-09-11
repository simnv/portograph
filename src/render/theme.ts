import { NETWORK_LINK_CLASSES, NETWORK_NODE_CLASSES, NETWORK_THEME } from '../profiles/network/theme.js';

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
 * The network profile theme. Colour, fill, dash and opacity only: every rule here is at the same
 * specificity a document `css:` rule can reach, and the document's filtered CSS is appended after
 * it, so an author still owns the palette.
 */
export function themeCss(): string {
  const rules: string[] = [
    `.pg-canvas{fill:${NETWORK_THEME.background}}`,
    `.group-box{fill:${NETWORK_THEME.group.fill};stroke:${NETWORK_THEME.group.stroke};stroke-dasharray:${NETWORK_THEME.group.dash}}`,
    `.group-label{fill:${NETWORK_THEME.group.text}}`,
    `.node-body{fill:${NETWORK_THEME.node.fill};stroke:${NETWORK_THEME.node.stroke}}`,
    `.node-label{fill:${NETWORK_THEME.node.text}}`,
    `.node-description{fill:${NETWORK_THEME.node.text};fill-opacity:0.8}`,
    // Defaults for a class the profile does not know; the class rules below are more specific.
    `.icon-tile{fill:${NETWORK_THEME.node.fill};stroke:${NETWORK_THEME.node.stroke}}`,
    `.node-icon{fill:none;stroke:${NETWORK_THEME.node.text};stroke-linecap:round;stroke-linejoin:round}`,
    `.pill{fill:${NETWORK_THEME.pill.fill};stroke:${NETWORK_THEME.pill.stroke}}`,
    `.pill-label{fill:${NETWORK_THEME.pill.text}}`,
    `.link-line{fill:none;stroke:${NETWORK_LINK_CLASSES[0]![1].stroke}}`,
    `.link-label{fill:${NETWORK_THEME.link.label}}`,
    `.legend-label{fill:${NETWORK_THEME.legend.text}}`,
    `.overlay-line{stroke:${NETWORK_THEME.overlay.stroke};stroke-opacity:${NETWORK_THEME.overlay.opacity}}`,
    `.overlay-endpoint{fill:${NETWORK_THEME.overlay.mark};stroke:none}`,
  ];
  for (const [name, style] of NETWORK_NODE_CLASSES) {
    rules.push(`.icon-tile.${name}{fill:${style.fill};stroke:${style.stroke}}`);
    rules.push(`.node-icon.${name}{stroke:${style.foreground}}`);
    if (style.body) {
      rules.push(`.node-body.${name}{fill:${style.body.fill};stroke:${style.body.stroke}}`);
      // A group whose nodes all share this class reads as one filled region, as the target does.
      rules.push(`.group-box.${name}{fill:${style.body.fill};stroke:${style.body.stroke};stroke-dasharray:none}`);
      rules.push(`.group-label.${name}{fill:${NETWORK_THEME.groupBodyText}}`);
      rules.push(`.node-label.${name}{fill:${style.foreground}}`);
    }
  }
  for (const [name, style] of NETWORK_LINK_CLASSES.slice(1)) {
    rules.push(`.link-line.${name}{stroke:${style.stroke}`
      + `${style.dash ? `;stroke-dasharray:${style.dash}` : ''}${style.cap ? `;stroke-linecap:${style.cap}` : ''}}`);
  }
  // The overlay mask is internal render structure, not an author styling surface.
  rules.push('.pg-mask-show{fill:#ffffff!important;stroke:none!important}',
    '.pg-mask-hide{fill:#000000!important;stroke:none!important}');
  return rules.join('\n');
}
