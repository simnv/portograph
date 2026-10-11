/**
 * The room a facing bundle needs between its two bodies, in one place so the grid packer that reserves it
 * (architecture ticket 23) and the bundle planner that reads it (`parallelPaths`, stage 7e) cannot disagree.
 *
 * A stem leaves each face before a member may turn (`BUNDLE_STEM`), and the members that turn toward one side
 * take distinct rows a pitch apart.
 */
export const BUNDLE_STEM = 15;

/** The depth the turning rows of `turning` members take, a pitch `q` apart. */
export const bundleTurnSpan = (turning: number, q: number): number => Math.max(0, (turning - 1) * q);

/** The channel between two faces for `turning` members that must turn: both stems and the rows. Straight members need none. */
export const bundleChannelNeed = (turning: number, q: number): number =>
  turning > 0 ? 2 * BUNDLE_STEM + bundleTurnSpan(turning, q) : 0;
