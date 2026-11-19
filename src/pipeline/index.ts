/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 * The far-end round (`FAR_END_ORDER_RUNS`) keeps a count of its own in each `Env`; a group lift and a width trial each create a further `Env`, so a command can make that many more runs.
 */
import type { LayoutModel, NormalisedDocument } from '../model/index.js';
import type { LayoutOptions } from './options.js';
import { createEnv } from './env.js';
import { checkReadCaches } from '../model/read-cache.js';
import { openRowReadingMemo } from '../layout/label-room-guard.js';
import { firstState } from './initial.js';
import { chooseFlatGapsAgain, drive, refuseCrowdedChords } from './driver.js';
import { publish } from './publish.js';
import { fitPublication, offerFit } from './publication-fit.js';
import { fitWidthBudget } from './width-budget.js';
import { decideLifts } from './lift-round.js';
import { floatComponents } from '../layout/lift.js';
import { resolve } from '../resolve/index.js';
import type { Diagnostic, Owner, StaggerRow } from '../model/layout.js';
import { choiceMessage, defaultMeansOn, FALLBACK_STAGE, fallbackMessage, growthChoiceTest, judgeGrowthChoice, MOVE_BEFORE_GROW_CHOICE, MOVE_BEFORE_GROW_FALLBACK, MOVE_BEFORE_GROW_TRIAL_SKIPPED, moveBeforeGrowMode, trialSkippedMessage } from '../layout/read/move-before-grow.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import { SEAT_SET_DECLINED } from '../layout/seat-set.js';
import { serializeLayoutModel } from '../model/model.js';
import { qualifyingRefusal, type PlacementRefusal } from '../layout/placement-refusal.js';
import { CommandDeadlineError, UNBOUNDED_BUDGET, type Budget } from './budget.js';
import { pathBends } from '../layout/objective.js';

export { MAX_RERUNS, PlacementBudgetExceeded } from './limits.js';
export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';
export type { LayoutOptions, LayoutProgress } from './options.js';

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 *
 * Link order (ticket DR-04): `parse` lists `document.links` in the canonical link order and allocates the ports in it, so a parsed
 * document is order-free. This function does not sort again: it reads `document.links` in the order given, as a link id `link-<n>` and
 * the order ELK reads the edges. A document built in code is order-free only when its links are in the canonical order; build it with
 * `parse`, or list the links as `parse` would. The canonical key reads the authored ends (a `*` ranks before a numbered port), which a
 * normalised document no longer holds, so the order cannot be derived again here.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  // The record of a default-mode run is the command's to write (dense-16x9 ticket 56): a caller's value is removed.
  const given: LayoutOptions = { ...options };
  delete given.moveBeforeGrowRun;
  // The row reading memo lives while the command runs (dense-16x9 ticket 21).
  const close = openRowReadingMemo();
  try {
    if (moveBeforeGrowMode(document) !== 'default' || !defaultMeansOn()) return await command(document, given);
    // The default-on mode (dense-16x9 ticket 56): the run writes the effective mode into its document, so every reader and the restore read it.
    // The caller's notes with a code the growth trigger reads stay apart from the run (ticket 60, review 2, P2), so the trigger reads what the
    // placement of this run wrote; they publish ahead of the run's notes (`withHeld`).
    const held = (given.diagnostics ?? []).filter(heldFromRun), run: LayoutOptions = held.length === 0 ? given
      : { ...given, diagnostics: (given.diagnostics ?? []).filter(note => !heldFromRun(note)) };
    let on: LayoutModel;
    try {
      on = await command(withMoveBeforeGrow(document, true), { ...run, moveBeforeGrowRun: { requested: 'default', effective: 'on' } });
    } catch (error) {
      if (!fallsBack(error, given.budget ?? UNBOUNDED_BUDGET)) throw error;
      // One terminal retry of the whole input with the option off, on what is left of the command budget: a fresh ledger, the ordinary pipeline
      // (the width and lift selection too), and its own validation. It names the first failure (R6); its own failure propagates.
      const failure = { code: error.code, message: error.message };
      const warning: Diagnostic = { stage: FALLBACK_STAGE, severity: 'warning', code: MOVE_BEFORE_GROW_FALLBACK, message: fallbackMessage(failure), owners: [...error.owners] };
      return await command(withMoveBeforeGrow(document, false), { ...given, diagnostics: [...given.diagnostics ?? [], warning], moveBeforeGrowRun: { requested: 'default', effective: 'off', failure } });
    }
    return await growthChoice(document, run, on, held);
  } finally { close(); }
}

