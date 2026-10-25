import type { PortRef } from '../model/document.js';
import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { bottom, EPS, retracingRuns, right, samePoint, segmentRectDistance } from '../geometry/planar.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth, overlayPortClearance, overlayTrackPitch, pathStrokeWidth } from '../theme/geometry.js';
import { overlayCrossingPairs } from './read/crossings.js';
import { bodiesOf, paddingOf, reachBeyond, sharedTrackPairs, TrackIndex } from './overlay-tracks.js';
import type { TrackPath } from './overlay-tracks.js';
import { RectangleIndex } from './rectangle-index.js';
import { findPort } from './row-paths.js';
import { courseGeometry, ringsOf } from './course-lanes.js';

/**
 * The **overlay port clearance** at the default stroke: where the straight segment is refused and the
 * orthogonal derivation answers instead, how far outside the face that path turns, and the margin its
 * ways round the pair keep. Each link reads its own stroke through `overlayPortClearance` (the dot of
 * a bare end, plus `OVERLAY_GAP`; architecture-2 ticket 23); this is that number for a 1.5 px stroke,
 * 7.75 px. It was twice the endpoint mark's radius (4 px) until the bare-end dot outgrew the mark and
 * the turn read as lying on the face (user, 2026-10-23).
 *
 * Measured from the **face**, not from the anchor: the anchor is the pill's centre and the renderer
 * masks the pill, so a stub measured from the anchor is shorter than the pill's own half-length —
 * 12 px even for a two-character port name, and the pill grows with the name — and nothing of it is
 * ever drawn. From the face, the whole step is drawn and the line meets the pill square, which is
 * what the maintainer chose over the anchor-to-anchor line (stress ticket 20).
 */
export const OVERLAY_PILL_CLEARANCE = overlayPortClearance(DEFAULT_STROKE_WIDTHS.path);

/** Unit vector pointing out of a node through the named side. */
const NORMAL: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** Every node body and every drawn port pill: the shapes an overlay link goes round. */
export type OverlayShape = Rect & { readonly pill?: true };
export type OverlayBlockers = RectangleIndex<OverlayShape>;
/** What the straight test asks of the shapes: the index, or a composite that adds shapes the index does not hold (ticket 143). */
export type ShapeQuery = Pick<OverlayBlockers, 'some'>;

/** Every body and drawn pill of the model, in a fresh index the caller owns. */
export function overlayBlockers(model: LayoutModel, skip?: ReadonlySet<string>): OverlayBlockers {
  const boxes: { bounds: Rect; value: OverlayShape }[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    if (skip?.has(id)) continue;
    if (node.bounds) boxes.push({ bounds: node.bounds, value: node.bounds });
    for (const port of node.ports) {
      if (port.pill && port.ref.anonymous !== true) boxes.push({ bounds: port.pill.bounds, value: { ...port.pill.bounds, pill: true } });
    }
  }
  return new RectangleIndex(boxes);
}

/**
 * The same shapes for the layout's own reads. The index depends on nothing but the boxes it holds, in order, so the last few per model are kept by
 * those boxes' numbers: the same bodies and pills come round again and again (a probe and a rebuild that moved nothing). Only `some` is handed out, so
 * a caller cannot change a kept index, and the cache lives and dies with the model, never beyond one layout. A body is held as a copy.
 */
const BLOCKER_CACHE_SIZE = 8;
const cachedBlockers = new WeakMap<LayoutModel, { signature: number[]; view: ShapeQuery }[]>();
const sameNumber = (a: number, b: number): boolean => a === b && (a !== 0 || 1 / a === 1 / b);
function sameSignature(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameNumber(a[i]!, b[i]!)) return false;
  return true;
}
export function sharedBlockers(model: LayoutModel, skip?: ReadonlySet<string>): ShapeQuery {
  const signature: number[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    if (skip?.has(id)) continue;
    const body = node.bounds;
    if (body) signature.push(1, body.x, body.y, body.width, body.height);
    else signature.push(0);
    const at = signature.length;
    signature.push(0);
    for (const port of node.ports) {
      if (!port.pill || port.ref.anonymous === true) continue;
      const pill = port.pill.bounds;
      signature[at]!++;
      signature.push(pill.x, pill.y, pill.width, pill.height);
    }
  }
  let kept = cachedBlockers.get(model);
  if (kept === undefined) cachedBlockers.set(model, kept = []);
  for (let i = 0; i < kept.length; i++) {
    const held = kept[i]!;
    if (!sameSignature(held.signature, signature)) continue;
    if (i > 0) { kept.splice(i, 1); kept.unshift(held); }
    return held.view;
  }
  const boxes: { bounds: Rect; value: OverlayShape }[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    if (skip?.has(id)) continue;
    if (node.bounds) boxes.push({ bounds: node.bounds, value: { ...node.bounds } });
    for (const port of node.ports) {
      if (port.pill && port.ref.anonymous !== true) boxes.push({ bounds: port.pill.bounds, value: { ...port.pill.bounds, pill: true } });
    }
  }
  const index = new RectangleIndex(boxes);
  const view: ShapeQuery = { some: (bounds, predicate, work, padding) => index.some(bounds, predicate, work, padding) };
  kept.unshift({ signature, view });
  if (kept.length > BLOCKER_CACHE_SIZE) kept.pop();
  return view;
}

/** Whether an axis-aligned segment reaches inside `box`, rather than only touching its edge. */
const enters = (from: Point, to: Point, box: Rect): boolean =>
  Math.max(from.x, to.x) > box.x + EPS && Math.min(from.x, to.x) < right(box) - EPS
  && Math.max(from.y, to.y) > box.y + EPS && Math.min(from.y, to.y) < bottom(box) - EPS;

/**
 * The same question for a segment of any angle: the parameter range that survives clipping against
 * the box's four slabs, each pulled in by `EPS` so a line along a face is clear. `enters` reads a
 * bounding box, which is exact for an axis-aligned run and far too wide for a diagonal.
 *
 * Why not `score/geometry`'s `segmentRect`: that one is the **closed** predicate and *expands* the
 * rectangle by `EPS`, so it counts a touch as a hit. This rule needs the open one — a path that
 * rides a pill face is clear of it, which is exactly what the `tooClose` reduction states and what
 * `enters` has always meant here. The two disagree only on that boundary, which is the point.
 */
export function crosses(from: Point, to: Point, box: Rect): boolean {
  let low = 0, high = 1;
  const slabs: readonly (readonly [number, number])[] = [
    [from.x - to.x, from.x - (box.x + EPS)], [to.x - from.x, right(box) - EPS - from.x],
    [from.y - to.y, from.y - (box.y + EPS)], [to.y - from.y, bottom(box) - EPS - from.y],
  ];
  for (const [rate, room] of slabs) {
    if (Math.abs(rate) <= EPS) { if (room < 0) return false; continue; }
    const at = room / rate;
    if (rate < 0) { if (at > high) return false; if (at > low) low = at; }
    else { if (at < low) return false; if (at < high) high = at; }
  }
  return high - low > EPS;
}

/** A polyline with no repeated point, so a degenerate corner leaves no zero-length segment. */
const compact = (points: readonly Point[]): Point[] =>
  points.filter((point, index) => index === 0 || !samePoint(points[index - 1]!, point));

/**
 * The same polyline with every point that turns nothing dropped. A point is dropped when it lies
 * **between** its two neighbours on one axis, which a point that doubles back does not — so a
 * candidate that walks back the way it came keeps the reversal and is refused by `retraces` rather
 * than straightened into something it is not.
 */
function straighten(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const [index, point] of points.entries()) {
    const before = out[out.length - 1], after = points[index + 1];
    const flat = before !== undefined && after !== undefined
      && (Math.abs(before.x - point.x) <= EPS && Math.abs(point.x - after.x) <= EPS
        && (point.y - before.y) * (after.y - point.y) > 0
        || Math.abs(before.y - point.y) <= EPS && Math.abs(point.y - after.y) <= EPS
        && (point.x - before.x) * (after.x - point.x) > 0);
    if (!flat) out.push(point);
  }
  return out;
}

const axisAligned = (points: readonly Point[]): boolean => points.slice(1).every((point, index) =>
  Math.abs(point.x - points[index]!.x) <= EPS || Math.abs(point.y - points[index]!.y) <= EPS);

const polylineLength = (points: readonly Point[]): number => points.slice(1)
  .reduce((total, point, index) => total + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);

/**
 * One end of an overlay link: the port's anchor, the box the link leaves — the pill when the port
 * draws one, the node body when it does not — the point on that box's outward face, which is where
 * the path starts, and the point one clearance beyond it, which is where the route between the two
 * ends begins. `pill` is that box again when it really is a pill, and `undefined` when the port
 * draws none: the straight branch drops its own two pills from the shapes it tests against, and a
 * node body is not one of them.
 */
export interface OverlayEnd { anchor: Point; box: Rect; pill: Rect | undefined; face: Point; clear: Point; out: Point; step: number }

