import type { Rect } from '../model/geometry.js';
import type { Frame, LayoutModel } from '../model/layout.js';
import { GROUP_PADDING } from './regions.js';
import { union } from './skeleton-geometry.js';

/** A cell grown by the frame margin on its two sides; top and bottom margins are held inside the cell box. */
const sides = (box: Rect): Rect => ({ x: box.x - GROUP_PADDING, y: box.y, width: box.width + 2 * GROUP_PADDING, height: box.height });
const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });

/**
 * Derive `model.frames` from cell geometry, the way `rebuildBands` derives tier bands
 * (docs/design/ranked-groups.md, section 2). One frame per `document.frames` entry, in document order.
 *
 * A cell carries no padding of its own. The frame margin (20 px) stands on the frame's two sides here,
 * and on its top and bottom edge inside the first and the last cell, where tier bands and gap rows
 * see it; the label band of the title lives in one own cell (`labelBands[].host`) and widens that
 * margin. A child frame is the union of its span's cells; the parent's box holds its own cells and
 * the child's box grown by group padding.
 * `tier` is the sub-tier of the frame's top cell.
 *
 * Nothing happens for a document without `frames`. Call it wherever group boxes move; `rebuildBands`
 * does, so every producer that rebuilds bands rebuilds frames with them.
 */
export function rebuildFrames(model: LayoutModel): void {
  const entries = Object.entries(model.document.frames ?? {});
  if (!entries.length) return;
  // Cells are placed a tier at a time in stage 4; frames wait for every cell to have its box.
  if (entries.some(([, item]) => item.cells.some(cell => model.groups[cell]?.bounds === undefined))) return;
  const derived = new Map<string, Frame>();
  const build = (id: string): Frame => {
    const known = derived.get(id);
    if (known) return known;
    const source = model.document.frames![id]!;
    const cells = source.cells;
    const children = entries.filter(([, item]) => item.parent === id).map(([child]) => build(child));
    const boxes = [...cells.map(cell => sides(model.groups[cell]!.bounds!)), ...children.map(child => grow(child.box, GROUP_PADDING))];
    const tiers = [...cells.map(cell => model.groups[cell]!.tier!), ...children.map(child => child.tier)];
    const frame: Frame = { id, label: source.label, ...(source.class !== undefined ? { class: source.class } : {}),
      ...(source.parent !== undefined ? { parent: source.parent } : {}), cells: [...source.cells],
      box: union(boxes), tier: Math.min(...tiers) };
    derived.set(id, frame);
    return frame;
  };
  model.frames = entries.map(([id]) => build(id));
}

/** The frames of a model, empty when no group was replaced by cells. */
export const framesOf = (model: LayoutModel): readonly Frame[] => model.frames ?? [];

/** Every node a frame holds: its own cells' and, for a parent, its child frames' cells'. */
export function frameNodes(model: LayoutModel, frame: string): string[] {
  const frames = model.document.frames ?? {};
  const cells = Object.entries(frames).filter(([id, item]) => id === frame || item.parent === frame).flatMap(([, item]) => item.cells);
  return cells.flatMap(cell => model.groups[cell]?.nodes ?? []);
}
