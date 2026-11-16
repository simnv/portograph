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
  let found: 'edge' | 'frame' | undefined;
  scanChordBoxes(model, link, segment, sideSlack, fault => { found = fault.entry; return true; });
  return found;
}

/**
 * One box a chord does not clear (`chordBoxRefusal`): the entry it breaks, what it breaks (`constraint`: the box, the entry, and for an edge
 * whether the chord misses the edge's span, misses the edge, or leaves by a face that has no edge) and how far it is short, in px; 0 for a
 * face with no edge.
 */
export interface ChordBoxFault { readonly entry: 'edge' | 'frame'; readonly constraint: string; readonly short: number }

/** Every box the chord does not clear, in the order of `groupBoxes`. */
export function chordBoxFaults(model: LayoutModel, link: LayoutLink, segment: PathSegment, sideSlack = 0): ChordBoxFault[] {
  const faults: ChordBoxFault[] = [];
  scanChordBoxes(model, link, segment, sideSlack, fault => { faults.push(fault); return false; });
  return faults;
}

/** The one reading of `chordBoxRefusal` and `chordBoxFaults`: `visit` gets each box the chord does not clear, and stops the scan by returning true. */
function scanChordBoxes(model: LayoutModel, link: LayoutLink, segment: PathSegment, sideSlack: number, visit: (fault: ChordBoxFault) => boolean): void {
  const ends = link.attachments!, stroke = linkStrokeWidth(link);
  const from = chordHolders(model, ends.from.node), to = chordHolders(model, ends.to.node);
  const sides = { from: findPort(model, ends.from)?.side, to: findPort(model, ends.to)?.side };
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  const margin = GROUP_EDGE_LINK_CLEARANCE - EPS;
  /** The fault of an edge the chord must cross at `along` within [low, high] of the edge's span, where `t` is where on the chord it meets the edge line. */
  const crossing = (id: string, t: number, along: number, low: number, high: number, miss: number): ChordBoxFault | undefined => {
    if (!(t >= -EPS && t <= 1 + EPS)) return { entry: 'edge', constraint: `${id}:edge:reach`, short: miss };
    if (along < low || along > high) return { entry: 'edge', constraint: `${id}:edge:span`, short: Math.max(low - along, along - high) };
    return undefined;
  };
  for (const { id, bounds } of groupBoxes(model)) {
    const one = from.has(id), two = to.has(id);
    if (one && two) continue;
    if (!one && !two) {
      const short = GROUP_EDGE_LINK_CLEARANCE + stroke / 2 - segmentRectDistance(segment, bounds);
      if (short > EPS && !groupConsumers(model, id).includes(link.id) && visit({ entry: 'frame', constraint: `${id}:frame`, short })) return;
      continue;
    }
    const side = one ? sides.from : sides.to;
    let fault: ChordBoxFault | undefined;
    if (side === 'left' || side === 'right') {
      // A lateral port leaves through the side edge it faces, at least the margin (and the slack) from each corner.
      const edge = side === 'right' ? bounds.x + bounds.width : bounds.x;
      const t = Math.abs(dx) < EPS ? Infinity : (edge - segment.from.x) / dx;
      const room = margin + sideSlack, miss = Math.min(Math.abs(edge - segment.from.x), Math.abs(edge - segment.to.x));
      fault = crossing(id, t, segment.from.y + t * dy, bounds.y + room, bounds.y + bounds.height - room, miss);
    } else if (side !== 'top' && side !== 'bottom') fault = { entry: 'edge', constraint: `${id}:edge:face`, short: 0 };
    else {
      const edge = side === 'bottom' ? bounds.y + bounds.height : bounds.y;
      const t = Math.abs(dy) < EPS ? Infinity : (edge - segment.from.y) / dy;
      const miss = Math.min(Math.abs(edge - segment.from.y), Math.abs(edge - segment.to.y));
      fault = crossing(id, t, segment.from.x + t * dx, bounds.x + margin, bounds.x + bounds.width - margin, miss);
    }
    if (fault !== undefined && visit(fault)) return;
  }
}

