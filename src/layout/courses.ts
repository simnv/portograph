import type { Side } from '../model/geometry.js';
import type { Course, CourseEnd, CourseKind, CourseRun, Lane, LayoutLink, LayoutModel } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { findPort } from './row-paths.js';
import { SideHintRefusal } from './side-hints.js';

/** A placement run cannot reserve a course (its faces cannot join one lane). The course round drops the offer; every other error is a bug. */
export class CourseRefusal extends SideHintRefusal {}

/**
 * The data shapes of architecture ticket 15, phase 1. A course is the planned route of one link, face to face (CONTEXT, course);
 * a perimeter lane and a column-gap lane are the lanes a course may own. Nothing plans a course yet: this module only states
 * what a course, an approach and those two lane kinds must satisfy, so that a layout which carries them restores or is refused.
 */

const KINDS: readonly CourseKind[] = ['transit', 'u-turn', 'skirt', 'shared-port', 'overlay'];
const RUNS: readonly CourseRun[] = ['padding', 'transit', 'gap', 'perimeter', 'tier-gap'];
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** A lane that a course owns: its id is `gap-lane:<link>:<n>` or `perimeter:<link>`. */
export const isCourseLane = (lane: Lane): boolean => lane.kind === 'gap' || lane.kind === 'perimeter';

const lateral = (side: Side): boolean => side === 'left' || side === 'right';
const samePort = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.ordinal === b.ordinal && (a.name ?? null) === (b.name ?? null) && (a.anonymous === true) === (b.anonymous === true);

/** The number of link ends that stand on a port. */
function linksAt(model: LayoutModel, ref: PortRef): number {
  let count = 0;
  for (const link of model.links) for (const end of [link.attachments?.from, link.attachments?.to]) if (end !== undefined && samePort(end, ref)) count++;
  return count;
}

function validateEnd(model: LayoutModel, link: LayoutLink, which: 'from' | 'to', end: CourseEnd): void {
  const ref = link.attachments?.[which];
  if (ref === undefined) throw new Error(`Course on ${link.id} has no ${which} attachment`);
  const port = findPort(model, ref);
  if (port === undefined || port.side === undefined) throw new Error(`Course on ${link.id} names a port without a side`);
  if (!SIDES.includes(end.face) || end.face !== port.side) throw new Error(`Course face on ${link.id} contradicts the port side`);
  const stored = link.approach?.[which];
  if (end.approach === undefined) {
    if (stored !== undefined) throw new Error(`Link ${link.id} approach is not in its course`);
    return;
  }
  if (!SIDES.includes(end.approach) || lateral(end.approach) === lateral(end.face)) throw new Error(`Approach on ${link.id} is not tangential to the port side`);
  if (ref.anonymous === true || ref.name === undefined) throw new Error(`Approach on ${link.id} stands on an anonymous port, which has no pill`);
  if (linksAt(model, ref) < 2) throw new Error(`Approach on ${link.id} stands on a port no other link shares`);
  if (stored !== end.approach) throw new Error(`Course approach on ${link.id} is not on the link`);
}

/**
 * The invariants of `model.courses` and `LayoutLink.approach`, not their history (ticket 15, Section 1): each course names an existing link once,
 * each face is the side of the port it ends on, each approach is a tangential face of a shared named port, and the link repeats it.
 * Absent courses and absent approaches read as today.
 */
export function validateCourses(model: LayoutModel): void {
  const courses = model.courses ?? [];
  const seen = new Set<string>();
  for (const course of courses) {
    const link = model.links.find(item => item.id === course.link);
    if (link === undefined) throw new Error(`Course names an unknown link ${course.link}`);
    if (seen.has(course.link)) throw new Error(`Link ${course.link} has two courses`);
    seen.add(course.link);
    if (!KINDS.includes(course.kind)) throw new Error(`Course on ${course.link} has an unknown kind`);
    if ((course.kind === 'overlay') !== (link.layer === 'overlay')) throw new Error(`Course kind on ${course.link} contradicts its layer`);
    if (course.runs.length === 0 || !course.runs.every(run => RUNS.includes(run))) throw new Error(`Course on ${course.link} has invalid runs`);
    if (course.runs.includes('perimeter') !== (course.side !== undefined) || (course.side !== undefined && course.side !== 'left' && course.side !== 'right')) throw new Error(`Course on ${course.link} must name the margin of its perimeter lane, and only then`);
    validateEnd(model, link, 'from', course.from);
    validateEnd(model, link, 'to', course.to);
  }
  for (const link of model.links) if (link.approach !== undefined && !seen.has(link.id)) throw new Error(`Link ${link.id} has an approach and no course`);
}

/** Whether `a` and `b` list the same courses; the freeze stores `model.courses` and a restore compares the two. */
export function sameCourses(a: readonly Course[] | undefined, b: readonly Course[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  const end = (p: CourseEnd, q: CourseEnd): boolean => p.face === q.face && p.approach === q.approach;
  return x.every((course, i) => {
    const other = y[i]!;
    return course.link === other.link && course.kind === other.kind && course.side === other.side && end(course.from, other.from) && end(course.to, other.to)
      && course.runs.length === other.runs.length && course.runs.every((run, j) => run === other.runs[j]);
  });
}

/**
 * The shape of a perimeter or column-gap lane (ticket 15, Section 2). The owner is a link with a course; the span is an ordered pair of
 * sub-tiers; only a perimeter lane has a ring. Geometry is checked with the other lanes once a phase reserves them.
 */
export function validateCourseLane(model: LayoutModel, lane: Lane): void {
  const owner = lane.owner.kind === 'link' ? lane.owner.id : undefined;
  if (owner === undefined || !model.links.some(link => link.id === owner)) throw new Error(`Lane ${lane.id} has no link owner`);
  if (!(model.courses ?? []).some(course => course.link === owner)) throw new Error(`Lane ${lane.id} belongs to a link with no course`);
  const prefix = lane.kind === 'perimeter' ? `perimeter:${owner}` : `gap-lane:${owner}:`;
  const idOk = lane.kind === 'perimeter' ? lane.id === prefix : lane.id.startsWith(prefix) && /^\d+$/.test(lane.id.slice(prefix.length));
  if (!idOk) throw new Error(`Lane id ${lane.id} contradicts its kind`);
  const span = lane.span;
  if (span === undefined || !Number.isInteger(span.top) || !Number.isInteger(span.bottom) || span.top > span.bottom) throw new Error(`Lane ${lane.id} has an invalid span`);
  if (lane.kind === 'perimeter') {
    if (lane.ring === undefined || !Number.isInteger(lane.ring) || lane.ring < 0) throw new Error(`Perimeter lane ${lane.id} has an invalid ring`);
    if (lane.port !== undefined) throw new Error(`Perimeter lane ${lane.id} names a port`);
  } else if (lane.ring !== undefined) throw new Error(`Gap lane ${lane.id} has a ring`);
  if (!['left', 'right'].includes(lane.side)) throw new Error(`Lane ${lane.id} has an invalid side`);
}
