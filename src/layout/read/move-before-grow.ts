import type { LayoutModel, RunTally } from '../../model/layout.js';
import type { NormalisedDocument } from '../../model/document.js';
import { isRefusalCode } from '../placement-refusal.js';
import { measuredTally, unifiedCompare, countOfTally } from '../turn-measure.js';
import { added, gateFindings } from '../trial-findings.js';
import { FINAL_STAGES } from '../mutation.js';

/**
 * What the sheet asks of `layout.moveBeforeGrow` (dense-16x9 ticket 56): `strict` when it writes `true` (a failure of the run throws), `off` when
 * it writes `false`, `default` when it writes nothing.
 */
export type MoveBeforeGrowMode = 'strict' | 'off' | 'default';

/**
 * Whether a sheet that does not write `layout.moveBeforeGrow` runs with it on (ADR-0027). False: the option is an opt-in. Ticket 45 flips the
 * default by setting this to `true`; from then on `layout` runs such a sheet with the option on and falls back to the option-off run when that run
 * fails for a placement reason (ticket 56), and chooses the option-off run on the whole sheet when that run completed with a seat short (the growth
 * choice, ticket 60; both in `pipeline/index.ts`).
 */
const DEFAULT_MEANS_ON = false;

/** Test only (dense-16x9 ticket 56): `on` replaces `DEFAULT_MEANS_ON`, so a test reaches the default-on mode through this one reader. */
export const moveBeforeGrowDefaultTest: { on?: boolean } = {};

/** The mode the sheet asks for (`MoveBeforeGrowMode`). */
export function moveBeforeGrowMode(document: Pick<NormalisedDocument, 'layout'>): MoveBeforeGrowMode {
  const written = document.layout?.moveBeforeGrow;
  return written === true ? 'strict' : written === false ? 'off' : 'default';
}

/** Whether a sheet that writes nothing runs with the option on (`DEFAULT_MEANS_ON`, or the test switch). */
export function defaultMeansOn(): boolean {
  return moveBeforeGrowDefaultTest.on ?? DEFAULT_MEANS_ON;
}

/**
 * The one reader of `layout.moveBeforeGrow` (ADR-0027). On: the alignment of 7c moves a node inside the slack of its row before it grows one, and
 * its seat owns the body (`alignmentSeats`, the cap of 5 times). Off: a body grows in place up to `ALIGNMENT_MAX_GROWTH` times its own width, and
 * the centre rule gives back a stranded growth (`givenBack`, ticket 71). `layout` writes the effective mode into the document of each run of the
 * default-on mode, so every model of that command and its restore read the mode the run had (`LayoutModel.moveBeforeGrowRun`).
 */
export function moveBeforeGrow(model: Pick<LayoutModel, 'document'>): boolean {
  const mode = moveBeforeGrowMode(model.document);
  return mode === 'strict' || (mode === 'default' && defaultMeansOn());
}

/** The warning of a command that published the option-off run of a default-on sheet (dense-16x9 ticket 56). */
export const MOVE_BEFORE_GROW_FALLBACK = 'MOVE_BEFORE_GROW_FALLBACK';
/** The stage of that warning: `layout` writes it, the record check reads it. */
export const FALLBACK_STAGE = 'placement';

/** The text of the fallback warning (`MOVE_BEFORE_GROW_FALLBACK`): it names the failure of the option-on run by code and message. */
export function fallbackMessage(failure: { code: string; message: string }): string {
  return `layout.moveBeforeGrow is not written and runs on by default; that run failed (${failure.code}: ${failure.message}), so the sheet is laid out with it off.`;
}

/** The note of a command that published the option-off run of a default-on sheet by the growth choice (dense-16x9 ticket 60). */
export const MOVE_BEFORE_GROW_CHOICE = 'MOVE_BEFORE_GROW_CHOICE';

