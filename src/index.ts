/**
 * portograph — YAML in, a laid-out diagram (SVG) out.
 *
 * Headless core (ADR-0004): no DOM, no framework. The pipeline
 * `parse → layout → render` lands here ticket by ticket; the layout JSON is a
 * first-class output that `score` and the tests consume.
 */

export { VERBS, EXIT, isVerb, helpText } from './cli.js';
export type { Verb } from './cli.js';
export * from './model/index.js';
export * from './text/index.js';
export * from './geometry/index.js';
export * from './parse/index.js';
export * from './migrate/index.js';
export * from './score/index.js';
export { DEFAULT_STROKE_WIDTHS } from './theme/geometry.js';
export * from './resolve/index.js';
export * from './layout/sides-one.js';
export * from './layout/size.js';
export * from './theme/content.js';
export * from './profiles/network/icons.js';
export { skeleton, SkeletonError } from './layout/skeleton.js';
export type { SkeletonOptions } from './layout/skeleton.js';
export { createWorkerElkAttempt, createBrowserElkFactory, runElkAttempt, elkDeadlineMs, ElkDeadlineError } from './layout/elk-worker.js';
export type { ElkAttempt, CreateElkAttempt, ElkWorker, ElkClock } from './layout/elk-worker.js';
export { sidesTwo } from './layout/sides-two.js';
export { rebuildNodeGeometry } from './layout/node-geometry.js';
export { freezePortTopology, restoreLayoutModel, withLayoutMutation } from './layout/mutation.js';
export type { PlacementRule } from './layout/mutation.js';
export { rows } from './layout/rows.js';
export { rebuildRowPaths, expectedRowPath, straightCorridorClear, facingPair, rowPathCandidate, STRAIGHT_PATH_CLEARANCE } from './layout/row-paths.js';
export type { FacingPair } from './layout/row-paths.js';

export { lanes, allocateLanes, rebuildLaneExtents, laneWidth, validateLanes } from './layout/lanes.js';
export { flanks, alignFlanks, rebuildFlankPaths, flankPair, flankPathCandidate, expectedFlankPath } from './layout/flanks.js';
export { centre, centreDraft, createCentreBudget, selectAnchorTier } from './layout/centre.js';
export type { CentreBudget } from './layout/centre.js';
export { rebuildRegions } from './layout/regions.js';
export { rebuildRegionGeometry } from './layout/region-rebuild.js';
