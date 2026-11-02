import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { FONT_FAMILY, measureText, type TextMeasurement } from '../text/index.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { isCantonFrame } from './read/canton.js';
import { frameTitleEdge } from './read/title-edge.js';

/** The group title type and the margins round it. `bands.ts` re-exports it; this leaf module lets `regions.ts` read it without an import cycle. */
export const GROUP_LABEL_GEOMETRY = {
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  fontWeight: 700 as const,
  horizontalInset: 8,
  verticalInset: 4,
  bandExtra: 8,
  /** Shortest outward routing checkpoint stage 8 may use for an ordinary attachment. */
  routerStem: 15,
  /** G6 node clearance; stage 8 expands each node obstacle by this plus the two half strokes. */
  nodeClearance: 10,
  /** Keeps a required entry point strictly outside a stroke-aware obstacle, not on its boundary. */
  entryTolerance: 0.25,
} as const;

/** A group or frame title as stage 7f measures and draws it. */
export function measureTitle(label: string): TextMeasurement {
  return measureText(label, { fontSize: GROUP_LABEL_GEOMETRY.fontSize, weight: GROUP_LABEL_GEOMETRY.fontWeight });
}

/**
 * How far past a forbidden range a title's left edge is placed to be clear of it. `placeGroupTitles` (`bands.ts`) counts a blocker
 * within one tolerance of the title as meeting it, so clearing one costs two: at `high + PLACEMENT_EPS` the range is still a hit
 * (stress ticket 19 measured the difference of one tolerance on the Enterprise NTP sheet).
 */
export const LABEL_CLEARANCE_STEP = 2 * PLACEMENT_EPS;

/**
 * The width a title asks of the box that holds it: the measured title, on each side the larger of the horizontal inset and the title's
 * link-free margin (`GROUP_LABEL_LINK_CLEARANCE`; both are 8 px), and one clearance step beyond it. A lane stands on the box edge and the
 * margin is kept to it, so the side takes whichever of the two is wider and the two constants cannot drift apart; `placeGroupTitles`
 * refuses an x within one tolerance of a forbidden range: the step on each side is the room the refusal takes.
 */
export function titleRoom(label: string): number {
  return measureTitle(label).width + 2 * (Math.max(GROUP_LABEL_GEOMETRY.horizontalInset, GROUP_LABEL_LINK_CLEARANCE) + LABEL_CLEARANCE_STEP);
}

/**
 * The rank cell that holds a frame's label band: the frame's own cell on the sub-tier that is the
 * frame's extreme one on that edge, counting the cells of its child frames. The room is reserved in
 * that cell and nowhere else. `undefined` when a child frame holds the edge.
 */
export function frameHost(model: LayoutModel, frame: string, side: 'top' | 'bottom'): string | undefined {
  const frames = model.document.frames!;
  const tier = (cell: string): number => model.groups[cell]!.tier!;
  const all = Object.entries(frames).filter(([id, item]) => id === frame || item.parent === frame).flatMap(([, item]) => item.cells);
  const extreme = (side === 'top' ? Math.min : Math.max)(...all.map(tier));
  return frames[frame]!.cells.find(cell => tier(cell) === extreme);
}

/**
 * ADR-0011's edge of a frame's title, read on natural sides from stage 5 on: `frameTitleEdge`, or the other edge when no own cell holds the
 * preferred one; `undefined` for a canton (its band is held by the sub-tier) and for a frame with an own cell on neither edge.
 */
export function frameTitleSide(model: LayoutModel, frame: string): 'top' | 'bottom' | undefined {
  if (isCantonFrame(model, frame)) return undefined;
  const side = frameTitleEdge(model, frame), other = side === 'top' ? 'bottom' : 'top';
  return frameHost(model, frame, side) !== undefined ? side : frameHost(model, frame, other) !== undefined ? other : undefined;
}

/**
 * The width floor a title sets on the box that holds it (snack-theme ticket 157; architecture-2 ticket 54): a free group's own title, and
 * the title of a frame on the rank cell that hosts it (`frameHost`, on the edge `frameTitleSide` reads). Group sizing reads it (`contentBox`)
 * from stage 5 on, so 7a reserves its lanes beside a box that already holds the title, and 7f only places it: no stage widens a box for a
 * title. A cell that hosts no title and a group without nodes have no floor (0). A canton's floor is its union's (`contentBox`).
 */
export function ownTitleFloor(model: LayoutModel, group: LayoutGroup): number {
  if (group.nodes.length === 0) return 0;
  if (group.frame === undefined) {
    const label = model.document.groups[group.id]?.label;
    return label ? titleRoom(label) : 0;
  }
  const label = model.document.frames?.[group.frame]?.label, side = frameTitleSide(model, group.frame);
  return label && side !== undefined && frameHost(model, group.frame, side) === group.id ? titleRoom(label) : 0;
}
