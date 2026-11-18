import type { NormalisedDocument } from '../../src/model/document.js';

/**
 * A parsed sheet with `layout.moveBeforeGrow: true` (ADR-0027). The default since 0.3.0 (dense-16x9 ticket 45), so the field changes nothing
 * on a sheet that does not opt out; the tests of the seat keep it to state what they test. The option is set on the parsed document, never
 * matched in the text: a text match took a comment that names the option for the option (dense-16x9 ticket 50c).
 */
export function withMoveBeforeGrow(document: NormalisedDocument): NormalisedDocument {
  return { ...document, layout: { ...document.layout, moveBeforeGrow: true } };
}

/**
 * A parsed sheet with the opt-out `layout.moveBeforeGrow: false` (dense-16x9 ticket 45): the tests of the rule before 0.3.0 (growth in place up
 * to 12 times, the give-back of ticket 71, the stretched-body trim and close-up) read their sheet with it. Set on the parsed document, as above.
 */
export function withoutMoveBeforeGrow(document: NormalisedDocument): NormalisedDocument {
  return { ...document, layout: { ...document.layout, moveBeforeGrow: false } };
}

/**
 * A parsed sheet read as main read it before 0.3.0 (dense-16x9 ticket 45): a sheet that states `layout.moveBeforeGrow` keeps its own value; one
 * that does not reads the opt-out, the old default. The files that test the rule before the flip (the give-back of ticket 71, the stretched-body
 * trim and close-up, growth in place up to 12 times) read every sheet with it, so each of their tests runs as it ran on main.
 */
export function withTheOldDefault(document: NormalisedDocument): NormalisedDocument {
  return { ...document, layout: { ...document.layout, moveBeforeGrow: document.layout?.moveBeforeGrow ?? false } };
}
