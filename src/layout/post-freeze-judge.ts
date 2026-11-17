import type { LayoutModel } from '../model/layout.js';
import { blockMoveRefusal, blockReservationFaults } from './block-checks.js';
import { placementWarning } from './regions.js';

/** The code of the note that a mover after the freeze of 7f was refused for a block reservation it would break (dense-16x9 ticket 31). */
export const POST_FREEZE_MOVE_REFUSED = 'POST_FREEZE_MOVE_REFUSED';

/**
 * Runs one mover after the freeze of 7f, with the replay it calls, under the one judge of a move after the freeze (`blockMoveRefusal`,
 * dense-16x9 ticket 31, R1). A result that takes a solid-block member or follower off its reservation (its faces, pitch, box clearance, gap
 * or angle) where the reservation held when the mover began is refused whole: the model goes back to the state it had before the mover,
 * the refusal is named (`POST_FREEZE_MOVE_REFUSED`, R6), `restored` runs (it gives back what the mover holds outside the model), and the
 * caller reads `refused`. A fault the model had already is no reason to refuse while the mover leaves it no further from its reservation
 * and gives its member no other fault. Before the freeze, and on a sheet with no solid block, the mover
 * runs unjudged and nothing is copied.
 */
export function judgedMove<T>(model: LayoutModel, pass: string, run: () => T, refused: T, restored?: () => void): T {
  if (model.frozenChords === undefined || !model.blockReservations?.length) return run();
  const before = blockReservationFaults(model), saved = JSON.parse(JSON.stringify(model)) as LayoutModel;
  const value = run();
  const refusal = blockMoveRefusal(before, model);
  if (refusal === undefined) return value;
  for (const key of Object.keys(model)) if (!(key in saved)) delete (model as unknown as Record<string, unknown>)[key];
  Object.assign(model, saved);
  restored?.();
  const message = `The ${pass} of 7f is refused: it would leave the reservation of a solid block (${refusal.fault}); the geometry before it stands.`;
  const link = refusal.key !== '' && model.links.some(item => item.id === refusal.key) ? [refusal.key] : [];
  if (!model.diagnostics.some(item => item.code === POST_FREEZE_MOVE_REFUSED && item.message === message)) placementWarning(model, POST_FREEZE_MOVE_REFUSED, message, link);
  return refused;
}
