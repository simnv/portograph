import type { Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { routedStroke, stemReach } from '../layout/bands.js';
import { findPort } from '../layout/row-paths.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { groupConsumers } from '../score/model.js';
import { EPS, horizontal, length, samePoint, segmentRect, vertical } from '../score/geometry.js';
import { outward } from '../score/model.js';
import { effectiveLayer, reversedRuns } from './plan.js';
import { overlayBlockers, overlayPath, type OverlayBlockers } from '../layout/overlay-paths.js';
import { ownedLanes, stubCandidate } from './paths.js';

/** Minimum port stem, the same number G5 enforces on final geometry. */
const MIN_STEM = 15;
const TOLERANCE = 1e-6;

export interface ReservationConflict { link: string; reservation: string }

const shrink = (bounds: Rect, by: number): Rect => ({
  x: bounds.x + by, y: bounds.y + by, width: bounds.width - 2 * by, height: bounds.height - 2 * by,
});

/**
 * Reserved rectangles a newly routed segment may not enter. Nodes, pills, labels and fixed paths
 * are judged by the public gates; lane and bundle reservations are not, so stage 8 asserts them
 * directly. A label band's unused space is traversable; its actual label remains protected.
 */
function reservations(model: LayoutModel, link: LayoutLink): { id: string; bounds: Rect }[] {
  const half = routedStroke(model) / 2, result: { id: string; bounds: Rect }[] = [];
  const expand = (bounds: Rect): Rect => ({ x: bounds.x - half, y: bounds.y - half, width: bounds.width + 2 * half, height: bounds.height + 2 * half });
  for (const label of model.labels) {
    if (label.role === 'group' && !label.omitted && label.bounds && label.layer !== 'overlay') {
      const m = half + GROUP_LABEL_LINK_CLEARANCE, b = label.bounds;
      result.push({ id: label.id, bounds: { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m } });
    }
  }
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay') continue;
    const owner = lane.owner;
    const owns = owner.kind === 'link' ? owner.id === link.id
      : owner.kind === 'bundle' && model.bundles.some(bundle => bundle.id === owner.id && bundle.members.includes(link.id));
    if (!owns) result.push({ id: lane.id, bounds: expand(lane.bounds) });
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length || groupConsumers(model, id).includes(link.id)) continue;
    const margin = half + GROUP_EDGE_LINK_CLEARANCE, box = group.bounds;
    result.push({ id: `group:${id}`, bounds: { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin } });
  }
  for (const bundle of model.bundles) {
    if (bundle.layer === 'overlay' || bundle.members.includes(link.id)) continue;
    const parts = bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [];
    for (const [index, part] of parts.entries()) result.push({ id: `${bundle.id}:envelope:${index}`, bounds: expand(part) });
  }
  for (const obstacle of model.obstacles) {
    if (obstacle.layer === 'overlay' || (obstacle.owner.kind === 'link' && obstacle.owner.id === link.id)) continue;
    result.push({ id: obstacle.id, bounds: expand(obstacle.bounds) });
  }
  return result;
}

/** The reserved runs a stitched path must reproduce exactly, in source-to-target order. */
export function reservedRuns(link: LayoutLink): PathSegment[][] {
  const result: PathSegment[][] = [];
  if (link.sharedRuns?.from?.length) result.push(link.sharedRuns.from);
  for (const segment of link.fixedSegments ?? []) result.push([segment]);
  if (link.sharedRuns?.to?.length) result.push(reversedRuns(link.sharedRuns.to));
  return result;
}

/**
 * Positions of every reserved segment inside a stitched path. Each run appears exactly once, in
 * source-to-target order, with its geometry, owner, lane and barCross unchanged: a second copy of
 * a reserved run would draw the reservation twice.
 */
function reservedPositions(link: LayoutLink): number[] {
  const segments = link.path!.segments, positions: number[] = [];
  let cursor = 0;
  for (const run of reservedRuns(link)) {
    const found: number[] = [];
    for (let index = 0; index + run.length <= segments.length; index++) {
      if (run.every((segment, offset) => equal(segments[index + offset], segment))) found.push(index);
    }
    const at = found.find(index => index >= cursor);
    if (at === undefined) throw new Error(`Routed path on ${link.id} does not preserve a reserved run`);
    if (found.length > 1) throw new Error(`Routed path on ${link.id} repeats a reserved run`);
    for (let offset = 0; offset < run.length; offset++) positions.push(at + offset);
    cursor = at + run.length;
  }
  return positions;
}