/** `strokeWidth` is the link's (`linkStrokeWidth`): the step out of the face is that link's overlay port clearance. */
export function overlayEnd(node: LayoutNode, port: LayoutPort, strokeWidth: number = DEFAULT_STROKE_WIDTHS.path): OverlayEnd | undefined {
  if (!port.anchor || !port.side || !node.bounds) return undefined;
  const pill = port.pill && port.ref.anonymous !== true ? port.pill.bounds : undefined;
  const box = pill ?? node.bounds;
  const out = NORMAL[port.side];
  // The outward face of the box on this side, plus the clearance, measured from the anchor.
  const face = port.side === 'top' ? box.y : port.side === 'bottom' ? bottom(box)
    : port.side === 'left' ? box.x : right(box);
  const depth = Math.abs((out.x !== 0 ? port.anchor.x : port.anchor.y) - face);
  const outward = (by: number): Point => ({ x: port.anchor!.x + out.x * by, y: port.anchor!.y + out.y * by });
  const step = overlayPortClearance(strokeWidth);
  return { anchor: { ...port.anchor }, box, pill,
    face: outward(depth), clear: outward(depth + step), out, step };
}

/**
 * Where an overlay link's path **begins and ends**: the point on the port's own outward face the
 * line leaves by, which is the pill's outward edge at the anchor's own offset along the side, or the
 * node body's edge — and so the anchor itself — where the port draws no pill.
 *
 * *"point should be on a side of a pill"*, and *"path should also start on the point"* (maintainer,
 * 2026-09-16, stress ticket 30). The anchor is the pill's centre and the renderer masks the pill, so
 * a path that started there carried a run no reader ever saw and put the **overlay endpoint mark**
 * — drawn above the mask — in the middle of the port's own name. From the face the path is exactly
 * what is drawn at its two ends, and the mark sits where the line meets the pill.
 *
 * `undefined` when the end states no side, no anchor or no node box: there is then no outward face
 * to read, that end keeps its anchor, and the link falls back to the one straight segment every
 * release before this one drew. `route/validate` and G7 `endpoint-anchor` read this same function,
 * so the gate still names one point per end and the producer cannot drift from it.
 */
export function overlayEndpoint(node: LayoutNode | undefined, port: LayoutPort | undefined): Point | undefined {
  return node && port ? overlayEnd(node, port)?.face : undefined;
}

/**
 * Whether the two ends face each other **on one line** across a gap narrower than their two
 * clearances. Each end leaves its own outward face by `OVERLAY_PILL_CLEARANCE`, so such a pair
 * states the two cleared ends the wrong way round, and both stubs lie on the line the two anchors
 * share: every one of the eight ways then walks back along the run the other stub already drew, the
 * sweep refuses all of them, and the link loses its route. A pair that faces across two different
 * lines keeps its clearance — its stubs cannot cover each other, so a way round is still open.
 */
function tooClose(head: OverlayEnd, tail: OverlayEnd): boolean {
  const along = (from: Point, to: Point): number => (to.x - from.x) * head.out.x + (to.y - from.y) * head.out.y;
  const across = (head.anchor.x - tail.anchor.x) * head.out.y - (head.anchor.y - tail.anchor.y) * head.out.x;
  return head.out.x === -tail.out.x && head.out.y === -tail.out.y && Math.abs(across) <= EPS
    && along(head.anchor, tail.anchor) > EPS && along(head.clear, tail.clear) < -EPS;
}

/**
 * The route between the two cleared ends, or `undefined` when no candidate clears even the two end
 * boxes.
 *
 * Eight candidates, all of them read off the two end boxes. The first two turn once. Four go right
 * round the pair, on a run one clearance outside the pair's own extent on each of the four
 * sides. Two more run down the middle of the gap between the boxes, on each axis — the case two
 * ports that face away from each other over a gap need, and the one no outside run reaches.
 *
 * They are judged twice, in a preference order. A route that enters **no node body and no pill**
 * wins outright; the shortest of those is taken, and a tie goes to the one listed first, which is
 * the single turn that carries on the way the source port faces — the three-segment detour the
 * maintainer drew by hand in draw.io. When every candidate is blocked, the shortest that clears the
 * link's own two end boxes is taken instead: the eight ways are read off those two boxes alone, so
 * a shape that lands on all of them cannot be dodged without searching, and going round the pill is
 * the principle that must survive (`.scratch/drawio-export/issues/02-maintainer-edit-principles.md`,
 * principle 2). Only when even that fails does the caller keep the straight segment.
 */
function between(head: OverlayEnd, tail: OverlayEnd, blockers: ShapeQuery, collect?: Point[][]): Point[] | undefined {
  const from = head.clear, to = tail.clear;
  const boxes = [head.box, tail.box];
  // The link's overlay port clearance: both ends carry the one stroke of the link.
  const step = Math.max(head.step, tail.step);
  const before = (of: (box: Rect) => number): number => Math.min(...boxes.map(of)) - step;
  const after = (of: (box: Rect) => number): number => Math.max(...boxes.map(of)) + step;
  const above = before(box => box.y), below = after(bottom);
  const left = before(box => box.x), far = after(right);
  /** The middle of the gap the two boxes leave on one axis; inside a box when they overlap on it. */
  const gap = (low: (box: Rect) => number, high: (box: Rect) => number): number =>
    (Math.max(...boxes.map(low)) + Math.min(...boxes.map(high))) / 2;
  const midX = gap(box => box.x, right), midY = gap(box => box.y, bottom);
  const turn = { x: to.x, y: from.y }, bend = { x: from.x, y: to.y };
  // The shapes that stand in the way of a run outside the pair. The four runs round
  // the pair are read off the two end boxes alone, and a body taller than a pill (every node body is)
  // that stands between two level side ports holds all four inside itself — so a second set of runs
  // goes round **those shapes**, one clearance outside the extent they make together (ticket 86).
  // The hull is grown to a fixed point: it starts as the rectangle the two end boxes and the two
  // cleared points span, every shape it meets one clearance out is added, and it is read again, so a
  // pill that hangs off a standing body is inside the runs' clearance too.
  const meets = (box: Rect, other: Rect): boolean => box.x <= right(other) - EPS && right(box) >= other.x + EPS
    && box.y <= bottom(other) - EPS && bottom(box) >= other.y + EPS;
  const hull = { left: Math.min(from.x, to.x, ...boxes.map(box => box.x)), top: Math.min(from.y, to.y, ...boxes.map(box => box.y)),
    right: Math.max(from.x, to.x, ...boxes.map(right)), bottom: Math.max(from.y, to.y, ...boxes.map(bottom)) };
  for (let grown = true; grown;) {
    grown = false;
    const reach: Rect = { x: hull.left - step, y: hull.top - step,
      width: hull.right - hull.left + 2 * step, height: hull.bottom - hull.top + 2 * step };
    blockers.some(reach, box => {
      if (!meets(reach, box)) return false;
      if (box.x < hull.left || right(box) > hull.right || box.y < hull.top || bottom(box) > hull.bottom) grown = true;
      hull.left = Math.min(hull.left, box.x); hull.right = Math.max(hull.right, right(box));
      hull.top = Math.min(hull.top, box.y); hull.bottom = Math.max(hull.bottom, bottom(box));
      return false;
    });
  }
  const outerAbove = Math.min(above, hull.top - step);
  const outerBelow = Math.max(below, hull.bottom + step);
  const outerLeft = Math.min(left, hull.left - step);
  const outerFar = Math.max(far, hull.right + step);
  const ways: Point[][] = [
    // One turn, starting the way the source port faces.
    ...(head.out.x !== 0 ? [[turn], [bend]] : [[bend], [turn]]),
    // Right round the pair, on each of its four sides.
    [{ x: from.x, y: above }, { x: to.x, y: above }],
    [{ x: from.x, y: below }, { x: to.x, y: below }],
    [{ x: left, y: from.y }, { x: left, y: to.y }],
    [{ x: far, y: from.y }, { x: far, y: to.y }],
    // Down the middle of the gap between them, on each axis. A run that falls inside a box — which
    // is what an overlap gives — is refused by the same test as every other candidate.
    [{ x: midX, y: from.y }, { x: midX, y: to.y }],
    [{ x: from.x, y: midY }, { x: to.x, y: midY }],
    // Right round every shape that stands in the way of a run outside the pair.
    [{ x: from.x, y: outerAbove }, { x: to.x, y: outerAbove }],
    [{ x: from.x, y: outerBelow }, { x: to.x, y: outerBelow }],
    [{ x: outerLeft, y: from.y }, { x: outerLeft, y: to.y }],
    [{ x: outerFar, y: from.y }, { x: outerFar, y: to.y }],
  ];
  const everySegment = (points: readonly Point[], blocked: (one: Point, two: Point) => boolean): boolean =>
    points.slice(1).every((point, index) => !blocked(points[index]!, point));
  /**
   * Whether the whole drawn polyline — the two stubs included — ever walks back along a run it
   * already drew. A candidate can leave the source by the clearance and then turn back toward its
   * own head, when the two cleared ends are less than one clearance apart along the source's
   * normal: it enters no box, ties in length with the clean turn and would win on order. A route
   * that retraces is not a route, and `route/validate` fails every path — an overlay path included
   * — by the same sweep, so the candidate is measured with `retracingRuns` and not by the steps at
   * one corner: two stubs that share a line overlap without ever being adjacent (ticket 04 A).
   */
  const retraces = (points: readonly Point[]): boolean =>
    retracingRuns(points.slice(1).map((point, index) => ({ from: points[index]!, to: point })));
  /**
   * The whole polyline this candidate publishes, its two outward steps included — **from face to
   * face**, which is what is published and so what `route/validate` re-derives and reads `retraces`
   * over. That is a change, not a restatement: this filter used to close the polyline at the two
   * anchors while the validator read what stage 8 published, so the two measured different lines and
   * the filter's was the longer by a pill half-depth at each end (stress ticket 30). They now read
   * the same one, which is the only way the producer can be sure it never states a path its own
   * validator throws on.
   */
  const whole = (points: readonly Point[]): Point[] => straighten(compact([head.face, ...points, tail.face]));
  const bends = (points: readonly Point[]): boolean => straighten(points).length > 2;
  const clearOfAll = (points: readonly Point[]): boolean => everySegment(points, (one, two) => {
    const box = { x: Math.min(one.x, two.x), y: Math.min(one.y, two.y),
      width: Math.abs(two.x - one.x), height: Math.abs(two.y - one.y) };
    return blockers.some(box, blocker => enters(one, two, blocker));
  });
  const clearOfPills = (points: readonly Point[]): boolean => everySegment(points, (one, two) => {
    const box = { x: Math.min(one.x, two.x), y: Math.min(one.y, two.y),
      width: Math.abs(two.x - one.x), height: Math.abs(two.y - one.y) };
    return blockers.some(box, blocker => blocker.pill === true && enters(one, two, blocker))
      || boxes.some(end => enters(one, two, end));
  });
  const clearOfEnds = (points: readonly Point[]): boolean =>
    everySegment(points, (one, two) => boxes.some(box => enters(one, two, box)));
  // A way round can land on the line the two cleared points already share, and then it states a corner
  // that is not one. That candidate is one straight run between the cleared ends, and the ends-only
  // test below would take it as the shortest: two level side ports with a body between them then drew
  // the straight segment through that body (ticket 86). `bends` refuses it — a candidate is a way
  // *round*, so it keeps at least one real corner — and the straight run stays the straight branch's
  // own answer, which tests every body. The retrace test reads the whole drawn polyline, stubs included, because that is
  // where the retrace lives; the box tests read the part between the cleared ends, because the
  // stubs are the port's own reserved outward reach and cross nothing else.
  const candidates = ways.map(way => compact([from, ...way, to]))
    .filter(points => axisAligned(points) && !retraces(whole(points)) && bends(points));
  const shortest = (clear: (points: readonly Point[]) => boolean): Point[] | undefined => {
    let best: { points: Point[]; length: number } | undefined;
    for (const points of candidates) {
      if (!clear(points)) continue;
      const length = polylineLength(points);
      if (best === undefined || length < best.length - EPS) best = { points, length };
    }
    return best?.points;
  };
  // Every way that clears every shape, shortest first and then in the order listed: the ways track separation may take instead (ticket 23).
  if (collect !== undefined) collect.push(...candidates.filter(clearOfAll).map((points, index) => ({ points, index, length: polylineLength(points) }))
    // Last key: the order the ways are listed in.
    .sort((a, b) => a.length < b.length - EPS ? -1 : b.length < a.length - EPS ? 1 : a.index - b.index).map(item => item.points));
  return shortest(clearOfAll) ?? shortest(clearOfPills) ?? shortest(clearOfEnds);
}

