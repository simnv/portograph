import type { Rect } from '../model/geometry.js';
import type { GroupExit, LayoutGroup, LayoutModel } from '../model/layout.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import { routedStroke } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { deriveFrames } from './frames.js';
import { standsIn } from './group-exits.js';

type Moved = { group: LayoutGroup; bounds: Rect }[];

const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
const strictInside = (box: Rect, p: { x: number; y: number }): boolean =>
  p.x > box.x + PLACEMENT_EPS && p.x < box.x + box.width - PLACEMENT_EPS && p.y > box.y + PLACEMENT_EPS && p.y < box.y + box.height - PLACEMENT_EPS;
const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - PLACEMENT_EPS && b.x < a.x + a.width - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;
const sameBox = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) <= PLACEMENT_EPS && Math.abs(a.y - b.y) <= PLACEMENT_EPS
  && Math.abs(a.width - b.width) <= PLACEMENT_EPS && Math.abs(a.height - b.height) <= PLACEMENT_EPS;

/**
 * Every box that obstructs links, by id, with the proposed bounds in place: the group boxes, and the frame boxes derived from the cells with those bounds. A cell is no box of its own; the frame it belongs to is.
 */
function boxesWith(model: LayoutModel, proposed: Moved): Map<string, Rect> {
  // A copy that shares everything but the proposed groups: the model may be frozen, and is never written.
  const trial: LayoutModel = { ...model, groups: { ...model.groups } };
  for (const item of proposed) trial.groups[item.group.id] = { ...model.groups[item.group.id]!, bounds: item.bounds };
  const boxes = new Map<string, Rect>();
  for (const [id, group] of Object.entries(trial.groups)) if (group.frame === undefined && group.bounds && group.nodes.length) boxes.set(id, group.bounds);
  for (const frame of deriveFrames(trial) ?? []) boxes.set(frame.id, frame.box);
  return boxes;
}

/**
 * Whether the proposed boxes leave every reserved group exit as 7e reserved it (architecture ticket 13). Only the boxes the proposal changes are judged, each against the
 * exits it newly reaches: the end of an exit may not come inside the margin 7e reserved beyond a box the exit leaves, and the strip of an exit may not meet another group's
 * box, with the edge margin. A violation that stands before the proposal is not the proposal's doing, and a link without attachments is no exit to judge.
 */
export function groupExitsHold(model: LayoutModel, exits: readonly GroupExit[], proposed: Moved): boolean {
  const changing = proposed.filter(item => item.group.bounds === undefined || !sameBox(item.group.bounds, item.bounds));
  if (!changing.length) return true;
  const half = routedStroke(model) / 2, margin = half + GROUP_EDGE_LINK_CLEARANCE;
  const before = boxesWith(model, []), after = boxesWith(model, changing);
  const changed = [...after].filter(([id, box]) => { const was = before.get(id); return was === undefined || !sameBox(was, box); }).map(([id]) => id);
  if (!changed.length) return true;
  for (const exit of exits) {
    const link = model.links.find(item => item.id === exit.link);
    if (!link?.attachments) continue;
    const near = link.attachments[exit.end].node, strip: Rect = {
      x: Math.min(exit.from.x, exit.to.x) - half, y: Math.min(exit.from.y, exit.to.y) - half,
      width: Math.abs(exit.to.x - exit.from.x) + 2 * half, height: Math.abs(exit.to.y - exit.from.y) + 2 * half };
    // The margin 7e reserved is `exit.clearance` (`margin` plus `EXIT_SLACK`); the strip keeps the edge margin alone.
    const violates = (id: string, box: Rect): boolean => exit.exited.includes(id)
      ? strictInside(grow(box, exit.clearance), exit.to)
      : !standsIn(model, id, near) && touches(grow(box, margin), strip);
    for (const id of changed) {
      const now = after.get(id)!, was = before.get(id);
      if (violates(id, now) && !(was !== undefined && violates(id, was))) return false;
    }
  }
  return true;
}
