/** Shared node content layout for measurement and rendering. All dimensions are CSS px. */
export const NODE_CONTENT_GEOMETRY = {
  // Minimum, port padding, fonts and scaled icon size come from d3-fd mainNode.ts.
  minWidth: 50,
  minHeight: 35,
  padding: 10,
  labelFontSize: 9,
  labelFontWeight: 700,
  descriptionFontSize: 7,
  descriptionFontWeight: 400,
  iconWidth: 12,
  iconHeight: 12,
  // Content uses the same padding, with a chosen 4px gap between nonempty stacked blocks.
  contentGap: 4,
} as const;
