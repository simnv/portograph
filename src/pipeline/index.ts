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
import { firstState } from './initial.js';
import { drive } from './driver.js';
import { publish } from './publish.js';
import { fitWidthBudget } from './width-budget.js';
import type { StaggerRow } from '../model/layout.js';

export { MAX_RERUNS, PlacementBudgetExceeded } from './limits.js';
export { CommandDeadlineError, createBudget, UNBOUNDED_BUDGET } from './budget.js';
export type { Budget } from './budget.js';
export type { LayoutOptions, LayoutProgress } from './options.js';

/**
 * Stages 1–9. The returned model is frozen and protected: retain it, because `score`, `render` and
 * the serialised layout JSON must all describe the same geometry.
 */
export async function layout(document: NormalisedDocument, options: LayoutOptions = {}): Promise<LayoutModel> {
  if (document.layout?.maxWidth !== undefined) return fitWidthBudget(document, options, layoutOnce);
  return layoutOnce(document, options);
}

/** One complete pipeline run; the width-budget trials share the caller's command deadline. */
async function layoutOnce(document: NormalisedDocument, options: LayoutOptions, staggerRows?: StaggerRow[]): Promise<LayoutModel> {
  const env = createEnv(document, options);
  if (staggerRows !== undefined) env.staggerRows = staggerRows;
  const state = await firstState(env);
  await drive(env, state);
  return publish(env, state);
}
