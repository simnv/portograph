/**
 * The tolerance placement compares distances at: one micrometre of drawing space.
 *
 * It is **not** `EPS` from `src/score/geometry.ts`, which is 1e-7 and answers a different question —
 * whether a published rectangle contains or overlaps another, where the residue to absorb is a few
 * ULP of a coordinate (stress ticket 13). This one absorbs the arithmetic of a *reservation*: a gap
 * measured, spent and measured again, a width grown to a measured label, a deficit inserted at a
 * split. `rows`, `bars`, `bands` and `mutation` each declared it privately under the name `EPS`,
 * which read as a second opinion about the 1e-7 and is one number here instead (stress ticket 19).
 */
export const PLACEMENT_EPS = 1e-6;
