import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { FONT_FAMILY, measureText, type TextMeasurement } from '../text/index.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';

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
 * How far past a forbidden range a label's left edge is placed to be clear of it. The filter of
 * `titleX` (`bands.ts`) refuses an x within one tolerance of a range, so clearing one costs two: at `high + PLACEMENT_EPS`
 * the range is still a hit.
 *
 * It is one constant because `planLabels` has two producers of the same x — the candidate list and
 * the `firstFree` walk — and a value produced by one and re-derived by the other then differs by
 * exactly one tolerance, which is the difference `equal` refused on the Enterprise NTP sheet (stress
 * ticket 19). `firstFree` also sets the width a blocked group asks to grow to, so the two stepping
 * one tolerance apart made the producer ask for a box one tolerance narrower than the x it then
 * emitted needs, and the label came to rest that far outside its own inset.
 */
export const LABEL_CLEARANCE_STEP = 2 * PLACEMENT_EPS;

/**
 * The width a title asks of the box that holds it: the measured title, on each side the larger of the horizontal inset and the title's
 * link-free margin (`GROUP_LABEL_LINK_CLEARANCE`; both are 8 px), and one clearance step beyond it. A lane stands on the box edge and the
 * margin is kept to it, so the side takes whichever of the two is wider and the two constants cannot drift apart; `titleX` refuses an x
 * within one tolerance of a forbidden range: the step on each side is the room the refusal takes.
 */
export function titleRoom(label: string): number {
  return measureTitle(label).width + 2 * (Math.max(GROUP_LABEL_GEOMETRY.horizontalInset, GROUP_LABEL_LINK_CLEARANCE) + LABEL_CLEARANCE_STEP);
}

/**
 * The width floor a free group's own title sets on its box (snack-theme ticket 157). Group sizing reads it (`contentBox`) from stage 5 on,
 * so 7a reserves its lanes beside a box that already holds the title, and 7f only places it. A rank cell holds no title of its own (its
 * frame's title is a 7f matter), and a group without nodes has no content box: both have no floor (0).
 */
export function ownTitleFloor(model: LayoutModel, group: LayoutGroup): number {
  if (group.frame !== undefined || group.nodes.length === 0) return 0;
  const label = model.document.groups[group.id]?.label;
  return label ? titleRoom(label) : 0;
}
