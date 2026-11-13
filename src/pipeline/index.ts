/**
 * The pipeline seam: one normalised document in, one final layout model out.
 *
 * This is the composition `pipeline.md` describes and nothing else. It decides no geometry of its
 * own: every stage is the module that owns it, called in order, each one handed the immutable model
 * the previous stage published. What this file does own is the *budget*: one remainder shared by
 * the ELK attempts and the router, so a command cannot spend a fresh stage policy per attempt.
 */
import type { LayoutModel, NormalisedDocument } from '../model/index.js';
import type { LayoutOptions } from './options.js';
import { createEnv } from './env.js';
import { checkReadCaches } from '../model/read-cache.js';
import { firstState } from './initial.js';
import { drive } from './driver.js';
import { publish } from './publish.js';
import { fitWidthBudget } from './width-budget.js';
import { decideLifts } from './lift-round.js';
import { floatComponents } from '../layout/lift.js';
import { resolve } from '../resolve/index.js';
import type { StaggerRow } from '../model/layout.js';

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
  const run = (): Promise<LayoutModel> => document.layout?.maxWidth !== undefined ? fitWidthBudget(document, options, layoutOnce) : layoutOnce(document, options);
  return options.checkCaches ? checkReadCaches(run, options.checkCaches === 'sampled' ? 'sampled' : 'all') : run();
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
  return publish(env, state);
}
