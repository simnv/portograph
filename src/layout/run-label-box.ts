import type { Point, Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { EPS, bottom, right, segmentDistance } from '../geometry/planar.js';
import { type OrientedBox, orientedBounds } from '../geometry/oriented.js';
import { effectiveLayer, groupBoxes, labelCrossesBorder } from '../score/model.js';
import { measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { LINK_LABEL_GEOMETRY } from './link-label-geometry.js';
import { paddingOf } from './overlay-tracks.js';
import { deriveFrames } from './frames.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { isDiagonal } from './diagonal-text.js';

/**
 * Where a link label stands beside a run, read off the geometry alone: the windows of a run, the box stage 9 tries on one side of
 * it, the box 7f reserves room for, the longest run, and whether a link shows a label. Stage 9 (`link-labels.ts`), 7f (`bands.ts`)
 * and the overlay track separation (`overlay-paths.ts`, ticket 24) read these one functions (R1). The module imports no producer, so
 * the overlay path derivation can read it without loading the label producer.
 */

/** How far a border keeps a link label off along its run: the border margin beyond the border's half stroke. */
export const LABEL_BORDER_REACH = LINK_LABEL_GEOMETRY.borderMargin + DEFAULT_STROKE_WIDTHS.group / 2;

/**
 * The pieces of an axis-aligned run where a link label may stand, as ascending intervals along the
 * run's axis: the run less the shorten margin at each end, less every stretch within `borderMargin`
 * of the stroke of a drawn group or frame border (`groupBoxes`). A run that goes along a side edge
 * within that distance loses the whole edge. A diagonal run has windows for a label on its line when
 * `across`, the height of the label's turned box, is given (`diagonalWindows`, ticket 20); without it,
 * and for a run of no length, `undefined`.
 *
 * Placement reads it to reserve the label room (`reserveLinkLabelRoom`) and stage 9 reads it to
 * place the label, so the two cannot disagree on where a label may stand (R1).
 *
 * The windows cut the run along its own line only. The label box stands beside the run, so stage 9
 * also tests the whole box with `labelCrossesBorder`: a border parallel to the run, or a corner, that
 * the box reaches and the run does not refuses the candidate there. Placement reserves room across the
 * run for a run in a group's padding (`acrossRunPadding`, ticket 21); elsewhere such a label falls back to
 * the midpoint and reports `LINK_LABEL_ON_BORDER`.
 */
export function labelRunWindows(boxes: readonly Rect[], run: PathSegment, across = 0, links: readonly LinkRun[] = []): { from: number; to: number }[] | undefined {
  const vertical = Math.abs(run.to.x - run.from.x) <= EPS, horizontal = Math.abs(run.to.y - run.from.y) <= EPS;
  if (vertical === horizontal) return vertical || !(across > 0) ? undefined : diagonalWindows(boxes, run, across, links);
  const at = vertical ? run.from.x : run.from.y;
  const [a, b] = vertical ? [run.from.y, run.to.y] : [run.from.x, run.to.x];
  const low = Math.min(a, b) + LINK_LABEL_GEOMETRY.shortenMargin, high = Math.max(a, b) - LINK_LABEL_GEOMETRY.shortenMargin;
  const reach = LABEL_BORDER_REACH;
  const cuts: [number, number][] = [];
  for (const box of boxes) {
    const [across0, across1, along0, along1] = vertical
      ? [box.x, right(box), box.y, bottom(box)] : [box.y, bottom(box), box.x, right(box)];
    if (at <= across0 - reach + EPS || at >= across1 + reach - EPS) continue;
    if (at < across0 + reach - EPS || at > across1 - reach + EPS) cuts.push([along0 - reach, along1 + reach]);
    else cuts.push([along0 - reach, along0 + reach], [along1 - reach, along1 + reach]);
  }
  return windowsBetween(low, high, cuts);
}

/** The pieces of [low, high] that no cut covers, ascending. */
function windowsBetween(low: number, high: number, cuts: [number, number][]): { from: number; to: number }[] {
  // Last key: the cut's end, so the order is total.
  cuts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const windows: { from: number; to: number }[] = [];
  let start = low;
  for (const [from, to] of cuts) {
    if (from > start + EPS && Math.min(from, high) > start + EPS) windows.push({ from: start, to: Math.min(from, high) });
    start = Math.max(start, to);
    if (start >= high - EPS) break;
  }
  if (high > start + EPS) windows.push({ from: start, to: high });
  return windows;
}

/**
 * The windows of a diagonal run (ticket 20) for a label on the line whose turned box is `across` high (the text height with its
 * halo), as ascending intervals of the text's extent along the run, measured from `run.from`. The run less the shorten margin at
 * each end, less every stretch where a cross-section of the label (the `across` long cut through the box at right angles to the
 * run) touches the stroke of a drawn group or frame border (`labelCrossesBorder`: neither outside the box grown by the half stroke
 * nor inside it shrunk by that), grown by the border margin and the halo along the run. The turned box touches a stroke exactly when
 * one of its cross-sections does, so a label whose text lies in a window is clear of every border by the border margin along the
 * run, as on an axis-aligned run.
 */
function diagonalWindows(boxes: readonly Rect[], run: PathSegment, across: number, links: readonly LinkRun[]): { from: number; to: number }[] {
  const length = Math.hypot(run.to.x - run.from.x, run.to.y - run.from.y);
  const ux = (run.to.x - run.from.x) / length, uy = (run.to.y - run.from.y) / length, nx = -uy, ny = ux, h = across / 2;
  const half = DEFAULT_STROKE_WIDTHS.group / 2, grow = LINK_LABEL_GEOMETRY.borderMargin + LINK_LABEL_GEOMETRY.halo;
  const low = LINK_LABEL_GEOMETRY.shortenMargin, high = length - LINK_LABEL_GEOMETRY.shortenMargin;
  type Span = [number, number];
  const meet = (a: Span, b: Span): Span => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  // The t at which `origin + t * u` (one coordinate) lies in [min, max].
  const along = (origin: number, u: number, min: number, max: number): Span => {
    const a = (min - origin) / u, b = (max - origin) / u;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const cuts: Span[] = [];
  for (const box of boxes) {
    const outer = { x: box.x - half, y: box.y - half, right: right(box) + half, bottom: bottom(box) + half };
    const inner = { x: box.x + half, y: box.y + half, right: right(box) - half, bottom: bottom(box) - half };
    // The cross-section at t meets the outer box: its x and y extents overlap the box's, and the box's extent along the run holds t.
    const projections = [outer.x, outer.right].flatMap(x => [outer.y, outer.bottom].map(y => (x - run.from.x) * ux + (y - run.from.y) * uy));
    let hit: Span = [Math.min(...projections), Math.max(...projections)];
    hit = meet(hit, along(run.from.x, ux, outer.x - h * Math.abs(nx), outer.right + h * Math.abs(nx)));
    hit = meet(hit, along(run.from.y, uy, outer.y - h * Math.abs(ny), outer.bottom + h * Math.abs(ny)));
    if (hit[0] > hit[1]) continue;
    // The cross-section at t lies inside the inner box: both its ends do.
    let inside: Span = inner.right > inner.x && inner.bottom > inner.y ? [-Infinity, Infinity] : [1, 0];
    for (const sign of [-1, 1]) {
      inside = meet(inside, along(run.from.x + sign * h * nx, ux, inner.x, inner.right));
      inside = meet(inside, along(run.from.y + sign * h * ny, uy, inner.y, inner.bottom));
    }
    const pieces: Span[] = inside[0] > inside[1] || inside[1] < hit[0] || inside[0] > hit[1] ? [hit]
      : ([[hit[0], inside[0]], [inside[1], hit[1]]] as Span[]).filter(([a, b]) => b >= a);
    for (const [a, b] of pieces) cuts.push([a - grow, b + grow]);
  }
  // A link run farther from the line than the label's half height, the halo and its clearance (and `LINK_CUT_SKIP` to spare) has no
  // stretch that reaches the run grown by the halo at each end: whatever `linkCut` finds lies beyond both ends and cuts no window. It is
  // skipped without the search, so the windows are the same (architecture-2 ticket 27: 7f reads them in every settle round).
  const reach = h + LINK_LABEL_GEOMETRY.halo + LINK_CUT_SKIP;
  for (const link of links) {
    if (segmentDistance(run, { from: link.segment.from, to: link.segment.to, owner: run.owner }) >= reach + link.clearance) continue;
    const cut = linkCut(run, length, h, link);
    if (cut !== undefined) cuts.push([cut[0] - LINK_LABEL_GEOMETRY.halo, cut[1] + LINK_LABEL_GEOMETRY.halo]);
  }
  return windowsBetween(low, high, cuts);
}

/** A run of another link that placement reserved, and the clear distance a label keeps from it: its half stroke (G3). */
export interface LinkRun { segment: { from: Point; to: Point }; clearance: number }

/** The slack, in px, beyond which `diagonalWindows` skips a link run without the search of `linkCut`. */
const LINK_CUT_SKIP = 1;
/** Bisection and ternary steps of `linkCut` (R4: a count). */
const LINK_CUT_STEPS = 60;

/**
 * How far beyond a link run's clearance `linkCut` ends a window. Stage 9's collision test (`collides`, `meetsBand`) rejects a text
 * nearer than the clearance plus `EPS`. The window edge lies where the bisection stopped, within rounding of the cut's own threshold,
 * so a cut at `+ EPS` let a text that fills its window come out at 0.7500001 against a 0.75 clearance and be rejected. The cut keeps
 * twice that hair, so a text in a window always passes the collision test.
 */
export const LINK_CUT_HAIR = 2 * EPS;

/**
 * The stretch of a diagonal `run` (as t from `run.from`) where the cross-section of a label `2 h` high, at right angles to the run,
 * comes nearer than the clearance to `link`'s segment: G3's test of a label against a routed segment, `areaSegmentDistance` below
 * its half stroke, read one cross-section at a time. The distance of a sliding cross-section to a fixed segment is convex in t, so
 * the stretch is one interval: its least point by a ternary search and both ends by bisection, `LINK_CUT_STEPS` steps each.
 */
function linkCut(run: PathSegment, length: number, h: number, link: LinkRun): [number, number] | undefined {
  const ux = (run.to.x - run.from.x) / length, uy = (run.to.y - run.from.y) / length, nx = -uy, ny = ux;
  const target: PathSegment = { from: link.segment.from, to: link.segment.to, owner: run.owner };
  const distance = (t: number): number => {
    const x = run.from.x + t * ux, y = run.from.y + t * uy;
    return segmentDistance({ from: { x: x - h * nx, y: y - h * ny }, to: { x: x + h * nx, y: y + h * ny }, owner: run.owner }, target);
  };
  const near = (t: number): boolean => distance(t) < link.clearance + LINK_CUT_HAIR;
  let low = -length, high = 2 * length;
  for (let step = 0; step < LINK_CUT_STEPS; step++) {
    const a = low + (high - low) / 3, b = high - (high - low) / 3;
    if (distance(a) <= distance(b)) high = b; else low = a;
  }
  const best = (low + high) / 2;
  if (!near(best)) return undefined;
  const edge = (outside: number): number => {
    let inside = best, out = outside;
    if (near(out)) return out;
    for (let step = 0; step < LINK_CUT_STEPS; step++) { const mid = (inside + out) / 2; if (near(mid)) inside = mid; else out = mid; }
    return out;
  };
  return [edge(-length), edge(2 * length)];
}

/** The longest run of a path, the first of equal ones: the run stage 9 tries first and 7f reserves a label's room on. */
export function longestRun(segments: readonly PathSegment[]): PathSegment | undefined {
  let run: PathSegment | undefined, longest = 0;
  for (const segment of segments) {
    const reach = segmentLength(segment);
    if (reach > longest + PLACEMENT_EPS) { longest = reach; run = segment; }
  }
  return run;
}

/** A run with no axis: a diagonal line, whose label lies on it (ticket 16). */
export function isDiagonalRun(run: PathSegment): boolean {
  return isDiagonal(run);
}

/**
 * Whether a link's authored label asks for room and a place: it has text, draws a line of its own (no stub, bundle member or bus
 * member), is not removed, and is not a suppressed overlay label. 7f (`reserveLinkLabelRoom`) and the label bands read this one test.
 */
export function describedLink(model: LayoutModel, link: LayoutLink, suppressed = overlayLabelsSuppressed(model)): boolean {
  const text = model.document.links[link.sourceIndex]?.label;
  return !!text && link.removed !== true && link.technique !== 'stub' && !link.bundle && link.meshBus === undefined
    && link.attachments !== undefined && !(effectiveLayer(link) === 'overlay' && suppressed);
}

/**
 * Whether a window of `labelRunWindows` holds a label `extent` long along the run. Placement
 * (`reserveLinkLabelRoom`) and stage 9 (`windowCentre`) both ask this, with this one tolerance (R1).
 */
export function windowHolds(window: { from: number; to: number }, extent: number): boolean {
  return window.to - window.from >= extent - EPS;
}

/**
 * The windows of a run (`labelRunWindows`) when a border cuts it; `undefined` for a run no border cuts or a run with no axis. A
 * diagonal run has windows only with the height of the label's turned box (`across`).
 */
export function cutWindows(boxes: readonly Rect[], run: PathSegment, across = 0, links: readonly LinkRun[] = []): { from: number; to: number }[] | undefined {
  const windows = labelRunWindows(boxes, run, across, links);
  if (windows === undefined) return undefined;
  const vertical = Math.abs(run.to.x - run.from.x) <= EPS, horizontal = Math.abs(run.to.y - run.from.y) <= EPS;
  const [a, b] = vertical ? [run.from.y, run.to.y] : horizontal ? [run.from.x, run.to.x] : [0, Math.hypot(run.to.x - run.from.x, run.to.y - run.from.y)];
  const low = Math.min(a, b) + LINK_LABEL_GEOMETRY.shortenMargin, high = Math.max(a, b) - LINK_LABEL_GEOMETRY.shortenMargin;
  const whole = windows.length === 1 && Math.abs(windows[0]!.from - low) <= EPS && Math.abs(windows[0]!.to - high) <= EPS;
  return whole || (!windows.length && high <= low + EPS) ? undefined : windows;
}

/**
 * The centre, along the run's axis, of a label `extent` long in `windows`: the point nearest the
 * run's midpoint at which the label lies wholly in one window. On a tie the lower coordinate wins.
 */
function windowCentre(windows: readonly { from: number; to: number }[], run: PathSegment, extent: number): number | undefined {
  const vertical = Math.abs(run.to.x - run.from.x) <= EPS;
  const mid = vertical ? (run.from.y + run.to.y) / 2 : (run.from.x + run.to.x) / 2;
  let best: number | undefined;
  for (const window of windows) {
    if (!windowHolds(window, extent)) continue;
    const centre = Math.min(Math.max(mid, window.from + extent / 2), window.to - extent / 2);
    if (best === undefined || Math.abs(centre - mid) < Math.abs(best - mid) - EPS) best = centre;
  }
  return best;
}

/** The centre of a label `extent` long on an axis-aligned run with `windows` (`cutWindows`): `undefined` = the midpoint (no border cuts the run), `null` = no window holds it. */
export function runCentre(windows: readonly { from: number; to: number }[] | undefined, run: PathSegment, extent: number): { x: number; y: number } | undefined | null {
  if (windows === undefined) return undefined;
  const along = windowCentre(windows, run, extent);
  if (along === undefined) return null;
  return Math.abs(run.to.x - run.from.x) <= EPS ? { x: run.from.x, y: along } : { x: along, y: run.from.y };
}

/**
 * The box stage 9 tries for a label `size` beside the axis-aligned `run` on one side (`second`): centred where `placeLabel` centres it
 * (the midpoint, or the window point nearest it), `candidateBox` on that side. `undefined` when no window of the run holds the label.
 * Placement reads it to reserve room across a run (ticket 21, `acrossRunPadding`), so the two read one box (R1).
 */
export function runLabelBox(borders: readonly Rect[], run: PathSegment, half: number, size: { width: number; height: number }, second: boolean): Rect | undefined {
  const centre = runCentre(cutWindows(borders, run), run, size.width);
  return centre === null ? undefined : candidateBox(run, half, size, second, centre).bounds;
}

/**
 * The box a label beside an axis-aligned run takes, as stage 9 tries it and 7f reserves its room (`acrossRunPadding`, ticket 21): the
 * first side, except for a run in a group's bottom or left padding on an edge no title holds, whose first box meets a node body, a pill
 * or a border; that label takes the second side, the side of the edge. `second` says which. `undefined` when no window of the run
 * holds the label. 7f and the overlay track separation (`overlayLabelRoom`) read this one box (R1).
 */
export function besideRunLabelBox(model: LayoutModel, borders: readonly Rect[], run: PathSegment, size: { width: number; height: number },
  half: number): { box: Rect; second: boolean } | undefined {
  const first = runLabelBox(borders, run, half, size, false);
  const held = paddingOf(model, run.from, run.to);
  if (held === undefined || held.title || held.side === 'top' || held.side === 'right') return first === undefined ? undefined : { box: first, second: false };
  // Stage 9 tries the side of the bodies first: when that box is free of bodies, pills and borders, the label stands there.
  const taken = first === undefined || borders.some(item => labelCrossesBorder(first, item)) || Object.values(model.nodes).some(node =>
    overlapsOpen(first, node.bounds!) || node.ports.some(port => port.pill !== undefined && overlapsOpen(first, port.pill.bounds)));
  if (!taken) return { box: first, second: false };
  const box = runLabelBox(borders, run, half, size, true);
  return box === undefined ? undefined : { box, second: true };
}
const overlapsOpen = (a: Rect, b: Rect): boolean =>
  a.x < right(b) - PLACEMENT_EPS && b.x < right(a) - PLACEMENT_EPS && a.y < bottom(b) - PLACEMENT_EPS && b.y < bottom(a) - PLACEMENT_EPS;

/** The measured text of a link's authored label (no halo): what 7f reserves room for and the separation keeps clear of. */
export function linkLabelSize(model: LayoutModel, link: LayoutLink): { width: number; height: number } {
  const measured = measureText(model.document.links[link.sourceIndex]!.label!, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
  return { width: measured.width, height: measured.height };
}

/** The drawn group and frame borders a link label stays clear of, read in placement with the frames derived afresh. */
export function labelBorders(model: LayoutModel): Rect[] {
  return groupBoxes({ ...model, frames: deriveFrames(model) ?? model.frames ?? [] }).map(item => item.bounds);
}

/** Overlay labels are suppressed strictly above this density (overlay links per node). */
export const OVERLAY_LABEL_DENSITY = 3;

/** Diagram density as `pipeline.md` defines it; an empty diagram divides by one, not by zero. */
export function overlayDensity(model: LayoutModel): number {
  // A mesh bus is one overlay, not its members (mesh-bus.md, section 6).
  const overlay = model.links.filter(link => effectiveLayer(link) === 'overlay' && link.meshBus === undefined).length + (model.meshBuses?.length ?? 0);
  return overlay / Math.max(1, Object.keys(model.nodes).length);
}

export function overlayLabelsSuppressed(model: LayoutModel): boolean {
  return overlayDensity(model) > OVERLAY_LABEL_DENSITY;
}

export const segmentLength = (segment: PathSegment): number =>
  Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);

/**
 * The measured box for one side of one segment. Text follows the segment (ADR-0014): along a
 * horizontal run it stays upright; along a vertical run it turns by `verticalRotation`; along a
 * declared straight bundle member (ADR-0017) it turns by the run's own angle, flipped by 180° when
 * that would read upside down (Visio gravity). The stored box is the rotated one, so its long side
 * lies along the run. The box is centred on the segment's midpoint, or on `centre` when given (a
 * point of the run); the 4 px normal gap is visible clearance beyond the stroke edge. A segment that
 * is neither axis-aligned nor a declared straight member — only an overlay link can be one — uses its
 * dominant axis. A vertical declared straight member is a vertical run: its text reads bottom-to-top
 * whichever way the member runs.
 */
export function candidateBox(segment: PathSegment, half: number, size: { width: number; height: number }, second: boolean,
  centre?: { x: number; y: number }): { bounds: Rect; textRotation: number; turnedSize?: { width: number; height: number } } {
  const midX = centre?.x ?? (segment.from.x + segment.to.x) / 2, midY = centre?.y ?? (segment.from.y + segment.to.y) / 2;
  const gap = LINK_LABEL_GEOMETRY.normalGap + half;
  if (segment.straight === true && Math.abs(segment.to.x - segment.from.x) > EPS) {
    const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
    // Gravity: the heading that keeps the text upright, then the box rotated about the midpoint.
    let degrees = Math.atan2(dy, dx) * 180 / Math.PI;
    if (degrees > 90) degrees -= 180;
    if (degrees <= -90) degrees += 180;
    const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const side = second ? -1 : 1, nx = side * sin, ny = -side * cos;
    // A turned label (ticket 20) is tested by its turned rectangle, so it stands half the text height plus the visible gap beside
    // the run; the stored box is that rectangle's upright box, and the label records the rectangle's size.
    if (degrees !== 0) {
      const offset = gap + size.height / 2;
      const area: OrientedBox = { centre: { x: midX + nx * offset, y: midY + ny * offset }, width: size.width, height: size.height, degrees };
      return { bounds: orientedBounds(area), textRotation: degrees, turnedSize: { width: size.width, height: size.height } };
    }
    // Upright: the offset clears the box, half its extent along the run's normal plus the visible gap.
    const width = Math.abs(size.width * cos) + Math.abs(size.height * sin);
    const height = Math.abs(size.width * sin) + Math.abs(size.height * cos);
    const offset = gap + (width * Math.abs(nx) + height * Math.abs(ny)) / 2;
    const cx = midX + nx * offset, cy = midY + ny * offset;
    return { bounds: { x: cx - width / 2, y: cy - height / 2, width, height }, textRotation: degrees };
  }
  if (Math.abs(segment.to.x - segment.from.x) >= Math.abs(segment.to.y - segment.from.y)) {
    return { bounds: { x: midX - size.width / 2, y: second ? midY + gap : midY - gap - size.height, ...size }, textRotation: 0 };
  }
  const rotated = { width: size.height, height: size.width };
  return { bounds: { x: second ? midX - gap - rotated.width : midX + gap, y: midY - rotated.height / 2, ...rotated }, textRotation: LINK_LABEL_GEOMETRY.verticalRotation };
}
