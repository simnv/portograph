import type { Side } from '../model/geometry.js';
import type { LayoutNode } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

/**
 * End margins of one face's port centres. Lateral pills clear the inward reach of horizontal
 * pills at both corners. Assigning that room to y leaves horizontal feed alignment unchanged. The
 * immutable port names and sides determine the room; placement and every later installer read it.
 */
export function portEndInsets(node: LayoutNode, side: Side, pitch = node.sidePitch![side]!): { low: number; high: number } {
  const base = NODE_CONTENT_GEOMETRY.padding + pitch / 2;
  const inset = Math.max(base, lateralPillInset(node, side));
  return { low: inset, high: inset };
}

/** The new corner reservation alone, independent of pitch and later body growth. */
export function lateralPillInset(node: LayoutNode, side: Side): number {
  if (side === 'top' || side === 'bottom') return 0;
  const named = node.ports.filter(port => (port.side ?? port.sizingSide) === side && port.ref.anonymous !== true);
  if (!named.length) return 0;
  const half = Math.max(...named.map(port => measurePortPill(port.ref.name!).height / 2));
  const reach = (edge: Side): number => Math.max(0, ...node.ports
    .filter(port => (port.side ?? port.sizingSide) === edge && port.ref.anonymous !== true)
    .map(port => measurePortPill(port.ref.name!).width / 2 + half + DEFAULT_STROKE_WIDTHS.pill));
  // Equal margins preserve the centred face contract, including a node with pills on one horizontal face only.
  return Math.max(reach('top'), reach('bottom'));
}

/** Measured face capacity, including the two corner reservations. Empty faces keep the old floor. */
export function portSideCapacity(node: LayoutNode, side: Side, count: number, pitch = node.sidePitch![side]!): number {
  const { low, high } = portEndInsets(node, side, pitch);
  const extra = low + high - (2 * NODE_CONTENT_GEOMETRY.padding + pitch);
  return count * pitch + 2 * NODE_CONTENT_GEOMETRY.padding + extra;
}
