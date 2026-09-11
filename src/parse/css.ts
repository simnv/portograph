import postcss from 'postcss';
import type { Validation } from './validation.js';

const locked = new Set([
  'font-family', 'font-size', 'font-weight', 'stroke-width', 'letter-spacing', 'transform',
  // Shorthands, independent transforms and SVG geometry must not bypass the locks.
  'font', 'all', 'translate', 'rotate', 'scale', 'transform-origin', 'transform-box',
  'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  // Text metrics. A label's box is measured from the font table at its stored size and weight, so
  // anything that changes glyph advances or case would draw text outside the box the gates cleared.
  'font-stretch', 'font-size-adjust', 'font-variant', 'font-variant-caps', 'font-feature-settings',
  'font-variation-settings', 'font-synthesis', 'font-optical-sizing', 'text-size-adjust',
  'word-spacing', 'text-transform', 'writing-mode', 'text-orientation',
  'glyph-orientation-horizontal', 'glyph-orientation-vertical',
  // Text and element placement. These move drawn geometry away from its measured position.
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'dx', 'dy',
  'offset', 'offset-path', 'offset-distance', 'offset-rotate', 'zoom',
  // Extra painted geometry: markers add arrowheads, and a non-scaling stroke changes its width.
  'marker', 'marker-start', 'marker-mid', 'marker-end', 'vector-effect',
  // Remaining text metrics. An italic face, kerning and the font-variant longhands all change glyph
  // advances, so the drawn text no longer fits the box the font table measured.
  'font-style', 'font-kerning', 'font-language-override', 'font-variant-ligatures',
  'font-variant-numeric', 'font-variant-east-asian', 'font-variant-alternates',
  'font-variant-position', 'font-variant-emoji',
  // Paint that leaves its element's box, or removes protection the design requires. A filter or a
  // shadow paints outside the measured geometry; `mask` and `clip-path` can switch off the overlay
  // mask that keeps node interiors, pills and labels readable.
  'filter', 'backdrop-filter', 'text-shadow', 'box-shadow', 'clip', 'clip-path',
  'mask', 'mask-image', 'mask-mode', 'mask-repeat', 'mask-position', 'mask-clip', 'mask-origin',
  'mask-size', 'mask-composite', 'mask-type', 'mask-border', 'mask-border-source',
  // An unbounded miter can extend a stroke far past the joint the gates measured.
  'stroke-miterlimit',
  // An outline is painted outside its element's box, after the shape and independently of `stroke`,
  // and it never contributes to the geometry the gates and the score measure. A wide one on an
  // ordinary node covers unrelated geometry and reaches past the canvas. The shorthand and each
  // longhand are locked together: `outline-style` alone paints at the `medium` default width, and
  // `outline-offset` pushes an outline arbitrarily far from the element it belongs to.
  'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',
]);

const cssEscape = /\\(?:([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\r\n\f]))/gi;

function normalizeEscapeWhitespace(css: string): string {
  // PostCSS accepts space-terminated hex escapes in property names, but rejects
  // the equivalent tab/newline terminators. Match whole escapes so an escaped
  // backslash cannot be mistaken for the start of a hexadecimal escape.
  return css.replace(cssEscape, (match, hex: string | undefined) =>
    hex !== undefined && /[\t\n\r\f]$/.test(match) ? `\\${hex} ` : match);
}

function propertyName(property: string): string {
  return property.replace(cssEscape, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd);
    }
    return char ?? '';
  }).trim().toLowerCase();
}

export function filterCss(css: string, validation: Validation): string {
  try {
    const root = postcss.parse(normalizeEscapeWhitespace(css), { from: undefined });
    root.walkDecls(declaration => {
      const property = propertyName(declaration.prop);
      const canonical = property.replace(/^-(?:webkit|moz|ms|o)-/, '');
      if (locked.has(canonical)) {
        validation.report('LOCKED_CSS', '$.css', `Ignored locked CSS property ${property}`, 'warning');
        declaration.remove();
      }
    });
    return root.toString();
  } catch {
    validation.report('INVALID_CSS', '$.css', 'Malformed CSS');
    return '';
  }
}
