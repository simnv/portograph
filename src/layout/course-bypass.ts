import type { PortRef } from '../model/document.js';
import type { Point, Rect } from '../model/geometry.js';
import type { Course, Lane, LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { bypassDepth, bypassRowIndex, RING_PITCH } from './course-rows.js';
import { findPort } from './row-paths.js';
import { nodeTier } from './read/tier.js';
import { portId } from './skeleton-graph.js';

/**
 * The row bypass (architecture ticket 24, phase 5; docs/design/turn-order.md, Section 6). A routed link between two nodes of one row group, with a node of the row
 * between them, has no straight run. Its route leaves the row by the gap beside each end and runs along one padding row on the top or bottom edge of the group:
 * the end leaves its lateral face by a side run into the gap of its neighbour toward the other end, turns along the gap to the padding row, runs along the row to
 * the other gap, and comes down it into the other face. Four turns. Placement reserves the two stems (the gap lanes `gap-lane:<link>:0` for the `from` end and
 * `:1` for the `to` end), the padding row (the group grows to hold it) and, with them, the whole route as fixed segments, so that the router finds nothing.
 *
 * This module is the one reader of that geometry: 7a, every replay, `validateLanes`, the planned turn and the course round's promise all read it. The stems stand
 * at the centre of their gaps and are derived from the node boxes at each replay, so a move of the group takes them along.
 */

export const isBypassCourse = (course: Course): boolean => course.kind === 'bypass';
export const bypassLaneId = (link: string, index: 0 | 1): string => `gap-lane:${link}:${index}`;
/** The bypass course of a link, if it has one. */
export const bypassOf = (model: LayoutModel, link: string): Course | undefined => model.courses?.find(course => course.link === link && isBypassCourse(course));

export interface BypassEnd {
  which: 'from' | 'to';
  ref: PortRef;
  port: LayoutPort & { anchor: Point };
  /** The x of the stem: the centre of the gap between the end and its neighbour toward the other end. */
  stem: number;
  /** The neighbour node, and the width of the gap. */
  neighbour: string;
  gap: number;
}

export interface BypassGeometry {
  group: string;
  tier: number;
  edge: 'top' | 'bottom';
  /** The ends in path order, `from` first. */
  ends: [BypassEnd, BypassEnd];
  /** The y of the padding row. */
  rowY: number;
  /** The reserved route in path order, each segment named by the lane whose box it touches. */
  segments: PathSegment[];
  /** The polyline the route makes: what the course promises (four turns). */
  polyline: Point[];
}

const rightOf = (box: Rect): number => box.x + box.width;
const bottomOf = (box: Rect): number => box.y + box.height;
const gapBetween = (a: Rect, b: Rect): { centre: number; width: number } => (a.x < b.x
  ? { centre: (rightOf(a) + b.x) / 2, width: b.x - rightOf(a) } : { centre: (rightOf(b) + a.x) / 2, width: a.x - rightOf(b) });

/** The geometry of the bypass of `link` on the model as it stands, or `undefined` when a port, a node or the row order does not allow it. */
export function bypassGeometry(model: LayoutModel, link: LayoutLink, course: Course): BypassGeometry | undefined {
  const attachments = link.attachments, edge = course.edge;
  if (attachments === undefined || edge === undefined) return undefined;
  const document = model.document.nodes, from = document[attachments.from.node], to = document[attachments.to.node];
  if (from === undefined || to === undefined || from.group !== to.group) return undefined;
  const group = model.groups[from.group];
  if (group === undefined || group.tier === undefined) return undefined;
  const order = group.rowOrder ?? group.nodes, at = order.indexOf(attachments.from.node), other = order.indexOf(attachments.to.node);
  if (at < 0 || other < 0 || Math.abs(at - other) < 2) return undefined;
  const direction = Math.sign(other - at);
  const ends: BypassEnd[] = [];
  for (const [which, index, toward] of [['from', at, direction], ['to', other, -direction]] as const) {
    const ref = attachments[which], port = findPort(model, ref), box = model.nodes[ref.node]?.bounds;
    const neighbour = order[index + toward], neighbourBox = neighbour === undefined ? undefined : model.nodes[neighbour]?.bounds;
    if (port?.anchor === undefined || box === undefined || neighbour === undefined || neighbourBox === undefined) return undefined;
    if (port.side !== (toward > 0 ? 'right' : 'left')) return undefined;
    const gap = gapBetween(box, neighbourBox);
    ends.push({ which, ref, port: port as BypassEnd['port'], stem: gap.centre, neighbour, gap: gap.width });
  }
  const boxes = group.nodes.map(id => model.nodes[id]?.bounds).filter((box): box is Rect => box !== undefined);
  if (boxes.length === 0) return undefined;
  const depth = bypassDepth(model, group.id, edge) + bypassRowIndex(model, course) * RING_PITCH;
  const rowY = edge === 'top' ? Math.min(...boxes.map(box => box.y)) - depth : Math.max(...boxes.map(bottomOf)) + depth;
  const [a, b] = ends as [BypassEnd, BypassEnd];
  const p0 = { ...a.port.anchor }, p1 = { ...b.port.anchor };
  const polyline: Point[] = [p0, { x: a.stem, y: p0.y }, { x: a.stem, y: rowY }, { x: b.stem, y: rowY }, { x: b.stem, y: p1.y }, p1];
  const middle = { x: (a.stem + b.stem) / 2, y: rowY };
  const owner = { kind: 'link' as const, id: link.id };
  const lanes = [bypassLaneId(link.id, 0), bypassLaneId(link.id, 1)] as const;
  const chain: [Point, Point, string][] = [[p0, polyline[1]!, lanes[0]], [polyline[1]!, polyline[2]!, lanes[0]], [polyline[2]!, middle, lanes[0]],
    [middle, polyline[3]!, lanes[1]], [polyline[3]!, polyline[4]!, lanes[1]], [polyline[4]!, p1, lanes[1]]];
  const segments: PathSegment[] = chain.map(([start, end, lane]) => ({ from: { ...start }, to: { ...end }, owner: { ...owner }, lane }));
  return { group: group.id, tier: group.tier, edge, ends: [a, b], rowY, segments, polyline };
}

/** The extent and x of the lane of end `index` (0 for `from`): from the padding row to the port's y, at the centre of the gap. */
export function bypassLaneExtent(geometry: BypassGeometry, index: 0 | 1): { x: number; y: number; height: number } {
  const end = geometry.ends[index], y = geometry.edge === 'top' ? geometry.rowY : end.port.anchor.y;
  return { x: end.stem, y, height: Math.abs(end.port.anchor.y - geometry.rowY) };
}

/** The y of the padding row of a bypass, for the planned turn (its reach). `undefined` when the bypass has no geometry. */
export function bypassRowY(model: LayoutModel, link: LayoutLink, course: Course): number | undefined {
  return bypassGeometry(model, link, course)?.rowY;
}

/**
 * The admission of a bypass at 7a, the one 7a and the course offer both call: its two lanes, or the reason the route cannot be reserved. A stem needs a gap as wide as
 * the lane, clear of the lanes already reserved and, at 7a, of every link path that exists now (a straight link in the gap above its own port would cross the stem). The offer does not read the paths: they stand in the far-end order of the baseline, and the trial's turn order moves the closing link to the slot on its turn side.
 */
export function admitBypassLanes(model: LayoutModel, link: LayoutLink, course: Course, pending: readonly Lane[], width: number, paths = true): { lanes: Lane[] } | { why: string } {
  const geometry = bypassGeometry(model, link, course);
  if (geometry === undefined) return { why: `The ends of ${link.id} do not allow a bypass: both must stand in one row, face the row and have a node between them` };
  const half = width / 2, lanes: Lane[] = [];
  for (const index of [0, 1] as const) {
    const end = geometry.ends[index], extent = bypassLaneExtent(geometry, index);
    if (end.gap < width) return { why: `The gap beside ${end.ref.node} is ${end.gap.toFixed(1)} px wide, the lane needs ${width.toFixed(1)}` };
    const box = { x: extent.x - half, width, y: extent.y, height: extent.height };
    for (const lane of pending) {
      if (lane.tier !== geometry.tier || lane.owner.kind === 'link' && lane.owner.id === link.id) continue;
      if (lane.bounds.x < rightOf(box) && rightOf(lane.bounds) > box.x && lane.bounds.y < bottomOf(box) && bottomOf(lane.bounds) > box.y) return { why: `The lane ${lane.id} stands in the gap beside ${end.ref.node}` };
    }
    for (const other of paths ? model.links : []) {
      if (other.id === link.id || other.path === undefined) continue;
      for (const segment of other.path.segments) {
        const strict = Math.abs(segment.from.y - segment.to.y) < 1e-6 && segment.from.y > box.y + 1e-6 && segment.from.y < bottomOf(box) - 1e-6
          && Math.min(segment.from.x, segment.to.x) < extent.x - 1e-6 && Math.max(segment.from.x, segment.to.x) > extent.x + 1e-6;
        if (strict) return { why: `The link ${other.id} runs across the stem beside ${end.ref.node}` };
      }
    }
    const group = model.groups[geometry.group]!;
    lanes.push({ id: bypassLaneId(link.id, index), kind: 'gap', owner: { kind: 'link', id: link.id }, layer: 'routed', group: group.id, tier: geometry.tier,
      side: end.port.side as 'left' | 'right', port: { ...end.ref }, span: { top: geometry.tier, bottom: geometry.tier }, x: extent.x, bounds: { ...box } });
  }
  return { lanes };
}

/** Whether the link's two ends stand in one tier: the precondition the offer checks before it reads any geometry. */
export const sameRow = (model: LayoutModel, link: LayoutLink): boolean => link.attachments !== undefined
  && nodeTier(model, link.attachments.from.node) === nodeTier(model, link.attachments.to.node) && portId(link.attachments.from) !== portId(link.attachments.to);