/**
 * Whether the straight branch answers: **one segment, face to face**, and nothing between. The empty
 * list is that answer — there is no point between the two ends — and `undefined` says a node stands
 * on the line, so the orthogonal derivation is asked instead.
 *
 * There is no stub here (maintainer, 2026-09-16, *"no point in stub then"*, stress ticket 30). The
 * stub had two jobs and the endpoint move retired both: it made the line meet the pill square rather
 * than at an angle, and it kept the endpoint mark clear of the pill. The path now starts on the face
 * and the mark is drawn there, so all the stub added was a 4 px kink under the dot. An overlay link
 * is the pill face, one straight segment at whatever angle, and the pill face. The **orthogonal**
 * branch keeps `OVERLAY_PILL_CLEARANCE`: it has to step outward before it can turn.
 *
 * **What counts as a node in the way** (stress ticket 20, the agent's reading of the maintainer's
 * *"only if link goes through node, we route it orthogonally"*, stated here so one word can correct
 * it): every node **body** and every drawn port **pill**, the link's own two ends included. A pill
 * is part of what the reader sees as the node, and a port on the far side of its own body makes that
 * body as much of an obstacle as any other — `overlay-blocked-by-a-body` is exactly that case. Not
 * another overlay line: overlay links are drawn thin and translucent so that they may cross each
 * other, and they are exempt from the clearance gates. Not a group box, not a lane, not a routed
 * path, not a label.
 *
 * **The segment must leave each port outward.** This is the branch's own condition, not a detail of
 * the test above: at both ends the segment's direction, taken *out of* that end, may not point back
 * along the port's own outward normal. Zero is allowed, and is what two ports level on one side
 * make — the line rides both faces, which is what a reader sees as leaving them. Strictly inward is
 * a port that **faces away** from its partner, and a line leaving such a port runs back under that
 * port's own pill; the overlay layer is masked out of every pill, so the mask would cut the line
 * away from its own endpoint mark. The orthogonal branch answers those, stepping outward before it
 * turns, and that is the one shape removing the stub moves (stress ticket 30).
 *
 * **So a link's own two pills are dropped from the shapes it is tested against** (maintainer,
 * 2026-09-16). They carry nothing the guard does not already have: leaving a face outward means the
 * segment's distance along that normal rises from zero and never falls, so it cannot re-enter the
 * pill behind it, and riding the face is the open boundary `crosses` already calls clear. Keeping
 * them only restated the guard's job in sub-pixel arithmetic — a tilt reaching 0.02 px inside a pill
 * read as an obstruction. Every node **body** stays, the link's own two included: a port on the far
 * side of its own body still has that body in the way.
 */
export function straightBetween(head: OverlayEnd, tail: OverlayEnd, blockers: ShapeQuery): Point[] | undefined {
  const from = head.face, to = tail.face;
  /** Whether the segment leaves this end outward rather than turning back into its own port. */
  const leaves = (end: OverlayEnd, towards: Point, away: Point): boolean =>
    (towards.x - away.x) * end.out.x + (towards.y - away.y) * end.out.y >= -EPS;
  if (!leaves(head, to, from) || !leaves(tail, from, to)) return undefined;
  // The link's own two pills, matched by **geometry** rather than by object identity. The index is
  // usually built from the very model these ends were read from, so identity would work today — and
  // would fail silently the first time a caller passed an index built from a structurally equal
  // clone, quietly putting the own-pill test back. Two drawn pills cannot share a rectangle, since
  // that would mean two ports drawn on top of each other, so equal geometry is the same pill.
  const own = (box: Rect): boolean => [head.pill, tail.pill].some(pill => pill !== undefined
    && pill.x === box.x && pill.y === box.y && pill.width === box.width && pill.height === box.height);
  const window: Rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
  if (blockers.some(window, box => !own(box) && crosses(from, to, box))) return undefined;
  // No retrace test: the branch publishes one segment, and one segment cannot walk back along a run
  // it already drew. The test this replaces read two stubs that could be stated the wrong way round,
  // and there are no stubs here.
  return [];
}

/**
 * The polyline of an overlay link from two ends: the straight segment, or the orthogonal derivation where a shape stands on it.
 * `overlayPath` draws exactly this; the window rule of `placeOverlayFree` (ticket 147) reads it for a shifted end, without a model copy.
 */
export function chordPoints(one: OverlayEnd, two: OverlayEnd, blockers: ShapeQuery, ways?: Point[][]): Point[] {
  const { head, tail } = tooClose(one, two)
    ? { head: { ...one, clear: one.face }, tail: { ...two, clear: two.face } }
    : { head: one, tail: two };
  const found: Point[][] = [];
  const straight = straightBetween(head, tail, blockers);
  const middle = straight ?? between(head, tail, blockers, ways === undefined ? undefined : found);
  // `ways` collects, face to face, every way round that clears every shape, shortest first (ticket 23).
  ways?.push(...found.map(points => straighten(compact([head.face, ...points, tail.face]))));
  return middle ? straighten(compact([head.face, ...middle, tail.face])) : [{ ...one.face }, { ...two.face }];
}

