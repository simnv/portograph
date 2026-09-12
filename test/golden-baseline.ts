/**
 * The maintainer-approved golden Q (ticket 18 baseline, re-measured by ticket 22 after the 20 px group
 * padding and the 8 px title link-margin, then by ticket 23 after titles moved opposite their links, then by ticket 24 after linked groups took one grid). Exact-Q pins across the suite read this one value; the
 * scorer's own `baseline` assertion keeps the ±0.05 tolerance in `test/pipeline/golden-snapshot.test.ts`.
 */
export const APPROVED_Q = 0.8984321241441757;