/**
 * Whether the option-on run of a default-on sheet left a seat short (dense-16x9 ticket 60, owner ruling 2026-11-19, whole-sheet choice with a narrowed trigger; the trigger is option (b) of slice 1, by the ruling on slice 1): the growth choice
 * runs only then. Read by code, stage and owners, never by message text; no 7c record is added for it. Either arm fires:
 *
 * - a link that a `CENTRE_ALIGNMENT_INFEASIBLE` note of the placement names (its owners) is still bent in the published run, by the scorer's bend
 *   reader (`pathBends`, review 1, P4: a straight path in two segments has no bend; a link the route removed has no bend count and is not bent,
 *   review 2): a step could
 *   not seat it (the cap, the slide or growth bound of its row, or a guard), and the route did not draw it straight either;
 * - the run has a `SEAT_SET_DECLINED` note of the placement (`seat-set.ts`, the one writer). The cap also acts in the placement runs of a round's
 *   trial (the course round): when that trial is declined, the published run names no short seat although the cap cost the sheet its course. A
 *   declined seat set is the note those sheets carry, and the option-off run never writes it.
 *
 * The notes are the run's own (review 2, P2): `layout` keeps the caller's notes with either code apart from the option-on run (`heldFromRun`), so
 * a caller's note neither fires the trial (review 1, P4) nor hides the note the placement writes.
 *
 * Measured on the census as written (647 sheets, ticket 60 slice 1): 259 sheets fire, and all 33 sheets that the option-off run repairs are among
 * them. The first arm alone fires on 143 sheets and misses 5 of the 33.
 */
/** The note of a centring step that left a feed unaligned (`centre.ts`, `placementWarning`: stage `placement`, the link in its owners). */
const CENTRE_ALIGNMENT_INFEASIBLE = 'CENTRE_ALIGNMENT_INFEASIBLE';
/**
 * Whether a caller's note is kept apart from the option-on run of a default-on sheet: a note with a code the trigger reads, at any stage (the
 * writer of `CENTRE_ALIGNMENT_INFEASIBLE` skips a note whose code and message the model has already, so a caller's copy would hide the run's own).
 * An error stays with the run: `resolve` refuses it there, as in every other mode.
 */
const heldFromRun = (note: Diagnostic): boolean => (note.code === CENTRE_ALIGNMENT_INFEASIBLE || note.code === SEAT_SET_DECLINED) && note.severity !== 'error';
export function growthShort(model: LayoutModel): boolean {
  const own = model.diagnostics.filter(note => note.stage === 'placement');
  if (own.some(note => note.code === SEAT_SET_DECLINED)) return true;
  const named = new Set(own.filter(note => note.code === CENTRE_ALIGNMENT_INFEASIBLE)
    .flatMap(note => (note.owners ?? []).flatMap(owner => owner.kind === 'link' ? [owner.id] : [])));
  return model.links.some(link => named.has(link.id) && (pathBends(link) ?? 0) > 0);
}

/**
 * The growth choice of a default-on sheet (dense-16x9 ticket 60, ADR-0027 amendment): move before grow is the first choice and the growth the
 * second. When the option-on run left a seat short (`growthShort`) and the command budget has time left, the whole input runs once more with the
 * option off, on what is left of the same budget, and the run that `judgeGrowthChoice` keeps publishes. A tie keeps the on run. A kept off run
 * carries its record (`moveBeforeGrowRun.choice`, both tallies) and one info note (`MOVE_BEFORE_GROW_CHOICE`), and publishes again through
 * `restoreLayoutModel`, so the record check of every restore (`moveBeforeGrowRunFault`) has judged it once already.
 *
 * The trial decides nothing when the budget has no time left before it starts, once it returns (review 1, P3: an expired trial is not judged)
 * or right before an off run is committed (review 2), or when it throws for any reason. The on run then publishes with one `MOVE_BEFORE_GROW_TRIAL_SKIPPED` note that names the cause (review 1, P5,
 * R6): `info` for a spent budget or a qualifying refusal (`qualifyingRefusal`), `warning` for anything else, such as a worker bug.
 */
