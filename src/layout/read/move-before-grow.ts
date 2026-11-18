import type { LayoutModel } from '../../model/layout.js';
import type { NormalisedDocument } from '../../model/document.js';

/**
 * What the sheet asks of `layout.moveBeforeGrow` (dense-16x9 ticket 56): `strict` when it writes `true` (a failure of the run throws), `off` when
 * it writes `false`, `default` when it writes nothing.
 */
export type MoveBeforeGrowMode = 'strict' | 'off' | 'default';

/**
 * Whether a sheet that does not write `layout.moveBeforeGrow` runs with it on (ADR-0027). False: the option is an opt-in. Ticket 45 flips the
 * default by setting this to `true`; from then on `layout` runs such a sheet with the option on and falls back to the option-off run when that run
 * fails for a placement reason (ticket 56, `pipeline/index.ts`).
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

/** The text of the fallback warning (`MOVE_BEFORE_GROW_FALLBACK`): it names the failure of the option-on run by code and message. */
export function fallbackMessage(failure: { code: string; message: string }): string {
  return `layout.moveBeforeGrow is not written and runs on by default; that run failed (${failure.code}: ${failure.message}), so the sheet is laid out with it off.`;
}

/**
 * What is wrong with the record of a default-mode run (`LayoutModel.moveBeforeGrowRun`), or undefined (R5: the publication and the restore refuse
 * a record the command cannot have written). The document holds the effective mode; an `off` run names its failure once, in the warning.
 */
export function moveBeforeGrowRunFault(model: Pick<LayoutModel, 'document' | 'diagnostics' | 'moveBeforeGrowRun'>): string | undefined {
  const run = model.moveBeforeGrowRun;
  const warnings = model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_FALLBACK);
  if (run === undefined) return warnings.length ? 'a fallback warning without a record' : undefined;
  if (typeof run !== 'object' || run === null || Array.isArray(run)) return 'the record is not an object';
  const keys = Object.keys(run).sort().join(',');
  if (run.requested !== 'default') return 'the requested mode is not default';
  const written = model.document.layout?.moveBeforeGrow;
  if (run.effective === 'on') {
    if (keys !== 'effective,requested') return 'an on run names a failure or an unknown field';
    if (written !== true) return 'an on run whose document does not hold layout.moveBeforeGrow: true';
    if (warnings.length) return 'an on run with a fallback warning';
    return undefined;
  }
  if (run.effective !== 'off') return 'the effective mode is neither on nor off';
  if (keys !== 'effective,failure,requested') return 'an off run without a failure, or with an unknown field';
  const failure = run.failure;
  if (typeof failure !== 'object' || failure === null || Object.keys(failure).sort().join(',') !== 'code,message'
    || typeof failure.code !== 'string' || typeof failure.message !== 'string') return 'the failure is not a code and a message';
  if (written !== false) return 'an off run whose document does not hold layout.moveBeforeGrow: false';
  if (warnings.length !== 1 || warnings[0]!.severity !== 'warning' || warnings[0]!.message !== fallbackMessage(failure)) return 'an off run that does not name its failure once';
  return undefined;
}