/**
 * The node bodies a link's straight chord passes over, under the opt-in `layout.overlayOverBodies` (ticket 152); `undefined` when the
 * link is drawn by the ordinary rule. The setting is off by default and then this is always `undefined`, so the default output is unchanged.
 *
 * It answers only for a link the ordinary rule bends, whose straight chord is blocked **by node bodies alone**: the chord must leave
 * both ports outward, must meet no foreign pill, and must meet neither of its own two end bodies. Only bodies of other nodes are
 * passed over. A title band and a frame edge are no overlay blocker at all (an overlay chord lies under a title), so they never
 * make a link qualify or fail to.
 *
 * Only stage 8 reads this (through `publishedOverlayPath`). Placement and every other reader of `overlayPath` keep the ordinary rule.
 */
export function overlayOverBodies(model: LayoutModel, link: LayoutLink, blockers: ShapeQuery): string[] | undefined {
  if (model.document.layout?.overlayOverBodies !== true || link.meshBus !== undefined || !link.attachments) return undefined;
  const read = chordEnds(model, link);
  if (!read) return undefined;
  const one = read.head, two = read.tail;
  // Already straight by the ordinary rule: nothing is passed over.
  if (straightBetween(one, two, blockers) !== undefined) return undefined;
  const own = [link.attachments.from.node, link.attachments.to.node];
  const ownBodies = own.map(id => model.nodes[id]?.bounds);
  const same = (a: Rect, b: Rect | undefined): boolean => b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  // The ordinary test, minus every body that is not one of the link's own two.
  const pillsAndOwn: ShapeQuery = { some: (window, test) => blockers.some(window, box => (box.pill === true || ownBodies.some(body => same(box, body))) && test(box)) };
  if (straightBetween(one, two, pillsAndOwn) === undefined) return undefined;
  const passed = bodiesUnder(model, link, [one.face, two.face]);
  return passed.length ? passed : undefined;
}

/** The bodies of other nodes that the straight segment between two points crosses. */
function bodiesUnder(model: LayoutModel, link: LayoutLink, [from, to]: [Point, Point]): string[] {
  const own = [link.attachments!.from.node, link.attachments!.to.node];
  return Object.entries(model.nodes).filter(([id, node]) => !own.includes(id) && node.bounds !== undefined
    && crosses(from, to, node.bounds)).map(([id]) => id);
}

/**
 * The bodies a **published** overlay path was drawn over (ticket 152): a one-segment path that crosses the body of a node that is not
 * one of the link's ends. Read from the path itself, so the diagnostic restates the decision of `publishedOverlayPath` rather than making it again.
 */
export function bodiesPassedOver(model: LayoutModel, link: LayoutLink, path: LayoutPath): string[] {
  if (path.segments.length !== 1 || !link.attachments) return [];
  const { from, to } = path.segments[0]!;
  return bodiesUnder(model, link, [from, to]);
}

/**
 * The overlay path stage 8 publishes: `overlayPath`, except that under `layout.overlayOverBodies` a link blocked by node bodies alone is
 * the one straight segment from face to face. Placement never calls this; it reads `overlayPath`.
 */
export function publishedOverlayPath(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery): LayoutPath {
  const ordinary = overlayPath(model, link, blockers);
  if (model.document.layout?.overlayOverBodies !== true) return ordinary;
  if (overlayOverBodies(model, link, blockers ?? sharedBlockers(model)) === undefined) return ordinary;
  const read = chordEnds(model, link)!;
  const segment = { from: { ...read.head.face }, to: { ...read.tail.face }, owner: { ...link.owner } };
  return { ...ordinary, segments: [segment] };
}

/**
 * The polyline an overlay link draws: **one straight segment from one pill face to the other**, at
 * whatever angle that is — unless a node body or a pill stands on it, and then the orthogonal
 * derivation of `between` answers instead, leaving each face outward by `OVERLAY_PILL_CLEARANCE`
 * before it turns. Straight by default, orthogonal by exception, and the exception is a node in the
 * way (maintainer, 2026-09-16, stress ticket 20).
 *
 * The path **begins and ends on the pill's face**, not on the port anchor at its centre: *"point
 * should be on a side of a pill"*, and *"path should also start on the point"* (maintainer,
 * 2026-09-16, stress ticket 30). The overlay layer is masked out of every pill, so an anchor-to-face
 * run was never drawn; the polyline is now exactly the line the reader sees, and the **overlay
 * endpoint mark** sits on the face where the line leaves. The straight branch then lost its stub to
 * the same review — *"no point in stub then"* — because the stub's two jobs were to square the
 * meeting and to clear the mark, and the face does both.
 *
 * The straight branch is what placement is meant to make possible: positioning the nodes so that as
 * many overlay links as possible are straight is stress ticket 21's work, and this rule is the test
 * it will be measured by. The orthogonal branch is unchanged from the derivation that used to be the
 * only one, fall-backs included.
 *
 * Nothing here is measured and no box is grown: every number is read off geometry placement already
 * reserved, so the path is derived rather than discovered and the pipeline's one rule holds. It
 * cannot be built before placement freezes, because placement moves pills until stage 7 closes;
 * stage 8 publishes it at the seam that used to publish the straight segment, and an overlay link
 * still never reaches the router.
 *
 * Two ports that face each other across a gap narrower than their two clearances clear their own
 * outward **face** instead, because the clearance would put the two ends the wrong way round and
 * every route between them would then walk back over a stub (ticket 04 A). The path still enters
 * neither pill — it rides the face — and the two ends keep their order.
 *
 * When neither branch answers — two pills that overlap on both axes, or a diagram that blocks every
 * way round — the link keeps the one straight segment every release before this one drew, now
 * between the two faces, and the renderer's mask carries the shapes it crosses. An end that states
 * no side has no outward face to read and keeps its anchor, which is the one point `overlayEndpoint`
 * leaves as it was.
 */
export function overlayPath(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery): LayoutPath {
  const along = link.meshBus === undefined ? undefined : busMemberPath(model, link);
  if (along !== undefined) return along;
  const base = derivedPoints(model, link, blockers);
  if (!base.movable) return pathOf(link, base.points);
  // A detour with a middle run may have to leave a track another overlay path holds (ticket 23): the whole overlay layer is read once.
  return pathOf(link, overlayTracks(model, blockers ?? sharedBlockers(model)).get(link.id)?.points ?? base.points);
}

/**
 * The path of one overlay link by the per-link rule alone, before track separation (ticket 23). It has the bends and the turns of
 * `overlayPath` exactly (a separated run moves across its own axis, and its two neighbours only lengthen or shorten), so a reader
 * that counts bends or asks whether the link is straight reads this and does not read the whole layer (`plannedBends`, the
 * straight-chord readers of placement).
 */
export function overlayBasePath(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery): LayoutPath {
  const along = link.meshBus === undefined ? undefined : busMemberPath(model, link);
  return along ?? pathOf(link, derivedPoints(model, link, blockers).points);
}

const pathOf = (link: LayoutLink, points: readonly Point[]): LayoutPath => ({ owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link),
  segments: points.slice(1).map((point, index) => ({ from: { ...points[index]! }, to: { ...point }, owner: { ...link.owner } })) });

const segmentsOf = (points: readonly Point[]): { from: Point; to: Point }[] => points.slice(1).map((point, index) => ({ from: points[index]!, to: point }));

/**
 * The points the per-link rule derives, and whether track separation may move them: only a detour of the orthogonal branch with a
 * middle run (four points or more). A course is reserved geometry, and a straight segment has no run to move.
 */
function derivedPoints(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery, ways?: Point[][]): { points: Point[]; movable: boolean } {
  const planned = overlayCoursePoints(model, link);
  if (planned !== undefined) return { points: planned, movable: false };
  const attachments = link.attachments!;
  const from = findPort(model, attachments.from), to = findPort(model, attachments.to);
  const stroke = linkStrokeWidth(link);
  const one = from && overlayEnd(model.nodes[attachments.from.node]!, from, stroke);
  const two = to && overlayEnd(model.nodes[attachments.to.node]!, to, stroke);
  const shapes = one && two ? blockers ?? sharedBlockers(model) : undefined;
  // The two ends of the drawn line, whichever branch answers: the port's own outward face, and the
  // anchor only where there is no face to read — an end that states no side. G7 `endpoint-anchor`
  // and `route/validate` read `overlayEndpoint`, which is this same pair.
  const ends = [{ end: one, port: from! }, { end: two, port: to! }]
    .map(({ end, port }) => end ? { ...end.face } : { ...port.anchor! });
  const found: Point[][] = [];
  const built = one && two && shapes ? chordPoints(one, two, shapes, ways === undefined ? undefined : found) : ends;
  // Two pill faces that meet exactly leave the tooClose branch nothing between them and `compact`
  // drops the repeat, so the one point is restated as the degenerate segment it is: a published
  // path is never empty, and both ends of this one are still the face the gate names.
  const points = built.length > 1 ? built : [built[0]!, { ...built[0]! }];
  const movable = one !== undefined && two !== undefined && points.length >= 4 && axisAligned(points);
  // `ways`: the other ways round with the same bends, axis-aligned, in the rule's order (ticket 23).
  if (movable) ways?.push(...found.filter(way => way.length === points.length && axisAligned(way)
    && !way.every((point, index) => samePoint(point, points[index]!))));
  return { points, movable };
}

