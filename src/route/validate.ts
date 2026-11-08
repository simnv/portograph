import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { stemReach } from '../layout/bands.js';
import { endPort } from '../layout/approach.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { EPS, horizontal, length, near, retracingRuns, samePoint, segmentRect, vertical } from '../geometry/planar.js';
import { outward } from '../score/model.js';
import { effectiveLayer, placementRuns, plannedRunsOf, reversedRuns, type PlannedRun } from './plan.js';
import { isRoutedChord } from '../layout/frame-paths.js';
import { pathEnd } from '../layout/path-end.js';
import { sharedBlockers, overlayPath, publishedOverlayPath, type ShapeQuery } from '../layout/overlay-paths.js';
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

/**
 * The model as stage 8 received it: the router's paths, its removals and the stub marks taken away; a rule's own (`fixed`) path kept.
 * The planned-run producers (`placementRuns`) read only a link that has no path and is not removed, so the validator asks them of this
 * view and of nothing else. Only the link list is copied.
 */
export function preRoute(model: LayoutModel): LayoutModel {
  const view: LayoutModel = { ...model, links: model.links.map(link => {
    if (link.path?.fixed === true || (link.path === undefined && link.removed === undefined && link.stubCandidate === undefined)) return link;
    const kept = { ...link };
    delete kept.path; delete kept.removed; delete kept.stubCandidate;
    return kept;
  }) };
  delete view.removedLinks;
  return view;
}

/**
 * A maximal straight piece of a path: consecutive segments of one link owner on one line and in one direction, joined end to end.
 * The stitcher joins a planned run to the routed gap beyond it where they are one straight run, and a lane corridor cuts a run in
 * two (`laneRuns`), so a planned segment lies inside a chain and need not equal one segment of the path.
 */
interface Chain { from: Point; to: Point; owner: string }

function chainsOf(segments: readonly PathSegment[]): Chain[] {
  const chains: Chain[] = [];
  let open = false;
  for (const segment of segments) {
    if (segment.owner.kind !== 'link') { open = false; continue; }
    const tail = chains.at(-1);
    const line = (axis: 'x' | 'y', cross: 'x' | 'y'): boolean => near(tail!.from[cross], tail!.to[cross]) && near(segment.from[cross], segment.to[cross])
      && Math.sign(tail!.to[axis] - tail!.from[axis]) === Math.sign(segment.to[axis] - segment.from[axis]);
    const along = tail !== undefined && open && tail.owner === segment.owner.id && samePoint(tail.to, segment.from) && (line('y', 'x') || line('x', 'y'));
    if (along) tail.to = segment.to;
    else chains.push({ from: segment.from, to: segment.to, owner: segment.owner.id });
    open = true;
  }
  return chains;
}

/**
 * The first planned run that `segments` does not keep, or undefined when it keeps them all (decision D-Q2). Each planned segment lies
 * inside one chain of the path (`chainsOf`): on the same line, with the same link owner, running the planned way, and the chains that
 * hold the planned segments come in the planned order. A collinear merge with the same owner therefore passes; a run moved off its
 * line, given another owner, reversed or reordered is lost. No planned run (an empty list) requires nothing.
 */
export function lostPlannedRun(segments: readonly PathSegment[], planned: readonly PlannedRun[]): PlannedRun | undefined {
  const chains = chainsOf(segments);
  let cursor = 0;
  for (const run of planned) {
    for (const segment of run.segments) {
      const owner = segment.owner.kind === 'link' ? segment.owner.id : undefined;
      const axis = vertical(segment) ? 'y' : 'x', cross = axis === 'y' ? 'x' : 'y';
      const low = Math.min(segment.from[axis], segment.to[axis]), high = Math.max(segment.from[axis], segment.to[axis]);
      const sign = Math.sign(segment.to[axis] - segment.from[axis]);
      const found = chains.findIndex((chain, index) => index >= cursor && chain.owner === owner
        && Math.abs(chain.from[cross] - segment.from[cross]) <= EPS && Math.abs(chain.to[cross] - segment.from[cross]) <= EPS
        && Math.min(chain.from[axis], chain.to[axis]) <= low + EPS && Math.max(chain.from[axis], chain.to[axis]) >= high - EPS
        && Math.sign(chain.to[axis] - chain.from[axis]) === sign);
      if (found < 0) return run;
      cursor = found;
    }
  }
  return undefined;
}

/**
 * `frozenChords` names exactly the links that hold a routed chord: `freezeChords` writes the links `isRoutedChord` holds, and from then
 * on a named link keeps its chord. The tier-gap plan leaves every named link out (`tierGapPlan`), so a name the published geometry does
 * not hold would take that link's planned runs out of `plannedRunsKept`. The record is read against the geometry, never trusted (R5).
 * Absent: not frozen yet, no name to check. Empty: frozen with no chord held.
 */
function frozenChordsHeld(model: LayoutModel): void {
  for (const id of model.frozenChords ?? []) {
    const link = model.links.find(item => item.id === id);
    if (link === undefined || !isRoutedChord(model, link)) throw new Error(`frozenChords names ${id}, which holds no routed chord`);
  }
}

