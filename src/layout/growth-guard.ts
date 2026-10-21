/**
 * What an optional growth of a group box may not take (architecture 2, ticket 16).
 *
 * After 7e the linked-group grid widens boxes in either axis (`alignGrid`). A move in x is held by `holdsMove`; this module holds what `holdsMove` does not read:
 * the room a box would newly claim (a strip beyond its present edges), judged against the reserved lane windows and span corridors, and the tier gaps whose rows the
 * 7f plan has seated. `reservedGeometryBreaches` states the same reservations on a finished model, from the model alone, so publication and restore validate
 * reserved geometry without the producer's help (equality with the producer is not that proof).
 *
 * Ticket 13 adds the exit-margin predicate: append it to `RESERVED_GEOMETRY_CHECKS`.
 */
import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutModel } from '../model/layout.js';
import { bottom, right } from './regions.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { rebuildBands } from './skeleton-geometry.js';
import { tierGapPlans } from './gap-plan.js';

export type Growth = { group: LayoutGroup; bounds: Rect }[];

const meets = (p: Rect, q: Rect): boolean => p.x < right(q) - PLACEMENT_EPS && q.x < right(p) - PLACEMENT_EPS && p.y < bottom(q) - PLACEMENT_EPS && q.y < bottom(p) - PLACEMENT_EPS;

/** The lanes that stand in room the boxes do not own: a transit, side or span run of a link. A course lane, a perimeter lane and a trunk lane derive from the boxes. */
const reservedLane = (lane: Lane): boolean => lane.layer !== 'overlay' && lane.owner.kind === 'link' && lane.kind !== 'gap' && lane.kind !== 'perimeter';

/** The parts of `to` outside `from`: the room a growth newly claims. */
export function strips(from: Rect, to: Rect): Rect[] {
  const result: Rect[] = [];
  if (to.x < from.x - PLACEMENT_EPS) result.push({ x: to.x, y: to.y, width: from.x - to.x, height: to.height });
  if (right(to) > right(from) + PLACEMENT_EPS) result.push({ x: right(from), y: to.y, width: right(to) - right(from), height: to.height });
  if (to.y < from.y - PLACEMENT_EPS) result.push({ x: to.x, y: to.y, width: to.width, height: from.y - to.y });
  if (bottom(to) > bottom(from) + PLACEMENT_EPS) result.push({ x: to.x, y: bottom(from), width: to.width, height: bottom(to) - bottom(from) });
  return result;
}

/** Whether the room the proposed boxes newly claim holds no reserved lane window or span corridor (a lane that already meets the box is not this growth's doing). */
export function lanesHoldGrowth(model: LayoutModel, proposed: Growth): boolean {
  return proposed.every(({ group, bounds }) => {
    const claimed = strips(group.bounds!, bounds);
    return claimed.length === 0 || model.lanes.filter(reservedLane).every(lane => meets(lane.bounds, group.bounds!) || !claimed.some(strip => meets(strip, lane.bounds)));
  });
}

/** What each tier gap seats, by the tier below it: the room it still lacks for its rows, and the parts the plan seats. */
function gapStates(model: LayoutModel): Map<number, { ask: number; parts: number }> | undefined {
  try { return new Map(tierGapPlans(model).map(({ gap, plan }) => [gap.below, { ask: plan.growth, parts: plan.parts.length }])); } catch { return undefined; }
}

/**
 * Whether a growth in y leaves every tier gap that seats its rows seating them. A gap that already asks for room (7f has not grown it yet) is not judged on its ask: the
 * growth of 7f counts the box. A gap that fits must still fit, and must keep every part the plan seated (a box that moved the low boundary off a stem tip turns the
 * parts over to the router). The check reads a copy with the proposed boxes and the bands rebuilt from them; the model is not touched.
 */
export function gapsHoldGrowth(model: LayoutModel, proposed: Growth): boolean {
  if (!proposed.some(({ group, bounds }) => Math.abs(bounds.y - group.bounds!.y) > PLACEMENT_EPS || Math.abs(bounds.height - group.bounds!.height) > PLACEMENT_EPS)) return true;
  if (model.tierBands.length < 2) return true;
  const before = gapStates(model);
  if (before === undefined) return true;
  const trial = JSON.parse(JSON.stringify(model)) as LayoutModel;
  for (const { group, bounds } of proposed) trial.groups[group.id]!.bounds = { ...bounds };
  rebuildBands(trial);
  const after = gapStates(trial);
  return after === undefined || [...after].every(([below, state]) => {
    const was = before.get(below);
    return was === undefined || ((was.ask > PLACEMENT_EPS || state.ask <= PLACEMENT_EPS) && state.parts >= was.parts);
  });
}

/** Whether the proposed boxes keep the reserved room on both axes: the lane windows and corridors, and the tier gaps that fit. `holdsMove` is asked separately. */
export const holdsGrowth = (model: LayoutModel, proposed: Growth): boolean => lanesHoldGrowth(model, proposed) && gapsHoldGrowth(model, proposed);

/** A finished model's lane windows and span corridors, read without the producer: no group of another sub-tier stands in the box of a reserved lane. */
function laneBreaches(model: LayoutModel): string[] {
  return model.lanes.filter(reservedLane).flatMap(lane => Object.values(model.groups)
    .filter(group => group.bounds !== undefined && group.nodes.length > 0 && group.tier !== lane.tier && meets(group.bounds, lane.bounds))
    .map(group => `${group.id} stands in the reserved run of ${lane.id}`));
}

/** The independent checks of reserved geometry, each on the model alone. Ticket 13 appends the exit-margin predicate. */
export const RESERVED_GEOMETRY_CHECKS: readonly ((model: LayoutModel) => string[])[] = [laneBreaches];

/** The breaches of reserved geometry a model shows after 7e. */
export const reservedGeometryBreaches = (model: LayoutModel): string[] => RESERVED_GEOMETRY_CHECKS.flatMap(check => check(model));