/** Test only (dense-16x9 ticket 60): `beforeTrial` runs when the growth choice starts its option-off run, after the trigger and the time check. */
export const growthChoiceTest: { beforeTrial?: () => void } = {};

/** The verdict of the growth choice (`judgeGrowthChoice`): the run to publish, and the two tallies when both runs scored. */
export interface GrowthChoice { keep: 'on' | 'off'; tallies?: { on: RunTally; off: RunTally } }

/**
 * The one judge of the growth choice (dense-16x9 ticket 60, owner ruling 2026-11-19, "whole-sheet choice"): the option-off run of a default-on
 * sheet is kept only when it is better on the whole sheet by the unified order (`unifiedCompare`, the comparator of the far-end round and its
 * restore check, R1: fewer bent links over both layers, then fewer turns, then fewer crossings) and it has no error-gate finding that the option-on
 * run does not have (`gateFindings`, the reader of the routed-trial guards). A tie keeps the on run, and so does a run that does not score.
 */
export function judgeGrowthChoice(on: LayoutModel, off: LayoutModel): GrowthChoice {
  const onTally = measuredTally(on), offTally = measuredTally(off);
  if (onTally === undefined || offTally === undefined) return { keep: 'on' };
  const tallies = { on: onTally, off: offTally };
  if (!(unifiedCompare(onTally, offTally) < 0)) return { keep: 'on', tallies };
  const errorsOn = gateFindings(on, 'error'), errorsOff = gateFindings(off, 'error');
  if (errorsOn === undefined || errorsOff === undefined || added(errorsOff.findings, errorsOn.findings).length > 0) return { keep: 'on', tallies };
  return { keep: 'off', tallies };
}

/** The text of the choice note (`MOVE_BEFORE_GROW_CHOICE`): the two tallies, both layers summed, as the far-end notes name them. */
export function choiceMessage(choice: { on: RunTally; off: RunTally }): string {
  const on = countOfTally(choice.on), off = countOfTally(choice.off);
  return `layout.moveBeforeGrow is not written and runs on by default; the option-off run is better on the whole sheet (${off.bent} bent links, ${off.turns} turns, ${off.crossings} crossings, against ${on.bent}, ${on.turns} and ${on.crossings} with it on), so the sheet is laid out with it off.`;
}

const TALLY_KEYS = 'crossings,overlay,routed';
/** Whether `value` has the shape of a run tally (`RunTally`): exactly its fields, each a finite count. */
function isTally(value: unknown): value is RunTally {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).sort().join(',') !== TALLY_KEYS) return false;
  const tally = value as Record<string, unknown>, count = (item: unknown): boolean => Number.isInteger(item) && (item as number) >= 0;
  const layer = (item: unknown): boolean => typeof item === 'object' && item !== null && !Array.isArray(item) && Object.keys(item).sort().join(',') === 'bent,turns'
    && count((item as Record<string, unknown>).bent) && count((item as Record<string, unknown>).turns);
  return layer(tally.routed) && layer(tally.overlay) && count(tally.crossings);
}
const sameTally = (a: RunTally, b: RunTally): boolean => a.routed.bent === b.routed.bent && a.routed.turns === b.routed.turns && a.overlay.bent === b.overlay.bent
  && a.overlay.turns === b.overlay.turns && a.crossings === b.crossings;

/**
 * What is wrong with the record of a default-mode run (`LayoutModel.moveBeforeGrowRun`), or undefined (R5: the publication and the restore refuse
 * a record the command cannot have written). The document holds the effective mode; an `off` run names its failure once, in the warning.
 */
