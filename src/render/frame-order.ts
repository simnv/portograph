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
 * The boxes of the group layer, back to front. Both renderers read this one order, and it is the order
 * draw.io can express: a frame's cell holds its child frames, so a child stands inside its parent's
 * subtree and the subtree is one block among its siblings. The order is a depth-first walk:
 * a box, then its child frames, with siblings ordered by these rules.
 *
 * Start order of siblings: plain groups in document order, then frames in layout order.
 * Two siblings "lie on" each other when the union boxes of their whole subtrees share more than 0.5 px
 * on both axes. Then:
 * 1. A flank (`of:` X) is drawn after the sibling whose subtree holds X, whatever the areas.
 * 2. Otherwise the sibling whose union box has the smaller area is drawn after the larger one; equal areas
 *    keep the start order.
 * A sibling that overlaps no other sibling keeps its start place. The siblings are placed by a stable
 * topological sort of those pairs. Rule 2 alone is a total order by (area descending, start index), so it
 * cannot cycle; rule 1 can cycle only against it in a pathological sheet, and then the earliest unplaced
 * sibling goes next, so the result is always total.
 */
export function groupShapes(layout: LayoutModel): GroupShape[] {
  const frames = layout.frames ?? [];
  const start: GroupShape[] = [
    ...orderedGroupIds(layout.document).filter(id => layout.groups[id]!.frame === undefined)
      .map(id => ({ id, bounds: layout.groups[id]!.bounds!, frame: false })),
    ...frames.map((frame): GroupShape => ({ id: frame.id, bounds: frame.box, frame: true,
      ...(frame.parent === undefined || !frames.some(item => item.id === frame.parent) ? {} : { parent: frame.parent }) })),
  ];
  const children = (id: string | undefined): GroupShape[] => start.filter(shape => shape.parent === id);
  const subtree = (shape: GroupShape): GroupShape[] => [shape, ...children(shape.id).flatMap(subtree)];
  const union = (shape: GroupShape): Rect => {
    const boxes = subtree(shape).map(item => item.bounds);
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
  };
  /** The id a flank's `of:` names, as a drawn box: the frame that holds the group's cell, or the group. */
  const flankTarget = (shape: GroupShape): string | undefined => {
    if (shape.frame) return undefined;
    const of = layout.document.groups[shape.id]?.of;
    return of === undefined ? undefined : layout.groups[of]?.frame ?? of;
  };
  const sort = (siblings: GroupShape[]): GroupShape[] => {
    const boxes = siblings.map(union), ids = siblings.map(shape => new Set(subtree(shape).map(item => item.id)));
    const behind = siblings.map(() => new Set<number>());
    siblings.forEach((a, i) => siblings.forEach((b, j) => {
      if (i >= j || !overlaps(boxes[i]!, boxes[j]!)) return;
      const flankA = flankTarget(a), flankB = flankTarget(b);
      const aOnB = flankA !== undefined && ids[j]!.has(flankA), bOnA = flankB !== undefined && ids[i]!.has(flankB);
      let front: number;
      if (aOnB !== bOnA) front = aOnB ? i : j;
      else {
        const areaA = area(boxes[i]!), areaB = area(boxes[j]!);
        front = areaB < areaA ? j : areaA < areaB ? i : j;
      }
      behind[front]!.add(front === j ? i : j);
    }));
    const placed = new Set<number>(), out: GroupShape[] = [];
    while (out.length < siblings.length) {
      const free = siblings.findIndex((_, i) => !placed.has(i) && [...behind[i]!].every(k => placed.has(k)));
      const next = free >= 0 ? free : siblings.findIndex((_, i) => !placed.has(i));
      placed.add(next);
      out.push(siblings[next]!);
    }
    return out;
  };
  const walk = (parent: string | undefined): GroupShape[] =>
    sort(children(parent)).flatMap(shape => [shape, ...walk(shape.id)]);
  return walk(undefined);
}
