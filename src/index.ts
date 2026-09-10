/**
 * portograph — YAML in, a laid-out diagram (SVG) out.
 *
 * Headless core (ADR-0004): no DOM, no framework. The pipeline
 * `parse → layout → render` lands here ticket by ticket; the layout JSON is a
 * first-class output that `score` and the tests consume.
 */

export { VERBS, EXIT, isVerb, helpText } from './cli.js';
export type { Verb } from './cli.js';