export function moveBeforeGrowRunFault(model: Pick<LayoutModel, 'document' | 'diagnostics' | 'moveBeforeGrowRun'> & Partial<LayoutModel>): string | undefined {
  const run = model.moveBeforeGrowRun;
  const warnings = model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_FALLBACK);
  const choices = model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_CHOICE);
  if (run === undefined) return warnings.length ? 'a fallback warning without a record' : choices.length ? 'a choice note without a record' : undefined;
  if (typeof run !== 'object' || run === null || Array.isArray(run)) return 'the record is not an object';
  const keys = Object.keys(run).sort().join(',');
  if (run.requested !== 'default') return 'the requested mode is not default';
  const written = model.document.layout?.moveBeforeGrow;
  if (run.effective === 'on') {
    if (keys !== 'effective,requested') return 'an on run names a failure or an unknown field';
    if (written !== true) return 'an on run whose document does not hold layout.moveBeforeGrow: true';
    if (warnings.length) return 'an on run with a fallback warning';
    if (choices.length) return 'an on run with a choice note';
    return undefined;
  }
  if (run.effective !== 'off') return 'the effective mode is neither on nor off';
  if (Object.hasOwn(run, 'choice')) return choiceFault(model as LayoutModel, run, keys, written, warnings.length, choices);
  if (choices.length) return 'a fallback with a choice note';
  if (keys !== 'effective,failure,requested') return 'an off run without a failure, or with an unknown field';
  const failure = run.failure;
  if (typeof failure !== 'object' || failure === null || Object.keys(failure).sort().join(',') !== 'code,message'
    || typeof failure.code !== 'string' || typeof failure.message !== 'string') return 'the failure is not a code and a message';
  if (!isRefusalCode(failure.code)) return `the failure code ${failure.code} is no refusal code`;
  if (written !== false) return 'an off run whose document does not hold layout.moveBeforeGrow: false';
  if (warnings.length !== 1 || warnings[0]!.severity !== 'warning' || warnings[0]!.message !== fallbackMessage(failure)) return 'an off run that does not name its failure once';
  if (warnings[0]!.stage !== FALLBACK_STAGE) return `the fallback warning has the stage ${warnings[0]!.stage}, not ${FALLBACK_STAGE}`;
  return undefined;
}

/**
 * The record check of a growth choice (dense-16x9 ticket 60, R5): exactly the shape `layout` writes. The document holds the option off; the kept
 * run is final; the recorded `off` tally is the one the judge's measure (`measuredTally`) reads on the published model now, and it is better than
 * the recorded `on` tally by the judge's comparator (`unifiedCompare`). The `on` tally is evidence only: the run it measured did not publish, so
 * restore cannot measure it again. One choice note names the two tallies; no fallback warning. The record excuses no gate.
 */
function choiceFault(model: LayoutModel, run: NonNullable<LayoutModel['moveBeforeGrowRun']>, keys: string, written: boolean | undefined, fallbacks: number,
  choices: LayoutModel['diagnostics']): string | undefined {
  if (keys !== 'choice,effective,requested') return 'a choice that names a failure or an unknown field';
  const choice = run.choice as unknown;
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice) || Object.keys(choice).sort().join(',') !== 'off,on') return 'the choice is not an on and an off tally';
  const { on, off } = choice as Record<string, unknown>;
  if (!isTally(on) || !isTally(off)) return 'a tally of the choice is not a tally';
  if (written !== false) return 'a choice whose document does not hold layout.moveBeforeGrow: false';
  if (fallbacks) return 'a choice with a fallback warning';
  if (!FINAL_STAGES.includes(model.stage)) return `a choice on a ${model.stage} model, which is no final layout`;
  if (!(unifiedCompare(on, off) < 0)) return 'a choice whose off tally is not better than its on tally by the unified order';
  const measured = measuredTally(model);
  if (measured === undefined || !sameTally(measured, off)) return 'a choice whose off tally is not the tally of the published model';
  if (choices.length !== 1 || choices[0]!.severity !== 'info' || choices[0]!.message !== choiceMessage({ on, off })) return 'a choice that is not named once';
  if (choices[0]!.stage !== FALLBACK_STAGE) return `the choice note has the stage ${choices[0]!.stage}, not ${FALLBACK_STAGE}`;
  return undefined;
}