/** Newly routed segments that enter a reservation they do not own. */
export function reservationConflicts(model: LayoutModel): ReservationConflict[] {
  const result: ReservationConflict[] = [];
  for (const link of model.links) {
    // Only a rule's own `fixed` path is exempt here; anything else is measured, boolean or not.
    if (!link.path || link.path.fixed === true || effectiveLayer(link) !== 'routed' || !link.attachments) continue;
    const reserved = new Set(reservedPositions(link)), boxes = reservations(model, link);
    for (const [index, segment] of link.path.segments.entries()) {
      if (reserved.has(index)) continue;
      for (const box of boxes) {
        if (box.bounds.width <= 2 * TOLERANCE || box.bounds.height <= 2 * TOLERANCE) continue;
        if (segmentRect(segment, shrink(box.bounds, TOLERANCE))) result.push({ link: link.id, reservation: box.id });
      }
    }
  }
  return result;
}

const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.attachments !== undefined;

/**
 * A route that walks back along a run it already drew is not a path — an exact reversal is only
 * the simplest way to do it. One interval sweep per line answers this for the whole path: two
 * pieces of the same route may touch at a bend, never share length.
 */
export function retraces(id: string, segments: PathSegment[]): void {
  type Span = { low: number; high: number };
  const overlaps = (spans: Span[]): boolean => {
    let reach = -Infinity;
    for (const span of [...spans].sort((a, b) => a.low - b.low)) {
      if (span.low < reach - EPS) return true;
      reach = Math.max(reach, span.high);
    }
    return false;
  };
  for (const along of [true, false]) {
    // One group per exact line, swept in one pass: that is where a real retrace lives, and it stays
    // linear however many runs share the line. Two lines closer than EPS are the same line, so
    // those groups are swept together as well — in real geometry there are none.
    const lines = new Map<number, Span[]>();
    for (const segment of segments) {
      if (along ? !horizontal(segment) : !vertical(segment)) continue;
      const line = along ? segment.from.y : segment.from.x;
      const a = along ? segment.from.x : segment.from.y, b = along ? segment.to.x : segment.to.y;
      const group = lines.get(line) ?? [];
      group.push({ low: Math.min(a, b), high: Math.max(a, b) });
      lines.set(line, group);
    }
    const values = [...lines.keys()].sort((a, b) => a - b);
    for (const [index, value] of values.entries()) {
      if (overlaps(lines.get(value)!)) throw new Error(`Routed path on ${id} retraces itself`);
      for (let next = index + 1; next < values.length && values[next]! - value <= EPS; next++) {
        if (overlaps([...lines.get(value)!, ...lines.get(values[next]!)!])) throw new Error(`Routed path on ${id} retraces itself`);
      }
    }
  }
}

/**
 * Stage 8 publication and restore contract. Route geometry cannot be re-derived without the
 * router, so every claim it makes is checked structurally instead: complete source-to-target
 * paths, exact reserved runs, perpendicular stems, link ownership of the routed gaps, and the
 * reservations the public gates do not cover.
 */
