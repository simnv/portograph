import type { LayoutLink, LayoutModel, LayoutPath, PathSegment } from '../model/layout.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { straightChord } from './overlay-paths.js';
import { groupShape } from './grid.js';
import { bandSide, frameSide } from './bands.js';
import { findPort, STRAIGHT_PATH_CLEARANCE, straightCorridorClear } from './row-paths.js';

const OUTWARD = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } } as const;
import { measureText } from '../text/index.js';
import { EPS, intersection, samePoint, segmentDistance, segmentRectDistance } from '../score/geometry.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import type { Rect } from '../model/geometry.js';

/**
 * The **straight** technique of a routed link inside one frame (ticket 34).
 *
 * A routed link whose two ends lie in one frame (the same document group, or a parent and its
 * child) is one straight segment between the two port faces where the chord clears every node body
 * and every pill that is not its own, and keeps the orthogonal route where it does not. The
 * candidate is topology only, known from stage 1; the confirmation reads placed bodies, so it is
 * re-derived by `rebuildRowPaths` after every move (rows, lanes, flanks, centre), and a body that
 * has moved onto the chord takes the link back to the orthogonal route.
 */

/** The document group whose frame holds this layout group: the group itself, or a cell's frame. */
export function frameOfGroup(model: LayoutModel, id: string): string {
  return model.groups[id]?.frame ?? id;
}
function parentFrame(model: LayoutModel, frame: string): string | undefined {
  const parent = model.document.frames?.[frame]?.parent ?? model.document.groups[frame]?.parent;
  return parent === undefined ? undefined : frameOfGroup(model, parent);
}
/** Whether two frames are one frame for this rule: the same, or a parent and its direct child. */
function sameFrame(model: LayoutModel, a: string, b: string): boolean {
  return a === b || parentFrame(model, a) === b || parentFrame(model, b) === a;
}

/** Topology-only test: the frame rule owns this link's path whenever geometry makes it eligible. */
export function frameLinkCandidate(model: LayoutModel, link: LayoutLink): boolean {
  if (link.layer !== 'routed' || !link.attachments || link.bundle !== undefined || link.groupLink !== undefined) return false;
  if (link.technique === 'stub' || effectiveLayer(link) !== 'routed') return false;
  const route = model.document.links[link.sourceIndex]?.route;
  if (route !== undefined && route !== 'straight') return false;
  const { from, to } = link.attachments;
  if (from.node === to.node) return false;
  const a = model.document.nodes[from.node]?.group, b = model.document.nodes[to.node]?.group;
  if (a === undefined || b === undefined) return false;
  // A flank and a bar own their links' paths (flank and bar rules), and a bar is not a frame member.
  if ([a, b].some(id => model.groups[id]?.flank !== undefined || groupShape(model, id) === 'bar')) return false;
  return sameFrame(model, frameOfGroup(model, a), frameOfGroup(model, b));
}

/**
 * A link that took the straight technique and holds its pinned chord. It reserves no lane, no gap
 * run, no stem and no bar membership, and it is no obstacle to the router: like an overlay link it
 * is read by node bodies and pills only.
 */
export function isFrameStraight(model: LayoutModel, link: LayoutLink): boolean {
  return link.technique === 'straight' && link.path?.fixed === true && link.path.segments.length === 1
    && link.path.segments[0]!.straight === true && frameLinkCandidate(model, link);
}

/**
 * The title sides of one link array. A title stands on the edge with fewer routed ports on links that
 * cross its group's boundary (ADR-0011), which the port sides stage 6 froze already decide; stage 7g
 * only places the label on that edge. Cached on the link array like the peer index of `sides-two`:
 * every checked transaction clones the array, and the answer reads it alone.
 */
const sidesCache = new WeakMap<LayoutModel['links'], Map<string, 'top' | 'bottom' | undefined>>();
function titleSides(model: LayoutModel): Map<string, 'top' | 'bottom' | undefined> {
  const cached = sidesCache.get(model.links);
  if (cached) return cached;
  const sides = new Map<string, 'top' | 'bottom' | undefined>();
  for (const id of Object.keys(model.document.frames ?? {})) sides.set(id, frameSide(model, id));
  for (const [id, group] of Object.entries(model.groups)) if (group.frame === undefined) sides.set(id, bandSide(model, group));
  sidesCache.set(model.links, sides);
  return sides;
}

