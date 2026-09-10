import { describe, expect, it } from 'vitest';
import { placePortPill, portPitch } from '../../src/geometry/index.js';

describe('port geometry', () => {
  const node = { x: 20, y: 30, width: 100, height: 80 };
  const pill = { width: 26, height: 10 };

  it.each([
    { side: 'top', anchor: { x: 60, y: 30 }, bounds: { x: 55, y: 17, width: 10, height: 26 }, rotation: -90 },
    { side: 'bottom', anchor: { x: 60, y: 110 }, bounds: { x: 55, y: 97, width: 10, height: 26 }, rotation: -90 },
    { side: 'left', anchor: { x: 20, y: 70 }, bounds: { x: 7, y: 65, width: 26, height: 10 }, rotation: 0 },
    { side: 'right', anchor: { x: 120, y: 70 }, bounds: { x: 107, y: 65, width: 26, height: 10 }, rotation: 0 },
  ] as const)('keeps the $side anchor on the boundary and uses the JPEG pill orientation', ({ side, anchor, bounds, rotation }) => {
    const placed = placePortPill(node, side, 40, pill);
    expect(placed.anchor).toEqual(anchor);
    expect(placed.bounds).toEqual(bounds);
    expect(placed.textRotation).toBe(rotation);
    expect(placed.size).toEqual(pill);
  });

  it('separates normal pill protrusion from tangential spacing', () => {
    expect(portPitch([])).toBe(12);
    expect(portPitch([pill, { width: 120, height: 10 }])).toBe(14);
    expect(portPitch([pill, { width: 120, height: 30 }])).toBe(34);
  });

  it.each([-1, 101, NaN, Infinity])('rejects an invalid top offset %s', (offset) => {
    expect(() => placePortPill(node, 'top', offset, pill)).toThrow(RangeError);
  });

  it('accepts corner anchors and rejects unusable rectangles', () => {
    expect(placePortPill(node, 'bottom', 100, pill).anchor).toEqual({ x: 120, y: 110 });
    expect(() => placePortPill({ ...node, width: -1 }, 'top', 0, pill)).toThrow(RangeError);
    expect(() => placePortPill(node, 'top', 0, { width: 0, height: 10 })).toThrow(RangeError);
  });
});
