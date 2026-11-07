import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { EPS, segmentRectDistance } from '../geometry/planar.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { findPort } from './row-paths.js';

/** The ids of the groups, frames and parents above them that hold this node. */
export function chordHolders(model: LayoutModel, node: string): Set<string> {
  const ids = new Set<string>();
  let id: string | undefined = model.document.nodes[node]?.group;
  for (let depth = 0; id !== undefined && depth < 6 && !ids.has(id); depth++) {
    ids.add(id);
    const frame = model.groups[id]?.frame ?? id;
    ids.add(frame);
    id = model.document.frames?.[frame]?.parent ?? model.document.groups[frame]?.parent;
  }
  return ids;
}

/**
 * What a cross-frame chord must clear beyond the bodies (docs/design/routed-chords.md, Section 4). Every box of `groupBoxes` that holds neither end
 * and does not consume the link is a wall with the group edge margin; a box that holds one end only is left through the horizontal edge the port
 * faces, at least the margin from each corner. Reads `model.frames`, which equals the cells after every transaction.
 */
export function chordBoxRefusal(model: LayoutModel, link: LayoutLink, segment: PathSegment, sideSlack = 0): 'edge' | 'frame' | undefined {
  const ends = link.attachments!, stroke = linkStrokeWidth(link);
  const from = chordHolders(model, ends.from.node), to = chordHolders(model, ends.to.node);
  const sides = { from: findPort(model, ends.from)?.side, to: findPort(model, ends.to)?.side };
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  const margin = GROUP_EDGE_LINK_CLEARANCE - EPS;
  for (const { id, bounds } of groupBoxes(model)) {
    const one = from.has(id), two = to.has(id);
    if (one && two) continue;
    if (!one && !two) {
      if (segmentRectDistance(segment, bounds) < GROUP_EDGE_LINK_CLEARANCE + stroke / 2 - EPS && !groupConsumers(model, id).includes(link.id)) return 'frame';
      continue;
    }
    const side = one ? sides.from : sides.to;
    if (side === 'left' || side === 'right') {
      // A lateral port leaves through the side edge it faces, at least the margin (and the slack) from each corner.
      const edge = side === 'right' ? bounds.x + bounds.width : bounds.x;
      const t = Math.abs(dx) < EPS ? Infinity : (edge - segment.from.x) / dx;
      const y = segment.from.y + t * dy, room = margin + sideSlack;
      if (!(t >= -EPS && t <= 1 + EPS) || y < bounds.y + room || y > bounds.y + bounds.height - room) return 'edge';
      continue;
    }
    if (side !== 'top' && side !== 'bottom') return 'edge';
    const edge = side === 'bottom' ? bounds.y + bounds.height : bounds.y;
    const t = Math.abs(dy) < EPS ? Infinity : (edge - segment.from.y) / dy;
    const x = segment.from.x + t * dx;
    if (!(t >= -EPS && t <= 1 + EPS) || x < bounds.x + margin || x > bounds.x + bounds.width - margin) return 'edge';
  }
  return undefined;
}

