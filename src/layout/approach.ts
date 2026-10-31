import type { Point, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { findPort } from './row-paths.js';

/**
 * Approach at a shared port (architecture ticket 15, phase 6). A named port keeps one side and one pill; a link end that a course gives an
 * approach meets the pill on a tangential edge (the top or bottom edge of a pill on a lateral side, the left or right edge of a pill on a top or
 * bottom side) instead of the face. This leaf module states where that meeting point stands, and reads a link end as the port it really meets:
 * the real port when the link has no approach, else the same port seen from the approach, a virtual port whose side is the approach and whose
 * anchor is the point on the pill's edge. Every reader of a link end after the freeze (the tier-gap plan, stage 8, validation, G7) reads it so.
 */

/** Where on the pill edge the stem stands, as a share of the pill's length along the face: the middle of the outer half, clear of the node face. */
const OUTER_HALF = 0.25;

/** The point on the pill of `port` where an approach from `approach` meets it, or undefined for an anonymous port or an approach that is not tangential. */
export function approachPoint(port: LayoutPort, approach: Side): Point | undefined {
  if (port.anchor === undefined || port.side === undefined || port.ref.anonymous === true || port.ref.name === undefined) return undefined;
  const pill = measurePortPill(port.ref.name);
  const lateralSide = port.side === 'left' || port.side === 'right', lateralApproach = approach === 'left' || approach === 'right';
  if (lateralSide === lateralApproach) return undefined;
  const { x, y } = port.anchor;
  if (lateralSide) {
    // The pill runs `pill.width` out of the face and `pill.height` along it.
    const out = (port.side === 'right' ? 1 : -1) * pill.width * OUTER_HALF;
    return { x: x + out, y: approach === 'top' ? y - pill.height / 2 : y + pill.height / 2 };
  }
  // A pill on a top or bottom side is turned: `pill.width` runs out of the face, `pill.height` along it.
  const out = (port.side === 'bottom' ? 1 : -1) * pill.width * OUTER_HALF;
  return { x: approach === 'left' ? x - pill.height / 2 : x + pill.height / 2, y: y + out };
}

/**
 * The extra reach of a virtual port's stem: how far its anchor stands inside the node's own face on the approach side. The stem still ends one side reach
 * (`portStemReach`) beyond that face, as the stem of every top or bottom port does, so its tip stands where the tips of the node's other ports on that face stand.
 */
export const approachReach = new WeakMap<LayoutPort, number>();

/** The port that `end` of `link` really meets: the port itself, or its virtual port on the approach the link carries. */
export function endPort(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): LayoutPort | undefined {
  const port = findPort(model, link.attachments![end]);
  const approach = link.approach?.[end];
  if (port === undefined || approach === undefined) return port;
  const point = approachPoint(port, approach), box = model.nodes[port.ref.node]?.bounds;
  if (point === undefined || box === undefined) return port;
  const virtual: LayoutPort = { ...port, side: approach, anchor: point };
  const inside = approach === 'top' ? point.y - box.y : approach === 'bottom' ? box.y + box.height - point.y
    : approach === 'left' ? point.x - box.x : box.x + box.width - point.x;
  approachReach.set(virtual, Math.max(0, inside));
  return virtual;
}

/** Whether `end` of `link` meets its pill on an approach. */
export const hasApproach = (link: LayoutLink, end: 'from' | 'to'): boolean => link.approach?.[end] !== undefined;
