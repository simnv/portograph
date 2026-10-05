import type { Rect } from '../../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../../model/layout.js';
import { xCatalogue } from './catalogue.js';
import { RESIDUAL_TOLERANCE, termValue } from './evaluate.js';

/**
 * The minimum separations a layout breaks, read from the x catalogue (ticket 17): every hard entry of a `separation-*` kind (the band gap between root groups and
 * frames, the frame gap, the cell gap, the cell inside one frame), whatever its classification. A `COLUMN_AXIS*`, `STRAIGHT_LINK*` or `GROUP_GRID*` warning turns a break into
 * a `legacy-exception` for the evaluator's report; it does not excuse a move that adds a break or deepens one, so these readings never look at a class.
 * A gap wider than the minimum is no finding: a straight link outranks the close-up.
 */
export interface Shortfall {
  /** The owners of the entry (`group:top-1`, `frame:a`). */
  owners: string[];
  /** How far under the minimum the gap stands, in px (positive). */
  short: number;
}

/** The catalogue is built once per call. */
export function separationShortfalls(model: LayoutModel): Map<string, Shortfall> {
  const found = new Map<string, Shortfall>();
  for (const constraint of xCatalogue(model)) {
    if (constraint.strength !== 'hard' || !constraint.kind.startsWith('separation') || constraint.support === 'unsupported' || !constraint.a || !constraint.b) continue;
    const a = termValue(model, constraint.a), b = termValue(model, constraint.b);
    if (a === undefined || b === undefined) continue;
    const short = constraint.bound - (b - a);
    if (short > RESIDUAL_TOLERANCE) found.set(constraint.id, { owners: constraint.owners, short });
  }
  return found;
}

/**
 * The entries `now` breaks that `then` did not, or breaks by less. The tolerance is `RESIDUAL_TOLERANCE` (0.01 px): the placement stages move a box by
 * float noise (a replay, a clone through JSON), and the evaluator itself calls a residual under it no violation, so a deeper break must be deeper than the noise.
 */
export function worseSeparations(now: ReadonlyMap<string, Shortfall>, then: ReadonlyMap<string, Shortfall>): string[] {
  return [...now].filter(([id, item]) => item.short > (then.get(id)?.short ?? 0) + RESIDUAL_TOLERANCE).map(([id]) => id);
}

/**
 * The hard separations a proposed set of group boxes would break or deepen, read on the model with the boxes in place; the boxes are put back before this
 * returns. A move that is a stage's own choice (the linked-group grid) asks this before it widens a box, so the gap is kept where the box is first sized
 * and no later pass has to find it short (ticket 19). A frame box is read as published, so only entries of group boxes answer here.
 */
export function separationsBrokenBy(model: LayoutModel, proposed: readonly { group: LayoutGroup; bounds: Rect }[]): string[] {
  const before = separationShortfalls(model);
  const saved = proposed.map(item => item.group.bounds!);
  for (const item of proposed) item.group.bounds = item.bounds;
  try {
    // A frame box is read as published (it is derived from the cells later), so an entry that names a frame would compare a moved cell with a stale box.
    const now = separationShortfalls(model);
    return worseSeparations(new Map([...now].filter(([, item]) => item.owners.every(owner => owner.startsWith('group:')))), before);
  } finally { proposed.forEach((item, index) => { item.group.bounds = saved[index]!; }); }
}
