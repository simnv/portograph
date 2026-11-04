/**
 * The maintainer-approved golden Q (ticket 18 baseline, re-measured by ticket 22 after the 20 px group
 * padding and the 8 px title link-margin, then by ticket 23 after titles moved opposite their links, then by ticket 24 after linked groups took one grid, then by ticket 34 after the node stroke went to 1.5 px and the radii to 4 / 4 / 2, then by ranked-groups ticket 100 after the two provider links took their chord through the title band: 0.8986107135065587 to 0.8983733581069394, then by architecture ticket 07 after the linked grid moved the flank out to keep the band gap: 0.8990646037601677, then by snack-theme ticket 157 after the font went from Arial to Verdana (Verdana metrics): 0.9005910496426979, then by the same ticket after sizing reserved the route-reflector title width before the lanes: 0.9006023865125251, pending the maintainer's approval). Exact-Q pins across the suite read this one value; the
 * scorer's own `baseline` assertion keeps the ±0.05 tolerance in `test/pipeline/golden-snapshot.test.ts`.
 */
// Ticket 156 protects existing x separation at wide corners, retaining the 9 px golden geometry.
// Architecture-2 ticket 68 (the end trim) narrows bodies the centring stretched: 0.9016777547259379 to 0.8911101106593655, pending the
// maintainer's approval of the regenerated golden.
export const APPROVED_Q = 0.8911101106593655;
