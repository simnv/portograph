/** Shared node content layout for measurement and rendering. All dimensions are CSS px. */
export const NODE_CONTENT_GEOMETRY = {
  // Minimum, port padding, fonts and scaled icon size come from d3-fd mainNode.ts.
  minWidth: 50,
  minHeight: 35,
  padding: 10,
  labelFontSize: 9,
  labelFontWeight: 700,
  descriptionFontSize: 9,
  descriptionFontWeight: 400,
  iconWidth: 12,
  iconHeight: 12,
  // Content uses the same padding, with a chosen 4px gap between nonempty stacked blocks.
  contentGap: 4,
} as const;

/**
 * The card content style (ticket 159, Snack scale). Title and subtitle are the node label and the node description. The line
 * heights are not stated here: they are the text module's (Verdana, `ceil(1.215 × size)`: 14 at 11 px, 11 at 9 px).
 */
export const CARD_CONTENT_GEOMETRY = {
  /** The icon tile is a square of this side. */
  tileSize: 24,
  /** Corner radius of the tile; the tile is geometry here because the glyph and the text stand against its edge. */
  tileRadius: 4,
  /** Distance from the tile edge to the glyph, on every side. */
  glyphInset: 3,
  /** Distance from the tile to the text block. */
  tileGap: 8,
  titleFontSize: 11,
  titleFontWeight: 700,
  subtitleFontSize: 9,
  subtitleFontWeight: 400,
  /** Between the title and the subtitle, only when there is a subtitle. */
  subtitleGap: 2,
} as const;
