import { describe, expect, it } from 'vitest';
import { pieceTurns, pointTurns } from '../../src/geometry/planar.js';
import { pathBends } from '../../src/layout/objective.js';
import { simplify } from '../../src/layout/course-plan.js';
import { polylinesCross, strictCrossing } from '../../src/layout/read/crossings.js';
import type { Point } from '../../src/model/geometry.js';
import type { LayoutLink } from '../../src/model/layout.js';

/**
 * D-Q6 (decision review 2026-11, ticket 12): one turn predicate and one proper-crossing predicate for every reader and gate. The course
 * round reads a polyline (`pointTurns`, `polylinesCross`); the scorer and the judges read a published path (`pathBends`, `strictCrossing`).
 * The two readings must agree on the same geometry.
 */
const OWNER = { kind: 'link', id: 'probe' } as const;
const pieces = (points: readonly Point[]) => points.slice(1).map((to, index) => ({ from: points[index]!, to, owner: OWNER }));
const link = (points: readonly Point[]): LayoutLink => ({ id: 'probe', path: { segments: pieces(points) } }) as unknown as LayoutLink;

describe('one turn predicate (pathBends)', () => {
  it.each<[string, Point[], number]>([
    // P-08-F2: the determinant is 5e-7 px squared, above the planar EPS; the old course reader saw 0.
    ['the determinant case', [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0.0000005 }], 1],
    ['exact collinearity', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 9 }], 0],
    ['a reversal', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 2 }], 1],
    ['a repeated point at a corner', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 5 }, { x: 4, y: 5 }], 1],
    ['a repeated point on a run', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 9 }], 0],
    ['a U', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 0 }], 2],
    // The test is on the angle: the determinant case at ten times the scale is still a turn, a residue on two long pieces is none.
    ['the determinant case at scale 10', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0.000005 }], 1],
    ['a residue on two long pieces', [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 1e-9 }], 0],
    // DR-12 review F3: a point 5e-7 px on is a distinct point for `simplify` and `pointTurns` alike (one `samePoint`).
    ['a short piece on a run, then a corner', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 5.0000005 }, { x: 4, y: 5.0000005 }], 1],
    ['a short jog', [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0.0000005, y: 100 }, { x: 0.0000005, y: 200 }], 2],
    ['a near repeat of a point', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0.00000005, y: 5 }, { x: 4, y: 5 }], 1],
  ])('%s: the polyline reader and the path reader agree', (_name, points, expected) => {
    expect(pathBends(link(points))).toBe(expected);
    expect(pointTurns(points)).toBe(expected);
    expect(pieceTurns(pieces(points))).toBe(expected);
    // `simplify` reads the same `samePoint` and the same `isTurn`, so the count survives it.
    expect(pointTurns(simplify(points))).toBe(expected);
  });
});

describe('one proper-crossing predicate (strictCrossing)', () => {
  const along = [{ x: 0, y: 0 }, { x: 10000, y: 0 }];
  const at = (x: number): Point[] => [{ x, y: -10 }, { x, y: 10 }];

  it('counts a crossing 5 px inside a long segment (P-08-F3: the old 1e-3 fraction dropped it)', () => {
    expect(polylinesCross(along, at(5))).toBe(true);
    expect(strictCrossing(pieces(along)[0]!, pieces(at(5))[0]!)).toBe(true);
  });

  it('does not count exact endpoint contact', () => {
    expect(polylinesCross(along, at(0))).toBe(false);
    expect(polylinesCross(along, [{ x: 5, y: 0 }, { x: 5, y: 10 }])).toBe(false);
    expect(strictCrossing(pieces(along)[0]!, pieces(at(0))[0]!)).toBe(false);
  });

  it.each<[string, Point[], Point[], boolean]>([
    ['a plain X', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 10 }], true],
    ['an X 5 px inside a 10000 px segment', [{ x: 0, y: 5 }, { x: 10000, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 10 }], true],
    ['a T at the end of one', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 5 }], false],
    ['a T 1e-8 px short', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 5 - 1e-8 }], false],
    ['a T 1e-8 px over', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 5 + 1e-8 }], false],
    // Past the planar EPS the end stands across the line: a crossing, as G6 reads one.
    ['a T 1e-6 px over', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 5, y: 0 }, { x: 5, y: 5 + 1e-6 }], true],
    ['an exact collinear overlap', [{ x: 0, y: 5 }, { x: 10, y: 5 }], [{ x: 3, y: 5 }, { x: 20, y: 5 }], false],
    ['a collinear overlap with a 1e-12 tilt', [{ x: 0, y: 5 }, { x: 100, y: 5 }], [{ x: 10, y: 5 + 1e-12 }, { x: 90, y: 5 - 1e-12 }], false],
    ['a diagonal collinear overlap with a residue', [{ x: 0, y: 0 }, { x: 100, y: 100.0000000000001 }], [{ x: 10, y: 10 }, { x: 90, y: 90 }], false],
    ['two near-parallel segments, 1e-9 tilt', [{ x: 0, y: 5 }, { x: 100, y: 5 }], [{ x: 0, y: 5 - 1e-9 }, { x: 100, y: 5 + 1e-9 }], false],
    ['two near-parallel segments within EPS of each other', [{ x: 0, y: 5 }, { x: 100, y: 5 }], [{ x: 0, y: 5 - 5e-8 }, { x: 100, y: 5 + 5e-8 }], false],
    // Ends 1e-6 px to either side of the other line, past the planar EPS: a real crossing at a shallow angle.
    ['two segments that cross at a shallow angle', [{ x: 0, y: 5 }, { x: 100, y: 5 }], [{ x: 0, y: 5 - 1e-6 }, { x: 100, y: 5 + 1e-6 }], true],
    ['a line through a corner of the other', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], [{ x: 0, y: 5 }, { x: 10, y: 5 }], false],
  ])('%s', (_name, a, b, expected) => {
    expect(polylinesCross(a, b)).toBe(expected);
    expect(polylinesCross(b, a)).toBe(expected);
  });

  it('counts a pair once, however many points the polylines share', () => {
    const zigzag = [{ x: 2, y: -10 }, { x: 2, y: 10 }, { x: 4, y: 10 }, { x: 4, y: -10 }];
    expect(polylinesCross(along, zigzag)).toBe(true);
  });
});
