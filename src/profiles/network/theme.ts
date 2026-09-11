/**
 * The network profile's visual theme. Every colour is a measured source fact from the d3-fd demo
 * recorded in `.superpowers/sdd/spec/render-theme-notes.md`; their placement follows the approved
 * target JPEG, which keeps node surfaces neutral and carries the role colour on the icon tile.
 *
 * Nothing here decides geometry. Sizes, positions and stroke widths come from the layout model.
 */

/** Role colours, keyed by node class. */
export interface NodeClassStyle {
  /** Icon tile fill. */
  fill: string;
  /** Icon tile stroke. */
  stroke: string;
  /** Icon glyph and, for a class-filled body, its text. */
  foreground: string;
  /** Set when the class fills the node body and its group instead of staying neutral. */
  body?: { fill: string; stroke: string };
  label: string;
}

/** Declaration order is the legend's stable order for known classes. */
export const NETWORK_NODE_CLASSES: readonly (readonly [string, NodeClassStyle])[] = [
  ['provider', { fill: '#e0e0e0', stroke: '#9e9e9e', foreground: '#333333', label: 'Provider' }],
  ['router', { fill: '#d64545', stroke: '#8b2e2e', foreground: '#ffffff', label: 'Router' }],
  ['tbr', { fill: '#7cb342', stroke: '#558b2f', foreground: '#ffffff', label: 'Transit border router' }],
  // The JPEG fills the whole Route-Reflector group and its nodes gold, so this class owns a body.
  ['rr', { fill: '#d64545', stroke: '#8b2e2e', foreground: '#ffffff', label: 'Route reflector',
    body: { fill: '#f9a825', stroke: '#f57f17' } }],
];

export interface LinkClassStyle {
  stroke: string;
  /** SVG `stroke-dasharray`; absent means solid. */
  dash?: string;
  /** SVG `stroke-linecap`; absent means the default butt cap. */
  cap?: 'round';
  label: string;
}

/** The class key a link without an authored `class:` contributes to the legend. */
export const LEGEND_DEFAULT_CLASS = 'default';

/** Declaration order is the legend's stable order for known link classes. */
export const NETWORK_LINK_CLASSES: readonly (readonly [string, LinkClassStyle])[] = [
  [LEGEND_DEFAULT_CLASS, { stroke: '#424242', label: 'Default link' }],
  ['dotted', { stroke: '#757575', dash: '1 3', cap: 'round', label: 'Dotted link' }],
  ['dashed', { stroke: '#757575', dash: '4 4', label: 'Dashed link' }],
];

/** Colours shared by every class. */
export const NETWORK_THEME = {
  background: '#ffffff',
  node: { fill: '#ffffff', stroke: '#9e9e9e', text: '#333333' },
  group: { fill: 'none', stroke: '#9e9e9e', dash: '5 5', text: '#666666', radius: 10 },
  /** The gold group of a single-class `rr` group keeps a dark label and no dash. */
  groupBodyText: '#5d4037',
  pill: { fill: '#d1c4e9', stroke: '#9575cd', text: '#333333' },
  link: { label: '#666666' },
  overlay: { stroke: '#607d8b', opacity: 0.45, mark: '#607d8b' },
  legend: { text: '#424242' },
  node_radius: 8,
} as const;

export const nodeClassStyle = (value: string | undefined): NodeClassStyle | undefined =>
  NETWORK_NODE_CLASSES.find(([key]) => key === value)?.[1];

export const linkClassStyle = (value: string | undefined): LinkClassStyle =>
  NETWORK_LINK_CLASSES.find(([key]) => key === (value ?? LEGEND_DEFAULT_CLASS))?.[1]
  ?? NETWORK_LINK_CLASSES[0]![1];

/** Display label for a legend entry; an unknown author class falls back to its literal name. */
export function classDisplayLabel(kind: 'symbol' | 'line', key: string): string {
  const known = kind === 'symbol' ? nodeClassStyle(key)?.label : NETWORK_LINK_CLASSES.find(([name]) => name === key)?.[1].label;
  return known ?? key;
}

/** Profile declaration index, or `undefined` for an author class the profile does not know. */
export function classOrder(kind: 'symbol' | 'line', key: string): number | undefined {
  const table = kind === 'symbol' ? NETWORK_NODE_CLASSES : NETWORK_LINK_CLASSES;
  const index = table.findIndex(([name]) => name === key);
  return index < 0 ? undefined : index;
}
