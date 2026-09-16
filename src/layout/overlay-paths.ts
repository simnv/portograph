import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { bottom, EPS, retracingRuns, right, samePoint } from '../score/geometry.js';
import { OVERLAY_ENDPOINT_RADIUS, pathStrokeWidth } from '../theme/geometry.js';
import { RectangleIndex } from './rectangle-index.js';
import { findPort } from './row-paths.js';

/**
 * How far past a port's own outward face an overlay link's **stub** reaches before the straight
 * segment between the two stub ends starts — and, where that segment is refused and the orthogonal
 * derivation answers instead, how far outside the face that path turns. It is twice the overlay
 * endpoint mark's radius — the mark is the widest thing drawn at that end — so the rule introduces
 * no number of its own (`.scratch/drawio-export/issues/02-maintainer-edit-principles.md`,
 * principle 2).
 *
 * Measured from the **face**, not from the anchor: the anchor is the pill's centre and the renderer
 * masks the pill, so a stub measured from the anchor is shorter than the pill's own half-length —
 * 12 px even for a two-character port name, and the pill grows with the name — and nothing of it is
 * ever drawn. From the face, the whole 4 px is drawn and the line meets the pill square, which is
 * what the maintainer chose over the anchor-to-anchor line (stress ticket 20).
 */
export const OVERLAY_PILL_CLEARANCE = 2 * OVERLAY_ENDPOINT_RADIUS;

/** Unit vector pointing out of a node through the named side. */
const NORMAL: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** Every node body and every drawn port pill: the shapes an overlay link goes round. */
export type OverlayBlockers = RectangleIndex<Rect>;

export function overlayBlockers(model: LayoutModel): OverlayBlockers {
  const boxes: { bounds: Rect; value: Rect }[] = [];
  for (const node of Object.values(model.nodes)) {
    if (node.bounds) boxes.push({ bounds: node.bounds, value: node.bounds });
    for (const port of node.ports) {
      if (port.pill && port.ref.anonymous !== true) boxes.push({ bounds: port.pill.bounds, value: port.pill.bounds });
    }
  }
  return new RectangleIndex(boxes);
}

/** Whether an axis-aligned segment reaches inside `box`, rather than only touching its edge. */
const enters = (from: Point, to: Point, box: Rect): boolean =>
  Math.max(from.x, to.x) > box.x + EPS && Math.min(from.x, to.x) < right(box) - EPS
  && Math.max(from.y, to.y) > box.y + EPS && Math.min(from.y, to.y) < bottom(box) - EPS;

/**
 * The same question for a segment of any angle: the parameter range that survives clipping against
 * the box's four slabs, each pulled in by `EPS` so a line along a face is clear. `enters` reads a
 * bounding box, which is exact for an axis-aligned run and far too wide for a diagonal.
 */
