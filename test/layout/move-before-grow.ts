import type { NormalisedDocument } from '../../src/model/document.js';

/**
 * A parsed sheet with `layout.moveBeforeGrow: true` (ADR-0027, an opt-in until ticket 15): the tests of the seat read a sheet of the corpus
 * with the option, so the sheet itself stays a test of the default. The option is set on the parsed document, never matched in the text: a
 * text match took a comment that names the option for the option, and that test ran without it (dense-16x9 ticket 50c).
 */
export function withMoveBeforeGrow(document: NormalisedDocument): NormalisedDocument {
  return { ...document, layout: { ...document.layout, moveBeforeGrow: true } };
}
