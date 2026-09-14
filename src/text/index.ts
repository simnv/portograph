import { CORNER_RADII } from '../theme/geometry.js';
import { FONT_METRICS } from './font-metrics.js';

/** Renderers must use this font stack, with kerning and discretionary ligatures disabled. */
export const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
export type FontWeight = 400 | 700;

export interface TextStyle {
  fontSize?: number;
  weight?: FontWeight;
}

export interface TextMeasurement {
  width: number;
  height: number;
  lineHeight: number;
  ascent: number;
  descent: number;
  /** Canonical lines for rendering: newlines normalized and tabs expanded to four spaces. */
  lines: string[];
  /** Unknown glyphs reserve one em each; callers can emit a font-coverage diagnostic. */
  unsupportedCharacters: string[];
}

/** Glyph advance measurement, without shaping; the checked-in table is shared in Node/browser. */
export function measureText(text: string, style: TextStyle = {}): TextMeasurement {
  const fontSize = style.fontSize ?? 12;
  if (!Number.isFinite(fontSize) || fontSize <= 0) throw new RangeError('fontSize must be positive and finite');
  const weight = style.weight ?? 400;
  if (weight !== 400 && weight !== 700) throw new RangeError('Supported font weights are 400 and 700');
  const font = FONT_METRICS[weight];
  const scale = fontSize / font.unitsPerEm;
  const ascent = font.ascent * scale;
  const descent = font.descent * scale;
  const lineHeight = Math.ceil((font.ascent + font.descent + font.lineGap) * scale);
  const lines = text === '' ? [] : text.replace(/\t/g, '    ').split(/\r\n|\r|\n/);
  const unsupported = new Set<string>();
  let width = 0;
  for (const line of lines) {
    let advance = 0;
    for (const character of line) {
      const measured = font.advances[character];
      if (measured === undefined) unsupported.add(character);
      advance += measured ?? font.unitsPerEm;
    }
    width = Math.max(width, advance * scale);
  }
  const height = lines.length * lineHeight;
  if (![width, height, lineHeight, ascent, descent].every(Number.isFinite)) {
    throw new RangeError('Text measurement exceeds finite geometry');
  }
  return { width, height, lineHeight, ascent, descent, lines,
    unsupportedCharacters: [...unsupported] };
}

export interface PortPillMeasurement {
  width: number;
  height: number;
  radius: number;
  text: TextMeasurement;
}

/** Unrotated dimensions. Port labels use 8px Arial, 3px horizontal padding and minimum 24×10. */
export function measurePortPill(label: string, style: TextStyle = {}): PortPillMeasurement {
  const text = measureText(label, { ...style, fontSize: style.fontSize ?? 8 });
  return { width: Math.max(24, Math.ceil(text.width + 6)), height: Math.max(10, text.height), radius: CORNER_RADII.pill, text };
}