async function growthChoice(document: NormalisedDocument, run: LayoutOptions, on: LayoutModel, held: readonly Diagnostic[]): Promise<LayoutModel> {
  if (!growthShort(on)) return withHeld(on, held);
  const budget = run.budget ?? UNBOUNDED_BUDGET;
  const spent = (when: string): LayoutModel => trialSkipped(on, held, 'info', { code: 'deadline', message: `the command budget ${when}` });
  if (!(budget.remainingMs() > 0)) return spent('has no time left for the trial');
  let off: LayoutModel;
  try {
    growthChoiceTest.beforeTrial?.();
    off = await command(withMoveBeforeGrow(document, false), run);
  } catch (error) {
    if (qualifyingRefusal(error)) return trialSkipped(on, held, 'info', { code: error.code, message: error.message }, error.owners);
    const deadline = deadlineIn(error);
    if (deadline !== undefined) return trialSkipped(on, held, 'info', { code: 'deadline', message: deadline.message });
    return trialSkipped(on, held, 'warning', describeThrown(error));
  }
  if (!(budget.remainingMs() > 0)) return spent('ran out during the trial');
  const verdict = judgeGrowthChoice(on, off);
  if (verdict.keep === 'on' || verdict.tallies === undefined) return withHeld(on, held);
  // The time is read once more on the winning path, right before the choice is committed (review 2, P2): the judge scores both runs.
  if (!(budget.remainingMs() > 0)) return spent('ran out while the trial was judged');
  const tallies = verdict.tallies;
  return withHeld(off, held, kept => {
    kept.moveBeforeGrowRun = { requested: 'default', effective: 'off', choice: tallies };
    kept.diagnostics = [...kept.diagnostics, { stage: FALLBACK_STAGE, severity: 'info', code: MOVE_BEFORE_GROW_CHOICE, message: choiceMessage(tallies) }];
  });
}

/**
 * The command deadline a trial threw, also under any chain of wrappers that a catch built from it (`cause`), walked to its end with cycle
 * detection (review 2, P2): a spent budget, no bug. A `cause` that cannot be read ends the walk.
 */
function deadlineIn(error: unknown): CommandDeadlineError | undefined {
  const seen = new Set<unknown>();
  for (let at = error; at !== undefined && at !== null && !seen.has(at);) {
    if (at instanceof CommandDeadlineError) return at;
    seen.add(at);
    try { at = (at as { cause?: unknown }).cause; } catch { return undefined; }
  }
  return undefined;
}

/** The cause of a thrown value as the skipped-trial note names it (review 2, P2, R6): never throws, also for a value with no `toString`. */
function describeThrown(error: unknown): { code: string; message: string } {
  const text = (read: () => unknown, fallback: string): string => { try { const value = read(); return typeof value === 'string' ? value : fallback; } catch { return fallback; } };
  try {
    if (error instanceof Error) return { code: text(() => error.name, 'Error'), message: text(() => error.message, 'an error whose message cannot be read') };
  } catch { /* a value whose prototype cannot be read is described as below */ }
  return { code: 'unknown', message: text(() => String(error), 'a thrown value that cannot be printed') };
}

/**
 * A model of the growth choice as it publishes: the caller's notes that `layout` kept apart from the run come first, where `resolve` puts the
 * caller's notes, and `edit` writes the record and note of a choice. With neither, the model publishes as the run published it; else it
 * publishes again through `restoreLayoutModel`, so the record check of every restore (`moveBeforeGrowRunFault`) has judged it once already.
 */
function withHeld(model: LayoutModel, held: readonly Diagnostic[], edit?: (json: LayoutModel) => void): LayoutModel {
  if (held.length === 0 && edit === undefined) return model;
  const json = JSON.parse(serializeLayoutModel(model)) as LayoutModel;
  edit?.(json);
  json.diagnostics = [...JSON.parse(JSON.stringify(held)) as Diagnostic[], ...json.diagnostics];
  return restoreLayoutModel(JSON.stringify(json));
}

