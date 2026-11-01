import type { Side } from '../model/geometry.js';
import type { LayoutNode } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Immutable pill extents describe the required separation, never the choice of axis. */
function cornerRequirements(node: LayoutNode) {
  const pills = (side: Side) => node.ports.filter(port => (port.side ?? port.sizingSide) === side && port.ref.anonymous !== true)
    .map(port => measurePortPill(port.ref.name!));
  return (['left', 'right'] as const).flatMap(lateral => (['top', 'bottom'] as const).flatMap(horizontal => {
    const a = pills(lateral), b = pills(horizontal);
    return a.length && b.length ? [{ lateral, horizontal,
      x: Math.max(...a.map(pill => pill.width / 2)) + Math.max(...b.map(pill => pill.height / 2)) + DEFAULT_STROKE_WIDTHS.pill,
      y: Math.max(...a.map(pill => pill.height / 2)) + Math.max(...b.map(pill => pill.width / 2)) + DEFAULT_STROKE_WIDTHS.pill }] : [];
  }));
}

/** Size chooses once on the centred horizontal capacity. Stage 5 replaces provisional choices before topology freezes. */
export function reservePortCorners(node: LayoutNode, width: number): void {
  if (node.portCorners !== undefined) return;
  const corners = cornerRequirements(node).map(corner => {
    const count = node.ports.filter(port => (port.side ?? port.sizingSide) === corner.horizontal).length;
    const margin = (width - (count - 1) * node.sidePitch![corner.horizontal]!) / 2;
    const axis = margin >= corner.x ? 'x' : 'y';
    return { lateral: corner.lateral, horizontal: corner.horizontal, axis, clearance: corner[axis] } as const;
  });
  // No occupied corner needs no record, preserving output for single-axis faces, including stagger rows.
  if (corners.length) node.portCorners = corners;
}

/** Equal lateral end margins retain centred faces. Read the stored y choices, even after width growth. */
export function lateralPillInset(node: LayoutNode, side: Side): number {
  return Math.max(0, ...(node.portCorners ?? []).filter(corner => corner.lateral === side && corner.axis === 'y').map(corner => corner.clearance));
}

/** Every face installer consumes the same stored corner choice. */
export function portEndInsets(node: LayoutNode, side: Side, pitch = node.sidePitch![side]!): { low: number; high: number } {
  const base = NODE_CONTENT_GEOMETRY.padding + pitch / 2;
  const inset = Math.max(base, lateralPillInset(node, side));
  const horizontal = (node.portCorners ?? []).filter(corner => corner.horizontal === side && corner.axis === 'x');
  return {
    low: Math.max(inset, ...horizontal.filter(corner => corner.lateral === 'left').map(corner => corner.clearance)),
    high: Math.max(inset, ...horizontal.filter(corner => corner.lateral === 'right').map(corner => corner.clearance)),
  };
}

/** Measured face capacity, including the stored corner reservations. Empty faces keep the old floor. */
export function portSideCapacity(node: LayoutNode, side: Side, count: number, pitch = node.sidePitch![side]!): number {
  const { low, high } = portEndInsets(node, side, pitch);
  const extra = low + high - (2 * NODE_CONTENT_GEOMETRY.padding + pitch);
  return count * pitch + 2 * NODE_CONTENT_GEOMETRY.padding + extra;
}

/** Publication and restore check the stored axis, not whichever axis happens to separate later geometry. */
export function validatePortCorners(node: LayoutNode): void {
  const required = cornerRequirements(node), corners = node.portCorners ?? [];
  if (corners.length !== required.length || (node.portCorners !== undefined && !corners.length)) throw new Error(`Missing port corner reservation on ${node.id}`);
  for (const [index, corner] of corners.entries()) {
    const need = required[index]!;
    if (corner.lateral !== need.lateral || corner.horizontal !== need.horizontal || !['x', 'y'].includes(corner.axis)
      || corner.clearance !== need[corner.axis]) throw new Error(`Invalid port corner reservation on ${node.id}`);
    const box = node.bounds;
    if (!box) throw new Error(`Missing port corner geometry on ${node.id}`);
    const side = corner.axis === 'x' ? corner.horizontal : corner.lateral;
    for (const port of node.ports.filter(port => port.side === side && port.ref.anonymous !== true)) {
      if (!port.anchor) throw new Error(`Missing port corner anchor on ${node.id}`);
      const distance = corner.axis === 'x'
        ? corner.lateral === 'left' ? port.anchor.x - box.x : box.x + box.width - port.anchor.x
        : corner.horizontal === 'top' ? port.anchor.y - box.y : box.y + box.height - port.anchor.y;
      if (distance < corner.clearance - PLACEMENT_EPS) throw new Error(`Port corner clearance violated on ${node.id}.${side}`);
    }
  }
}
