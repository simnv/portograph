import { describe, expect, it } from 'vitest';
import { BundleFeasibilityError } from '../../src/layout/bundle-paths.js';
import { CourseRefusal } from '../../src/layout/courses.js';
import { PlacementRefusal, refusedAtBands } from '../../src/layout/placement-refusal.js';
import { SideHintRefusal, TrunkBlocked } from '../../src/layout/side-hints.js';
import { SkeletonError } from '../../src/layout/skeleton.js';
import { SpanRefusal } from '../../src/layout/span-lanes.js';
import { PlacementBudgetExceeded } from '../../src/pipeline/index.js';

/** Architecture 2, ticket 04: an expected refusal is a typed `PlacementRefusal` with a code, never a message prefix. */
describe('PlacementRefusal', () => {
  it('gives every source its code', () => {
    expect(new SideHintRefusal('x').code).toBe('side');
    expect(new CourseRefusal('x').code).toBe('course');
    expect(new SpanRefusal('x').code).toBe('span');
    expect(new TrunkBlocked('k', 'w').code).toBe('trunk');
    expect(new SkeletonError('x').code).toBe('skeleton');
    expect(new BundleFeasibilityError('BUNDLE_X', 'b1', 'why').code).toBe('bundle');
    expect(new PlacementBudgetExceeded(4).code).toBe('budget');
    expect(new PlacementRefusal('centring', 'x').owners).toEqual([]);
  });
  it('keeps the bundle rule apart from the family and names the owner', () => {
    const error = new BundleFeasibilityError('BUNDLE_X', 'b1', 'why');
    expect(error.reason).toBe('BUNDLE_X');
    expect(error.owners).toEqual([{ kind: 'bundle', id: 'b1' }]);
    expect(error.message).toBe('BUNDLE_X: b1: why');
  });
  it('lets stage 7f refuse everything but the centring invariant and the budget', () => {
    expect(refusedAtBands(new SkeletonError('x'))).toBe(true);
    expect(refusedAtBands(new PlacementRefusal('centring', 'x'))).toBe(false);
    expect(refusedAtBands(new PlacementBudgetExceeded(4))).toBe(false);
    expect(refusedAtBands(new Error('x'))).toBe(false);
  });
});
