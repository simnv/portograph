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
