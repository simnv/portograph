import type { Rect } from '../model/geometry.js';
import type { GroupExit, LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import { routedStroke } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { deriveFrames } from './frames.js';
import { exitNeeds, reserveGroupExits, standsIn } from './group-exits.js';

type Moved = { group: LayoutGroup; bounds: Rect }[];

const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
const strictInside = (box: Rect, p: { x: number; y: number }): boolean =>
  p.x > box.x + PLACEMENT_EPS && p.x < box.x + box.width - PLACEMENT_EPS && p.y > box.y + PLACEMENT_EPS && p.y < box.y + box.height - PLACEMENT_EPS;
const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - PLACEMENT_EPS && b.x < a.x + a.width - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;
const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) <= PLACEMENT_EPS && Math.abs(a.y - b.y) <= PLACEMENT_EPS;
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

/** A reserved exit that the boxes of the model break, or that names a run its link does not end with. */
export interface ExitViolation { link: string; end: 'from' | 'to'; box?: string; why: 'margin' | 'strip' | 'run' }

/**
 * The absolute reading of `groupExitsHold` (DR-11, D-Q3): every reserved exit judged against every box as it stands, with no move proposed. The
 * end of an exit stands outside the margin it reserved beyond each box it leaves; its strip meets no other box with the edge margin; and its
 * link's shared run at that end ends with the exit run.
 */
export function groupExitViolations(model: LayoutModel, exits: readonly GroupExit[] = model.groupExits ?? []): ExitViolation[] {
  const half = routedStroke(model) / 2, margin = half + GROUP_EDGE_LINK_CLEARANCE, boxes = boxesWith(model, []), out: ExitViolation[] = [];
  for (const exit of exits) {
    const link = model.links.find(item => item.id === exit.link);
    if (!link?.attachments) { out.push({ link: exit.link, end: exit.end, why: 'run' }); continue; }
    const last = link.sharedRuns?.[exit.end]?.at(-1);
    if (last === undefined || !samePoint(last.from, exit.from) || !samePoint(last.to, exit.to)) out.push({ link: exit.link, end: exit.end, why: 'run' });
    const near = link.attachments[exit.end].node, strip: Rect = {
      x: Math.min(exit.from.x, exit.to.x) - half, y: Math.min(exit.from.y, exit.to.y) - half,
      width: Math.abs(exit.to.x - exit.from.x) + 2 * half, height: Math.abs(exit.to.y - exit.from.y) + 2 * half };
    for (const [id, box] of boxes) {
      if (exit.exited.includes(id) ? strictInside(grow(box, exit.clearance), exit.to) : !standsIn(model, id, near) && touches(grow(box, margin), strip)) {
        out.push({ link: exit.link, end: exit.end, box: id, why: exit.exited.includes(id) ? 'margin' : 'strip' });
      }
    }
  }
  return out;
}

/**
 * The required exits that are missing (DR-11, R5): the link ends whose shared run ends inside a box it leaves (`exitNeeds`), with no reserved
 * exit, where the geometry admits one. The proof reads the geometry and the record only, never `GROUP_EXIT_BLOCKED`: it takes every reserved exit
 * run off its shared run, so the model reads as the reservation read it, and derives the exits once more with the record as the held promise.
 * An end the derivation can place is missing; an end it cannot place is blocked, the advisory outcome the reservation names.
 */
export function missingGroupExits(model: LayoutModel): { link: string; end: 'from' | 'to' }[] {
  const records = model.groupExits ?? [], reserved = new Set(records.map(exit => `${exit.link}:${exit.end}`));
  const strip = (link: LayoutLink): LayoutLink => {
    const ends = records.filter(exit => exit.link === link.id);
    if (!ends.length || link.sharedRuns === undefined) return link;
    const runs = { ...link.sharedRuns };
    for (const exit of ends) {
      const list = runs[exit.end], last = list?.at(-1);
      if (list !== undefined && last !== undefined && samePoint(last.from, exit.from) && samePoint(last.to, exit.to)) runs[exit.end] = list.slice(0, -1);
    }
    return { ...link, sharedRuns: runs };
  };
  const view: LayoutModel = { ...model, links: model.links.map(strip) };
  const open = exitNeeds(view).filter(need => !reserved.has(`${need.link.id}:${need.end}`));
  if (!open.length) return [];
  // A copy the derivation may write: its own runs, records and diagnostics.
  // The proof replans nothing it keeps, so the copy reads as before the final freeze.
  const trial = JSON.parse(JSON.stringify({ ...view, diagnostics: [] })) as LayoutModel;
  if (trial.freeze !== undefined) delete trial.freeze.placement;
  reserveGroupExits(trial);
  const placed = new Set((trial.groupExits ?? []).map(exit => `${exit.link}:${exit.end}`));
  return open.filter(need => placed.has(`${need.link.id}:${need.end}`)).map(need => ({ link: need.link.id, end: need.end }));
}
