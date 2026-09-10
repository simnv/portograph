import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measurePortPill, measureText } from '../../src/text/index.js';

describe('font measurements', () => {
  it('matches browser-measured port, proportional, kernable and Cyrillic labels at both weights', () => {
    const reference: { samples: { text: string; fontSize: number; weight: 400 | 700; width: number }[] } =
      JSON.parse(readFileSync(new URL('../fixtures/text/chrome-reference.json', import.meta.url), 'utf8'));
    for (const sample of reference.samples) {
      const actual = measureText(sample.text, sample);
      expect(Math.abs(actual.width - sample.width) / sample.width).toBeLessThan(0.05);
      expect(actual.unsupportedCharacters).toEqual([]);
    }
  });

  it('uses glyph advances and weight rather than character count', () => {
    expect(measureText('WWW').width).toBeGreaterThan(measureText('iii').width * 3);
    expect(measureText('iii', { weight: 700 }).width).toBeGreaterThan(measureText('iii').width);
  });

  it('measures lines independently, normalizes newlines and expands tabs for the renderer', () => {
    const measured = measureText('WWW\r\ni\tI\rX', { fontSize: 12 });
    expect(measured.lines).toEqual(['WWW', 'i    I', 'X']);
    expect(measured.width).toBeCloseTo(33.978515625);
    expect(measured.lineHeight).toBe(14);
    expect(measured.height).toBe(42);
    expect(measureText('').height).toBe(0);
  });

  it('reserves one em per unsupported code point and reports it once', () => {
    const measured = measureText('🧭🧭', { fontSize: 12 });
    expect(measured.width).toBe(24);
    expect(measured.unsupportedCharacters).toEqual(['🧭']);
  });

  it('sizes pills to measured content while retaining the minimum', () => {
    expect(measurePortPill('i')).toMatchObject({ width: 24, height: 10, radius: 3 });
    expect(measurePortPill('100G')).toMatchObject({ width: 26, height: 10, radius: 3 });
    const long = measurePortPill('100G-LONG-NAME');
    expect(long.width).toBeGreaterThan(60);
    expect(long.width - long.text.width).toBeGreaterThanOrEqual(6);
  });

  it.each([0, -1, NaN, Infinity])('rejects unusable font size %s', (fontSize) => {
    expect(() => measureText('100G', { fontSize })).toThrow(RangeError);
  });

  it('rejects unsupported runtime weights and numeric overflow', () => {
    // JavaScript consumers can supply weights outside the TypeScript union.
    // @ts-expect-error Exercise invalid runtime input.
    expect(() => measureText('100G', { weight: 600 })).toThrow(RangeError);
    expect(() => measureText('100G', { fontSize: Number.MAX_VALUE })).toThrow(RangeError);
  });
});