export function validateRoutedPaths(model: LayoutModel, requireComplete = false): void {
  // Built on the first overlay link and shared by the rest; a diagram with none pays nothing.
  let blockers: OverlayBlockers | undefined;
  for (const link of model.links) {
    if (!drawn(link)) {
      if (link.path) throw new Error(`Link ${link.id} must not carry a path`);
      if (link.stubCandidate !== undefined) throw new Error(`Link ${link.id} cannot be a stub candidate`);
      continue;
    }
    const path = link.path;
    // A model still at the route stage may be mid-production; every later stage needs every path.
    if (!path && !requireComplete) continue;
    if (!path || !path.segments.length) throw new Error(`Stage 8 left ${link.id} without a path`);
    if (path.layer !== effectiveLayer(link)) throw new Error(`Path layer on ${link.id} contradicts its effective layer`);
    const ends = link.attachments!;
    const from = findPort(model, ends.from), to = findPort(model, ends.to);
    if (!from?.anchor || !to?.anchor) throw new Error(`Link ${link.id} references a missing port`);
    if (!samePoint(path.segments[0]!.from, from.anchor) || !samePoint(path.segments.at(-1)!.to, to.anchor)) {
      throw new Error(`Path on ${link.id} does not start and end at its port anchors`);
    }
    // `fixed` decides which contract this path answers to, so a restored value that merely looks
    // true is not good enough.
    if (typeof path.fixed !== 'boolean') throw new Error(`Path on ${link.id} has no boolean fixed flag`);
    // The effective width is the one stage 1 resolved from the document, and every path constructor
    // restates it the same way: present when it differs from the shared default, absent otherwise.
    // Placement, the gates and the renderer all read this one number, so a path width that differs
    // — or that merely omits a resolved width — would not be producer output. The expectation is
    // derived from the link alone: reading the path here would compare it with itself.
    const resolved = link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path;
    const expected = resolved === DEFAULT_STROKE_WIDTHS.path ? undefined : resolved;
    if (!equal(expected, path.strokeWidth)) {
      throw new Error(`Path width on ${link.id} contradicts its resolved link width`);
    }
    if (effectiveLayer(link) !== 'routed') {
      // An overlay link is never routed: its path is derived from the boxes placement reserved, so
      // the one deterministic producer is re-run and the published geometry has to be exactly it.
      // Ownership, the absence of a lane or `barCross` claim, and the orthogonal shape all follow
      // from the comparison, and a hand-written layout JSON cannot state a line of its own.
      blockers ??= overlayBlockers(model);
      if (!equal(path.segments, overlayPath(model, link, blockers).segments)) {
        throw new Error(`Overlay path on ${link.id} is not the one its ports and their boxes state`);
      }
      // The same rule every other path answers to: a route that walks back along a run it already
      // drew is not a route. The comparison above already fixes the geometry, so this is the second
      // reader of it — it fails the producer, not the model, if the rule ever states such a route.
      retraces(link.id, path.segments);
      continue;
    }
    // A rule's own path is re-derived and compared by that rule; stage 8 owns every other one, and
    // `validateRegionClaims` rejects a `fixed` path no rule produced.
    if (path.fixed === true) continue;
    const segments = path.segments, reserved = new Set(reservedPositions(link));
    retraces(link.id, segments);
    for (const [index, segment] of segments.entries()) {
      if (!horizontal(segment) && !vertical(segment)) throw new Error(`Routed path on ${link.id} is not orthogonal`);
      if (length(segment) <= EPS) throw new Error(`Routed path on ${link.id} has a zero-length segment`);
      if (index > 0 && !samePoint(segments[index - 1]!.to, segment.from)) throw new Error(`Routed path on ${link.id} is disconnected`);
      if (!reserved.has(index) && (segment.owner.kind !== 'link' || segment.owner.id !== link.id)) {
        throw new Error(`Routed segment on ${link.id} claims foreign ownership`);
      }
      if (!reserved.has(index) && segment.barCross !== undefined) {
        throw new Error(`Routed segment on ${link.id} invents a bar crossing`);
      }
      // A routed gap may touch only its own reserved lanes, collinear and named: G4 admits nothing else.
      if (!reserved.has(index)) {
        const touched = ownedLanes(model, link).filter(lane => segmentRect(segment, lane.bounds));
        if (touched.length > 1) throw new Error(`Routed segment on ${link.id} occupies two reserved lanes at once`);
        if (segment.lane !== (touched[0]?.id)) throw new Error(`Routed segment on ${link.id} contradicts the lanes it occupies`);
        if (touched.length && (!vertical(segment) || Math.abs(segment.from.x - touched[0]!.x) > EPS)) {
          throw new Error(`Routed segment on ${link.id} enters reserved lane ${touched[0]!.id} off its centre`);
        }
      }
    }
    for (const [port, segment, first] of [[from, segments[0]!, true], [to, segments.at(-1)!, false]] as const) {
      if (!outward(port, segment, first)) throw new Error(`Port stem on ${link.id} does not leave its side perpendicular`);
      const index = first ? 0 : segments.length - 1;
      const required = reserved.has(index) ? MIN_STEM : Math.max(MIN_STEM, stemReach(model, model.nodes[port.ref.node]!));
      if (length(segment) < required - EPS) throw new Error(`Port stem on ${link.id} is shorter than its reserved entry`);
    }
  }
  const conflicts = reservationConflicts(model);
  if (conflicts.length) {
    throw new Error(`Routed path on ${conflicts[0]!.link} enters reserved ${conflicts[0]!.reservation}`);
  }
  // Derived metadata last: a route that is wrong about where it goes must be reported for that,
  // not for the stub mark that disagrees with it.
  for (const link of model.links) {
    if (!drawn(link) || !link.path) continue;
    if ((link.stubCandidate ?? false) !== stubCandidate(model, link)) {
      throw new Error(`Stub candidacy on ${link.id} contradicts its measured route`);
    }
  }
}
