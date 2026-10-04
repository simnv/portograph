import type { Point, Rect } from '../model/geometry.js';
import type { Course, Lane, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { COURSE_STEM, endMode, type EndName } from './course-rows.js';
import { nodeTier } from './read/tier.js';
import { findPort } from './row-paths.js';

/**
 * The column-gap lane of a course (architecture ticket 15, phase 5). A gap course joins the two ends of a link that stand in one band and have a
 * unit between them: the lateral end keeps its face and meets the lane by a side run, the other end leaves by a top or bottom face and meets the lane by
 * a U part of the tier gap. The lane is one vertical run in the free column between two sibling units, from the side run's y to the band edge that the
 * U part faces. Its x is fixed at stage 7a (ADR-0010: every lane x but a perimeter lane's is immutable); its extent is replayed from the lateral port's y.
 *
 * This module is the one reader of that geometry: 7a, every replay, `validateLanes` and the course round's promise read it.
 */

export const gapLaneId = (link: string): string => `gap-lane:${link}:0`;

/** Whether the course runs through a column gap (and not round the outside): its lane is a column-gap lane. */
export const isGapCourse = (course: Course): boolean => course.runs.includes('gap') && !course.runs.includes('perimeter');

/** The column-gap lane of a link, if its course owns one. */
export const gapLaneOf = (model: LayoutModel, link: string): Lane | undefined => model.lanes.find(lane => lane.kind === 'gap' && lane.owner.kind === 'link' && lane.owner.id === link);

/** The two ends of a gap course: the lateral end that meets the lane, and the end that leaves by the tier gap. `down`: the U part lies below the band. */
export interface GapEnds { lateral: EndName; u: EndName; down: boolean }

export function gapEnds(course: Course): GapEnds | undefined {
  if (!isGapCourse(course)) return undefined;
  const modes = { from: endMode(course, 'from'), to: endMode(course, 'to') };
  const lateral = modes.from === 'hold' ? 'from' : modes.to === 'hold' ? 'to' : undefined;
  if (lateral === undefined) return undefined;
  const u = lateral === 'from' ? 'to' : 'from';
  if (modes[u] !== 'u') return undefined;
  const face = course[u].face;
  return { lateral, u, down: face === 'bottom' };
}

const padOf = (): number => 10 + DEFAULT_STROKE_WIDTHS.path / 2;
const bottomOf = (box: Rect): number => box.y + box.height;

export interface GapGeometry {
  /** The lateral port, and the end it belongs to. */
  lateral: { which: EndName; anchor: Point };
  /** The other end's port anchor. */
  other: { which: EndName; anchor: Point };
  /** The vertical extent of the lane: from the side run's y to the band edge (grown by the pad) that the U part faces. */
  extent: { y: number; height: number };
  down: boolean;
  tier: number;
}

/** The extent and ends of the lane of `course`, read from the ports as they stand, or `undefined` when a port or a band is missing. */
export function gapGeometry(model: LayoutModel, link: LayoutLink, course: Course): GapGeometry | undefined {
  const ends = gapEnds(course);
  if (ends === undefined || link.attachments === undefined) return undefined;
  const lateralPort = findPort(model, link.attachments[ends.lateral]), otherPort = findPort(model, link.attachments[ends.u]);
  if (lateralPort?.anchor === undefined || otherPort?.anchor === undefined) return undefined;
  const tier = nodeTier(model, link.attachments[ends.lateral].node);
  const band = model.tierBands.find(item => item.tier === tier)?.bounds;
  if (band === undefined) return undefined;
  const pad = padOf(), at = lateralPort.anchor.y;
  const extent = ends.down ? { y: at, height: bottomOf(band) + pad - at } : { y: band.y - pad, height: at - (band.y - pad) };
  return { lateral: { which: ends.lateral, anchor: lateralPort.anchor }, other: { which: ends.u, anchor: otherPort.anchor }, extent, down: ends.down, tier };
}

/**
 * The two fixed segments of a column-gap lane, in path order: the vertical run at the lane x from the band edge to the side run's y, then the side run to
 * the lateral port's face. Where the lateral end is the source of the link, both run the other way. Both carry `lane: <id>`.
 */
export function gapReservation(model: LayoutModel, link: LayoutLink, course: Course, lane: Lane): PathSegment[] | undefined {
  const geometry = gapGeometry(model, link, course);
  if (geometry === undefined) return undefined;
  const anchor = geometry.lateral.anchor, edgeY = geometry.down ? lane.bounds.y + lane.bounds.height : lane.bounds.y;
  const edge = { x: lane.x, y: edgeY }, turn = { x: lane.x, y: anchor.y };
  const owner = { kind: 'link' as const, id: link.id };
  return geometry.lateral.which === 'to'
    ? [{ from: edge, to: turn, owner, lane: lane.id }, { from: { ...turn }, to: { x: anchor.x, y: anchor.y }, owner: { ...owner }, lane: lane.id }]
    : [{ from: { x: anchor.x, y: anchor.y }, to: turn, owner, lane: lane.id }, { from: { ...turn }, to: edge, owner: { ...owner }, lane: lane.id }];
}

/** The polyline the course promises: the other end's stem, the row of the U part, the lane, the side run. The row's y is a stand-in (one stem inside the gap). */
export function gapPolyline(geometry: GapGeometry, x: number, lane: { y: number; height: number }): Point[] {
  const edgeY = geometry.down ? lane.y + lane.height : lane.y, row = edgeY + (geometry.down ? 1 : -1) * COURSE_STEM;
  const other = geometry.other.anchor, lateral = geometry.lateral.anchor;
  const ordered: Point[] = [{ ...other }, { x: other.x, y: row }, { x, y: row }, { x, y: lateral.y }, { ...lateral }];
  return geometry.lateral.which === 'from' ? ordered.reverse() : ordered;
}