/** The tracks tried on each side of a run (1, 2 and 3 pitches out) and the passes over one path's runs (R4: bounded by count). */
const OVERLAY_TRACK_STEPS = 3;
const OVERLAY_TRACK_PASSES = 2;

/** The overlay links drawn on the layer: the set `route/plan` hands to stage 8 (`plan.overlay`). */
const drawnOverlay = (link: LayoutLink): boolean => (link.layer ?? link.family ?? 'routed') === 'overlay'
  && link.technique !== 'stub' && link.removed !== true && link.attachments !== undefined;

/**
 * The separated paths of the overlay layer, one per detour (architecture-2 ticket 23): **two overlay detours never share a track.**
 * Kept per model and blocker index, by the numbers the per-link rule reads (the ends, the group and frame boxes, the courses and the
 * buses), as `sharedBlockers` keeps its index: 7f, stage 8 and `route/validate` read one model many times and get one answer.
 * Nothing is recorded on the model (R1): the separation is a function of the geometry placement froze, run by the one producer every
 * reader calls, as the overlay path always was; `route/validate` derives it again and compares (R5).
 */
type TrackKey = (number | string | undefined)[];
const trackCache = new WeakMap<LayoutModel, { key: TrackKey; shapes: ShapeQuery; tracks: ReadonlyMap<string, Separated> }[]>();
const TRACK_CACHE_SIZE = 4;
function overlayTracks(model: LayoutModel, shapes: ShapeQuery): ReadonlyMap<string, Separated> {
  const links = model.links.filter(drawnOverlay);
  const key = trackKey(model, links);
  let kept = trackCache.get(model);
  if (kept === undefined) trackCache.set(model, kept = []);
  const held = kept.find(item => item.shapes === shapes && sameKey(item.key, key));
  if (held !== undefined) return held.tracks;
  // A copy of the model (a trial, a replay on a clone) has the same geometry and a document equal by value: on the shared blocker index,
  // the separation of an earlier copy is the same function of the same numbers (`sharedKey`), so it is read, not run again.
  const shared = shapes === sharedBlockers(model) ? sharedKey(model, key) : undefined;
  const found = shared === undefined ? undefined : sharedTracks.find(item => sameKey(item.key, shared));
  const tracks = found?.tracks ?? separateTracks(model, links, shapes);
  if (shared !== undefined && found === undefined) {
    sharedTracks.unshift({ key: shared, tracks });
    if (sharedTracks.length > SHARED_TRACK_CACHE_SIZE) sharedTracks.pop();
  }
  kept.unshift({ key, shapes, tracks });
  if (kept.length > TRACK_CACHE_SIZE) kept.pop();
  return tracks;
}

/**
 * The separations kept across models, by `sharedKey`. A reader never changes a separated path (each copies the points it publishes), so
 * one result may serve every copy of a model. Bounded by count; it holds results, not models.
 */
const sharedTracks: { key: TrackKey; tracks: ReadonlyMap<string, Separated> }[] = [];
const SHARED_TRACK_CACHE_SIZE = 16;
// The print of a document is taken once, on the first read: it assumes the document does not change after that. A caller that edits a
// document in place after a track read keeps a stale print, and may get the separation of the document as it was. Edit a copy.
const documentPrints = new WeakMap<object, string>();
/**
 * `trackKey` plus what a copy shares only by value: the document (labels, layout options, link order), each link's place in it, and
 * every pill of every node (the shared blocker index holds them all, `sharedBlockers`).
 */
function sharedKey(model: LayoutModel, key: TrackKey): TrackKey {
  let print = documentPrints.get(model.document);
  if (print === undefined) documentPrints.set(model.document, print = JSON.stringify(model.document));
  const full: TrackKey = [print, ...key];
  for (const link of model.links) if (drawnOverlay(link)) full.push(link.sourceIndex);
  for (const node of Object.values(model.nodes)) {
    full.push(node.ports.length);
    for (const port of node.ports) {
      const pill = port.ref.anonymous === true ? undefined : port.pill?.bounds;
      if (pill === undefined) full.push(undefined); else full.push(pill.x, pill.y, pill.width, pill.height);
    }
  }
  return full;
}

const sameKey = (one: TrackKey, two: TrackKey): boolean => one.length === two.length && one.every((value, index) => value === two[index]);

/** The values the separation reads, flat, so a cache hit costs one pass and no string (a JSON key made a sheet with many overlay links slow). */
function trackKey(model: LayoutModel, links: readonly LayoutLink[]): TrackKey {
  const key: TrackKey = [];
  const box = (rect: Rect | undefined): void => { if (rect === undefined) key.push(undefined); else key.push(rect.x, rect.y, rect.width, rect.height); };
  for (const link of links) {
    key.push(link.id, linkStrokeWidth(link), link.meshBus);
    for (const ref of [link.attachments!.from, link.attachments!.to]) {
      const port = findPort(model, ref);
      key.push(port?.anchor?.x, port?.anchor?.y, port?.side);
      box(port?.ref.anonymous === true ? undefined : port?.pill?.bounds);
    }
  }
  for (const node of Object.values(model.nodes)) box(node.bounds);
  for (const group of Object.values(model.groups)) box(group.bounds);
  for (const frame of model.frames ?? []) box(frame.box);
  for (const lane of model.lanes) key.push(lane.id, lane.kind, lane.x);
  for (const band of model.labelBands) key.push(band.host ?? band.group, band.side);
  // The tier bands: the overlay courses read them (`course-lanes.ts`).
  for (const band of model.tierBands) { key.push(band.tier); box(band.bounds); }
  // Few and nested: the overlay courses and the buses are read whole.
  key.push(JSON.stringify(model.courses?.filter(course => course.kind === 'overlay')), JSON.stringify(model.meshBuses?.map(bus => [bus.id, bus.bar, bus.stubs, bus.riser, bus.trunk])));
  return key;
}

/**
 * Each detour, in order, takes a track no earlier path holds. The paths that cannot move (straight segments, courses, a link drawn
 * straight over a body under `overlayOverBodies`) hold theirs first; a mesh-bus member is not read, as the scorer does not read it. The detours follow by geometry, shortest first, so an inner detour keeps the track the rule gave it and
 * the one that goes further round steps out past it (nesting). Order keys: length, bends, the first point (x, y), the last point
 * (x, y); last key `sourceIndex` (R3).
 */
function separateTracks(model: LayoutModel, links: readonly LayoutLink[], shapes: ShapeQuery): ReadonlyMap<string, Separated> {
  // The paths the scorer reads (`overlayTrackShares`), so the two agree (R1): the published path of each link, a mesh-bus member left
  // out (its bar and stubs are the bus's, shared by design). Under `overlayOverBodies` a link stage 8 draws straight over a body holds
  // that straight segment, not the detour.
  const items = links.filter(link => link.meshBus === undefined).map(link => {
    const ways: Point[][] = [];
    const over = overlayOverBodies(model, link, shapes) === undefined ? undefined : chordEnds(model, link);
    const base = over !== undefined ? { points: [{ ...over.head.face }, { ...over.tail.face }], movable: false } : derivedPoints(model, link, shapes, ways);
    return { link, ...base, ways, stroke: linkStrokeWidth(link), labelled: model.document.links[link.sourceIndex]?.label !== undefined };
  });
  const held = new TrackIndex();
  for (const item of items) if (!item.movable) held.add({ points: item.points, strokeWidth: item.stroke });
  // A labelled detour goes after the unlabelled ones, so where no crossing decides it takes the outer track and its label the side away
  // from the other tracks.
  const movers = items.filter(item => item.movable).map(item => ({ ...item, length: polylineLength(item.points) }))
    .sort((a, b) => Number(a.labelled) - Number(b.labelled) || a.length - b.length || a.points.length - b.points.length
      || a.points[0]!.x - b.points[0]!.x || a.points[0]!.y - b.points[0]!.y
      || a.points.at(-1)!.x - b.points.at(-1)!.x || a.points.at(-1)!.y - b.points.at(-1)!.y
      || a.link.sourceIndex - b.link.sourceIndex);
  const borders: Border[] = [...Object.entries(model.groups).flatMap(([id, group]) => group.bounds === undefined ? [] : [{ group: id, box: group.bounds }]),
    ...(model.frames ?? []).map(frame => ({ group: undefined, box: frame.box }))];
  const placed: (Separated & { id: string; stroke: number; labelled: boolean })[] = [];
  for (const item of movers) {
    const separated = separate(model, [item.points, ...item.ways], item.stroke, held, shapes, borders, item.labelled);
    held.add({ points: separated.points, strokeWidth: item.stroke });
    placed.push({ ...separated, id: item.link.id, stroke: item.stroke, labelled: item.labelled });
  }
  nestTracks(model, placed, items.filter(item => !item.movable).map(item => ({ points: item.points, strokeWidth: item.stroke })), shapes, borders);
  return new Map(placed.map(({ id, points, way }) => [id, { points, way }]));
}

