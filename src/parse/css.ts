import postcss from 'postcss';
import type { Validation } from './validation.js';

const locked = new Set([
  'font-family', 'font-size', 'font-weight', 'stroke-width', 'letter-spacing', 'transform',
  // Shorthands, independent transforms and SVG geometry must not bypass the locks.
  'font', 'all', 'translate', 'rotate', 'scale', 'transform-origin', 'transform-box',
  'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
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
