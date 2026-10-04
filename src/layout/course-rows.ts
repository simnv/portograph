import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { Course, LayoutGroup, LayoutModel } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

/**
 * The padding row of a course (architecture ticket 15, Section 2): a horizontal run inside an end group's padding, on the edge that faces out of the
 * drawing, between the node faces and the title band. This module states the sizes and reads which group edge holds how many rows. It imports no
 * geometry module, so `regions.ts` (the padding of a group) can read it without a cycle.
 */

/** The stem a course end leaves its face by before it turns (CONTEXT, stem). */
export const COURSE_STEM = 15;
/** The pitch of two runs side by side: the gate clearance plus the routed stroke. */
export const RING_PITCH = 11.5;
/** The edge margin `e`: a run stands this far from a box edge it runs along (the gate clearance plus half the routed stroke). */
export const EDGE_MARGIN = 10.75;
/** The link-free margin of a group title (G3) plus half the routed stroke. */
const TITLE_MARGIN = 8.75;

export type EndName = 'from' | 'to';
/**
 * `hold`: the lateral face that the rule gives, joined to a column-gap lane by a side run (phase 5); the course does not move the port.
 * `u`: a top or bottom face that the course sets, joined to a U part of the tier gap (phase 5).
 */
export type EndMode = 'natural' | 'side' | 'padding' | 'hold' | 'u';

/**
 * How one end of a course meets its node. A lateral face is a side run (a perimeter lane's) or, on a course with a column-gap run, the held face of a gap lane;
 * a top or bottom face is a padding row when the course's first run (for `from`) or last run (for `to`) is `padding`, a U part when it is `u`, and the natural
 * face with a drop or a tier-gap part otherwise.
 */
export function endMode(course: Course, which: EndName): EndMode {
  const face = course[which].face;
  if (face === 'left' || face === 'right') return course.runs.includes('gap') ? 'hold' : 'side';
  const run = which === 'from' ? course.runs[0] : course.runs[course.runs.length - 1];
  return run === 'padding' ? 'padding' : run === 'u' ? 'u' : 'natural';
}

/** Whether the course sets the face of this end in stage 5: every mode but the natural face and the held lateral face. */
export const movesPort = (course: Course, which: EndName): boolean => { const mode = endMode(course, which); return mode !== 'natural' && mode !== 'hold'; };

/** How far a padding row stands from the face: the stem, or beyond the pill of a named port. */
export function rowDepth(ref: PortRef): number {
  if (ref.anonymous === true || ref.name === undefined) return COURSE_STEM;
  return Math.max(COURSE_STEM, measurePortPill(ref.name).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2 + 6);
}

/** The padding rows of one group edge. `depth` is the deepest first row; `count` the number of rows. */
export interface EdgeRows { count: number; depth: number }

/** The group a course end stands in, or undefined when the link or its attachment is unknown. */
function endGroup(model: LayoutModel, course: Course, which: EndName): { group: string; ref: PortRef } | undefined {
  const ref = model.links.find(link => link.id === course.link)?.attachments?.[which];
  const document = ref === undefined ? undefined : model.document.nodes[ref.node];
  return ref === undefined || document === undefined ? undefined : { group: document.group, ref };
}

/** The rows that the courses of the model put on the top and bottom edge of `group`. */
export function paddingRows(model: LayoutModel, group: Pick<LayoutGroup, 'id'>): Partial<Record<'top' | 'bottom', EdgeRows>> {
  const rows: Partial<Record<'top' | 'bottom', EdgeRows>> = {};
  for (const course of model.courses ?? []) for (const which of ['from', 'to'] as const) {
    if (endMode(course, which) !== 'padding') continue;
    const found = endGroup(model, course, which), face = course[which].face as 'top' | 'bottom';
    if (found === undefined || found.group !== group.id) continue;
    const entry = rows[face] ?? { count: 0, depth: 0 };
    entry.count++; entry.depth = Math.max(entry.depth, rowDepth(found.ref));
    rows[face] = entry;
  }
  return rows;
}

/** The room a group edge needs between its node faces and its box edge for `rows`: the first row's depth, the pitch of the others, and the edge margin. */
export const rowsInset = (rows: EdgeRows): number => rows.depth + (rows.count - 1) * RING_PITCH + EDGE_MARGIN;

/** The same on the edge that carries the group title: the rows stand under the title band and its link-free margin. */
export const rowsInsetUnderTitle = (rows: EdgeRows, bandHeight: number): number => bandHeight + TITLE_MARGIN + rows.depth + (rows.count - 1) * RING_PITCH;

/** The side a padding row stands on for a top or bottom face; `Side` narrowing for callers. */
export const isRowFace = (face: Side): face is 'top' | 'bottom' => face === 'top' || face === 'bottom';