/**
 * Separated tracks nest (architecture-2 ticket 24, the user's rule of ticket 23): two detours that cross, and that the separation moved
 * apart off one track (a run of each on one line in the ways round the rule derived), trade the offsets of those two runs when the
 * trade lowers what the layer shares and crosses. The greedy separation gives the later detour the outer offset on every run it
 * shares; two U's that leave one face need it the other way on one of the runs: the detour on the outer track over the row takes the
 * inner riser beside the face, so neither crosses the other. Nothing else changes: the bends stay (each neighbour keeps its direction),
 * and each moved run keeps the rules `shiftOff` keeps (`runRules`). A labelled detour is not traded: its label keeps the outer side. The measure is the separation's own, in its order: shared tracks,
 * then crossing pairs, over the whole layer. A trade is tried only where the two then no longer cross each other, so one trade at most
 * per pair. One pass over the pairs in the movers' order, the runs in path order (R3: the movers are ordered by geometry; finite, no
 * cap).
 */
function nestTracks(model: LayoutModel, placed: (Separated & { stroke: number; labelled: boolean })[], fixed: readonly TrackPath[], shapes: ShapeQuery,
  borders: readonly Border[]): void {
  // The layer as it stands: the held paths, then the movers (`placed.length` on). Two paths whose boxes stand more than a pitch apart
  // share no track and cross nowhere, so a pair is measured against the paths near it only.
  const layer: { path: TrackPath; box: Rect }[] = [...placed.map(item => ({ points: item.points, strokeWidth: item.stroke })), ...fixed]
    .map(path => ({ path, box: boxOf(path.points) }));
  const widest = Math.max(0, ...layer.map(item => item.path.strokeWidth)), reach = overlayTrackPitch(widest, widest);
  const near = (one: Rect, two: Rect): boolean => !(one.x > right(two) + reach || two.x > right(one) + reach || one.y > bottom(two) + reach || two.y > bottom(one) + reach);
  // Shared run pairs and crossing pairs of two paths. The sweeps run only where a run of each is near the other's on one axis (shares)
  // and where the boxes meet (crossings); both answers are the same as without the filter.
  const nearRuns = (one: readonly Point[], two: readonly Point[]): boolean => {
    for (let a = 0; a + 1 < one.length; a++) for (let b = 0; b + 1 < two.length; b++) {
      const p = one[a]!, q = one[a + 1]!, r = two[b]!, t = two[b + 1]!;
      const vertical = Math.abs(p.x - q.x) <= EPS, other = Math.abs(r.x - t.x) <= EPS;
      if (vertical !== other) continue;
      const [at, low, high, at2, low2, high2] = vertical
        ? [p.x, Math.min(p.y, q.y), Math.max(p.y, q.y), r.x, Math.min(r.y, t.y), Math.max(r.y, t.y)]
        : [p.y, Math.min(p.x, q.x), Math.max(p.x, q.x), r.y, Math.min(r.x, t.x), Math.max(r.x, t.x)];
      if (Math.abs(at - at2) < reach && low <= high2 + reach && low2 <= high + reach) return true;
    }
    return false;
  };
  const meets = (one: Rect, two: Rect): boolean => !(one.x > right(two) + EPS || two.x > right(one) + EPS || one.y > bottom(two) + EPS || two.y > bottom(one) + EPS);
  const against = (one: TrackPath, oneBox: Rect, two: TrackPath, twoBox: Rect): number[] => [
    nearRuns(one.points, two.points) ? sharedTrackPairs([one, two]).length : 0,
    meets(oneBox, twoBox) ? overlayCrossingPairs([segmentsOf(one.points), segmentsOf(two.points)]) : 0];
  /** Shared run pairs, then crossing pairs, of movers `i` and `j` drawn as `one` and `two`, with the rest of the layer and with each other. */
  const measure = (i: number, j: number, one: TrackPath, two: TrackPath): number[] => {
    const boxes = [boxOf(one.points), boxOf(two.points)];
    const sum = against(one, boxes[0]!, two, boxes[1]!);
    for (const [at, item] of layer.entries()) {
      if (at === i || at === j) continue;
      for (const [k, path] of [one, two].entries()) {
        if (!near(boxes[k]!, item.box)) continue;
        const [shares, crossings] = against(path, boxes[k]!, item.path, item.box);
        sum[0]! += shares!; sum[1]! += crossings!;
      }
    }
    return sum;
  };
  /** `points` with run `index` moved onto the line of `to` (its x for a vertical run, its y for a horizontal one). */
  const shifted = (points: readonly Point[], index: number, to: Point): Point[] => {
    const horizontal = Math.abs(points[index]!.y - points[index + 1]!.y) <= EPS;
    const shift = (point: Point): Point => horizontal ? { x: point.x, y: to.y } : { x: to.x, y: point.y };
    return [...points.slice(0, index), shift(points[index]!), shift(points[index + 1]!), ...points.slice(index + 2)];
  };
  /** Whether `candidate`, `item` with run `index` moved, keeps the rules `shiftOff` keeps: no bend appears or goes, and `runRules`. */
  const holds = (item: Separated & { stroke: number }, index: number, candidate: Point[]): boolean => {
    const points = item.points;
    if (!keepsDirection(points[index - 1]!, points[index]!, candidate[index - 1]!, candidate[index]!)
      || !keepsDirection(points[index + 1]!, points[index + 2]!, candidate[index + 1]!, candidate[index + 2]!)) return false;
    if (retracingRuns(segmentsOf(candidate))) return false;
    const { keeps, growsFor } = runRules(model, item.way, item.stroke, shapes, borders);
    const grows = Math.abs(candidate[index]!.y - candidate[index + 1]!.y) <= EPS ? growsFor(index, candidate[index]!) : undefined;
    return [index - 1, index, index + 1].every(at => keeps(candidate, at, grows) !== undefined);
  };
  const runAxis = (points: readonly Point[], index: number): 'x' | 'y' | undefined => {
    const one = points[index]!, two = points[index + 1]!;
    const vertical = Math.abs(one.x - two.x) <= EPS, horizontal = Math.abs(one.y - two.y) <= EPS;
    return vertical === horizontal ? undefined : vertical ? 'x' : 'y';
  };
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    // A labelled detour keeps its offsets: it took its tracks last so that its label stands on the outer side (`separateTracks`), and
    // 7f reserved the label's room on the run it draws.
    if (placed[i]!.labelled || placed[j]!.labelled) continue;
    if (!near(layer[i]!.box, layer[j]!.box) || overlayCrossingPairs([segmentsOf(placed[i]!.points), segmentsOf(placed[j]!.points)]) === 0) continue;
    let now: number[] | undefined;
    // Middle runs only: an end run leaves a port face (`shiftOff`).
    trades: for (let a = 1; a + 2 < placed[i]!.points.length; a++) for (let b = 1; b + 2 < placed[j]!.points.length; b++) {
      const one = placed[i]!, two = placed[j]!;
      const axis = runAxis(one.points, a);
      if (axis === undefined || axis !== runAxis(two.points, b) || axis !== runAxis(one.way, a) || axis !== runAxis(two.way, b)) continue;
      // On one line in the ways round, apart now: the separation set them apart.
      if (Math.abs(one.way[a]![axis] - two.way[b]![axis]) > EPS || Math.abs(one.points[a]![axis] - two.points[b]![axis]) <= EPS) continue;
      const first = shifted(one.points, a, two.points[b]!), second = shifted(two.points, b, one.points[a]!);
      // The trade is for the pair: the two must no longer cross. Then each moved run keeps its rules, and the whole layer shares and
      // crosses less.
      const fit = overlayCrossingPairs([segmentsOf(first), segmentsOf(second)]) === 0 && holds(one, a, first) && holds(two, b, second);
      if (!fit) continue;
      const moved = [{ points: first, strokeWidth: one.stroke }, { points: second, strokeWidth: two.stroke }] as const;
      if (!better(measure(i, j, ...moved), now ??= measure(i, j, layer[i]!.path, layer[j]!.path))) continue;
      placed[i] = { ...one, points: first };
      placed[j] = { ...two, points: second };
      layer[i] = { path: moved[0], box: boxOf(first) };
      layer[j] = { path: moved[1], box: boxOf(second) };
      // The two no longer cross: the pair is done.
      break trades;
    }
  }
}

/** A separated detour: its drawn points, and the way round the rule derived that they were moved from, point for point. */
interface Separated { points: Point[]; way: Point[] }

/**
 * One detour off every held track (ticket 23). Every way round with the bends of the derived way is tried, each with its runs moved
 * off shared tracks (`shiftOff`): the bends are equal, so the user's order goes on to the crossings. Of the results, the one that
 * shares the fewest tracks wins, then the fewest crossings with the held paths, then the shortest (a moved run lengthens its two
 * neighbours, so this counts the offset); last key: the way's place, the derived way first.
 */
