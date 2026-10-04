/**
 * The tolerance placement compares distances at: one micrometre of drawing space.
 *
 * It is **not** `EPS` of `src/geometry/planar.ts`, which is 1e-7 and answers a different question —
 * whether a published rectangle contains or overlaps another, where the residue to absorb is a few
 * ULP of a coordinate (stress ticket 13). This one absorbs the arithmetic of a *reservation*: a gap
 * measured, spent and measured again, a width grown to a measured label, a deficit inserted at a
 * split. `rows`, `bars`, `bands` and `mutation` each declared it privately under the name `EPS`,
 * which read as a second opinion about the 1e-7 and is one number here instead (stress ticket 19).
 *
 * **Every comparison of this meaning reads the name** (architecture ticket 03): the literal is gone from `src/layout`, `src/route`
 * (the router's `TOLERANCE` is this constant) and `src/pipeline`. Two spellings stay on purpose. `render/drawio.ts` keeps its own
 * `EPS`: a renderer must not import a placement rule, and its value is a coincidence of the unit. `geometry/planar.ts` keeps the
 * 1e-7 above, a different question. A new comparison of "the arithmetic of a reservation" reads this name and not a literal.
 */
export const PLACEMENT_EPS = 1e-6;

/**
 * The sign tolerance of a product of two differences, in px squared: a pair of coordinates is "inverted" when
 * `(a1 - b1) * (a2 - b2) < -SIGN_EPS`, so a tie or a rounding residue is no inversion. Same number as `PLACEMENT_EPS` and not the same
 * unit: it is no distance. Kept apart so a change of one cannot move the other.
 */
export const SIGN_EPS = 1e-6;
