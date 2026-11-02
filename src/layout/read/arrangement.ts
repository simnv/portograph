import type { LayoutModel } from '../../model/layout.js';

/** The one reader of a recorded column (ticket 52, R1): stage 5 recorded `column` for group `id` in `groupArrangements`. */
export function columnOf(model: LayoutModel, id: string): boolean {
  return model.groupArrangements?.[id]?.chosen === 'column';
}
