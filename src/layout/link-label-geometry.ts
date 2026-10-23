import { FONT_FAMILY } from '../text/index.js';

// The link label typography and spacing in a module of its own, so the overlay track separation reads it without importing
// stage 9 (`link-labels.ts` re-exports it).

/** Theme typography and the two spacing rulings stage 9 needs; `pipeline.md` fixes the ladder. */
export const LINK_LABEL_GEOMETRY = {
  fontFamily: FONT_FAMILY,
  fontSize: 9,
  fontWeight: 400 as const,
  /** Visible gap between the label box and the supporting path's stroke edge. */
  normalGap: 4,
  /** The checked-in advance table has no U+2026, so shortening uses measured ASCII dots. */
  ellipsis: '...',
  /** A shortened label must leave this much of its supporting segment free. */
  shortenMargin: 8,
  /**
   * Text follows its supporting segment (ADR-0014): horizontal along a horizontal run, and along a
   * vertical run rotated so it reads bottom-to-top — Visio's "gravity": rotated text is never
   * upside down and never reads top-to-bottom. Orthogonal paths need only these two headings.
   */
  verticalRotation: -90 as const,
  /**
   * Architecture ticket 16: a label on a direct (diagonal) line lies on it, centred, text at the
   * line's angle. The line is cut away under the text with this much clear space round the glyphs,
   * and the placed box reserves that space.
   */
  halo: 2,
  /** Step of the scan along a direct line when the midpoint is taken. */
  alongStep: 2,
  /**
   * A link label stays in one region: along its run it keeps this much clear space beyond the
   * stroke of every drawn group or frame border the run crosses, as it keeps the shorten margin from
   * the run's ends. Placement reserves the room with the same figure (`labelRunWindows`).
   */
  borderMargin: 8,
} as const;
