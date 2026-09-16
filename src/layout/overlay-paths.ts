import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { bottom, EPS, retracingRuns, right, samePoint } from '../score/geometry.js';
import { OVERLAY_ENDPOINT_RADIUS, pathStrokeWidth } from '../theme/geometry.js';
import { findPort } from './row-paths.js';

/**
 * How far past a port's own outward face an overlay link's **stub** reaches before the diagonal
 * starts. It is twice the overlay endpoint mark's radius — the mark is the widest thing drawn at
 * that end — so the rule introduces no number of its own
 * (`.scratch/drawio-export/issues/02-maintainer-edit-principles.md`, principle 2).
 *
 * Measured from the **face**, not from the anchor: the anchor is the pill's centre and the renderer
 * masks the pill, so a stub measured from the anchor is shorter than the pill's own half-length
 * (13 px for the 26 px pills placement draws) and nothing of it is ever drawn. From the face, the
 * whole 4 px is drawn, the line meets the pill square, and the diagonal starts clear of it — which
 * is what the maintainer chose over the anchor-to-anchor line (stress ticket 20).
 */
export const OVERLAY_PILL_CLEARANCE = 2 * OVERLAY_ENDPOINT_RADIUS;

/** Unit vector pointing out of a node through the named side. */
const NORMAL: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

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

/**
 * One end of an overlay link: the anchor the path must start from, the box the link leaves — the
 * pill when the port draws one, the node body when it does not — the point on that box's outward
 * face, and the point one stub beyond it, which is where the diagonal between the two ends begins.
 */
interface OverlayEnd { anchor: Point; box: Rect; face: Point; clear: Point; out: Point }

function overlayEnd(node: LayoutNode, port: LayoutPort): OverlayEnd | undefined {
  if (!port.anchor || !port.side || !node.bounds) return undefined;
  const box = port.pill && port.ref.anonymous !== true ? port.pill.bounds : node.bounds;
  const out = NORMAL[port.side];
  // The outward face of the box on this side, plus the stub, measured from the anchor.
  const face = port.side === 'top' ? box.y : port.side === 'bottom' ? bottom(box)
    : port.side === 'left' ? box.x : right(box);
  const depth = Math.abs((out.x !== 0 ? port.anchor.x : port.anchor.y) - face);
  const outward = (by: number): Point => ({ x: port.anchor!.x + out.x * by, y: port.anchor!.y + out.y * by });
  return { anchor: { ...port.anchor }, box, face: outward(depth), clear: outward(depth + OVERLAY_PILL_CLEARANCE), out };
}

/**
 * Whether the two ends face each other **on one line** across a gap narrower than their two stubs.
 * Each end leaves its own outward face by `OVERLAY_PILL_CLEARANCE`, so such a pair states the two
 * stub ends the wrong way round and the segment between them walks back along both stubs. Riding
 * the faces instead keeps the two ends in order, and the whole thing then collapses onto the line
 * the two anchors already share (ticket 04 A). A pair that faces across two different lines keeps
 * its stubs: they cannot cover each other, so the diagonal between them is a real segment.
 */
function tooClose(head: OverlayEnd, tail: OverlayEnd): boolean {
  const along = (from: Point, to: Point): number => (to.x - from.x) * head.out.x + (to.y - from.y) * head.out.y;
  const across = (head.anchor.x - tail.anchor.x) * head.out.y - (head.anchor.y - tail.anchor.y) * head.out.x;
  return head.out.x === -tail.out.x && head.out.y === -tail.out.y && Math.abs(across) <= EPS
    && along(head.anchor, tail.anchor) > EPS && along(head.clear, tail.clear) < -EPS;
}

/**
 * The polyline an overlay link draws: a short **stub** straight out of each port, past that port's
 * own outward face by `OVERLAY_PILL_CLEARANCE`, and **one straight segment** between the two stub
 * ends, at whatever angle that is (maintainer, stress ticket 20). An overlay link is not routed and
 * is not orthogonal; the orthogonal rule of 2026-09-15 governs the routed family only.
 *
 * Three consequences, each chosen rather than inherited:
 *
 * - **The diagonal does not dodge.** It draws through a node body or a pill in its way and the
 *   renderer's mask keeps that shape readable, which is what the mask was always there for. Moving
 *   the nodes so there is nothing to draw through is placement's job (stress ticket 21), not a
 *   search here.
 * - **A pair that lines up degenerates.** Two ports facing each other on a clear axis put all four
 *   points on one line, `straighten` drops both stub ends, and the path is the one straight segment
 *   the maintainer's direct-line rule asks for — byte for byte what the orthogonal derivation drew.
 * - **A pair too close to hold its stubs rides its faces**, so the two ends keep their order
 *   (ticket 04 A). Where even that walks back — two boxes that overlap along the axis — the link
 *   keeps the straight anchor-to-anchor segment, as does an end that states no side to leave by.
 *
 * Nothing here is measured and no box is grown: every number is read off geometry placement already
 * reserved, so the path is derived rather than discovered and the pipeline's one rule holds. It
 * cannot be built before placement freezes, because placement moves pills until stage 7 closes;
 * stage 8 publishes it at the seam that used to publish the straight segment, and an overlay link
 * still never reaches the router.
 */
export function overlayPath(model: LayoutModel, link: LayoutLink): LayoutPath {
  const attachments = link.attachments!;
  const from = findPort(model, attachments.from), to = findPort(model, attachments.to);
  const one = from && overlayEnd(model.nodes[attachments.from.node]!, from);
  const two = to && overlayEnd(model.nodes[attachments.to.node]!, to);
  const { head, tail } = one && two && tooClose(one, two)
    ? { head: { ...one, clear: one.face }, tail: { ...two, clear: two.face } }
    : { head: one, tail: two };
  const stubbed = head && tail
    ? straighten(compact([head.anchor, head.clear, tail.clear, tail.anchor]))
    : undefined;
  // A route that walks back along a run it already drew is not a route, and `route/validate` fails
  // every path — an overlay path included — by the same interval sweep, so the producer may not
  // state one: two stubs that share a line cover each other without ever being adjacent
  // (ticket 04 A).
  const retraces = stubbed !== undefined
    && retracingRuns(stubbed.slice(1).map((point, index) => ({ from: stubbed[index]!, to: point })));
  const points = stubbed && !retraces ? stubbed : [{ ...from!.anchor! }, { ...to!.anchor! }];
  const segments: PathSegment[] = points.slice(1).map((point, index) =>
    ({ from: { ...points[index]! }, to: { ...point }, owner: { ...link.owner } }));
  return { owner: { ...link.owner }, layer: 'overlay', fixed: false, ...pathStrokeWidth(link), segments };
}