/**
 * The strips the titles stand in: the edge each titled group or frame keeps its label on, as tall as
 * the title's band, grown by the link-free margin. The label's x is chosen in 7g, after this rule pins
 * its chord, so the whole strip is held: a chord that crossed it would meet a title that no later stage
 * could move out of the way in a frame as narrow as its own label, and stage 9 would discover what
 * placement could have reserved. Such a link keeps the orthogonal route, which the title planner already
 * detours.
 */
function titleStrips(model: LayoutModel): Rect[] {
  const strips: Rect[] = [], sides = titleSides(model);
  const add = (label: string | undefined, side: 'top' | 'bottom' | undefined, box: Rect): void => {
    if (!label || side === undefined) return;
    const height = measureText(label, { fontSize: 12, weight: 700 }).height + 8 + 2 * GROUP_LABEL_LINK_CLEARANCE;
    strips.push({ x: box.x, y: side === 'top' ? box.y - GROUP_LABEL_LINK_CLEARANCE : box.y + box.height - height + GROUP_LABEL_LINK_CLEARANCE, width: box.width, height });
  };
  for (const [id, frame] of Object.entries(model.document.frames ?? {})) {
    const cells = frame.cells.map(cell => model.groups[cell]).filter(group => group?.bounds !== undefined)
      .sort((a, b) => a!.tier! - b!.tier!);
    const side = sides.get(id);
    if (cells.length) add(frame.label, side, (side === 'bottom' ? cells.at(-1)! : cells[0]!).bounds!);
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (group.frame === undefined && group.bounds && group.nodes.length) add(model.document.groups[id]?.label, sides.get(id), group.bounds);
  }
  return strips;
}

/** The chord this rule pins for the link, or undefined when a body stands on it or a gate would fail it. */
export function expectedFramePath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!frameLinkCandidate(model, link)) return undefined;
  const chord = straightChord(model, link);
  if (!chord || Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y) < 1e-6) return undefined;
  const segment: PathSegment = { from: chord.from, to: chord.to, owner: { ...link.owner } };
  // A link that crosses a tier it does not end in needs the lane lanes.ts reserves for it, and a lane
  // cannot be given back after 7c has aligned the ends under it. Such a link keeps the lane and the
  // orthogonal route, so that no move after stage 7a can leave a transit without its reservation.
  const tiers = [link.attachments!.from.node, link.attachments!.to.node].map(id => model.groups[model.document.nodes[id]!.group]!.tier!);
  if (model.tierBands.some(band => band.tier > Math.min(...tiers) && band.tier < Math.max(...tiers))) return undefined;
  if (titleStrips(model).some(strip => segmentRectDistance(segment, strip) === 0)) return undefined;
  // The chord must also hold every clearance the gates measure a routed segment against (G2, G6),
  // or a published straight link would fail the gate its rule was meant to satisfy.
  if (!straightCorridorClear(model, link, segment)) return undefined;
  // Two chords are no obstacle to each other for the router, but G6 still measures their clearance:
  // only a strict crossing excuses a pair that stands closer than 10 px (a shared end does not).
  const stroke = linkStrokeWidth(link);
  for (const other of model.links) {
    if (other.id === link.id || !isFrameStraight(model, other)) continue;
    const run = other.path!.segments[0]!;
    const point = intersection(segment, run);
    const strict = point !== undefined && ![segment.from, segment.to, run.from, run.to].some(end => samePoint(end, point));
    if (!strict && segmentDistance(segment, run) - (stroke + linkStrokeWidth(other)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return undefined;
  }
  // The router leaves every other port by a stem of at least 15 px, and G6 keeps that stem 10 px from the
  // chord. Stage 8 cannot make room the chord took, so the chord stays clear of every stem placement has
  // already promised, its own ports' other links included.
  for (const other of model.links) {
    if (other.id === link.id || other.layer !== 'routed' || other.technique === 'stub' || !other.attachments || other.removed === true) continue;
    if (isFrameStraight(model, other)) continue;
    for (const end of [other.attachments.from, other.attachments.to]) {
      const port = findPort(model, end), out = port?.side === undefined ? undefined : OUTWARD[port.side];
      if (!port?.anchor || !out) continue;
      const stem: PathSegment = { from: port.anchor, to: { x: port.anchor.x + 15 * out.x, y: port.anchor.y + 15 * out.y }, owner: { ...other.owner } };
      if (segmentDistance(segment, stem) - (stroke + linkStrokeWidth(other)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return undefined;
    }
  }
  // Declared, at any angle: the segment has no axis to read, so the gates measure it by distance.
  segment.straight = true;
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}
