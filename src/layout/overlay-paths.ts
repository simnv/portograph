import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { bottom, EPS, right, samePoint } from '../score/geometry.js';
import { OVERLAY_ENDPOINT_RADIUS, pathStrokeWidth } from '../theme/geometry.js';
import { RectangleIndex } from './rectangle-index.js';
import { findPort } from './row-paths.js';

/**
 * How far outside a port's own outward face an overlay link turns. It is twice the overlay endpoint
 * mark's radius — the mark is the widest thing drawn at that end — so the rule introduces no number
 * of its own (`.scratch/drawio-export/issues/02-maintainer-edit-principles.md`, principle 2).
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

/** A polyline with no repeated point, so a degenerate corner leaves no zero-length segment. */
const compact = (points: readonly Point[]): Point[] =>
  points.filter((point, index) => index === 0 || !samePoint(points[index - 1]!, point));

/**
 * The same polyline with every point that turns nothing dropped. A point is dropped when it lies
 * **between** its two neighbours on one axis, which a point that doubles back does not — so a
 * candidate that walks back the way it came keeps the reversal and is refused by `reverses` rather
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
 * pill when the port draws one, the node body when it does not — and the point one clearance beyond
 * that box's outward face, which is where the route between the two ends begins.
 */
interface OverlayEnd { anchor: Point; box: Rect; clear: Point; out: Point }

function overlayEnd(node: LayoutNode, port: LayoutPort): OverlayEnd | undefined {
  if (!port.anchor || !port.side || !node.bounds) return undefined;
  const box = port.pill && port.ref.anonymous !== true ? port.pill.bounds : node.bounds;
  const out = NORMAL[port.side];
  // The outward face of the box on this side, plus the clearance, measured from the anchor.
  const face = port.side === 'top' ? box.y : port.side === 'bottom' ? bottom(box)
    : port.side === 'left' ? box.x : right(box);
  const reach = Math.abs((out.x !== 0 ? port.anchor.x : port.anchor.y) - face) + OVERLAY_PILL_CLEARANCE;
  return { anchor: { ...port.anchor }, box,
    clear: { x: port.anchor.x + out.x * reach, y: port.anchor.y + out.y * reach }, out };
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
   * Whether the whole drawn polyline — the two stubs included — ever walks back along the way it
   * came. A candidate can leave the source by the clearance and then turn back toward its own head,
   * when the two cleared ends are less than one clearance apart along the source's normal: it enters
   * no box, ties in length with the clean turn and would win on order. A route that retraces is not
   * a route, and `route/validate` fails a routed path for exactly this.
   */
  const reverses = (points: readonly Point[]): boolean => {
    const step = (one: Point, two: Point): Point =>
      ({ x: Math.sign(two.x - one.x), y: Math.sign(two.y - one.y) });
    const steps = points.slice(1).map((point, index) => step(points[index]!, point));
    return steps.slice(1).some((one, index) =>
      one.x === -steps[index]!.x && one.y === -steps[index]!.y && (one.x !== 0 || one.y !== 0));
  };
  const clearOfAll = (points: readonly Point[]): boolean => everySegment(points, (one, two) => {
    const box = { x: Math.min(one.x, two.x), y: Math.min(one.y, two.y),
      width: Math.abs(two.x - one.x), height: Math.abs(two.y - one.y) };
    return blockers.some(box, blocker => enters(one, two, blocker));
  });
  const clearOfEnds = (points: readonly Point[]): boolean =>
    everySegment(points, (one, two) => boxes.some(box => enters(one, two, box)));
  // A way round can land on the line the two cleared points already share, and then it states a corner
  // that is not one. The reversal test reads the whole polyline, stubs included, because that is
  // where the retrace lives; the box tests read the part between the cleared ends, because the
  // stubs are the port's own reserved outward reach and cross nothing else.
  const candidates = ways.map(way => compact([from, ...way, to]))
    .filter(points => axisAligned(points) && !reverses(compact([head.anchor, ...points, tail.anchor])));
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
 * The polyline an overlay link draws: out of each port past its own outward face by
 * `OVERLAY_PILL_CLEARANCE`, and round every node body and port pill between the two.
 *
 * Nothing here is measured and no box is grown: every number is read off geometry placement already
 * reserved, so the path is derived rather than discovered and the pipeline's one rule holds. It
 * cannot be built before placement freezes, because placement moves pills until stage 7 closes;
 * stage 8 publishes it at the seam that used to publish the straight segment, and an overlay link
 * still never reaches the router.
 *
 * When no candidate is clear — two pills that overlap on both axes, or a diagram that blocks every
 * way round — the link keeps the straight anchor-to-anchor segment, which is what every release before
 * this one drew, and the renderer's mask carries it.
 */
export function overlayPath(model: LayoutModel, link: LayoutLink, blockers?: OverlayBlockers): LayoutPath {
  const attachments = link.attachments!;
  const from = findPort(model, attachments.from), to = findPort(model, attachments.to);
  const head = from && overlayEnd(model.nodes[attachments.from.node]!, from);
  const tail = to && overlayEnd(model.nodes[attachments.to.node]!, to);
  const middle = head && tail ? between(head, tail, blockers ?? overlayBlockers(model)) : undefined;
  const points = head && tail && middle
    ? straighten(compact([head.anchor, ...middle, tail.anchor]))
    : [{ ...from!.anchor! }, { ...to!.anchor! }];
  const segments: PathSegment[] = points.slice(1).map((point, index) =>
    ({ from: { ...points[index]! }, to: { ...point }, owner: { ...link.owner } }));
  return { owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link), segments };
}
