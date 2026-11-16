import type { StaggerRow } from '../../model/layout.js';

/** The line a staggered member stands on: `'far'` when listed in `plan.far`, else `'near'` (R1: one reader). */
export function lineOf(plan: StaggerRow, id: string): 'near' | 'far' {
  return plan.far.includes(id) ? 'far' : 'near';
}
