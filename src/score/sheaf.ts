import type { LayoutLink, LayoutModel, PathSegment, Point } from '../model/index.js';
import { EPS, segmentDistance } from './geometry.js';
import { chordEnds } from '../layout/overlay-paths.js';

/** One run that the G6 clearance reads: its segment, its link and the stroke it is drawn with. */
export type ClearanceRun = { segment: PathSegment; link: LayoutLink; stroke: number };

/**
 * The near-node stretch of a sheaf (dense-16x9 ticket 04, owner ruling 2026-11-15): two chords of one complete solid block that share a node
 * are excused from the parallel clearance for `min(max(body.width, body.height), lengthA / 2, lengthB / 2)` from their ports on that node.
 * Returns the chord that stands from `start` (the port on the shared node) cut to the stretch past the zone.
 */
function remainder(segment: PathSegment, start: Point, zone: number): PathSegment {
  const end = Math.hypot(segment.from.x - start.x, segment.from.y - start.y) <= EPS ? segment.to : segment.from;
  const length = Math.hypot(end.x - start.x, end.y - start.y), t = zone / length;
  return { ...segment, from: { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }, to: end };
}

/**
 * Where the chord of `link` starts on `node`, when `segment` is the whole chord: the outward face point of the port on that node, the point
 * the chord is drawn from (`chordEnds`, the one end reader of a placement chord and of a routed straight path; R1). The face point is the
 * anchor where the port draws no pill, and the pill's outer edge where it does. Undefined when `segment` does not join the two face points.
 */
function chordEnd(model: LayoutModel, link: LayoutLink, segment: PathSegment, node: string): Point | undefined {
  const ends = link.attachments, faces = chordEnds(model, link);
  if (ends === undefined || faces === undefined) return undefined;
  const near = ends.from.node === node ? faces.head.face : ends.to.node === node ? faces.tail.face : undefined;
  if (near === undefined) return undefined;
  const far = near === faces.head.face ? faces.tail.face : faces.head.face;
  const on = (p: Point, q: Point): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= EPS;
  return (on(segment.from, near) && on(segment.to, far)) || (on(segment.to, near) && on(segment.from, far)) ? near : undefined;
}

/**
 * The parallel clearance of two runs, strokes taken off: `segmentDistance` less the half strokes, the G6 measure. For two chords of one complete
 * solid block that share a node (a sheaf), the stretch of each chord within the sheaf zone of that node is excused: each remainder past the zone
 * is measured against the whole other chord, and the clearance is the smaller of the two. Collinear chords are never excused, and nothing else
 * is: a foreign link, a pill or a fallen-back member (no whole chord) is measured on the whole run.
 *
 * The one sheaf predicate (R1): the gate (`parallelClearance`), the chord judges of placement (`chordsApart`, so the joint admission and the
 * fixed point) and every reader of `parallelClearance` read it.
 */
export function runClearance(model: LayoutModel, a: ClearanceRun, b: ClearanceRun): number {
  const strokes = (a.stroke + b.stroke) / 2, whole = segmentDistance(a.segment, b.segment) - strokes;
  const shared = sheafNode(model, a.link, b.link);
  if (shared === undefined) return whole;
  const startA = chordEnd(model, a.link, a.segment, shared), startB = chordEnd(model, b.link, b.segment, shared);
  if (startA === undefined || startB === undefined) return whole;
  const lengthA = Math.hypot(a.segment.to.x - a.segment.from.x, a.segment.to.y - a.segment.from.y);
  const lengthB = Math.hypot(b.segment.to.x - b.segment.from.x, b.segment.to.y - b.segment.from.y);
  const da = { x: (a.segment.to.x - a.segment.from.x) / lengthA, y: (a.segment.to.y - a.segment.from.y) / lengthA };
  const db = { x: (b.segment.to.x - b.segment.from.x) / lengthB, y: (b.segment.to.y - b.segment.from.y) / lengthB };
  // Collinear overlap is never excused: parallel directions measure the whole runs.
  if (Math.abs(da.x * db.y - da.y * db.x) <= EPS) return whole;
  const body = model.nodes[shared]!.bounds!;
  const zone = Math.min(Math.max(body.width, body.height), lengthA / 2, lengthB / 2);
  return Math.min(segmentDistance(remainder(a.segment, startA, zone), b.segment), segmentDistance(remainder(b.segment, startB, zone), a.segment)) - strokes;
}

/** The node two links of one complete solid block share, or undefined: no sheaf. Two members of one block share at most one node. */
function sheafNode(model: LayoutModel, a: LayoutLink, b: LayoutLink): string | undefined {
  if (a.id === b.id || a.solidBlock !== true || b.solidBlock !== true || a.fanFamily === undefined || a.fanFamily !== b.fanFamily) return undefined;
  if (a.attachments === undefined || b.attachments === undefined || model.nodes === undefined) return undefined;
  const mine = [a.attachments.from.node, a.attachments.to.node];
  return [b.attachments.from.node, b.attachments.to.node].find(node => mine.includes(node) && model.nodes[node]?.bounds !== undefined);
}
