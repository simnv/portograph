import type { LayoutGroup, LayoutModel, NormalisedDocument } from '../../model/index.js';

/**
 * Shared readers: what is a canton. Three questions share the word and stay three named readers.
 * `isCantonFrame` and `isCantonUnit` ask of a frame in the expanded model; `isCantonSource` asks of a group in
 * the authored document, before ranked groups are expanded (the frame does not exist yet).
 */

/** Whether the frame `id` of the expanded model is a canton. */
export function isCantonFrame(model: LayoutModel, id: string): boolean {
  return model.document.frames?.[id]?.kind === 'canton';
}

/** Whether a column unit (a frame, or a one-rank group) is a canton frame. */
export function isCantonUnit(model: LayoutModel, unit: { id: string; frame: boolean }): boolean {
  return unit.frame && isCantonFrame(model, unit.id);
}

/** Whether the authored group `id` is a canton: it names members. Reads the document before expansion. */
export function isCantonSource(source: NormalisedDocument, id: string): boolean {
  return source.groups[id]!.members !== undefined;
}

/**
 * Whether the cell stands in a frame with a canton anywhere on its chain of parents. Mode of the column pull: its inner
 * pass (`pullMembers`) reads only the members of a canton. It differs from `standsInRootCanton` only for a canton that is
 * the child of another frame, which no document built so far has.
 */
export function standsInCanton(model: LayoutModel, group: LayoutGroup): boolean {
  const frames = model.document.frames;
  for (let id = group.frame; id !== undefined && frames?.[id] !== undefined; id = frames[id]!.parent) {
    if (frames[id]!.kind === 'canton') return true;
  }
  return false;
}

/**
 * Whether the root frame of the cell is a canton. Mode of the 7f slide guard (`mayGrow` in `chord-clear.ts`): only there
 * may a frame edge move out. A nested canton under a non-canton root answers `false` here and `true` in `standsInCanton`.
 */
export function standsInRootCanton(model: LayoutModel, group: LayoutGroup): boolean {
  const all = model.document.frames ?? {};
  let at = group.frame;
  while (at !== undefined && all[at]?.parent !== undefined) at = all[at]!.parent;
  return at !== undefined && all[at]?.kind === 'canton';
}