/**
 * Every run placement planned for a routed link stays in its path, with its owner and traversal (decision D-Q2), as the fixed and
 * shared runs do (`reservedPositions`), even where another route would pass the gates. The one producer (`placementRuns`) runs again
 * on the published or restored placement, seen as stage 8 received it; nothing new is recorded. A producer that cannot read the
 * placement throws, and the model is refused (R6).
 */
function plannedRunsKept(model: LayoutModel): void {
  frozenChordsHeld(model);
  let placed: ReturnType<typeof placementRuns> | undefined;
  for (const link of model.links) {
    if (!drawn(link) || !link.path || link.path.fixed === true || effectiveLayer(link) !== 'routed') continue;
    placed ??= placementRuns(preRoute(model));
    const lost = lostPlannedRun(link.path.segments, plannedRunsOf(placed, link.id));
    if (!lost) continue;
    const owner = lost.segments[0]!.owner, name = owner.kind === 'link' ? owner.id : owner.kind;
    throw new Error(lost.kind === 'leg'
      ? `Routed path on ${link.id} does not keep the leg placement planned for ${name} in its row gap`
      : `Routed path on ${link.id} does not keep the run placement planned for ${name} in its tier gap (part ${lost.index})`);
  }
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
 * paths, exact reserved runs, the runs placement planned (`plannedRunsKept`), perpendicular stems,
 * link ownership of the routed gaps, and the reservations the public gates do not cover.
 */
export function validateRoutedPaths(model: LayoutModel, requireComplete = false): void {
  // Built on the first overlay link and shared by the rest; a diagram with none pays nothing.
  let blockers: ShapeQuery | undefined;
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
    const from = endPort(model, link, 'from'), to = endPort(model, link, 'to');
    if (!from?.anchor || !to?.anchor) throw new Error(`Link ${link.id} references a missing port`);
    // Where a path has to meet its two ports: the path-end rule by producer (`pathEnd`). A
    // stem-built path ends on the anchor, and the pill is painted over the inner half of its stem.
    // A chord-built path (an overlay path, a routed chord) ends on the port's own outward **face**,
    // because the overlay layer is masked out of the pill and a chord has no stem (stress ticket 30,
    // ticket 34). G7 `endpoint-anchor` and the renderers read the same module.
    const head = pathEnd(model, link, 'from'), tail = pathEnd(model, link, 'to');
    if (head === undefined || tail === undefined) throw new Error(`Link ${link.id} references a missing port`);
    if (!samePoint(path.segments[0]!.from, head) || !samePoint(path.segments.at(-1)!.to, tail)) {
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
      blockers ??= sharedBlockers(model);
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
  for (const bus of (model.meshBuses ?? []).filter(item => item.cross !== undefined && item.trunk === undefined)) {
    const lower = model.meshBuses!.find(item => item.id === bus.joined), riser = bus.riser;
    if (lower === undefined || riser?.from === undefined || riser.to === undefined || riser.from.x !== riser.x || riser.to.x !== riser.x
      || bus.bar === undefined || lower.bar === undefined || riser.from.y !== bus.bar.from.y || riser.to.y !== lower.bar.from.y
      || riser.x < Math.min(bus.bar.from.x, bus.bar.to.x) - EPS || riser.x > Math.max(bus.bar.from.x, bus.bar.to.x) + EPS
      || riser.x < Math.min(lower.bar.from.x, lower.bar.to.x) - EPS || riser.x > Math.max(lower.bar.from.x, lower.bar.to.x) + EPS) {
      throw new Error(`The riser of ${bus.id} does not stand on the bars it joins`);
    }
  }
  // A trunk join: every bar of it runs to the trunk x, which the lane of the head bus holds (mesh-bus.md, section 12.5).
  for (const head of (model.meshBuses ?? []).filter(item => item.trunk !== undefined)) {
    const lane = model.lanes.find(item => item.id === head.trunk!.lane);
    if (lane === undefined || head.trunk!.x !== lane.x) throw new Error(`The trunk of ${head.id} contradicts its lane`);
    const joins = head.trunk!.joins, bars = head.trunk!.buses.map(id => model.meshBuses!.find(item => item.id === id)?.bar);
    if (joins?.length !== bars.length || joins.some((point, index) => point.x !== lane.x || bars[index] === undefined || Math.abs(point.y - bars[index]!.from.y) > EPS)) throw new Error(`The trunk of ${head.id} does not stand on the bars it joins`);
    for (const id of head.trunk!.buses) {
      const bar = model.meshBuses!.find(item => item.id === id)?.bar;
      if (bar === undefined || Math.min(bar.from.x, bar.to.x) > lane.x + EPS || Math.max(bar.from.x, bar.to.x) < lane.x - EPS) throw new Error(`The bar of ${id} does not reach the trunk of ${head.id}`);
    }
  }
  const conflicts = reservationConflicts(model);
  if (conflicts.length) {
    throw new Error(`Routed path on ${conflicts[0]!.link} enters reserved ${conflicts[0]!.reservation}`);
  }
  // After the older, more specific refusals: a route that enters a reservation is named for that.
  plannedRunsKept(model);
  // Derived metadata last: a route that is wrong about where it goes must be reported for that,
  // not for the stub mark that disagrees with it.
  for (const link of model.links) {
    if (!drawn(link) || !link.path) continue;
    if ((link.stubCandidate ?? false) !== stubCandidate(model, link)) {
      throw new Error(`Stub candidacy on ${link.id} contradicts its measured route`);
    }
  }
}