function separate(model: LayoutModel, ways: readonly Point[][], stroke: number, held: TrackIndex, shapes: ShapeQuery, borders: readonly Border[],
  labelled: boolean): Separated {
  let best: { separated: Separated; rank: number[] } | undefined;
  for (const [index, way] of ways.entries()) {
    const result = shiftOff(model, way, stroke, held, shapes, borders, labelled);
    const rank = [result.shares, result.crossings, polylineLength(result.points), index];
    if (best === undefined || better(rank, best.rank)) best = { separated: { points: result.points, way }, rank };
  }
  return best!.separated;
}

/** A drawn group or frame box; `group` names a group box, which may hold a padding 7f grows for a track. */
interface Border { group: string | undefined; box: Rect }

/**
 * The runs of an overlay link's separated path beside the runs of the way round they were moved from, index for index (ticket 23);
 * empty for a link the separation does not move (a straight segment, a course, a mesh-bus member). 7f reads it to grow the padding a
 * track moved into (`trackRoomPadding`).
 */
export function overlayTrackRuns(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery): { base: [Point, Point]; drawn: [Point, Point] }[] {
  if (link.meshBus !== undefined || link.attachments === undefined) return [];
  // Only a movable detour has an entry (`separateTracks` keeps the movers), so the map answers whether the link moves.
  const separated = overlayTracks(model, blockers ?? sharedBlockers(model)).get(link.id);
  if (separated === undefined) return [];
  // Copies: the separation is kept and shared across models (`sharedTracks`), so a caller may not hold its points.
  const { way, points } = separated;
  return way.slice(1).map((point, index) => ({ base: [{ ...way[index]! }, { ...point }], drawn: [{ ...points[index]! }, { ...points[index + 1]! }] }));
}

/** Where an axis-aligned segment stands to a box: wholly inside it (closed), clear of it, or across its border. */
function relation(from: Point, to: Point, box: Rect): 'in' | 'out' | 'across' {
  const low = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) }, high = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) };
  if (low.x >= box.x - EPS && high.x <= right(box) + EPS && low.y >= box.y - EPS && high.y <= bottom(box) + EPS) return 'in';
  if (high.x < box.x - EPS || low.x > right(box) + EPS || high.y < box.y - EPS || low.y > bottom(box) + EPS) return 'out';
  return 'across';
}

/** Whether rank `one` is better than rank `two`: the first key that differs decides. */
const better = (one: readonly number[], two: readonly number[]): boolean => {
  for (let at = 0; at < one.length; at++) if (one[at] !== two[at]) return one[at]! < two[at]!;
  return false;
};

/**
 * The rules a moved run of one detour keeps (ticket 23), against `base`, the way round the rule derived: `keeps` (its distance to every
 * shape and its stand to every box; `true` when it holds only by a growth 7f makes) and `growsFor` (the group whose padding that growth
 * is). `shiftOff` and the nesting of separated tracks (`nestTracks`, ticket 24) read the same rules.
 */
function runRules(model: LayoutModel, base: readonly Point[], stroke: number, shapes: ShapeQuery, borders: readonly Border[]): {
  keeps: (points: readonly Point[], index: number, grows: string | undefined) => boolean | undefined;
  growsFor: (index: number, moved: Point) => string | undefined;
} {
  const step = overlayPortClearance(stroke);
  const gap = (from: Point, to: Point, box: Rect): number => segmentRectDistance({ from, to } as PathSegment, box);
  // A track keeps one track pitch from a border it runs inside, as from another track.
  const edge = overlayTrackPitch(stroke, DEFAULT_STROKE_WIDTHS.group);
  const inner = (from: Point, to: Point, box: Rect): number => Math.min(Math.min(from.x, to.x) - box.x, right(box) - Math.max(from.x, to.x),
    Math.min(from.y, to.y) - box.y, bottom(box) - Math.max(from.y, to.y));
  /**
   * Whether segment `index` of `points`, moved from where `base` had it, keeps its distance to every shape and its stand to every
   * box: `undefined` when it does not, else whether it holds only by a growth 7f makes (`true`). `grows` is the group whose padding 7f
   * grows for this move (`trackRoomPadding`): its box is read after the growth, not now.
   */
  const keeps = (points: readonly Point[], index: number, grows: string | undefined): boolean | undefined => {
    const from = points[index]!, to = points[index + 1]!, was = [base[index]!, base[index + 1]!] as const;
    const window: Rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
    if (shapes.some(window, shape => enters(from, to, shape) || gap(from, to, shape) < Math.min(step, gap(was[0], was[1], shape)) - EPS, undefined, step)) return undefined;
    // A box the move leaves as it stood is no growth; only the box of `grows` may fail the test, and then 7f grows it (`true`). A track
    // the room 7f already grew holds is no growth, so a replay after the growth chooses the same track (the separation is stable).
    let growth = false;
    const stands = borders.every(({ group, box }) => {
      const now = relation(from, to, box);
      if (now === relation(was[0], was[1], box) && (now !== 'in' || inner(from, to, box) >= Math.min(edge, inner(was[0], was[1], box)) - EPS)) return true;
      if (group !== undefined && group === grows) return growth = true;
      return false;
    });
    return stands ? growth : undefined;
  };
  /**
   * The group whose padding a run moved to `moved` grows into (ticket 23): the run the rule derived lies in a plain group's padding on
   * an edge no title holds (`paddingOf`, the reader 7f shares), and the move takes it further from the bodies.
   */
  const growsFor = (index: number, moved: Point): string | undefined => {
    const held = paddingOf(model, base[index]!, base[index + 1]!);
    if (held === undefined || held.title) return undefined;
    const bodies = bodiesOf(model, model.groups[held.group]!.nodes);
    return reachBeyond(bodies, held.side, moved) > reachBeyond(bodies, held.side, base[index]!) + EPS ? held.group : undefined;
  };
  return { keeps, growsFor };
}

