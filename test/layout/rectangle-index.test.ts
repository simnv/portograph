import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/model/geometry.js';
import { RectangleIndex } from '../../src/layout/rectangle-index.js';

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

describe('rectangle queries for label obstacles', () => {
  it('matches an independent inclusive rectangle oracle before and after additions', () => {
    let state = 712367;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const rect = (): Rect => ({ x: random() * 2000 - 1000, y: random() * 2000 - 1000,
      width: random() < .2 ? 0 : random() * 300, height: random() < .2 ? 0 : random() * 300 });
    const entries = Array.from({ length: 300 }, (_, value) => ({ bounds: rect(), value }));
    const index = new RectangleIndex(entries);
    for (let i = 0; i < 1000; i++) {
      if (i % 10 === 0) { const entry = { bounds: rect(), value: entries.length }; entries.push(entry); index.add(entry.bounds, entry.value); }
      const query = i % 5 === 0 ? entries[i % entries.length]!.bounds : rect();
      const found: number[] = [];
      expect(index.some(query, value => { found.push(value); return false; })).toBe(false);
      expect(found.sort((a, b) => a - b)).toEqual(entries.filter(entry => overlaps(entry.bounds, query)).map(entry => entry.value));
      expect(index.some(query, value => value % 7 === 0)).toBe(entries.some(entry => entry.value % 7 === 0 && overlaps(entry.bounds, query)));
    }
  });

  it('prunes coincident shared stems before visiting member copies and stops at the first hit', () => {
    const index = new RectangleIndex(Array.from({ length: 4000 }, (_, value) => ({
      bounds: { x: 19.25, y: 40, width: 1.5, height: 360 }, value,
    })));
    const work = { nodes: 0, items: 0 };
    for (let i = 0; i < 4000; i++) {
      expect(index.some({ x: 24.75, y: 215, width: 5, height: 10 }, () => true, work)).toBe(false);
    }
    expect(work.items).toBe(0);
    expect(work.nodes).toBeLessThanOrEqual(4000);
    let calls = 0;
    expect(index.some({ x: 20, y: 200, width: 1, height: 10 }, () => { calls++; return true; })).toBe(true);
    expect(calls).toBe(1);
  });

  it('queries wide disjoint labels without scanning whole rows or measuring text', () => {
    const count = 4000;
    const entries = Array.from({ length: count }, (_, value) => ({
      bounds: { x: 40, y: 200 * value + 19.25, width: 699960, height: 1.5 }, value,
    }));
    const index = new RectangleIndex(entries);
    const work = { nodes: 0, items: 0 };
    for (let i = 0; i < count; i++) {
      expect(index.some({ x: 70000, y: 200 * i + 5, width: 552151, height: 10 }, () => true, work)).toBe(false);
    }
    expect(work.items).toBe(0);
    expect(work.nodes).toBeLessThan(count * 300);
  });

  it('terminates for a query with one oversized axis and for extreme finite coordinates', () => {
    const index = new RectangleIndex([{ bounds: { x: 2 ** 66, y: 0, width: 10, height: 10 }, value: 1 },
      { bounds: { x: 0, y: 0, width: 1, height: 1 }, value: 2 }]);
    expect(index.some({ x: 0, y: 0, width: 1e18, height: 10 }, value => value === 2)).toBe(true);
    expect(index.some({ x: 2 ** 66, y: 0, width: 0, height: 0 }, value => value === 1)).toBe(true);
    expect(index.some({ x: -1e300, y: -1e300, width: 2e300, height: 2e300 }, () => true)).toBe(true);
    expect(index.some({ x: 0, y: 20, width: 1e300, height: 10 }, () => true)).toBe(false);
  }, 5000);

  it('rounds padding outward on every edge without reconstructing a large width', () => {
    const cases = [
      { box: { x: -(2 ** 52), y: 100, width: 2 ** 51, height: 200 }, query: { x: -(2 ** 51) + .25, y: 150, width: 0, height: 0 } },
      { box: { x: 2 ** 51, y: 100, width: 2 ** 51, height: 200 }, query: { x: 2 ** 51 - .25, y: 150, width: 0, height: 0 } },
    ];
    for (const { box, query } of cases) for (const swap of [false, true]) {
      const transpose = (r: Rect): Rect => swap ? { x: r.y, y: r.x, width: r.height, height: r.width } : r;
      const bounds = transpose(box), point = transpose(query);
      const index = new RectangleIndex([{ bounds, value: 1, padding: .500001 }]);
      expect(index.some(point, () => true)).toBe(true);
      const inverse = new RectangleIndex([{ bounds: point, value: 1 }]);
      expect(inverse.some(bounds, () => true, undefined, .500001)).toBe(true);
    }
    const extreme = new RectangleIndex([{ bounds: { left: -Number.MAX_VALUE, top: 0, right: Number.MAX_VALUE, bottom: 0 }, value: 1, padding: 1 }]);
    expect(extreme.some({ x: 0, y: 0, width: 0, height: 0 }, () => true)).toBe(true);
  });
});
