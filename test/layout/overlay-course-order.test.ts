import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { validateCourseLane } from '../../src/layout/courses.js';
import type { Lane } from '../../src/index.js';
import { rowIndex } from '../../src/layout/course-lanes.js';

/** Architecture ticket 15, phase 7 review: the padding rows of one group edge follow the rings,. */
describe('padding rows', () => {
  it('stand in ring order, not in link id order', () => {
    const course = (link: string) => ({ link, kind: 'overlay', side: 'right', from: { face: 'top' }, to: { face: 'right' }, runs: ['padding', 'perimeter'] });
    const model = {
      document: { nodes: { a: { group: 'g' }, b: { group: 'g' } } },
      links: [{ id: 'link-a', attachments: { from: { node: 'a' }, to: { node: 'x' } } }, { id: 'link-b', attachments: { from: { node: 'b' }, to: { node: 'y' } } }],
      courses: [course('link-a'), course('link-b')],
    } as unknown as LayoutModel;
    const rings = new Map<string, { ring: number; side: 'left' | 'right' }>([['link-a', { ring: 1, side: 'right' }], ['link-b', { ring: 0, side: 'right' }]]);
    // The outer ring (link-a) stands on the outer row; ids alone would give link-a the inner one.
    expect(rowIndex(model, model.courses![0]!, 'from', rings)).toBe(1);
    expect(rowIndex(model, model.courses![1]!, 'from', rings)).toBe(0);
    expect(rowIndex(model, model.courses![0]!, 'from', new Map())).toBe(0);
  });
});

describe('the layer of a course lane', () => {
  it('equals the layer of its link', () => {
    const model = { links: [{ id: 'link-a', layer: 'overlay' }], courses: [{ link: 'link-a', kind: 'overlay', side: 'right', from: { face: 'right' }, to: { face: 'right' }, runs: ['perimeter'] }] } as unknown as LayoutModel;
    const lane = (layer: string): Lane => ({ id: 'perimeter:link-a', kind: 'perimeter', owner: { kind: 'link', id: 'link-a' }, layer, side: 'right', ring: 0, span: { top: 0, bottom: 1 } }) as unknown as Lane;
    expect(() => validateCourseLane(model, lane('overlay'))).not.toThrow();
    expect(() => validateCourseLane(model, lane('routed'))).toThrow(/layer/);
  });
});
