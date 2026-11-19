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
import type { Diagnostic, StaggerRow } from '../model/layout.js';
import { choiceMessage, defaultMeansOn, FALLBACK_STAGE, fallbackMessage, growthChoiceTest, judgeGrowthChoice, MOVE_BEFORE_GROW_CHOICE, MOVE_BEFORE_GROW_FALLBACK, moveBeforeGrowMode } from '../layout/read/move-before-grow.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import { SEAT_SET_DECLINED } from '../layout/seat-set.js';
import { serializeLayoutModel } from '../model/model.js';
import { qualifyingRefusal, type PlacementRefusal } from '../layout/placement-refusal.js';
import { UNBOUNDED_BUDGET, type Budget } from './budget.js';

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
    let on: LayoutModel;
    try {
      on = await command(withMoveBeforeGrow(document, true), { ...given, moveBeforeGrowRun: { requested: 'default', effective: 'on' } });
    } catch (error) {
      if (!fallsBack(error, given.budget ?? UNBOUNDED_BUDGET)) throw error;
      // One terminal retry of the whole input with the option off, on what is left of the command budget: a fresh ledger, the ordinary pipeline
      // (the width and lift selection too), and its own validation. It names the first failure (R6); its own failure propagates.
      const failure = { code: error.code, message: error.message };
      const warning: Diagnostic = { stage: FALLBACK_STAGE, severity: 'warning', code: MOVE_BEFORE_GROW_FALLBACK, message: fallbackMessage(failure), owners: [...error.owners] };
      return await command(withMoveBeforeGrow(document, false), { ...given, diagnostics: [...given.diagnostics ?? [], warning], moveBeforeGrowRun: { requested: 'default', effective: 'off', failure } });
    }
    return await growthChoice(document, given, on);
  } finally { close(); }
}

/**
 * Whether the option-on run of a default-on sheet left a seat short (dense-16x9 ticket 60, owner ruling 2026-11-19, trigger (b)): the growth choice
 * runs only then. Read by code and owners, never by message text; no 7c record is added for it. Either arm fires:
 *
 * - a link that a `CENTRE_ALIGNMENT_INFEASIBLE` note of the placement names (its owners) is still bent in the published run: a step could not seat
 *   it (the cap, the slide or growth bound of its row, or a guard), and the route did not draw it straight either;
 * - the run has a `SEAT_SET_DECLINED` note. The cap also acts in the placement runs of a round's trial (the course round): when that trial is
 *   declined, the published run names no short seat although the cap cost the sheet its course. A declined seat set is the note those sheets
 *   carry, and the option-off run never writes it.
 *
 * Measured on the census as written (647 sheets, ticket 60 slice 1): 259 sheets fire, and all 33 sheets that the option-off run repairs are among
 * them. The first arm alone fires on 143 sheets and misses 5 of the 33.
 */
/** The note of a centring step that left a feed unaligned (`centre.ts`, `placementWarning`: stage `placement`, the link in its owners). */
const CENTRE_ALIGNMENT_INFEASIBLE = 'CENTRE_ALIGNMENT_INFEASIBLE';
export function growthShort(model: LayoutModel): boolean {
  if (model.diagnostics.some(note => note.code === SEAT_SET_DECLINED)) return true;
  const named = new Set(model.diagnostics.filter(note => note.stage === 'placement' && note.code === CENTRE_ALIGNMENT_INFEASIBLE)
    .flatMap(note => (note.owners ?? []).flatMap(owner => owner.kind === 'link' ? [owner.id] : [])));
  return model.links.some(link => named.has(link.id) && (link.path?.segments.length ?? 0) > 1);
}

/**
 * The growth choice of a default-on sheet (dense-16x9 ticket 60, ADR-0027 amendment): move before grow is the first choice and the growth the
 * second. When the option-on run left a seat short (`growthShort`) and the command budget has time left, the whole input runs once more with the
 * option off, on what is left of the same budget, and the run that `judgeGrowthChoice` keeps publishes. A tie keeps the on run. The trial decides
 * nothing when it fails for any reason (a deadline, a refusal, a bug): the on run publishes as it is. A kept off run carries its record
 * (`moveBeforeGrowRun.choice`, both tallies) and one info note (`MOVE_BEFORE_GROW_CHOICE`), and publishes again through `restoreLayoutModel`, so the
 * record check of every restore (`moveBeforeGrowRunFault`) has judged it once already.
 */
async function growthChoice(document: NormalisedDocument, given: LayoutOptions, on: LayoutModel): Promise<LayoutModel> {
  if (!growthShort(on) || !((given.budget ?? UNBOUNDED_BUDGET).remainingMs() > 0)) return on;
  let off: LayoutModel;
  try {
    growthChoiceTest.beforeTrial?.();
    off = await command(withMoveBeforeGrow(document, false), given);
  } catch { return on; }
  const verdict = judgeGrowthChoice(on, off);
  if (verdict.keep === 'on' || verdict.tallies === undefined) return on;
  const kept = JSON.parse(serializeLayoutModel(off)) as LayoutModel;
  kept.moveBeforeGrowRun = { requested: 'default', effective: 'off', choice: verdict.tallies };
  kept.diagnostics = [...kept.diagnostics, { stage: FALLBACK_STAGE, severity: 'info', code: MOVE_BEFORE_GROW_CHOICE, message: choiceMessage(verdict.tallies) }];
  return restoreLayoutModel(JSON.stringify(kept));
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