/** The on run of a growth choice whose trial decided nothing, published with the note that names the cause (`MOVE_BEFORE_GROW_TRIAL_SKIPPED`). */
function trialSkipped(on: LayoutModel, held: readonly Diagnostic[], severity: 'info' | 'warning', cause: { code: string; message: string }, owners: readonly Owner[] = []): LayoutModel {
  return withHeld(on, held, kept => {
    kept.diagnostics = [...kept.diagnostics, { stage: FALLBACK_STAGE, severity, code: MOVE_BEFORE_GROW_TRIAL_SKIPPED, message: trialSkippedMessage(cause),
      ...(owners.length ? { owners: [...owners] } : {}) }];
  });
}

/** One whole run of the command: the width and lift selection, then the publication fit (the final flat-gap choice, dense-16x9 ticket 42) once, on the run it publishes (`fitPublication`). */
function command(document: NormalisedDocument, options: LayoutOptions): Promise<LayoutModel> {
  const run = async (): Promise<LayoutModel> => fitPublication(await (document.layout?.maxWidth !== undefined ? fitWidthBudget(document, options, layoutOnce) : layoutOnce(document, options)));
  return options.checkCaches ? checkReadCaches(run, options.checkCaches === 'sampled' ? 'sampled' : 'all') : run();
}

/** The document with `layout.moveBeforeGrow` written as `on`: the effective mode of a default-mode run. */
const withMoveBeforeGrow = (document: NormalisedDocument, on: boolean): NormalisedDocument => ({ ...document, layout: { ...document.layout, moveBeforeGrow: on } });

/**
 * Whether a failure of the option-on run of a default-on sheet falls back to the option-off run (dense-16x9 ticket 56). A `PlacementRefusal`
 * does: any code of the closed set (`REFUSAL_CODES`), the centring invariant included, and the placement count (`PlacementBudgetExceeded`),
 * since the option-off run counts its own placements. Nothing else does: a parse or resolve error fails in both modes, and a bug is no placement
 * reason. A deadline (the command's, ELK's, or the caller's timeout) is no refusal and never falls back; a refusal falls back only while the
 * command budget has time left (`remainingMs() > 0`), and the option-off run spends what is left, so a deadline in it propagates.
 *
 * The rule reads the cause, not the wrapper (reviews 1 and 2, R6; `qualifyingRefusal`): a refusal built in a catch (the tier attempt of the
 * skeleton, a postcondition check that cannot read its draft) carries the caught value, also `undefined`, and qualifies only when that value is
 * itself a qualifying refusal. A worker bug, a reader exception, a deadline, a timeout or a rejection with no reason under it ends the command.
 */
export function fallsBack(error: unknown, budget: Budget): error is PlacementRefusal {
  return qualifyingRefusal(error) && budget.remainingMs() > 0;
}


/** One complete pipeline run; the width-budget trials share the caller's command deadline. */
async function layoutOnce(document: NormalisedDocument, options: LayoutOptions, staggerRows?: StaggerRow[]): Promise<LayoutModel> {
  // D-Q5 (ticket 08): the group lift is decided on the published results of whole command runs (`decideLifts`); each trial run applies its record.
  // A document with no float component in the first slice has nothing to decide: one run, no record (as `groupArrangements` when stage 5 has
  // nothing to choose). A component that holds a flank, a bar or a canton member is no candidate of the rule.
  if (options.fixedLifts === undefined && options.testLiftOff !== true && document.layout?.autoArrange !== false
    && floatComponents(resolve(document)).some(component => component.scope === undefined)) {
    return decideLifts(document, options, opts => layoutOnce(document, opts, staggerRows));
  }
  const env = createEnv(document, options);
  if (staggerRows !== undefined) env.staggerRows = staggerRows;
  const state = await firstState(env);
  await drive(env, state);
  // The state to publish: a held chord the plan names crowded falls back before a gate finding is published (one bounded replay).
  await refuseCrowdedChords(env, state);
  const model = await publish(env, state);
  // The flat gaps chosen once more on the sheet the rounds left (dense-16x9 ticket 42): after the last step that changes the sheet, and only on
  // the run the command publishes (review 1): a lift or width trial is judged on `model`. A choice that ran publishes once more.
  // The fit reads the published sheet of this run (review 2, P2a) and the limits of the wrapper that picked it (P2b).
  return offerFit(model, async limits => await chooseFlatGapsAgain(env, state, model.canvas!, limits) ? publish(env, state) : model);
}
