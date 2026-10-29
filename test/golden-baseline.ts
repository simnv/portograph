/**
 * The maintainer-approved golden Q (ticket 18 baseline, re-measured by ticket 22 after the 20 px group
 * padding and the 8 px title link-margin, then by ticket 23 after titles moved opposite their links, then by ticket 24 after linked groups took one grid, then by ticket 34 after the node stroke went to 1.5 px and the radii to 4 / 4 / 2, then by ranked-groups ticket 100 after the two provider links took their chord through the title band: 0.8986107135065587 to 0.8983733581069394, then by architecture ticket 07 after the linked grid moved the flank out to keep the band gap: 0.8990646037601677, pending the maintainer's approval). Exact-Q pins across the suite read this one value; the
 * scorer's own `baseline` assertion keeps the ±0.05 tolerance in `test/pipeline/golden-snapshot.test.ts`.
 */
// The owner requested the 9 px font floor. The regenerated golden has Q = 0.9002135964671911.
export const APPROVED_Q = 0.9002135964671911;
