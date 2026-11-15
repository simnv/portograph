import { describe, expect, it } from 'vitest';
import { parse, parseWithDiagnostics } from '../../src/index.js';
import { aspectAim, aspectGap } from '../../src/layout/aspect.js';
import { DEFAULT_ASPECT } from '../../src/model/index.js';

// ADR-0025: `layout.aspect` is a quoted "W:H" string, stored as W/H only when it differs from 16:9.
const sheet = (layoutLine: string): string => `portograph: 2
${layoutLine}
groups: { g: { tier: 0 } }
nodes: { a: { group: g } }
`;

describe('layout.aspect (ADR-0025)', () => {
  it('stores the ratio of a quoted W:H string', () => {
    expect(parse(sheet('layout: { aspect: "1:1" }')).layout?.aspect).toBe(1);
    expect(parse(sheet('layout: { aspect: "4:3" }')).layout?.aspect).toBeCloseTo(4 / 3, 12);
    expect(parse(sheet('layout: { aspect: "2.5:1" }')).layout?.aspect).toBe(2.5);
    expect(parse(sheet('layout: { aspect: " 3 : 2 " }')).layout?.aspect).toBe(1.5);
  });

  it('does not store the default, as theme does not', () => {
    expect(parse(sheet('layout: { aspect: "16:9" }')).layout).toBeUndefined();
    expect(parse(sheet('layout: { aspect: "32:18" }')).layout).toBeUndefined();
    expect(parse(sheet('layout: { aspect: "16:9", autoArrange: false }')).layout).toEqual({ autoArrange: false });
  });

  it.each([
    ['an unquoted number (a YAML 1.1 tool reads 16:9 as 969)', 'layout: { aspect: 969 }'],
    ['a number', 'layout: { aspect: 1.5 }'],
    ['a boolean', 'layout: { aspect: true }'],
    ['one part', 'layout: { aspect: "16" }'],
    ['three parts', 'layout: { aspect: "16:9:1" }'],
    ['a zero part', 'layout: { aspect: "0:9" }'],
    ['a zero divisor', 'layout: { aspect: "16:0" }'],
    ['a negative part', 'layout: { aspect: "-16:9" }'],
    ['a word', 'layout: { aspect: "wide" }'],
    ['an empty string', 'layout: { aspect: "" }'],
  ])('refuses %s with INVALID_TYPE at $.layout.aspect', (_name, line) => {
    const result = parseWithDiagnostics(sheet(line));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter(item => item.code === 'INVALID_TYPE' && item.path === '$.layout.aspect')).toHaveLength(1);
  });

  it('reads the aim from the document: 16:9 absent, the stored ratio when stated', () => {
    expect(aspectAim(parse(sheet('')))).toBe(DEFAULT_ASPECT);
    expect(aspectAim(parse(sheet('layout: { aspect: "1:1" }')))).toBe(1);
  });
});

describe('aspectAim of a document built in code (R6)', () => {
  it.each([0, -1, Number.NaN, Infinity])('throws for layout.aspect %s', aspect => {
    const document = parse(sheet(''));
    document.layout = { aspect };
    expect(() => aspectAim(document)).toThrow(/layout\.aspect must be positive and finite/);
  });
});

describe('aspectGap', () => {
  it('is |ln((W/H) / aim)|: 0 on the aim, symmetric in ratio, Infinity with no area', () => {
    expect(aspectGap(1600, 900, DEFAULT_ASPECT)).toBeCloseTo(0, 12);
    expect(aspectGap(500, 500, 1)).toBe(0);
    expect(aspectGap(2000, 500, 1)).toBeCloseTo(Math.log(4), 12);
    expect(aspectGap(500, 2000, 1)).toBeCloseTo(Math.log(4), 12);
    expect(aspectGap(500, 500, DEFAULT_ASPECT)).toBeCloseTo(Math.log(DEFAULT_ASPECT), 12);
    expect(aspectGap(0, 500, 1)).toBe(Infinity);
    expect(aspectGap(500, 0, 1)).toBe(Infinity);
  });
});
