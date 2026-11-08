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
  ])('%s: the polyline reader and the path reader agree', (_name, points, expected) => {
    expect(pathBends(link(points))).toBe(expected);
    expect(pointTurns(points)).toBe(expected);
    expect(pieceTurns(pieces(points))).toBe(expected);
    // `simplify` drops a point only where the predicate sees no turn, so the count survives it.
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

  it('counts a pair once, however many points the polylines share', () => {
    const zigzag = [{ x: 2, y: -10 }, { x: 2, y: 10 }, { x: 4, y: 10 }, { x: 4, y: -10 }];
    expect(polylinesCross(along, zigzag)).toBe(true);
  });
});
