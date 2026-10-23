import { expect, it } from 'vitest';
import { areaDistance, areaOverlap, areaSegment, areaSegmentDistance, orientedBounds, orientedCorners, type OrientedBox } from '../../src/geometry/oriented.js';
import { rectDistance, rectOverlap, segmentRect, segmentRectDistance } from '../../src/geometry/planar.js';
import { labelArea, labelCrossesBorder } from '../../src/score/model.js';

const owner = { kind: 'link' as const, id: 'link-1' };
// A 100 x 10 bar turned by 45° about (0, 0): its upright box is about 77.8 px square, its corners reach ±38.9 px.
const bar: OrientedBox = { centre: { x: 0, y: 0 }, width: 100, height: 10, degrees: 45 };

it('an oriented box has its corners and upright box from centre, size and angle (ticket 20)', () => {
  const corners = orientedCorners(bar);
  const bounds = orientedBounds(bar);
  expect(Math.min(...corners.map(p => p.x))).toBeCloseTo(bounds.x, 9);
  expect(Math.max(...corners.map(p => p.y))).toBeCloseTo(bounds.y + bounds.height, 9);
  expect(bounds.width).toBeCloseTo((100 + 10) / Math.SQRT2, 9);
});

it('a turned box is tested by its turned rectangle, not its upright box (ticket 20)', () => {
  // A box in the empty corner of the upright box: the upright box overlaps it, the bar does not.
  const corner = { x: 20, y: -38, width: 10, height: 10 };
  expect(rectOverlap(orientedBounds(bar), corner)).toBe(true);
  expect(areaOverlap(bar, corner)).toBe(false);
  expect(areaDistance(bar, corner)).toBeGreaterThan(10);
  // A box on the bar's long axis overlaps it.
  expect(areaOverlap(bar, { x: 20, y: 20, width: 5, height: 5 })).toBe(true);
  expect(areaDistance(bar, { x: 20, y: 20, width: 5, height: 5 })).toBe(0);
  // A segment through the empty corner misses the bar; one across the bar meets it.
  const miss = { from: { x: 25, y: -38 }, to: { x: 38, y: -25 }, owner };
  expect(segmentRect(miss, orientedBounds(bar))).toBe(true);
  expect(areaSegment(miss, bar)).toBe(false);
  expect(areaSegmentDistance(miss, bar)).toBeGreaterThan(10);
  expect(areaSegment({ from: { x: -30, y: 30 }, to: { x: 30, y: -30 }, owner }, bar)).toBe(true);
  // The distance of a point segment beside the long side: the perpendicular distance less half the height.
  const beside = { from: { x: -10, y: 10 }, to: { x: -10, y: 10 }, owner };
  expect(areaSegmentDistance(beside, bar)).toBeCloseTo(Math.hypot(10, 10) - 5, 9);
});

it('upright boxes give exactly the planar results (ticket 20)', () => {
  const a = { x: 0, y: 0, width: 30, height: 10 }, b = { x: 25, y: 12, width: 10, height: 10 };
  const s = { from: { x: -5, y: 20 }, to: { x: 40, y: 15 }, owner };
  expect(areaOverlap(a, b)).toBe(rectOverlap(a, b));
  expect(areaDistance(a, b)).toBe(rectDistance(a, b));
  expect(areaSegment(s, a)).toBe(segmentRect(s, a));
  expect(areaSegmentDistance(s, a)).toBe(segmentRectDistance(s, a));
  // A label with no turned size is its box; a turned label is its turned rectangle about the box's centre.
  expect(labelArea({ bounds: a, textRotation: -90 })).toBe(a);
  const turned = labelArea({ bounds: orientedBounds(bar), textRotation: 45, turnedSize: { width: 100, height: 10 } });
  expect(turned).toMatchObject({ width: 100, height: 10, degrees: 45 });
});

it('labelCrossesBorder reads the turned rectangle: a corner the upright box reaches is no crossing (ticket 20)', () => {
  // The group's corner lies in the empty corner of the upright box.
  const group = { x: 22, y: -200, width: 200, height: 170 };
  expect(labelCrossesBorder(orientedBounds(bar), group)).toBe(true);
  expect(labelCrossesBorder(bar, group)).toBe(false);
  // Moved onto the corner, the bar crosses it; wholly inside a box it does not.
  expect(labelCrossesBorder({ ...bar, centre: { x: 30, y: -20 } }, group)).toBe(true);
  expect(labelCrossesBorder(bar, { x: -100, y: -100, width: 200, height: 200 })).toBe(false);
});
