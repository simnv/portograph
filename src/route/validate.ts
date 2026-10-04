import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { stemReach } from '../layout/bands.js';
import { findPort } from '../layout/row-paths.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { EPS, horizontal, length, retracingRuns, samePoint, segmentRect, vertical } from '../geometry/planar.js';
import { outward } from '../score/model.js';
import { effectiveLayer, reversedRuns } from './plan.js';
import { isRoutedChord } from '../layout/frame-paths.js';
import { overlayBlockers, overlayEndpoint, overlayPath, publishedOverlayPath, type OverlayBlockers } from '../layout/overlay-paths.js';
import { ownedLanes, stubCandidate } from './paths.js';
import { MIN_STEM, reservations, TOLERANCE, shrink } from './reservations.js';


export interface ReservationConflict { link: string; reservation: string }

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

const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.removed !== true && link.attachments !== undefined;

/**
 * A route that walks back along a run it already drew is not a path — an exact reversal is only
 * the simplest way to do it. `retracingRuns` sweeps the whole path, one interval sweep per line:
 * two pieces of the same route may touch at a bend, never share length. The overlay rule refuses a
 * candidate by the same sweep, so the producer cannot state a path this rejects. `stitchPath` asks the same
 * sweep of a router answer and removes the link (ticket 46), so from a router this throw is an assertion.
 */
export function retraces(id: string, segments: PathSegment[]): void {
  if (retracingRuns(segments)) throw new Error(`Routed path on ${id} retraces itself`);
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
  // A link stage 8 removed has no path, and the model lists exactly those links.
  const removed = model.links.filter(link => link.removed === true).map(link => link.id);
  if (removed.join('|') !== (model.removedLinks ?? []).join('|')) throw new Error('removedLinks does not list the removed links');
  for (const link of model.links) {
    if (link.removed === true && link.path) throw new Error(`Removed link ${link.id} must not carry a path`);
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
    // Where a path has to meet its two ports. A routed path ends on the anchor, and the pill is
    // painted over the inner half of its stem. An overlay path ends on the port's own outward
    // **face**, because the overlay layer is masked out of the pill and a run inside it would never
    // be drawn (stress ticket 30); `overlayEndpoint` names that point, and an end with no side to
    // leave by has no face and keeps its anchor. The rule is the same one in both families — a path
    // starts and ends where its ports are — read at the point each family really draws.
    const attach = (port: LayoutPort, node: string): Point => (effectiveLayer(link) === 'routed' && !isRoutedChord(model, link)
      ? undefined : overlayEndpoint(model.nodes[node], port)) ?? port.anchor!;
    if (!samePoint(path.segments[0]!.from, attach(from, ends.from.node))
      || !samePoint(path.segments.at(-1)!.to, attach(to, ends.to.node))) {
      throw new Error(`Path on ${link.id} does not start and end at its ports`);
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
      // Either the ordinary path or, under `layout.overlayOverBodies`, the one stage 8 publishes (a judged trial route keeps the ordinary one).
      if (!equal(path.segments, overlayPath(model, link, blockers).segments) && !equal(path.segments, publishedOverlayPath(model, link, blockers).segments)) {
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
  // 7f publishes the bar and the stubs of every bus, and every member path is derived from them (mesh-bus.md, section 5).
  for (const bus of model.meshBuses ?? []) {
    if (bus.bar === undefined || bus.stubs === undefined || bus.stubs.length !== bus.nodes.length) throw new Error(`Mesh bus ${bus.id} has no published bar and stubs`);
  }
  // The riser of a joined pair: present on the upper bus, both ends on its x, and one end on each bar (mesh-bus.md, section 11.6). The cross paths
  // are derived from it, so a stale x would leave the drawn riser and the paths disagreeing.
  for (const bus of (model.meshBuses ?? []).filter(item => item.cross !== undefined)) {
    const lower = model.meshBuses!.find(item => item.id === bus.joined), riser = bus.riser;
    if (lower === undefined || riser?.from === undefined || riser.to === undefined || riser.from.x !== riser.x || riser.to.x !== riser.x
      || bus.bar === undefined || lower.bar === undefined || riser.from.y !== bus.bar.from.y || riser.to.y !== lower.bar.from.y
      || riser.x < Math.min(bus.bar.from.x, bus.bar.to.x) - EPS || riser.x > Math.max(bus.bar.from.x, bus.bar.to.x) + EPS
      || riser.x < Math.min(lower.bar.from.x, lower.bar.to.x) - EPS || riser.x > Math.max(lower.bar.from.x, lower.bar.to.x) + EPS) {
      throw new Error(`The riser of ${bus.id} does not stand on the bars it joins`);
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
