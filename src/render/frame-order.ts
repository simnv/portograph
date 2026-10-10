import type { Rect } from '../model/geometry.js';
import type { LayoutModel } from '../model/index.js';
import { orderedGroupIds } from '../model/model.js';

/** One box of the group layer: a plain group, or a frame that stands in its cells' place. */
export interface GroupShape {
  id: string;
  bounds: Rect;
  frame: boolean;
  /** The id of the holding frame, for a frame inside another. */
  parent?: string;
}

/** Overlap on both axes below this is a shared edge or float noise, not a frame lying on another. */
const OVERLAP_MIN = 0.5;

const area = (box: Rect): number => box.width * box.height;
const overlaps = (a: Rect, b: Rect): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > OVERLAP_MIN
  && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > OVERLAP_MIN;

/**
 * The boxes of the group layer, back to front. Both renderers read this one order.
 *
 * Start order: plain groups in document order, then frames by depth (a parent before its child).
 * Two rules then refine it, and nothing else moves:
 * 1. A frame comes after every frame that holds it.
 * 2. Two boxes where neither holds the other and whose boxes share area (more than 0.5 px on both
 *    axes) are ordered so the box with the smaller area lies on the box with the larger area. Equal
 *    areas keep the start order. A flank placed against or over the frame it flanks is such a box.
 * A box that overlaps no other box and has no ancestor keeps its place. Both rules point from a
 * larger (or equal and earlier) box to a smaller (or later) one, so the order is total and acyclic.
 */
export function groupShapes(layout: LayoutModel): GroupShape[] {
  const frames = layout.frames ?? [];
  const depth = (frame: { parent?: string }): number => frame.parent === undefined ? 0
    : 1 + depth(frames.find(item => item.id === frame.parent)!);
  const start: GroupShape[] = [
    ...orderedGroupIds(layout.document).filter(id => layout.groups[id]!.frame === undefined)
      .map(id => ({ id, bounds: layout.groups[id]!.bounds!, frame: false })),
    ...[...frames].sort((a, b) => depth(a) - depth(b))
      .map((frame): GroupShape => ({ id: frame.id, bounds: frame.box, frame: true,
        ...(frame.parent === undefined ? {} : { parent: frame.parent }) })),
  ];
  const parentOf = new Map(start.filter(shape => shape.frame && shape.parent !== undefined).map(shape => [shape.id, shape.parent!]));
  const holds = (ancestor: string, id: string): boolean => {
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) if (at === ancestor) return true;
    return false;
  };
  // after[i] holds the indices that must stand behind box i.
  const behind = start.map(() => new Set<number>());
  start.forEach((a, i) => start.forEach((b, j) => {
    if (i >= j) return;
    if (holds(a.id, b.id)) behind[j]!.add(i);
    else if (holds(b.id, a.id)) behind[i]!.add(j);
    else if (overlaps(a.bounds, b.bounds)) {
      const front = area(b.bounds) < area(a.bounds) ? j : area(a.bounds) < area(b.bounds) ? i : j;
      behind[front]!.add(front === j ? i : j);
    }
  }));
  // Stable topological sort: always take the earliest start index whose boxes behind it are placed.
  const placed = new Set<number>(), out: GroupShape[] = [];
  while (out.length < start.length) {
    const next = start.findIndex((_, i) => !placed.has(i) && [...behind[i]!].every(k => placed.has(k)));
    if (next < 0) throw new Error('Group draw order is cyclic');
    placed.add(next);
    out.push(start[next]!);
  }
  return out;
}
