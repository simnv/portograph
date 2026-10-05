import { measureText } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';

/** Room a bar keeps either side of its text and of its outer ports. */
export const BAR_PADDING = 30;

/**
 * The one width rule of a bar: its text and padding, and its outer ports and padding. The floor of the first is `barLabelFloor`, the least of the second is
 * `barPortsFloor` (the ports at their pitch); 7d widens the second to the ports' span at their desired x (`barReach` in `bars.ts`), and centring reserves that
 * span where it first knows it, so neither phase-two sizing nor 7d finds a neighbour inside the band gap (architecture ticket 19).
 */
export function barLabelFloor(text: string): number {
  return measureText(text, { fontSize: NODE_CONTENT_GEOMETRY.labelFontSize, weight: NODE_CONTENT_GEOMETRY.labelFontWeight }).width + 2 * BAR_PADDING;
}
export const barPortsFloor = (count: number, pitch: number): number => Math.max(0, count - 1) * pitch + 2 * BAR_PADDING;
