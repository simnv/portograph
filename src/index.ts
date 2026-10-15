/**
 * portograph — YAML in, a laid-out diagram (SVG or draw.io) out.
 *
 * The public surface: parse, lay out, score, render. Everything else (the stage functions, the
 * router internals, the theme tables, the CLI contract) lives in `portograph/internal`, which
 * carries no stability promise.
 *
 * Keep every value export in the plain form `export { a, b } from './internal.js';`: the build
 * reads this file to write the `dist/index.js` and `dist/index.cjs` entry points.
 */

// Parse and migrate.
export { parse, parseWithDiagnostics, ParseError } from './internal.js';
export type { ParseOptions, ParseResult, SourceDiagnostic, SourceLocation } from './internal.js';
export { migrate, migrateWithDiagnostics } from './internal.js';
export type { MigrationResult } from './internal.js';

// Lay out.
export { layout, createBudget, CommandDeadlineError, ResolveError } from './internal.js';
export type { Budget, LayoutOptions, LayoutProgress } from './internal.js';
export { createBrowserElkFactory, ElkDeadlineError, createBrowserRouteFactory, RouteDeadlineError } from './internal.js';
export type { CreateElkAttempt, CreateRouteAttempt, RouteAssets } from './internal.js';

// The layout JSON.
export { restoreFinalLayout, serializeLayoutModel } from './internal.js';
export type * from './model/index.js';

// Score.
export { score } from './internal.js';
export type { GateId, GateResult, GateViolation, ScoreAdvisory, ScoreAssertion, ScoreCounters, ScoreCounts, ScoreMetrics, ScoreOptions, ScoreReport, ScoreSnapshot } from './internal.js';

// Render.
export { render, drawio } from './internal.js';
export type { RenderOptions, DrawioOptions } from './internal.js';
