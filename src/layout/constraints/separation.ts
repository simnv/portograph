import type { LayoutModel } from '../../model/layout.js';
import { framesAfter, type ProposedBox } from '../frames.js';
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
 * and no later pass has to find it short (ticket 19). A frame box is derived from its cells, so both readings derive the frames from the boxes they read
 * (`framesAfter`), and an entry that names a frame is judged too: a cell of a child frame that the grid widens grows its top-level frame into the band
 * gap of the next frame, and a reading that kept the published frame box would accept that widening and let G9 find the gap short (ticket 157).
 * An entry that names a frame in a canton (the canton frame or a frame on a chain below one) is left to the close-up of 7f, which packs the cantons and
 * their members to the spacing again after the grid (`closeCantons`, `holdMemberWalls`); no later step packs any other frame.
 */
export function separationsBrokenBy(model: LayoutModel, proposed: readonly ProposedBox[]): string[] {
  const published = model.frames;
  const saved = proposed.map(item => item.group.bounds!);
  const framed = (frames: typeof published): void => { if (frames !== undefined) model.frames = frames; };
  try {
    framed(framesAfter(model, []));
    const before = separationShortfalls(model);
    // Derived before the boxes move: `framesAfter` reads each proposed box against the one the group has, and moves the bodies by the shift the stage gives them.
    const after = framesAfter(model, proposed);
    for (const item of proposed) item.group.bounds = item.bounds;
    framed(after);
    const judged = new Map([...separationShortfalls(model)].filter(([, item]) => item.owners.every(owner => !owner.startsWith('frame:') || !inCanton(model, owner.slice('frame:'.length)))));
    return worseSeparations(judged, before);
  } finally {
    proposed.forEach((item, index) => { item.group.bounds = saved[index]!; });
    if (published === undefined) delete model.frames; else model.frames = published;
  }
}

/** Whether the frame `id` is a canton or stands on a chain of parents below one. */
function inCanton(model: LayoutModel, id: string): boolean {
  const frames = model.document.frames;
  for (let at: string | undefined = id; at !== undefined && frames?.[at] !== undefined; at = frames[at]!.parent) if (frames[at]!.kind === 'canton') return true;
  return false;
}
