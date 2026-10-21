import type { Rect } from '../model/geometry.js';
import type { GroupExit, LayoutModel } from '../model/layout.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import { routedStroke } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { EXIT_SLACK, standsIn } from './group-exits.js';

type Moved = { group: { id: string }; bounds: Rect }[];

const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
const strictInside = (box: Rect, p: { x: number; y: number }): boolean =>
  p.x > box.x + PLACEMENT_EPS && p.x < box.x + box.width - PLACEMENT_EPS && p.y > box.y + PLACEMENT_EPS && p.y < box.y + box.height - PLACEMENT_EPS;
const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - PLACEMENT_EPS && b.x < a.x + a.width - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;

/**
 * Whether every reserved group exit survives `proposed` (a move or a growth of group boxes): the end of the exit stays beyond the margin of each box it leaves,
 * as the exit was drawn, and the strip does not meet another group's box, with the margin, in the place the proposal puts it. Architecture ticket 13.
 */
export function groupExitsHold(model: LayoutModel, exits: readonly GroupExit[], proposed: Moved): boolean {
  const half = routedStroke(model) / 2, moved = new Map(proposed.map(item => [item.group.id, item.bounds]));
  const boundsOf = (id: string): Rect | undefined => moved.get(id) ?? model.groups[id]?.bounds ?? model.frames?.find(frame => frame.id === id)?.box;
  const margin = half + GROUP_EDGE_LINK_CLEARANCE;
  const ids = [...new Set([...Object.keys(model.groups), ...(model.frames ?? []).map(frame => frame.id)])];
  for (const exit of exits) {
    const link = model.links.find(item => item.id === exit.link);
    if (!link?.attachments) return false;
    const near = link.attachments[exit.end].node, strip: Rect = {
      x: Math.min(exit.from.x, exit.to.x) - half, y: Math.min(exit.from.y, exit.to.y) - half,
      width: Math.abs(exit.to.x - exit.from.x) + 2 * half, height: Math.abs(exit.to.y - exit.from.y) + 2 * half };
    for (const id of exit.exited) {
      const box = boundsOf(id);
      if (box && strictInside(grow(box, margin - EXIT_SLACK + PLACEMENT_EPS), exit.to)) return false;
    }
    for (const id of ids) {
      if (exit.exited.includes(id) || model.groups[id]?.frame !== undefined || standsIn(model, id, near)) continue;
      const box = boundsOf(id);
      if (box && model.groups[id]?.nodes.length !== 0 && touches(grow(box, margin), strip)) return false;
    }
  }
  return true;
}
