/**
 * What an optional growth of a group box may not take (architecture 2, ticket 16).
 *
 * After 7e the linked-group grid widens boxes in either axis (`alignGrid`). A move in x is held by `holdsMove`; this module holds what `holdsMove` does not read:
 * the room a box would newly claim (a strip beyond its present edges), judged against the reserved lane windows and span corridors, and the tier gaps whose rows the
 * 7f plan has seated.
 */
import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutModel } from '../model/layout.js';
import { bottom, right } from './regions.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { rebuildBands } from './skeleton-geometry.js';
import { tierGapPlans } from './gap-plan.js';
import { groupExitsHold } from './group-exit-check.js';

export type Growth = { group: LayoutGroup; bounds: Rect }[];


/** The lanes that stand in room the boxes do not own: a transit, side or span run of a link. A course lane, a perimeter lane and a trunk lane derive from the boxes. */
const reservedLane = (lane: Lane): boolean => lane.layer !== 'overlay' && lane.owner.kind === 'link' && lane.kind !== 'gap' && lane.kind !== 'perimeter';

const intersection = (p: Rect, q: Rect): Rect | undefined => {
  const x = Math.max(p.x, q.x), y = Math.max(p.y, q.y), r = Math.min(right(p), right(q)), b = Math.min(bottom(p), bottom(q));
  return r - x > PLACEMENT_EPS && b - y > PLACEMENT_EPS ? { x, y, width: r - x, height: b - y } : undefined;
};
const sameRect = (p: Rect, q: Rect): boolean => Math.abs(p.x - q.x) <= PLACEMENT_EPS && Math.abs(p.y - q.y) <= PLACEMENT_EPS
  && Math.abs(p.width - q.width) <= PLACEMENT_EPS && Math.abs(p.height - q.height) <= PLACEMENT_EPS;

/**
 * Whether no reserved lane window or span corridor meets a proposed box beyond the part it meets now. A lane that already meets the box excuses that part only (a bypass lane
 * inside the box stays inside it); any more of the lane taken is the growth's doing.
 */
export function lanesHoldGrowth(model: LayoutModel, proposed: Growth): boolean {
  return proposed.every(({ group, bounds }) => model.lanes.filter(reservedLane).every(lane => {
    const now = intersection(lane.bounds, bounds);
    if (now === undefined) return true;
    const was = intersection(lane.bounds, group.bounds!);
    return was !== undefined && sameRect(was, now);
  }));
}

/** What each tier gap seats, by the tier below it: the room it still lacks for its rows, and the parts the plan seats. */
function gapStates(model: LayoutModel): Map<number, { ask: number; parts: number }> | undefined {
  try { return new Map(tierGapPlans(model).map(({ gap, plan }) => [gap.below, { ask: plan.growth, parts: plan.parts.length }])); } catch { return undefined; }
}

/**
 * Whether a growth in y leaves every tier gap that seats its rows seating them. A gap that already asks for room (7f has not grown it yet) is not judged on its ask: the
 * growth of 7f counts the box. A gap that fits must still fit, and must keep every part the plan seated (a box that moved the low boundary off a stem tip turns the
 * parts over to the router). A plan that cannot be read refuses the growth. The check reads a copy with the proposed boxes and the bands rebuilt from them; the model is not touched.
 */
export function gapsHoldGrowth(model: LayoutModel, proposed: Growth): boolean {
  if (!proposed.some(({ group, bounds }) => Math.abs(bounds.y - group.bounds!.y) > PLACEMENT_EPS || Math.abs(bounds.height - group.bounds!.height) > PLACEMENT_EPS)) return true;
  if (model.tierBands.length < 2) return true;
  const before = gapStates(model);
  if (before === undefined) return false;
  const trial = JSON.parse(JSON.stringify(model)) as LayoutModel;
  for (const { group, bounds } of proposed) trial.groups[group.id]!.bounds = { ...bounds };
  rebuildBands(trial);
  const after = gapStates(trial);
  return after !== undefined && [...after].every(([below, state]) => {
    const was = before.get(below);
    return was === undefined || ((was.ask > PLACEMENT_EPS || state.ask <= PLACEMENT_EPS) && state.parts >= was.parts);
  });
}

/** Whether no reserved group exit loses its margin to the proposed boxes (architecture ticket 13): the end of an exit stays beyond the margin of each box it leaves. */
export function exitsHoldGrowth(model: LayoutModel, proposed: Growth): boolean {
  return model.groupExits === undefined || model.groupExits.length === 0 || groupExitsHold(model, model.groupExits, proposed);
}

/**
 * The guards a growth meets before the costly gap guard, each on the model and the proposed boxes. `exitsHoldGrowth` (ticket 13) is the exit-margin predicate: `alignGrid` asks every one
 * of them, and a pair one refuses is recorded in `model.gridRefusals`, which the validator honours.
 */
export const GROWTH_GUARDS: readonly ((model: LayoutModel, proposed: Growth) => boolean)[] = [lanesHoldGrowth, exitsHoldGrowth];
export const growthHolds = (model: LayoutModel, proposed: Growth): boolean => GROWTH_GUARDS.every(guard => guard(model, proposed));
