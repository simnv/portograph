import type { PortRef } from '../model/document.js';
import type { Point, Rect } from '../model/geometry.js';
import type { Course, Lane, LayoutGroup, LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { EDGE_MARGIN, RING_PITCH, endMode, rowDepth, type EndMode, type EndName } from './course-rows.js';
import { nodeTier } from './read/tier.js';
import { findPort } from './row-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The perimeter lane of a course (architecture ticket 15, Section 2). A course names the face of each end and how each end joins the lane: by a side run
 * into a lateral face, by a padding row on the outer top or bottom edge of its group, or by its own natural face and a drop or a tier-gap part. The lane
 * is one vertical run beyond every box on its extent, on the left or right. Its id, owner, side, ring and span are fixed at stage 7a; its x is derived from
 * the boxes at each replay (`rebuildLaneExtents`), so a unit that moves outward after 7a never stands across it.
 *
 * `courseGeometry` is the one reader of this geometry. 7a, every replay, `validateLanes` and the course round's promise all read it, so a polyline that
 * the round promised is the polyline the lane reserves.
 */

/** A course of kind `shared-port` owns no lane: it only names the approach of a link end at a shared pill (phase 6). */
export const isApproachCourse = (course: Course): boolean => course.kind === 'shared-port';
/** The lane course of a link: a perimeter or column-gap course. An approach course has no lane, so it is not read here. */
export const courseOf = (model: LayoutModel, link: string): Course | undefined => model.courses?.find(course => course.link === link && !isApproachCourse(course));
export const perimeterLaneId = (link: string): string => `perimeter:${link}`;
/** The perimeter lane of a link, if its course owns one. */
export const courseLaneOf = (model: LayoutModel, link: string): Lane | undefined => model.lanes.find(lane => lane.kind === 'perimeter' && lane.owner.kind === 'link' && lane.owner.id === link);

/** Reads the occupied box of a group for a link: the group box, its nodes with their clearance and the lanes it holds (`occupied` of `lanes.ts`). */
export type Occupied = (group: LayoutGroup, link: LayoutLink) => Rect;

export interface CourseEndFacts { which: EndName; ref: PortRef; port: LayoutPort & { anchor: Point; side: NonNullable<LayoutPort['side']> }; mode: EndMode; tier: number }

export interface CourseGeometry {
  x: number;
  /** The far port stands on the lane: the drop into its natural face has no turn. */
  aligned: boolean;
  yTop: number;
  yBottom: number;
  bounds: Rect;
  /** The sub-tiers whose band the lane's vertical extent meets. */
  span: { top: number; bottom: number };
  /** The upper end and the lower end of the course (by sub-tier). */
  upper: CourseEndFacts;
  lower: CourseEndFacts;
  /** The reserved runs in path order (from the link's `from` end to its `to` end), the natural ends left to the tier-gap plan and the router. */
  segments: PathSegment[];
  /** The polyline the reserved runs make, with the natural end's drop or step added: what the course promises. */
  polyline: Point[];
}

const bandBox = (model: LayoutModel, tier: number): Rect => model.tierBands.find(band => band.tier === tier)!.bounds!;
const bottomOf = (box: Rect): number => box.y + box.height;
const pad = (): number => 10 + DEFAULT_STROKE_WIDTHS.path / 2;

function endFacts(model: LayoutModel, course: Course, link: LayoutLink, which: EndName): CourseEndFacts | undefined {
  const ref = link.attachments?.[which];
  const port = ref === undefined ? undefined : findPort(model, ref);
  if (ref === undefined || port?.anchor === undefined || port.side === undefined) return undefined;
  return { which, ref, port: port as CourseEndFacts['port'], mode: endMode(course, which), tier: nodeTier(model, ref.node) };
}

/** Whether the face of an end can join the lane: a natural end faces the other end, a padding row the outside, a side run the lane. */
function legal(end: CourseEndFacts, isUpper: boolean, side: 'left' | 'right'): boolean {
  if (end.mode === 'natural') return end.port.side === (isUpper ? 'bottom' : 'top');
  if (end.mode === 'padding') return end.port.side === (isUpper ? 'top' : 'bottom');
  return end.port.side === side;
}

/**
 * The index of the padding row of one end on its group edge: the rows of the same edge are ordered by the ring of their lanes (an outer ring stands on an
 * outer row), left lanes after right lanes. `rings` is the ring and side of each link's lane, read from the lanes the model has now or the ones 7a is building.
 */
export function rowIndex(model: LayoutModel, course: Course, which: EndName, rings: ReadonlyMap<string, { ring: number; side: 'left' | 'right' }>): number {
  const own = model.links.find(link => link.id === course.link)?.attachments?.[which];
  if (own === undefined) return 0;
  const group = model.document.nodes[own.node]?.group, face = course[which].face;
  const peers: { link: string; key: number }[] = [];
  for (const other of model.courses ?? []) for (const end of ['from', 'to'] as const) {
    if (endMode(other, end) !== 'padding' || other[end].face !== face) continue;
    const ref = model.links.find(link => link.id === other.link)?.attachments?.[end];
    if (ref === undefined || model.document.nodes[ref.node]?.group !== group) continue;
    const lane = rings.get(other.link);
    peers.push({ link: other.link, key: (lane?.side === 'left' ? 1000 : 0) + (lane?.ring ?? 0) });
  }
  peers.sort((a, b) => a.key - b.key || (a.link < b.link ? -1 : 1));
  return Math.max(0, peers.findIndex(peer => peer.link === course.link));
}

/** The ring and side of every course lane the model holds, by link. */
export function ringsOf(lanes: readonly Lane[]): Map<string, { ring: number; side: 'left' | 'right' }> {
  const result = new Map<string, { ring: number; side: 'left' | 'right' }>();
  for (const lane of lanes) if (lane.kind === 'perimeter' && lane.owner.kind === 'link') result.set(lane.owner.id, { ring: lane.ring ?? 0, side: lane.side });
  return result;
}

/** `keepX` with `x`: read the polyline of a lane that already stands (the overlay path of a course), not the x the boxes derive. */
export interface LaneDraft { id: string; side: 'left' | 'right'; ring?: number; aligned?: true; x?: number; keepX?: true }

/** The geometry of a course lane on the model as it stands, or `undefined` when the faces of the course cannot join one lane. */
export function courseGeometry(model: LayoutModel, link: LayoutLink, course: Course, lane: LaneDraft, occ: Occupied, rings: ReadonlyMap<string, { ring: number; side: 'left' | 'right' }>, peers: readonly Lane[] = []): CourseGeometry | undefined {
  const ends = [endFacts(model, course, link, 'from'), endFacts(model, course, link, 'to')];
  if (ends[0] === undefined || ends[1] === undefined || ends[0].tier === ends[1].tier) return undefined;
  const [upper, lower] = ends[0].tier < ends[1].tier ? [ends[0], ends[1]] : [ends[1], ends[0]];
  if (!legal(upper, true, lane.side) || !legal(lower, false, lane.side)) return undefined;
  const tiers = model.tierBands.filter(band => band.bounds !== undefined).map(band => band.tier).sort((a, b) => a - b);
  const next = (tier: number): number | undefined => tiers.find(item => item > tier), previous = (tier: number): number | undefined => [...tiers].reverse().find(item => item < tier);
  const rowY = (end: CourseEndFacts): number => {
    const at = end.port.anchor.y, index = rowIndex(model, course, end.which, rings), sign = end.port.side === 'top' ? -1 : 1;
    return at + sign * (rowDepth(end.ref) + index * RING_PITCH);
  };
  let yTop: number, yBottom: number;
  if (upper.mode === 'natural') { const t = next(upper.tier); if (t === undefined) return undefined; yTop = bandBox(model, t).y - pad(); }
  else yTop = upper.mode === 'side' ? upper.port.anchor.y : rowY(upper);
  if (lower.mode === 'natural') { const t = previous(lower.tier); if (t === undefined) return undefined; yBottom = bottomOf(bandBox(model, t)) + pad(); }
  else yBottom = lower.mode === 'side' ? lower.port.anchor.y : rowY(lower);
  if (!(yBottom > yTop + PLACEMENT_EPS)) return undefined;

  const dir = lane.side === 'right' ? 1 : -1;
  const meets = (box: Rect): boolean => box.y < yBottom - PLACEMENT_EPS && bottomOf(box) > yTop + PLACEMENT_EPS;
  const boxes: Rect[] = [];
  for (const group of Object.values(model.groups)) {
    if (group.bounds === undefined || group.nodes.length === 0) continue;
    const box = occ(group, link);
    if (meets(box)) boxes.push(box);
  }
  for (const frame of model.frames ?? []) if (meets(frame.box)) boxes.push(frame.box);
  for (const other of model.lanes) if (other.kind !== 'perimeter' && other.kind !== 'gap' && !(other.owner.kind === 'link' && other.owner.id === link.id) && meets(other.bounds)) boxes.push(other.bounds);
  const outer = boxes.length === 0 ? upper.port.anchor.x : dir > 0 ? Math.max(...boxes.map(box => box.x + box.width)) : Math.min(...boxes.map(box => box.x));
  let base = lane.keepX === true && lane.x !== undefined ? lane.x : outer + dir * (EDGE_MARGIN + (lane.ring ?? 0) * RING_PITCH);
  // The lanes of one side stand as one stack: a lane stands a pitch beyond every inner lane of its side whose extent it meets, whatever boxes each one clears.
  for (const other of lane.keepX === true ? [] : peers) {
    if (other.side !== lane.side || (other.ring ?? 0) >= (lane.ring ?? 0) || !(other.bounds.y < yBottom - PLACEMENT_EPS && bottomOf(other.bounds) > yTop + PLACEMENT_EPS)) continue;
    const wanted = other.x + dir * RING_PITCH;
    base = dir > 0 ? Math.max(base, wanted) : Math.min(base, wanted);
  }
  const far = ends.find(end => end?.mode === 'natural');
  let x = base, aligned = false;
  if (lane.aligned === true && far !== undefined && lane.keepX !== true) {
    const fx = far.port.anchor.x;
    if (dir > 0 ? fx >= base - PLACEMENT_EPS : fx <= base + PLACEMENT_EPS) { x = fx; aligned = true; }
  }

  // The reserved polyline from the upper end to the lower end.
  const down: Point[] = [];
  if (upper.mode === 'side') down.push({ ...upper.port.anchor }, { x, y: upper.port.anchor.y });
  else if (upper.mode === 'padding') { const y = rowY(upper); down.push({ ...upper.port.anchor }, { x: upper.port.anchor.x, y }, { x, y }); }
  else down.push({ x, y: yTop });
  if (lower.mode === 'side') down.push({ x, y: lower.port.anchor.y }, { ...lower.port.anchor });
  else if (lower.mode === 'padding') { const y = rowY(lower); down.push({ x, y }, { x: lower.port.anchor.x, y }, { ...lower.port.anchor }); }
  else down.push({ x, y: yBottom });
  const reserved = ends[0] === upper ? down : [...down].reverse();
  const owner = { kind: 'link' as const, id: link.id };
  const segments: PathSegment[] = reserved.slice(1).map((to, index) => ({ from: { ...reserved[index]! }, to: { ...to }, owner: { ...owner }, lane: lane.id }));

  // What the course promises: the reserved runs, and the part from the port to the mouth of a natural end (a drop when the port stands on the lane, else a step).
  const polyline: Point[] = [...reserved];
  const first = ends[0], last = ends[1];
  const mid = (a: number, b: number): number => (a + b) / 2;
  if (first.mode === 'natural') {
    const mouth = polyline[0]!, anchor = first.port.anchor;
    polyline.unshift(...(Math.abs(mouth.x - anchor.x) <= PLACEMENT_EPS ? [{ ...anchor }] : [{ ...anchor }, { x: anchor.x, y: mid(anchor.y, mouth.y) }, { x: mouth.x, y: mid(anchor.y, mouth.y) }]));
  }
  if (last.mode === 'natural') {
    const mouth = polyline.at(-1)!, anchor = last.port.anchor;
    polyline.push(...(Math.abs(mouth.x - anchor.x) <= PLACEMENT_EPS ? [{ ...anchor }] : [{ x: mouth.x, y: mid(anchor.y, mouth.y) }, { x: anchor.x, y: mid(anchor.y, mouth.y) }, { ...anchor }]));
  }
  const spanTiers = tiers.filter(tier => meets(bandBox(model, tier)));
  const span = spanTiers.length ? { top: Math.min(...spanTiers), bottom: Math.max(...spanTiers) } : { top: upper.tier, bottom: lower.tier };
  const width = RING_PITCH;
  return { x, aligned, yTop, yBottom, bounds: { x: x - width / 2, y: yTop, width, height: yBottom - yTop }, span, upper, lower, segments, polyline };
}
