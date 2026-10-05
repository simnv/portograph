import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { validateCourseLane } from '../../src/layout/courses.js';
import type { Lane } from '../../src/index.js';
import { rowIndex } from '../../src/layout/course-lanes.js';
import { slotOrder } from '../../src/layout/sides-two.js';

/** Architecture ticket 15, phase 7 review: the padding rows of one group edge follow the rings, and the port order on a face is a total order. */
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

describe('the port order of a face', () => {
  const ports = [{ id: 'c1', far: 10, reach: 300 }, { id: 'c2', far: 500, reach: 200 }, { id: 'above', far: 50 }, { id: 'below', far: 450 }, { id: 'none', far: Infinity }];
  const sorted = (list: typeof ports): string[] => [...list].sort(slotOrder(list)).map(item => item.id);
  it('is total: the same order from every start', () => {
    const expected = sorted(ports);
    for (let shift = 0; shift < ports.length; shift++) expect(sorted([...ports.slice(shift), ...ports.slice(0, shift)])).toEqual(expected);
    expect(sorted([...ports].reverse())).toEqual(expected);
  });
  it('puts a routed port whose peer is above the brackets above them, and the others below', () => {
    expect(sorted(ports)).toEqual(['above', 'c1', 'c2', 'below', 'none']);
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