/** The bounding box of a polyline. */
const boxOf = (points: readonly Point[]): Rect => {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** The neighbour from `a` to `b`, moved to run from `c` to `d`, keeps its direction and a length: no bend appears or goes. */
const keepsDirection = (a: Point, b: Point, c: Point, d: Point): boolean =>
  Math.sign(b.x - a.x) === Math.sign(d.x - c.x) && Math.sign(b.y - a.y) === Math.sign(d.y - c.y) && Math.hypot(d.x - c.x, d.y - c.y) > EPS;

/**
 * One detour moved off every track the held paths take (ticket 23). A **middle run** (both neighbours perpendicular to it) that
 * shares a track moves across its own axis by one, two or three track pitches, either way. Its two neighbours lengthen or shorten
 * and keep their direction, so the path keeps its bends and its turns (bends first, then turns). An end run leaves a port face and
 * does not move: that would add a jog. A candidate stands only when it
 * - walks back along no run it drew (`retracingRuns`);
 * - enters no node body and no pill, and keeps the link's overlay port clearance from each, or the distance the derived path kept
 *   where that was less (a run down a narrow gap), so it never passes nearer than the clearance beside a foreign port or a column of
 *   ports;
 * - stands to every group and frame box as the derived run did (inside it, clear of it, or across its border), and keeps one track
 *   pitch from the border of a box it runs inside; it may cross the padding edge of a plain group that no title holds, when it moves
 *   further from that group's bodies: 7f grows that edge for it (`trackRoomPadding`, `paddingOf`).
 * Of the candidates, the one that shares the fewest tracks wins; then one that needs no growth beyond the box as it stands (spacing is
 * spent only where no track is free, and a track the room 7f grew holds is no growth, so a replay after the growth keeps it); then the
 * fewest crossings with the held paths (overlay pairs: the tracks nest, the user's order puts crossings before a label's comfort); then,
 * for a labelled detour, the way out of its U (its label takes the outer side); then the nearest track; then the way out of a U (away
 * from its two neighbours); then the positive direction (last key). A run that no candidate
 * improves keeps its track, and the scorer's `overlayTrackShares` counts it.
 */
function shiftOff(model: LayoutModel, base: Point[], stroke: number, held: TrackIndex, shapes: ShapeQuery, borders: readonly Border[],
  labelled: boolean): { points: Point[]; shares: number; crossings: number } {
  const pitch = overlayTrackPitch(stroke, Math.max(stroke, ...held.paths.map(path => path.strokeWidth)));
  const shares = (points: readonly Point[]): { count: number; runs: Set<number> } => {
    const runs = held.sharesOf({ points, strokeWidth: stroke });
    return { count: runs.length, runs: new Set(runs) };
  };
  // A held path whose box does not meet the candidate's box crosses it nowhere (`boxOf`).
  const heldSegments = held.paths.map(path => ({ box: boxOf(path.points), segments: segmentsOf(path.points) }));
  const crossings = (points: readonly Point[]): number => {
    const mine = segmentsOf(points), box = boxOf(points);
    return heldSegments.reduce((sum, other) => other.box.x > right(box) + EPS || box.x > right(other.box) + EPS || other.box.y > bottom(box) + EPS
      || box.y > bottom(other.box) + EPS ? sum : sum + overlayCrossingPairs([mine, other.segments]), 0);
  };
  const { keeps, growsFor } = runRules(model, base, stroke, shapes, borders);
  let points = base;
  let current = shares(points);
  for (let pass = 0; pass < OVERLAY_TRACK_PASSES && current.count > 0; pass++) {
    let moved = false;
    for (let index = 1; index + 2 < points.length; index++) {
      if (!current.runs.has(index)) continue;
      const one = points[index]!, two = points[index + 1]!, before = points[index - 1]!, after = points[index + 2]!;
      const horizontal = Math.abs(one.y - two.y) <= EPS;
      // The side each neighbour leaves the run to; a U is left the other way.
      const side = (point: Point): number => Math.sign(horizontal ? point.y - one.y : point.x - one.x);
      const outward = side(before) === side(after) ? -side(before) : 0;
      let best: { points: Point[]; rank: number[] } | undefined;
      for (let steps = 1; steps <= OVERLAY_TRACK_STEPS; steps++) {
        for (const sign of [1, -1]) {
          const by = sign * steps * pitch;
          const shift = (point: Point): Point => horizontal ? { x: point.x, y: point.y + by } : { x: point.x + by, y: point.y };
          const candidate = [...points.slice(0, index), shift(one), shift(two), ...points.slice(index + 2)];
          if (!keepsDirection(before, one, candidate[index - 1]!, candidate[index]!) || !keepsDirection(two, after, candidate[index + 1]!, candidate[index + 2]!)) continue;
          if (retracingRuns(segmentsOf(candidate))) continue;
          const grows = horizontal ? growsFor(index, candidate[index]!) : undefined;
          const stands = [index - 1, index, index + 1].map(at => keeps(candidate, at, grows));
          if (stands.some(item => item === undefined)) continue;
          // A move that needs no growth goes before one that does: spacing is spent only where no track is free. Fewer crossings go
          // next (the tracks nest), and only then does a labelled detour leave a U outward, so its label has the outer side (ticket 23).
          const out = sign === outward ? 0 : 1, growth = stands.some(item => item === true) ? 1 : 0;
          const rank = [shares(candidate).count, growth, crossings(candidate), labelled ? out : 0, steps, out, sign === 1 ? 0 : 1];
          if (best === undefined || better(rank, best.rank)) best = { points: candidate, rank };
        }
      }
      if (best === undefined || best.rank[0]! >= current.count) continue;
      points = best.points; current = shares(points); moved = true;
    }
    if (!moved) break;
  }
  return { points, shares: current.count, crossings: crossings(points) };
}

/**
 * The polyline of an overlay link that has a planned course (architecture ticket 15, phase 7), face to face, or `undefined` when it has none or its lane
 * does not stand yet (a model before stage 7a derives the path as it always did). The course reserved a perimeter lane in the overlay layer: its x is the one
 * the lane holds, and its side runs and padding rows are the geometry that stage 5 and 7a reserved (`courseGeometry`, the one reader). The two ends are
 * the faces of the pills, which is where an overlay path begins and ends.
 */
export function overlayCoursePoints(model: LayoutModel, link: LayoutLink): Point[] | undefined {
  const course = model.courses?.find(item => item.link === link.id && item.kind === 'overlay');
  const lane = course === undefined ? undefined : model.lanes.find(item => item.kind === 'perimeter' && item.owner.kind === 'link' && item.owner.id === link.id);
  if (course === undefined || lane === undefined || link.attachments === undefined) return undefined;
  const geometry = courseGeometry(model, link, course, { id: lane.id, side: lane.side, ring: lane.ring ?? 0, ...(lane.aligned === true ? { aligned: true as const } : {}), x: lane.x, keepX: true },
    group => group.bounds!, ringsOf(model.lanes));
  if (geometry === undefined) return undefined;
  const faces = [link.attachments.from, link.attachments.to].map(ref => {
    const port = findPort(model, ref), node = model.nodes[ref.node];
    return port && node ? overlayEnd(node, port)?.face : undefined;
  });
  if (faces[0] === undefined || faces[1] === undefined) return undefined;
  const points = geometry.polyline.map(point => ({ ...point }));
  points[0] = { ...faces[0] }; points[points.length - 1] = { ...faces[1] };
  const path = straighten(compact(points));
  return path.length > 1 ? path : undefined;
}

/**
 * The path of a mesh bus member: along the bus, stub, bar run, stub (docs/design/mesh-bus.md, section 5). Both stubs and the bar are
 * the geometry 7f published on the bus (`bus.stubs`, `bus.bar`), so stage 8 states nothing of its own and `route/validate` compares
 * against the same line. A bus whose geometry is not published yet (the side is fixed at stage 5, the bar at 7f) has no such path, and
 * the member keeps the overlay rule's until it has.
 */
export function busMemberPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  const bus = model.meshBuses?.find(item => item.id === link.meshBus);
  if (bus?.bar === undefined || bus.stubs === undefined || link.attachments === undefined) return undefined;
  // A cross link of a join runs along both bars and the riser (mesh-bus.md, section 11.6): stub, bar run, riser, bar run, stub.
  const cross = bus.cross?.includes(link.id) === true;
  // A cross link of a trunk join runs along both bars and the trunk: stub, bar run, trunk, bar run, stub, always five orthogonal segments (mesh-bus.md, section 12.7).
  if (cross && bus.trunk !== undefined) {
    const x = bus.trunk.x, buses = bus.trunk.buses.map(id => model.meshBuses?.find(item => item.id === id));
    if (x === undefined || buses.some(item => item?.bar === undefined || item.stubs === undefined)) return undefined;
    const stubs = buses.flatMap(item => item!.stubs!);
    const one = stubs.find(stub => stub.node === link.attachments!.from.node), two = stubs.find(stub => stub.node === link.attachments!.to.node);
    if (one === undefined || two === undefined) return undefined;
    const path = straighten(compact([one.from, one.to, { x, y: one.to.y }, { x, y: two.to.y }, two.to, two.from]));
    const segments: PathSegment[] = path.slice(1).map((point, index) => ({ from: { ...path[index]! }, to: { ...point }, owner: { ...link.owner } }));
    return { owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link), segments };
  }
  const partner = cross ? model.meshBuses?.find(item => item.id === bus.joined) : undefined;
  const stubs = [...bus.stubs, ...(partner?.stubs ?? [])];
  if (cross && (partner?.bar === undefined || partner.stubs === undefined || bus.riser === undefined)) return undefined;
  const stubOf = (ref: PortRef): { node: string; from: Point; to: Point } | undefined => stubs.find(stub => stub.node === ref.node);
  const one = stubOf(link.attachments.from), two = stubOf(link.attachments.to);
  if (one === undefined || two === undefined) return undefined;
  const riser = bus.riser;
  const points = cross && riser !== undefined
    ? [one.from, one.to, { x: riser.x, y: one.to.y }, { x: riser.x, y: two.to.y }, two.to, two.from]
    : [one.from, one.to, two.to, two.from];
  const path = cross ? straighten(compact(points)) : points;
  const segments: PathSegment[] = path.slice(1).map((point, index) => ({ from: { ...path[index]! }, to: { ...point }, owner: { ...link.owner } }));
  return { owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link), segments };
}

/**
 * The one straight segment an overlay link would draw between the two port faces, or `undefined`
 * when the segment leaves a port inward, or a node body or a foreign pill stands on it. It is the
 * overlay rule's own straight branch, read by the **straight** technique of a routed link inside
 * one frame (ticket 34), so the two families cannot state different faces or different blockers.
 */
export function straightChord(model: LayoutModel, link: LayoutLink, blockers?: ShapeQuery, geometryOnly = false): { from: Point; to: Point } | undefined {
  const ends = link.attachments;
  if (!ends) return undefined;
  const from = findPort(model, ends.from), to = findPort(model, ends.to);
  const one = from && model.nodes[ends.from.node] && overlayEnd(model.nodes[ends.from.node]!, from);
  const two = to && model.nodes[ends.to.node] && overlayEnd(model.nodes[ends.to.node]!, to);
  if (!one || !two) return undefined;
  if (!geometryOnly && !straightBetween(one, two, blockers ?? sharedBlockers(model))) return undefined;
  return { from: { ...one.face }, to: { ...two.face } };
}

/**
 * The two overlay ends of a link as the straight test reads them, or `undefined` where an end states no side (ticket 143). The
 * window rule of `placeOverlayFree` shifts one end and asks `straightBetween` again, without a model copy.
 */
export function chordEnds(model: LayoutModel, link: LayoutLink): { head: OverlayEnd; tail: OverlayEnd } | undefined {
  const ends = link.attachments;
  if (!ends) return undefined;
  const from = findPort(model, ends.from), to = findPort(model, ends.to);
  const stroke = linkStrokeWidth(link);
  const head = from && model.nodes[ends.from.node] && overlayEnd(model.nodes[ends.from.node]!, from, stroke);
  const tail = to && model.nodes[ends.to.node] && overlayEnd(model.nodes[ends.to.node]!, to, stroke);
  return head && tail ? { head, tail } : undefined;
}
