/**
 * The publication fit of a command (dense-16x9 ticket 42, review 1): a step that fits the published sheet runs once per command, on the run
 * that publishes, never inside a group-lift trial or a width trial. A complete run offers its fit with its published model (`offerFit`); a
 * wrapper that picks one run of several and decorates its model (`decideLifts`, `fitWidthBudget`) carries the fit of the run it picked
 * (`carryFit`); the command applies the fit of the model it would publish, once (`fitPublication`). The trials are judged on their models
 * without the fit, as they were before the final flat-gap choice.
 */
import type { LayoutModel } from '../model/index.js';

/**
 * What a wrapper asks of the fit of the run it picked (review 2, P2b; review 3): `maxWidth`, the widest sheet the fit may publish: the width
 * budget when the picked run met it, else the width of the picked run (the fit declines a candidate past it by name).
 */
export interface FitLimits { maxWidth?: number }
type Fit = (limits: FitLimits) => Promise<LayoutModel>;
const fits = new WeakMap<LayoutModel, Fit>();

/** `model` with its fit: the command runs `fit` when it publishes `model`. */
export function offerFit(model: LayoutModel, fit: Fit): LayoutModel {
  fits.set(model, fit);
  return model;
}

/**
 * `to`, the decorated copy of `from` (`decorate(from)`, or `from` itself), with the fit of `from`, decorated the same way and held to
 * `limits`. A fit that returns `from` itself changed nothing: the result is `to`, already built (review 2, P3b).
 */
export function carryFit(from: LayoutModel, to: LayoutModel, decorate: (model: LayoutModel) => LayoutModel, limits: FitLimits = {}): LayoutModel {
  const fit = fits.get(from);
  if (fit !== undefined) fits.set(to, async outer => { const fitted = await fit({ ...outer, ...limits }); return fitted === from ? to : decorate(fitted); });
  return to;
}

/** The model the command publishes: `model` after its fit, or `model` when it has none. A fit runs once. */
export async function fitPublication(model: LayoutModel): Promise<LayoutModel> {
  const fit = fits.get(model);
  if (fit === undefined) return model;
  fits.delete(model);
  return fit({});
}