function crosses(from: Point, to: Point, box: Rect): boolean {
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
 * One end of an overlay link: the anchor the path must start from, the box the link leaves — the
 * pill when the port draws one, the node body when it does not — the point on that box's outward
 * face, and the point one clearance beyond it, which is where the route between the two ends
 * begins.
 */
interface OverlayEnd { anchor: Point; box: Rect; face: Point; clear: Point; out: Point }

function overlayEnd(node: LayoutNode, port: LayoutPort): OverlayEnd | undefined {
  if (!port.anchor || !port.side || !node.bounds) return undefined;
  const box = port.pill && port.ref.anonymous !== true ? port.pill.bounds : node.bounds;
  const out = NORMAL[port.side];
  // The outward face of the box on this side, plus the clearance, measured from the anchor.
  const face = port.side === 'top' ? box.y : port.side === 'bottom' ? bottom(box)
    : port.side === 'left' ? box.x : right(box);
  const depth = Math.abs((out.x !== 0 ? port.anchor.x : port.anchor.y) - face);
  const outward = (by: number): Point => ({ x: port.anchor!.x + out.x * by, y: port.anchor!.y + out.y * by });
  return { anchor: { ...port.anchor }, box, face: outward(depth), clear: outward(depth + OVERLAY_PILL_CLEARANCE), out };
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
function between(head: OverlayEnd, tail: OverlayEnd, blockers: OverlayBlockers): Point[] | undefined {
  const from = head.clear, to = tail.clear;
  const boxes = [head.box, tail.box];
  const before = (of: (box: Rect) => number): number => Math.min(...boxes.map(of)) - OVERLAY_PILL_CLEARANCE;
  const after = (of: (box: Rect) => number): number => Math.max(...boxes.map(of)) + OVERLAY_PILL_CLEARANCE;
  const above = before(box => box.y), below = after(bottom);
  const left = before(box => box.x), far = after(right);
  /** The middle of the gap the two boxes leave on one axis; inside a box when they overlap on it. */
  const gap = (low: (box: Rect) => number, high: (box: Rect) => number): number =>
    (Math.max(...boxes.map(low)) + Math.min(...boxes.map(high))) / 2;
  const midX = gap(box => box.x, right), midY = gap(box => box.y, bottom);
  const turn = { x: to.x, y: from.y }, bend = { x: from.x, y: to.y };
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
  const clearOfAll = (points: readonly Point[]): boolean => everySegment(points, (one, two) => {
    const box = { x: Math.min(one.x, two.x), y: Math.min(one.y, two.y),
      width: Math.abs(two.x - one.x), height: Math.abs(two.y - one.y) };
    return blockers.some(box, blocker => enters(one, two, blocker));
  });
  const clearOfEnds = (points: readonly Point[]): boolean =>
    everySegment(points, (one, two) => boxes.some(box => enters(one, two, box)));
  // A way round can land on the line the two cleared points already share, and then it states a corner
  // that is not one. The retrace test reads the whole drawn polyline, stubs included, because that is
  // where the retrace lives; the box tests read the part between the cleared ends, because the
  // stubs are the port's own reserved outward reach and cross nothing else.
  const candidates = ways.map(way => compact([from, ...way, to]))
    .filter(points => axisAligned(points) && !retraces(straighten(compact([head.anchor, ...points, tail.anchor]))));
  const shortest = (clear: (points: readonly Point[]) => boolean): Point[] | undefined => {
    let best: { points: Point[]; length: number } | undefined;
    for (const points of candidates) {
      if (!clear(points)) continue;
      const length = polylineLength(points);
      if (best === undefined || length < best.length - EPS) best = { points, length };
    }
    return best?.points;
  };
  return shortest(clearOfAll) ?? shortest(clearOfEnds);
}

/**
 * The straight segment between the two stub ends, when nothing a reader would call a node stands in
 * its way; `undefined` when something does, and the orthogonal derivation answers instead.
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
 * The two stubs are not tested. Each starts at its own anchor, which is its own pill's centre, so a
 * stub is inside that pill by construction; it is the port's own reserved outward reach and it
 * crosses nothing else. The same reading the eight ways use.
 */
function straightBetween(head: OverlayEnd, tail: OverlayEnd, blockers: OverlayBlockers): Point[] | undefined {
  const from = head.clear, to = tail.clear;
  const window: Rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
  if (blockers.some(window, box => crosses(from, to, box))) return undefined;
  // The stub ends can still be the wrong way round — a pair on two lines whose ports face away from
  // each other — and then the segment walks back along a stub. `route/validate` fails such a path,
  // so the rule may not state one and the orthogonal derivation is asked instead.
  const drawn = straighten(compact([head.anchor, from, to, tail.anchor]));
  if (retracingRuns(drawn.slice(1).map((point, index) => ({ from: drawn[index]!, to: point })))) return undefined;
  return [from, to];
}

/**
 * The polyline an overlay link draws: a stub out of each port, past its own outward face by
 * `OVERLAY_PILL_CLEARANCE`, and between the two stub ends **one straight segment** at whatever angle
 * that is — unless a node body or a pill stands on that segment, and then the orthogonal derivation
 * of `between` answers instead. Straight by default, orthogonal by exception, and the exception is a
 * node in the way (maintainer, 2026-09-16, stress ticket 20).
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
 * way round — the link keeps the straight anchor-to-anchor segment, which is what every release before
 * this one drew, and the renderer's mask carries it.
 */
export function overlayPath(model: LayoutModel, link: LayoutLink, blockers?: OverlayBlockers): LayoutPath {
  const attachments = link.attachments!;
  const from = findPort(model, attachments.from), to = findPort(model, attachments.to);
  const one = from && overlayEnd(model.nodes[attachments.from.node]!, from);
  const two = to && overlayEnd(model.nodes[attachments.to.node]!, to);
  const { head, tail } = one && two && tooClose(one, two)
    ? { head: { ...one, clear: one.face }, tail: { ...two, clear: two.face } }
    : { head: one, tail: two };
  const shapes = head && tail ? blockers ?? overlayBlockers(model) : undefined;
  const middle = head && tail && shapes
    ? straightBetween(head, tail, shapes) ?? between(head, tail, shapes) : undefined;
  const points = head && tail && middle
    ? straighten(compact([head.anchor, ...middle, tail.anchor]))
    : [{ ...from!.anchor! }, { ...to!.anchor! }];
  const segments: PathSegment[] = points.slice(1).map((point, index) =>
    ({ from: { ...points[index]! }, to: { ...point }, owner: { ...link.owner } }));
  return { owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link), segments };
}
