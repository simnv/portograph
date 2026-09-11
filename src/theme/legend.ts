import { FONT_FAMILY } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from './content.js';

/**
 * Generated-legend typography and spacing. Stage 9 measures the legend with these values and
 * records the result; stage 11 draws exactly what was measured.
 */
export const LEGEND_GEOMETRY = {
  fontFamily: FONT_FAMILY,
  fontSize: 9,
  fontWeight: 400 as const,
  /** Reserved vertical space between the drawn diagram and the first legend row. */
  gap: 20,
  /** A symbol swatch is the node icon tile at its measured size. */
  symbolWidth: NODE_CONTENT_GEOMETRY.iconWidth,
  symbolHeight: NODE_CONTENT_GEOMETRY.iconHeight,
  /** A line swatch is a horizontal sample of the class's stroke. */
  lineWidth: 24,
  /** Visible gap between a swatch and its text. */
  swatchGap: 6,
  /** Visible gap between two entries on one row. */
  columnGap: 18,
  /** Visible gap between two legend rows. */
  rowGap: 6,
} as const;
