import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { flattenWhere } from '../../scripts/png-lib.mjs';

describe('flattenWhere', () => {
  it('rewrites a :where() rule in a style element and leaves the rest', () => {
    const svg = '<svg><style>.node-body{fill:#fff}\n.node-body:where(.core){fill:#abc}\n@media print{\n  .node-body:where(.pg-wash-1){fill:#ddd}\n}</style><g class="node-body core"/></svg>';
    const flat = flattenWhere(svg);
    expect(flat).toContain('.node-body.core{fill:#abc}');
    expect(flat).toContain('@media print{\n  .node-body.pg-wash-1{fill:#ddd}\n}');
    expect(flat).toContain('.node-body{fill:#fff}');
    expect(flat).not.toContain(':where');
  });

  it('expands a list argument into one selector per item', () => {
    expect(flattenWhere('<style>.a:where(.b, .c) .d{fill:red}</style>')).toBe('<style>.a.b .d,.a.c .d{fill:red}</style>');
  });

  it('does not touch text outside a style element', () => {
    const svg = '<svg><text>:where(.x){}</text></svg>';
    expect(flattenWhere(svg)).toBe(svg);
  });

  it('makes resvg paint the wash on a node body', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><style>.b:where(.k){fill:#ff0000}</style><rect class="b k" width="4" height="4" fill="#ffffff"/></svg>';
    const pixel = (text: string): number[] => [...new Resvg(text).render().pixels.subarray(0, 3)];
    expect(pixel(svg)).toEqual([255, 255, 255]);
    expect(pixel(flattenWhere(svg))).toEqual([255, 0, 0]);
  });
});
