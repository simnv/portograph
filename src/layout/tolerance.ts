/**
 * The tolerance placement compares distances at: one micrometre of drawing space.
 *
 * It is **not** `EPS` from `src/score/geometry.ts`, which is 1e-7 and answers a different question —
 * whether a published rectangle contains or overlaps another, where the residue to absorb is a few
 * ULP of a coordinate (stress ticket 13). This one absorbs the arithmetic of a *reservation*: a gap
 * measured, spent and measured again, a width grown to a measured label, a deficit inserted at a
 * split. `rows`, `bars`, `bands` and `mutation` each declared it privately under the name `EPS`,
 * which read as a second opinion about the 1e-7 and is one number here instead (stress ticket 19).
 *
 * **This name has not replaced the literal; it has only stopped four files shadowing it.** Measured
 * on this tree: 12 files under `src/` still write `1e-6` out, 106 times between them, and one more —
 * `layout/skeleton-geometry.ts` — names the figure in prose only.
 *
 * | file | literals |
 * | --- | ---: |
 * | `layout/bundle-geometry.ts` | 25 |
 * | `layout/bundle-junctions.ts` | 25 |
 * | `layout/lanes.ts` | 22 |
 * | `route/plan.ts` | 8 |
 * | `layout/mutation.ts` | 7 |
 * | `route/obstacles.ts` | 6 |
 * | `layout/node-geometry.ts` | 4 |
 * | `layout/bundle-channel.ts` | 3 |
 * | `layout/bundle-paths.ts` | 2 |
 * | `layout/flanks.ts` | 2 |
 * | `route/validate.ts` | 1 (`const TOLERANCE`) |
 * | `render/drawio.ts` | 1 (`const EPS`) |
 *
 * Two of those are worth naming. `mutation.ts` imports this constant and still writes the literal at
 * seven of its own gates (lines 181, 322, 338, 344, 367, 370, 371), so "converted" describes the
 * private `EPS` it dropped, not the file. `lanes.ts` imports it for one comparison and writes the
 * literal 22 times, `laneSidesHold` — which decides whether a linked pair may share an x-extent —
 * among them.
 *
 * What the conversion did finish is the *shadowing*: `render/drawio.ts:67` is the last
 * `const EPS = 1e-6` in the tree, and it is a renderer, not a placement rule. The rest are inline
 * literals that read as arithmetic rather than as a second opinion about the 1e-7. Converting them
 * is its own change with its own differential, one file at a time.
 */
export const PLACEMENT_EPS = 1e-6;
