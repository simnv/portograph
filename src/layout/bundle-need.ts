/**
 * The room a facing bundle needs between its two bodies, in one place so the grid packer that reserves it
 * (architecture ticket 23) and the bundle planner that reads it (stage 7e) cannot disagree.
 *
 * A stem leaves each face before a member may turn (`BUNDLE_STEM`), and the members that turn toward one side
 * take distinct rows a pitch apart.
 */
export const BUNDLE_STEM = 15;

/** The depth the turning rows of `turning` members take, a pitch `q` apart (`parallelPaths`). */
export const bundleTurnSpan = (turning: number, q: number): number => Math.max(0, (turning - 1) * q);

/**
 * The channel between the faces of a facing bundle across a tier gap, which stage 7e grows the gap to: `lead` (a merge
 * trunk's rows), the fan depth of both ends, both stems, a row per member (or the crossover of the inverted pairs) and an
 * edge margin each side. The terms are added in the order 7e always added them.
 */
export const facingBundleNeed = (lead: number, members: number, q: number, inversions: number, fan: number, margin: number): number =>
  lead + fan + 2 * BUNDLE_STEM + (inversions ? 4 * q * inversions + 2 * q * (members + 1) : q * (members + 1)) + 2 * margin;

/**
 * What a bundle between two bodies of one group needs. Members whose two ends stand at one coordinate run straight
 * between the faces and need nothing; any other bundle needs the channel a tier gap reserves.
 */
export const bundleChannelNeed = (aligned: boolean, members: number, q: number, inversions: number, fan: number, margin: number): number =>
  aligned ? 0 : facingBundleNeed(0, members, q, inversions, fan, margin);
