import type { LayoutModel } from '../model/layout.js';

/**
 * A copy of the model to try a rule on, when the rule writes only some parts of it. Every part is copied the way a full copy copies it (a JSON round
 * trip) except the parts `shared` names: those are the model's own objects, read only. The caller names what its rule never writes (through any
 * function it calls); a rule that writes another part must take a full copy, or it would write into the model it tried the move on.
 */
export function copyWithShared(model: LayoutModel, shared: readonly (keyof LayoutModel)[]): LayoutModel {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model)) {
    if (value === undefined) continue; // a round trip drops it
    copy[key] = (shared as readonly string[]).includes(key) ? value : JSON.parse(JSON.stringify(value));
  }
  return copy as unknown as LayoutModel;
}

/** Every part of the model but the ones named: the shared set of a rule that writes those parts alone. */
export function allBut(model: LayoutModel, written: readonly (keyof LayoutModel)[]): (keyof LayoutModel)[] {
  return (Object.keys(model) as (keyof LayoutModel)[]).filter(key => !written.includes(key));
}
