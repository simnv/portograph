import type { Point, Rect } from '../model/geometry.js';
import type {
  Bundle, Diagnostic, LabelSupport, LayoutLabel, LayoutLink, LayoutModel, LayoutPath, Owner, PathSegment,
} from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { EPS, bottom, contains, right, segmentDistance } from '../geometry/planar.js';
import { effectiveLayer, groupBoxes, labelArea, labelCrossesBorder } from '../score/model.js';
import { type Area, type OrientedBox, areaBounds, areaDistance, areaSegment, areaSegmentDistance, isOriented, orientedBounds } from '../geometry/oriented.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { CANVAS_MARGIN, DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { type ShapeQuery, overlayPath, sharedBlockers, straightChord } from './overlay-paths.js';
import { drawnBoxes as paintedBoxes, produceLegend } from './legend.js';
import { BUS_LABEL_FONT, BUS_LABEL_GAP, busCarriesLabel, busLabelText } from './bus-room.js';
import { withLayoutMutation } from './mutation.js';
import { RectangleIndex, type RectangleBounds } from './rectangle-index.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Theme typography and the two spacing rulings stage 9 needs; `pipeline.md` fixes the ladder. */
export const LINK_LABEL_GEOMETRY = {
  fontFamily: FONT_FAMILY,
  fontSize: 9,
  fontWeight: 400 as const,
  /** Visible gap between the label box and the supporting path's stroke edge. */
  normalGap: 4,
  /** The checked-in advance table has no U+2026, so shortening uses measured ASCII dots. */
  ellipsis: '...',
  /** A shortened label must leave this much of its supporting segment free. */
  shortenMargin: 8,
  /**
   * Text follows its supporting segment (ADR-0014): horizontal along a horizontal run, and along a
   * vertical run rotated so it reads bottom-to-top — Visio's "gravity": rotated text is never
   * upside down and never reads top-to-bottom. Orthogonal paths need only these two headings.
   */
  verticalRotation: -90 as const,
  /**
   * Architecture ticket 16: a label on a direct (diagonal) line lies on it, centred, text at the
   * line's angle. The line is cut away under the text with this much clear space round the glyphs,
   * and the placed box reserves that space.
   */
  halo: 2,
  /** Step of the scan along a direct line when the midpoint is taken. */
  alongStep: 2,
  /**
   * A link label stays in one region: along its run it keeps this much clear space beyond the
   * stroke of every drawn group or frame border the run crosses, as it keeps the shorten margin from
   * the run's ends. Placement reserves the room with the same figure (`labelRunWindows`).
   */
  borderMargin: 8,
} as const;

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
 * the box reaches and the run does not refuses the candidate there. Placement reserves no room across
 * the run for that case; such a label falls back to the midpoint and reports `LINK_LABEL_ON_BORDER`.
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
  for (const link of links) {
    const cut = linkCut(run, length, h, link);
    if (cut !== undefined) cuts.push([cut[0] - LINK_LABEL_GEOMETRY.halo, cut[1] + LINK_LABEL_GEOMETRY.halo]);
  }
  return windowsBetween(low, high, cuts);
}

/** A run of another link that placement reserved, and the clear distance a label keeps from it: its half stroke (G3). */
export interface LinkRun { segment: { from: Point; to: Point }; clearance: number }

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
/**
 * The link geometry placement reserved, as the runs a label on a diagonal line keeps clear of (ticket 20, user decision 2026-10-23):
 * every frozen chord (`model.frozenChords`, its straight segment between its two faces) and every routed lane (`model.lanes`: a
 * vertical run at the lane's x over its reserved extent; a span corridor is its chord's room, not a run), less the label's own
 * link, and the bands of the labels this label yields to (`labelBands`, read from `model.labelYields`). Placement (7f) and stage 9
 * pass the same runs to `labelRunWindows` (R1). A link placement did not reserve is left to stage 9's collision test.
 */
export function reservedLinkRuns(model: LayoutModel, own: string): LinkRun[] {
  return [...fixedLinkRuns(model, own), ...labelBands(model, own)];
}

/** The frozen chords and routed lanes of `reservedLinkRuns`, less the label's own link. */
function fixedLinkRuns(model: LayoutModel, own: string): LinkRun[] {
  const runs: LinkRun[] = [];
  const byId = new Map(model.links.map(link => [link.id, link]));
  for (const id of model.frozenChords ?? []) {
    const link = byId.get(id);
    if (link === undefined || id === own) continue;
    const chord = straightChord(model, link, undefined, true);
    if (chord !== undefined) runs.push({ segment: chord, clearance: linkStrokeWidth(link) / 2 });
  }
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay' || lane.kind === 'span' || lane.owner.kind === 'link' && lane.owner.id === own) continue;
    const owner = lane.owner.kind === 'link' ? byId.get(lane.owner.id) : undefined;
    runs.push({ segment: { from: { x: lane.x, y: lane.bounds.y }, to: { x: lane.x, y: bottom(lane.bounds) } },
      clearance: (owner ? linkStrokeWidth(owner) : DEFAULT_STROKE_WIDTHS.path) / 2 });
  }
  return runs;
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
  return Math.abs(run.to.x - run.from.x) > PLACEMENT_EPS && Math.abs(run.to.y - run.from.y) > PLACEMENT_EPS;
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

/** A described overlay link whose label lies on a diagonal line, with that label's extent, turned height and band. */
interface LabelledLine { link: LayoutLink; line: PathSegment; extent: number; across: number; band: LinkRun }

/**
 * Every described overlay link (`describedLink`) whose longest run (`longestRun`) is a diagonal line (`isDiagonalRun`). Its label
 * lies on that line, so wholly in the line's **band**: the line, with half the height of the label's turned box plus the halo as
 * clearance. `drawn` reads the published path when there is one (the band a drawn label lies in, `labelBands`); otherwise, and for the
 * decision and its check (`recordLabelYields`, `labelYieldsFault`), the path placement derives (`overlayPath`): under
 * `layout.overlayOverBodies` the two can differ, and the record is a placement decision.
 */
function labelledLines(model: LayoutModel, drawn: boolean): LabelledLine[] {
  const suppressed = overlayLabelsSuppressed(model);
  const lines: LabelledLine[] = [];
  let blockers: ShapeQuery | undefined;
  for (const link of model.links) {
    if (!describedLink(model, link, suppressed) || effectiveLayer(link) !== 'overlay') continue;
    const line = longestRun((drawn ? link.path?.segments : undefined) ?? overlayPath(model, link, blockers ??= sharedBlockers(model)).segments);
    if (line === undefined || !isDiagonalRun(line)) continue;
    const measured = measure(model.document.links[link.sourceIndex]!.label!), across = haloSize(measured).height;
    lines.push({ link, line, extent: measured.width, across,
      band: { segment: { from: { ...line.from }, to: { ...line.to } }, clearance: across / 2 + LINK_LABEL_GEOMETRY.halo } });
  }
  return lines;
}

/**
 * The bands of the labels the label of `own` yields to, read from the record 7f made (`model.labelYields`, `recordLabelYields`), on
 * the lines as they stand now. Absent record: no yield. Stage 9 never decides a yield; it reads this.
 */
export function labelBands(model: LayoutModel, own: string): LinkRun[] {
  const yields = model.labelYields?.[own];
  if (!yields?.length) return [];
  const lines = new Map(labelledLines(model, true).map(item => [item.link.id, item]));
  return yields.flatMap(id => { const line = lines.get(id); return line ? [line.band] : []; });
}

/**
 * Who yields, decided once per pair and recorded (`model.labelYields`, R1). Two labels on diagonal lines whose bands can meet would
 * each take the window placement reserved for the other (the label placed first takes it). So one label of each such pair keeps clear
 * of the other's band, in placement (its windows) and in stage 9 (every candidate on its line), and the other lies in its own band:
 * the two never meet, whichever stage 9 places first. The label with the more **slack** yields: the longest window of its line clear
 * of the borders (`boxes`), the fixed link runs and the other's band, less its text. On equal slack the later link in link order
 * yields (the last key).
 *
 * The record has a key for every labelled diagonal line ([] = it yields to none). A pair is decided when its bands first can meet,
 * and never again: a decided pair keeps its direction whatever moves later. A key whose link no longer carries a label on a diagonal
 * line is dropped, with every reference to it. Returns whether the record changed. 7f calls it before each reservation and once more
 * on the geometry that publishes; the validator replays it on a copy, and a record it would change is rejected.
 *
 * Convergence, per pair: the reservation grows the gap until the yielding label's window holds, or reports the label
 * LINK_LABEL_ROOM_UNRESERVED and grows nothing for it; the decision never flips, and growth only increases, so the passes end. A label
 * that yields to two or more others may find no window clear of every band at any growth: it is reported and stays without a window.
 */
export function recordLabelYields(model: LayoutModel, boxes: readonly Rect[]): boolean {
  const lines = labelledLines(model, false);
  const live = new Set(lines.map(item => item.link.id));
  const before = model.labelYields;
  const record: Record<string, string[]> = {};
  for (const item of lines) record[item.link.id] = (before?.[item.link.id] ?? []).filter(id => live.has(id));
  const fixed = new Map<string, LinkRun[]>();
  const slack = (line: LabelledLine, other: LabelledLine): number => {
    let runs = fixed.get(line.link.id);
    if (runs === undefined) fixed.set(line.link.id, runs = fixedLinkRuns(model, line.link.id));
    const windows = labelRunWindows(boxes, line.line, line.across, [...runs, other.band]) ?? [];
    return Math.max(-Infinity, ...windows.map(window => window.to - window.from)) - line.extent;
  };
  for (const [i, mine] of lines.entries()) for (const other of lines.slice(i + 1)) {
    const a = mine.link.id, b = other.link.id;
    if (record[a]!.includes(b) || record[b]!.includes(a)) continue;
    // Bands that cannot meet: the two lines stay farther apart than both clearances.
    if (segmentDistance(mine.line, { ...other.line, owner: mine.line.owner }) >= mine.band.clearance + other.band.clearance - EPS) continue;
    const p = slack(mine, other), q = slack(other, mine);
    // A line with no window has slack -Infinity: two such lines are equal, and the later link (`other`) yields.
    if (p > q + EPS) record[a]!.push(b); else record[b]!.push(a);
  }
  // Values in link order, so the record does not depend on the order pairs were decided in.
  const order = new Map(model.links.map((link, at) => [link.id, at]));
  for (const id of Object.keys(record)) record[id]!.sort((x, y) => order.get(x)! - order.get(y)!);
  const next = lines.length ? record : undefined;
  if (equal(next, before)) return false;
  if (next === undefined) delete model.labelYields; else model.labelYields = next;
  return true;
}

/**
 * The checks a validator makes on `model.labelYields` before it replays it (R5): every key and every value names a link whose label
 * lies on a diagonal line now, no link yields to itself, and no pair yields both ways.
 */
export function labelYieldsFault(model: LayoutModel): string | undefined {
  const record = model.labelYields;
  if (record === undefined) return undefined;
  const live = new Set(labelledLines(model, false).map(item => item.link.id));
  for (const [id, yields] of Object.entries(record)) {
    if (!live.has(id)) return `${id} carries no label on a diagonal line`;
    for (const other of yields) {
      if (other === id) return `${id} yields to itself`;
      if (!live.has(other)) return `${id} yields to ${other}, which carries no label on a diagonal line`;
      if (record[other]?.includes(id)) return `${id} and ${other} yield to each other`;
    }
  }
  return undefined;
}

/**
 * Whether a window of `labelRunWindows` holds a label `extent` long along the run. Placement
 * (`reserveLinkLabelRoom`) and stage 9 (`windowCentre`) both ask this, with this one tolerance (R1).
 */
export function windowHolds(window: { from: number; to: number }, extent: number): boolean {
  return window.to - window.from >= extent - EPS;
}

/**
 * How far placement must grow a `run` so that one of its windows (`labelRunWindows`) holds a label `extent` long
 * (`windowHolds`), when the growth moves everything at or beyond `split` on the run's axis on by that much: a box beyond the split
 * moves, a box across it stretches, a box before it stays, and so do the run's two ends. Placement (`reserveLinkLabelRoom`) asks
 * this for every run a label rides, with the same two functions stage 9 places the label with (R1).
 *
 * Zero when a window holds the label now, and for a diagonal run without `turned` (stage 9 decides). `undefined` when no window
 * grows with the move, or the grown window still does not hold the label: a box that moves with the far end cuts the run. On an
 * axis-aligned run a window between a cut that stays and a cut that moves grows by exactly the growth, so one probe gives the growth.
 *
 * `farEndMoves` states that the run's end with the larger coordinate moves whatever the split says: the end on a pill that stands out
 * of its box, before the top of the box that moves with it. The split then stays where the boxes part, and no box before it is taken
 * as moved.
 *
 * `turned` gives a diagonal run its windows (ticket 20): the label lies on the line, `across` is the height of its turned box, and
 * the growth moves things on `axis`. The run then turns as its far end moves, so the window does not grow linearly with the growth:
 * the least growth is found by bisection, `LABEL_WINDOW_BISECTIONS` steps from a probe that holds the label, and is rounded up to
 * `LABEL_WINDOW_GRAIN` so that a replay on the grown geometry finds the window holding.
 */
export function labelWindowDeficit(boxes: readonly Rect[], run: PathSegment, extent: number, split: number, farEndMoves = false,
  turned?: { across: number; axis: 'x' | 'y'; links?: readonly LinkRun[] }): number | undefined {
  const vertical = Math.abs(run.to.x - run.from.x) <= EPS, horizontal = Math.abs(run.to.y - run.from.y) <= EPS;
  if (vertical && horizontal) return 0;
  const diagonal = !vertical && !horizontal;
  if (diagonal && turned === undefined) return 0;
  const axis = diagonal ? turned!.axis : vertical ? 'y' : 'x', size = axis === 'y' ? 'height' : 'width';
  const windows = (growth: number): { from: number; to: number }[] => {
    const moved = (at: number): number => at >= split - EPS ? at + growth : at;
    const far = Math.max(run.from[axis], run.to[axis]);
    const end = (at: number): number => farEndMoves && at >= far - EPS ? at + growth : moved(at);
    const grown = boxes.map(box => ({ ...box, [axis]: moved(box[axis]), [size]: moved(box[axis] + box[size]) - moved(box[axis]) }));
    // A reserved link run moves with the boxes: an end at or beyond the split moves on (a chord's or lane's lower end).
    const links = (turned?.links ?? []).map(link => ({ ...link, segment: {
      from: { ...link.segment.from, [axis]: moved(link.segment.from[axis]) }, to: { ...link.segment.to, [axis]: moved(link.segment.to[axis]) } } }));
    return labelRunWindows(grown, { ...run, from: { ...run.from, [axis]: end(run.from[axis]) }, to: { ...run.to, [axis]: end(run.to[axis]) } },
      turned?.across, links) ?? [];
  };
  const holds = (growth: number): boolean => windows(growth).some(window => windowHolds(window, extent));
  if (holds(0)) return 0;
  if (diagonal) {
    const length = Math.hypot(run.to.x - run.from.x, run.to.y - run.from.y);
    let high = length + extent + 4 * LABEL_BORDER_REACH + 2 * LINK_LABEL_GEOMETRY.shortenMargin + 2 * turned!.across, low = 0;
    if (!holds(high)) return undefined;
    for (let step = 0; step < LABEL_WINDOW_BISECTIONS; step++) {
      const middle = (low + high) / 2;
      if (holds(middle)) high = middle; else low = middle;
    }
    const rounded = Math.ceil(high / LABEL_WINDOW_GRAIN) * LABEL_WINDOW_GRAIN;
    return holds(rounded) ? rounded : high;
  }
  // A probe longer than the run, the label and every border cut together: a window that grows is then the longest one, and the
  // only one that can hold the label (no window that stays holds it).
  const span = Math.abs(run.to[axis] - run.from[axis]), probe = span + extent + 4 * LABEL_BORDER_REACH + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
  const longest = Math.max(0, ...windows(probe).map(window => window.to - window.from));
  if (longest < extent - EPS) return undefined;
  const growth = Math.max(0, extent - (longest - probe));
  return windows(growth).some(window => windowHolds(window, extent)) ? growth : undefined;
}

/** Bisection steps of `labelWindowDeficit` on a diagonal run (R4: a count, not a time). */
export const LABEL_WINDOW_BISECTIONS = 40;
/** The grain, in px, a diagonal run's growth is rounded up to. */
export const LABEL_WINDOW_GRAIN = 1e-3;

/**
 * The windows of a run (`labelRunWindows`) when a border cuts it; `undefined` for a run no border cuts or a run with no axis. A
 * diagonal run has windows only with the height of the label's turned box (`across`).
 */
function cutWindows(boxes: readonly Rect[], run: PathSegment, across = 0, links: readonly LinkRun[] = []): { from: number; to: number }[] | undefined {
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

/** A direct line is a segment with no axis: its label lies on it (ticket 16). */
export function isDirect(segment: PathSegment): boolean {
  return Math.abs(segment.to.x - segment.from.x) > EPS && Math.abs(segment.to.y - segment.from.y) > EPS;
}

/** The heading of a direct line normalised to (-90, 90], so text never reads upside down. */
export function lineAngle(segment: PathSegment): number {
  let degrees = Math.atan2(segment.to.y - segment.from.y, segment.to.x - segment.from.x) * 180 / Math.PI;
  if (degrees > 90) degrees -= 180;
  if (degrees <= -90) degrees += 180;
  return degrees;
}

/** The text box of a label, with its halo, before rotation. */
export function haloSize(size: { width: number; height: number }): { width: number; height: number } {
  return { width: size.width + 2 * LINK_LABEL_GEOMETRY.halo, height: size.height + 2 * LINK_LABEL_GEOMETRY.halo };
}

/** The axis-aligned box of a `size` rectangle turned by `degrees` about `centre`. */
export function turnedBox(centre: { x: number; y: number }, size: { width: number; height: number }, degrees: number): Rect {
  const radians = degrees * Math.PI / 180, cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const width = size.width * cos + size.height * sin, height = size.width * sin + size.height * cos;
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

/** Overlay labels are suppressed strictly above this density (overlay links per node). */
export const OVERLAY_LABEL_DENSITY = 3;

export const LINK_LABEL_CODES = ['LINK_LABEL_OMITTED', 'LINK_LABEL_SHORTENED', 'LINK_LABELS_OVERLAY_SUPPRESSED', 'LINK_LABEL_ON_BORDER'] as const;

/** Diagram density as `pipeline.md` defines it; an empty diagram divides by one, not by zero. */
export function overlayDensity(model: LayoutModel): number {
  // A mesh bus is one overlay, not its members (mesh-bus.md, section 6).
  const overlay = model.links.filter(link => effectiveLayer(link) === 'overlay' && link.meshBus === undefined).length + (model.meshBuses?.length ?? 0);
  return overlay / Math.max(1, Object.keys(model.nodes).length);
}

export function overlayLabelsSuppressed(model: LayoutModel): boolean {
  return overlayDensity(model) > OVERLAY_LABEL_DENSITY;
}

interface Obstacle {
  /** Rectangle to clear. A segment stores its own bounding box here and its exact geometry below. */
  bounds: Rect;
  /** Required clear distance beyond the rectangle; zero for a label box. */
  clearance: number;
  /** A placed turned label's turned rectangle (ticket 20), which the tests read instead of `bounds`. */
  area?: OrientedBox;
  segment?: PathSegment;
  /** Set only for a path segment, so a supporting reference can waive its clearance zone. */
  link?: string;
  index?: number;
  /** A drawn overlay run, which a label avoids when it can and crosses when it must. */
  overlay?: true;
}

/** Stroke-expanded obstacle rectangles, queried without materializing a candidate list. */
class ObstacleIndex {
  private readonly rectangles: RectangleIndex<Obstacle>;

  constructor(items: Obstacle[]) {
    this.rectangles = new RectangleIndex(items.map(value => ({ bounds: this.bounds(value), value, padding: value.clearance + EPS })));
  }

  add(item: Obstacle): void { this.rectangles.add(this.bounds(item), item, item.clearance + EPS); }

  some(box: Rect, predicate: (item: Obstacle) => boolean): boolean {
    return this.rectangles.some(box, predicate, undefined, EPS);
  }

  private bounds(item: Obstacle): RectangleBounds {
    if (!item.segment) return item.bounds;
    const { from, to } = item.segment;
    return { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y),
      right: Math.max(from.x, to.x), bottom: Math.max(from.y, to.y) };
  }
}

const segmentBounds = (segment: PathSegment): Rect => ({
  x: Math.min(segment.from.x, segment.to.x), y: Math.min(segment.from.y, segment.to.y),
  width: Math.abs(segment.to.x - segment.from.x), height: Math.abs(segment.to.y - segment.from.y),
});
const segmentLength = (segment: PathSegment): number =>
  Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
const halfStroke = (path: LayoutPath | undefined): number =>
  (path?.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path) / 2;

/**
 * Everything a candidate box must clear, indexed once per producer run. Placed labels join it as
 * they are accepted, so an earlier accepted label is an obstacle for every later one.
 *
 * **A drawn overlay run is an obstacle too**, which is stricter than G3 — the gate measures a label
 * against routed geometry only. It used to be left out because the renderer masks the overlay layer
 * out of every drawn link label, so the label stayed readable. What that hid is the other side of
 * the same collision: the mask cuts the *overlay* wherever a label sits on it, and since the overlay
 * became an orthogonal path round the shapes it crosses (synthetics review ticket 01) the line it
 * cuts is a line the rule went to some trouble to keep whole. A label is the thing that can move, so
 * the label moves. Node bodies and pills on the overlay layer stay out: they are not drawn.
 */
function buildObstacles(model: LayoutModel): ObstacleIndex {
  const items: Obstacle[] = [];
  for (const node of Object.values(model.nodes)) {
    if (node.layer === 'overlay') continue;
    items.push({ bounds: node.bounds!, clearance: (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2 });
    for (const port of node.ports) {
      if (!port.pill || port.pill.layer === 'overlay') continue;
      items.push({ bounds: port.pill.bounds, clearance: DEFAULT_STROKE_WIDTHS.pill / 2 });
    }
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds) continue;
    items.push(labelObstacle(label));
  }
  for (const link of model.links) {
    if (link.technique === 'stub' || !link.path) continue;
    const half = halfStroke(link.path), overlay = effectiveLayer(link) === 'overlay';
    for (const [i, segment] of link.path.segments.entries()) {
      items.push({ bounds: segmentBounds(segment), clearance: half, segment, link: link.id, index: i,
        ...(overlay ? { overlay: true as const } : {}) });
    }
  }
  return new ObstacleIndex(items);
}

/** A placed label as an obstacle: its box, and its turned rectangle when it is turned (`labelArea`). */
function labelObstacle(label: Pick<LayoutLabel, 'bounds' | 'turnedSize' | 'textRotation'>): Obstacle {
  const area = labelArea(label);
  return { bounds: label.bounds!, clearance: 0, ...(isOriented(area) ? { area } : {}) };
}

/**
 * True when G3 would report this area, plus a hair: every predicate rejects at `+ EPS` where G3
 * fails at `- EPS`, so an accepted placement cannot become a label hit. A turned label is tested
 * by its turned rectangle, upright geometry by its box (ticket 20); the index is asked with the
 * upright box, which holds the area.
 */
function collides(index: ObstacleIndex, area: Area, support: LabelSupport | undefined,
  overlayCounts = true, onLine = false): boolean {
  return index.some(areaBounds(area), item => {
    if (item.overlay && !overlayCounts) return false;
    if (!item.segment) return areaDistance(area, item.area ?? item.bounds) < item.clearance + EPS;
    const supporting = support?.kind === 'link-segment' && support.link === item.link
      && item.index !== undefined && item.index >= support.segment && item.index <= (support.through ?? support.segment);
    // A label on a direct line lies on the very line it names (ticket 16): that line is no obstacle.
    if (onLine && supporting && isDirect(item.segment)) return false;
    if (areaSegment(item.segment, area)) return true;
    return !supporting && areaSegmentDistance(item.segment, area) < item.clearance + EPS;
  });
}

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

interface Placement {
  onLine?: true; segment: number; bounds: Rect; textRotation: number; turnedSize?: { width: number; height: number };
  text: string; lines: string[]; lineHeight: number;
}
interface Supported {
  segments: PathSegment[]; half: number; support: (index: number) => LabelSupport | undefined;
  /** The link runs placement reserved that a label on a diagonal line keeps clear of (`reservedLinkRuns`). */
  links?: readonly LinkRun[];
  /** The bands of the labels this label yields to (`labelBands`): no candidate on its line meets one, on any rung. A candidate beside the line is left to the collision test. */
  bands?: readonly LinkRun[];
}

/** Whether `area` meets one of the label bands a label yields to (`labelBands`), with the hair every predicate here keeps. */
function meetsBand(bands: readonly LinkRun[] | undefined, area: Area): boolean {
  return (bands ?? []).some(band => areaSegmentDistance({ ...band.segment, owner: { kind: 'link', id: '' } }, area) < band.clearance + EPS);
}

/**
 * The supports of a link path (ticket 142). A link with a lane piece publishes one straight run as
 * several collinear consecutive pieces (stem, gap part, lane), and 7a reserved the label room over
 * the whole run. The label placer reads each such run as one segment, so the label stands on the
 * run whose room was reserved. A link with no lane piece keeps one support per segment. In a lane
 * link every collinear same-direction pair is joined, also a pair away from the lane run.
 */
export function labelRuns(segments: PathSegment[]): { segment: PathSegment; first: number; last: number }[] {
  const runs: { segment: PathSegment; first: number; last: number }[] = segments.map((segment, at) => ({ segment, first: at, last: at }));
  if (!segments.some(segment => segment.lane !== undefined)) return runs;
  const merged: typeof runs = [];
  for (const run of runs) {
    const before = merged[merged.length - 1];
    if (before && collinearContinuation(before.segment, run.segment)) {
      before.segment = { ...before.segment, to: run.segment.to };
      before.last = run.last;
    } else merged.push({ ...run });
  }
  return merged;
}

/** True when `next` starts where `run` ends and both go the same way along one axis. */
function collinearContinuation(run: PathSegment, next: PathSegment): boolean {
  if (run.straight === true || next.straight === true) return false;
  if (Math.abs(run.to.x - next.from.x) > EPS || Math.abs(run.to.y - next.from.y) > EPS) return false;
  const vertical = (s: PathSegment) => Math.abs(s.to.x - s.from.x) <= EPS && Math.abs(s.to.y - s.from.y) > EPS;
  const horizontal = (s: PathSegment) => Math.abs(s.to.y - s.from.y) <= EPS && Math.abs(s.to.x - s.from.x) > EPS;
  return vertical(run) && vertical(next) && Math.sign(run.to.y - run.from.y) === Math.sign(next.to.y - next.from.y)
    || horizontal(run) && horizontal(next) && Math.sign(run.to.x - run.from.x) === Math.sign(next.to.x - next.from.x);
}

const measure = (text: string) =>
  measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });

/**
 * Measured width of `prefix + ellipsis` for every proper prefix of `text`, as `max(before, line)`:
 * the widest completed line, against the open line plus the ellipsis.
 *
 * The width does **not** grow with the prefix length, so this cannot bisect: a line break inside
 * the prefix moves the ellipsis onto a new line and can make the whole box narrower. `measureText`
 * sums per-character advances with no shaping or kerning, so one pass over the code points gives
 * the exact numbers it would return, and `.split(/\r\n|\r|\n/)` is mirrored exactly, `\r\n`
 * included.
 */
function prefixWidths(text: string): { before: number[]; line: number[]; characters: string[] } {
  const characters = [...text], before: number[] = [], line: number[] = [];
  const advances = new Map<string, number>();
  const advance = (character: string): number => {
    const known = advances.get(character);
    if (known !== undefined) return known;
    const width = measure(character).width;
    advances.set(character, width);
    return width;
  };
  let widest = 0, open = 0, afterReturn = false;
  for (const character of characters) {
    before.push(widest); line.push(open);
    if (character === '\r' || character === '\n') {
      if (character === '\r' || !afterReturn) { widest = Math.max(widest, open); open = 0; }
      afterReturn = character === '\r';
      continue;
    }
    afterReturn = false;
    open += character === '\t' ? 4 * advance(' ') : advance(character);
  }
  return { before, line, characters };
}

/** Longest proper prefix plus the ellipsis that fits `limit`, or nothing when even `...` does not. */
function shorten(widths: ReturnType<typeof prefixWidths>, limit: number): string | undefined {
  const ellipsis = measure(LINK_LABEL_GEOMETRY.ellipsis).width;
  for (let count = widths.characters.length - 1; count >= 0; count--) {
    if (Math.max(widths.before[count]!, widths.line[count]! + ellipsis) <= limit + EPS) {
      return widths.characters.slice(0, count).join('') + LINK_LABEL_GEOMETRY.ellipsis;
    }
  }
  return undefined;
}

/**
 * One rung of the ladder of `pipeline.md` stage 9: the first side across every segment in descending
 * length order, then the opposite side across that order. Above and right are the deterministic
 * first sides; ties break on the source-to-target segment index.
 *
 * `shortened` chooses the text the rung offers, and `overlayCounts` whether drawn overlay runs are
 * obstacles on it. The caller decides the order of the rungs, because the choices are not nested
 * (ticket 04 C). `borders` are the drawn group and frame boxes the label may not lie across; absent,
 * the label takes the midpoint and borders are not read.
 */
function placeLabel(index: ObstacleIndex, supported: Supported, text: string, shortenable: boolean,
  shortened: boolean, overlayCounts: boolean, borders: readonly Rect[] | undefined, refusal: { border: boolean } = { border: false }): Placement | undefined {
  const ordered = supported.segments
    .map((segment, at) => ({ segment, at, length: segmentLength(segment) }))
    .filter(item => item.length > EPS)
    .sort((a, b) => b.length - a.length || a.at - b.at);
  const widths = shortened ? prefixWidths(text) : undefined;
  // An authored description takes the first clear candidate in ladder order whose segment is long
  // enough to carry it: the text plus the shorten margin at each end, so a label never overhangs
  // both ends of the run it names (ticket 30). A multiplicity count is not shortenable and keeps
  // its trunk however short — a count-2 run one member pitch long is 17.5 px, less than `2` plus
  // both margins — so the length guard is the shortenable labels' alone. A shortened text takes
  // the clear candidate that keeps the most characters, so the best location is found
  // automatically rather than the first short stub of a segment; ties keep ladder order.
  let best: Placement | undefined;
  for (const second of [false, true]) {
    for (const { segment, at, length } of ordered) {
      // A direct line carries its label on it (ticket 16), and has one place for it, so only the first
      // side pass tries. A line too short for the text on it, or crowded along its whole length, falls
      // back to the rule that held before: the box beside the line, at the line's angle when it is a
      // declared straight member, on the dominant axis otherwise.
      if (isDirect(segment) && !second) {
        // With borders, a line a border cuts offers only its windows (ticket 20): a shortened text fits the longest one.
        const lineWindows = borders === undefined ? undefined : cutWindows(borders, segment, haloSize(measure(text)).height, supported.links);
        const longestOn = lineWindows === undefined ? Infinity : Math.max(0, ...lineWindows.map(window => window.to - window.from));
        const onLine = shortened ? shorten(widths!, Math.min(length - 2 * LINK_LABEL_GEOMETRY.shortenMargin, longestOn)) : text;
        const measuredOn = onLine === undefined ? undefined : measure(onLine);
        const fits = measuredOn !== undefined && measuredOn.lines.length > 0
          && (shortened || !shortenable || measuredOn.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin <= length + EPS);
        const found = fits ? alongLine(index, segment, length, measuredOn, supported.support(at), overlayCounts, borders, refusal, supported.links, supported.bands) : undefined;
        if (found && measuredOn) {
          const placement: Placement = { onLine: true, segment: at, bounds: found.bounds, textRotation: found.textRotation, turnedSize: found.turnedSize,
            text: onLine!, lines: measuredOn.lines, lineHeight: measuredOn.lineHeight };
          if (!shortened) return placement;
          if (!best || onLine!.length > best.text.length) best = placement;
          continue;
        }
      }
      // With borders, an axis-aligned run that a border cuts offers only its windows
      // (`labelRunWindows`): a shortened text fits the longest one, and the label stands at the
      // point of a window nearest the midpoint. A run no border cuts keeps the midpoint.
      const windows = borders === undefined ? undefined : cutWindows(borders, segment);
      if (windows !== undefined) refusal.border = true;
      const longest = windows === undefined ? Infinity : Math.max(0, ...windows.map(window => window.to - window.from));
      const drawn = shortened ? shorten(widths!, Math.min(length - LINK_LABEL_GEOMETRY.shortenMargin, longest)) : text;
      if (drawn === undefined) continue;
      const measured = measure(drawn);
      if (!measured.lines.length) continue;
      if (!shortened && shortenable && measured.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin > length + EPS) continue;
      let centre: { x: number; y: number } | undefined;
      if (windows !== undefined) {
        const along = windowCentre(windows, segment, measured.width);
        if (along === undefined) continue;
        centre = Math.abs(segment.to.x - segment.from.x) <= EPS ? { x: segment.from.x, y: along } : { x: along, y: segment.from.y };
      }
      const { bounds, textRotation, turnedSize } = candidateBox(segment, supported.half, { width: measured.width, height: measured.height }, second, centre);
      const area = labelArea({ bounds, textRotation, ...(turnedSize ? { turnedSize } : {}) });
      if (borders !== undefined && borders.some(box => labelCrossesBorder(area, box))) { refusal.border = true; continue; }
      if (collides(index, area, supported.support(at), overlayCounts)) continue;
      const placement: Placement = { segment: at, bounds, textRotation, ...(turnedSize ? { turnedSize } : {}), text: drawn, lines: measured.lines, lineHeight: measured.lineHeight };
      if (!shortened) return placement;
      if (!best || drawn.length > best.text.length) best = placement;
    }
  }
  return best;
}

/**
 * The place of a label on a direct line (ticket 16): its centre on the line, its text at the line's
 * angle. The midpoint when it is free; otherwise the nearest free centre along the line, stepping
 * `alongStep` px towards the target and then the source in turn, so the choice is deterministic. The
 * centre keeps the text, the halo and the shorten margin inside the segment. The label is tested by
 * the rectangle of its text with the halo, turned to the line's angle (ticket 20); the stored box is
 * that rectangle's upright box.
 *
 * With borders, a line a border cuts offers only its windows (`labelRunWindows` with the turned box's
 * height, the ones placement reserved): the text must lie wholly in one, and the point of each window
 * nearest the midpoint is a candidate beside the steps, in order of distance from the midpoint.
 */
function alongLine(index: ObstacleIndex, segment: PathSegment, length: number, measured: { width: number; height: number },
  support: LabelSupport | undefined, overlayCounts: boolean, borders: readonly Rect[] | undefined,
  refusal: { border: boolean }, links: readonly LinkRun[] = [], bands: readonly LinkRun[] = []): { bounds: Rect; textRotation: number; turnedSize: { width: number; height: number } } | undefined {
  const degrees = lineAngle(segment), size = haloSize(measured);
  const ux = (segment.to.x - segment.from.x) / length, uy = (segment.to.y - segment.from.y) / length;
  const reach = Math.min(length / 2, measured.width / 2 + LINK_LABEL_GEOMETRY.shortenMargin);
  const room = length / 2 - reach, steps = Math.floor(room / LINK_LABEL_GEOMETRY.alongStep + EPS);
  const windows = borders === undefined ? undefined : cutWindows(borders, segment, size.height, links);
  if (windows !== undefined) refusal.border = true;
  // The steps in order: the midpoint, then towards the target before the source at each distance.
  let candidates: number[] = [];
  for (let step = 0; step <= steps; step++) for (const sign of step === 0 ? [1] : [1, -1]) candidates.push(length / 2 + sign * step * LINK_LABEL_GEOMETRY.alongStep);
  if (windows !== undefined) {
    const extent = measured.width, mid = length / 2;
    const inWindow = (along: number): boolean => windows.some(window => along - extent / 2 >= window.from - EPS && along + extent / 2 <= window.to + EPS);
    const centres = windows.filter(window => windowHolds(window, extent))
      .map(window => Math.min(Math.max(mid, window.from + extent / 2), window.to - extent / 2));
    // Last keys: the distance from the midpoint, then the side of the target first, then the coordinate, so the order is total.
    const key = (along: number): [number, number, number] => [Math.abs(along - mid), along >= mid ? 0 : 1, along];
    candidates = [...candidates.filter(inWindow), ...centres.filter(along => !candidates.some(step => Math.abs(step - along) <= EPS))]
      .sort((a, b) => { const p = key(a), q = key(b); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
  }
  for (const along of candidates) {
    const area: OrientedBox = { centre: { x: segment.from.x + ux * along, y: segment.from.y + uy * along }, ...size, degrees };
    if (borders !== undefined && borders.some(box => labelCrossesBorder(area, box))) { refusal.border = true; continue; }
    if (!collides(index, area, support, overlayCounts, true) && !meetsBand(bands, area)) return { bounds: orientedBounds(area), textRotation: degrees, turnedSize: { ...size } };
  }
  return undefined;
}

function baseLabel(id: string, owner: LayoutLabel['owner'], layer: LayoutLabel['layer'], text: string): LayoutLabel {
  return { id, owner: { ...owner }, layer, role: 'link', text,
    fontFamily: LINK_LABEL_GEOMETRY.fontFamily, fontSize: LINK_LABEL_GEOMETRY.fontSize,
    fontWeight: LINK_LABEL_GEOMETRY.fontWeight, textRotation: 0 };
}

function omitted(label: LayoutLabel): LayoutLabel {
  return { ...label, tooltip: label.text, omitted: true };
}

function placedLabel(label: LayoutLabel, placement: Placement, support: LabelSupport | undefined): LayoutLabel {
  return { ...label, ...(support ? { support } : {}), text: placement.text, textRotation: placement.textRotation,
    ...(placement.turnedSize ? { turnedSize: placement.turnedSize } : {}),
    ...(placement.onLine ? { onLine: true as const } : {}), lines: placement.lines, lineHeight: placement.lineHeight, bounds: placement.bounds,
    ...(placement.text === label.text ? {} : { tooltip: label.text }) };
}

/** `count === members.length ≥ 2`, every member really merged into this bundle, one routed trunk. */
function checkMergeRun(links: Map<string, LayoutLink>, bundle: Bundle, run: NonNullable<Bundle['mergeRuns']>[number]): void {
  const fault = (reason: string): never => { throw new Error(`Merge run ${run.id} ${reason}`); };
  if (run.count < 2 || run.count !== run.members.length || new Set(run.members).size !== run.count) fault('has no exact counted membership');
  if (run.path.layer !== 'routed' || run.path.owner.kind !== 'bundle' || run.path.owner.id !== bundle.id) fault('has no routed trunk owned by its bundle');
  const selected = new Set(bundle.members);
  for (const id of run.members) {
    const member = links.get(id);
    if (!member || member.bundle !== bundle.id || member.technique !== 'merge' || !selected.has(id)) fault(`names ${id}, which is not a selected merge member of ${bundle.id}`);
  }
}

function diagnostic(code: string, severity: Diagnostic['severity'], message: string, owners: Owner[]): Diagnostic {
  return { stage: 'final-geometry', severity, code, message, owners };
}

/**
 * Transaction-owned stage-9 producer. It consumes the frozen placement and the final routed paths,
 * measures every authored link label and every counted merge trunk, and appends the result. It
 * moves nothing: only labels, their diagnostics and the canvas extent change.
 */
export function produceLinkLabels(model: LayoutModel): void {
  const index = buildObstacles(model);
  const suppressOverlay = overlayLabelsSuppressed(model);
  const produced: LayoutLabel[] = [], suppressed: string[] = [];
  // A bus label stands on the room 7f reserved on its bar (mesh-bus.md, sections 4 and 6). It is placed first, so that no link label
  // takes the room, and it is not subject to the overlay density suppression, which reads the labels of overlay links.
  for (const bus of model.meshBuses ?? []) {
    // A joined mesh has one label, on the bar of the bus with more members; the other bar has none (mesh-bus.md, section 11.5).
    if (!busCarriesLabel(bus)) continue;
    const text = busLabelText(bus), id = `label:bus:${bus.id}`;
    const base: LayoutLabel = { id, owner: { ...bus.owner }, layer: 'overlay', role: 'mesh-bus', text,
      fontFamily: BUS_LABEL_FONT.fontFamily, fontSize: BUS_LABEL_FONT.fontSize, fontWeight: BUS_LABEL_FONT.fontWeight, textRotation: 0 };
    bus.label = id;
    if (bus.bar === undefined || bus.labelRoom === undefined) { produced.push(omitted(base)); continue; }
    const measured = measure(text);
    const y = bus.side === 'top' ? bus.bar.from.y - BUS_LABEL_GAP - measured.height : bus.bar.from.y + BUS_LABEL_GAP;
    const bounds = { x: bus.labelRoom.from, y, width: measured.width, height: measured.height };
    produced.push({ ...base, lines: measured.lines, lineHeight: measured.lineHeight, bounds });
    index.add({ bounds, clearance: 0 });
  }
  /**
   * The four rungs, in the order the diagram is best read in: the whole text clear of every drawn
   * overlay run, the whole text allowed to cross one, then the same two with shortened text
   * (ticket 04 C). The relaxed rungs exist because the ladder does not slide a label along its run —
   * it is the midpoint of a segment or nothing — and a label that is drawn beats a line that is
   * whole. A truncated label is the last thing tried, because the mask cuts the overlay back under
   * a whole label but nothing gives a shortened one its characters back.
   *
   * A label stays in one region. Each text first tries both overlay rungs with the drawn group and
   * frame borders as walls, the label sliding along an axis-aligned run to the window nearest its
   * midpoint (`labelRunWindows`); then both again without them, at the midpoint, as before. A whole
   * label across a border still beats a shortened one. Placement reserved the window
   * (`reserveLinkLabelRoom`), so a label that crosses a border is reported (`LINK_LABEL_ON_BORDER`).
   */
  const borders = groupBoxes(model);
  const walls = borders.map(item => item.bounds);
  const emit = (label: LayoutLabel, supported: Supported | undefined, shortenable: boolean): void => {
    const rung = (shortened: boolean, overlayCounts: boolean, bordersCount: boolean, refusal?: { border: boolean }): Placement | undefined =>
      supported && supported.segments.length
        ? placeLabel(index, supported, label.text, shortenable, shortened, overlayCounts, bordersCount ? walls : undefined, refusal) : undefined;
    // Without a border cut or a border refusal the rungs without walls offer the same candidates again: they are skipped.
    const text = (shortened: boolean): Placement | undefined => {
      const refusal = { border: false };
      return rung(shortened, true, true, refusal) ?? rung(shortened, false, true, refusal)
        ?? (refusal.border ? rung(shortened, true, false) ?? rung(shortened, false, false) : undefined);
    };
    const placement = text(false) ?? (shortenable ? text(true) : undefined);
    const crossed = placement === undefined ? [] : borders.filter(item => labelCrossesBorder(labelArea(placement), item.bounds));
    if (crossed.length) model.diagnostics.push(diagnostic('LINK_LABEL_ON_BORDER', 'warning',
      `Label ${label.id} lies across the border of ${crossed.map(item => item.id).join(', ')}: no place on its runs clear of every group and frame border holds it.`,
      [{ ...label.owner }]));
    if (!placement) {
      produced.push(omitted(label));
      model.diagnostics.push(diagnostic('LINK_LABEL_OMITTED', 'warning',
        `Label ${label.id} collides on every segment and side; its full text survives as a tooltip.`,
        [{ ...label.owner }]));
      return;
    }
    const final = placedLabel(label, placement, supported!.support(placement.segment));
    if (final.text !== label.text) model.diagnostics.push(diagnostic('LINK_LABEL_SHORTENED', 'info',
      `Label ${label.id} was shortened to fit its supporting segment; its full text survives as a tooltip.`,
      [{ ...label.owner }]));
    produced.push(final);
    index.add(labelObstacle(final));
  };

  // The runs a label on a diagonal line keeps clear of (`reservedLinkRuns`), and the bands among them that every candidate on the line keeps clear of.
  const linkRunsOf = (own: string): { links: LinkRun[]; bands: LinkRun[] } => {
    const bands = labelBands(model, own);
    return { links: [...fixedLinkRuns(model, own), ...bands], bands };
  };
  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (text === undefined || text === '') continue;
    // A removed link (ticket 24) has no path to label; its removal diagnostic already names it.
    if (link.removed === true) continue;
    // A bus member draws no line of its own: its label is in the bus tooltip (mesh-bus.md, section 6).
    if (link.meshBus !== undefined) continue;
    const layer = effectiveLayer(link);
    if (layer === 'overlay' && suppressOverlay) { suppressed.push(link.id); continue; }
    const label = baseLabel(`label:link:${link.id}`, link.owner, layer, text);
    const drawable = link.technique !== 'stub' && link.path !== undefined;
    const runs = drawable ? labelRuns(link.path!.segments) : [];
    emit(label, drawable ? { segments: runs.map(run => run.segment), half: halfStroke(link.path),
      support: at => ({ kind: 'link-segment', link: link.id, segment: runs[at]!.first,
        ...(runs[at]!.last > runs[at]!.first ? { through: runs[at]!.last } : {}) }),
      ...(runs.some(run => isDirect(run.segment)) ? linkRunsOf(link.id) : {}) } : undefined, true);
  }

  const byId = new Map(model.links.map(link => [link.id, link]));
  for (const bundle of model.bundles) for (const run of bundle.mergeRuns ?? []) {
    checkMergeRun(byId, bundle, run);
    const label = baseLabel(`label:multiplicity:${run.id}`, bundle.owner, 'routed', String(run.count));
    // A counted trunk gets no segment exemption, and a decimal count has no meaningful prefix, so
    // the shortening rung cannot apply to it: it would replace the datum with an ellipsis.
    emit(label, { segments: run.path.segments, half: halfStroke(run.path),
      support: () => ({ kind: 'merge-run', bundle: bundle.id, run: run.id }) }, false);
  }

  if (suppressed.length) model.diagnostics.push(diagnostic('LINK_LABELS_OVERLAY_SUPPRESSED', 'info',
    `Overlay density ${overlayDensity(model)} exceeds ${OVERLAY_LABEL_DENSITY}; ${suppressed.length} overlay link label(s) are suppressed.`,
    suppressed.map(id => ({ kind: 'link', id }))));

  model.labels.push(...produced);
  // The generated legend is measured last, against the geometry every earlier step settled, and
  // takes newly reserved space below it. Nothing already placed moves.
  produceLegend(model);
  model.canvas = refitCanvas(model);
}

/**
 * Everything the canvas has to hold, with the outer half of every stroke. `expandCanvas` reserves
 * groups and lanes on their centrelines; a route may leave both, and stage 9 adds label and legend
 * boxes, so stage 9 is where the canvas is finally settled. An orthogonal chain is covered by the
 * boxes of its segments.
 */
const drawnBoxes = (model: LayoutModel): Rect[] => paintedBoxes(model, true);

/**
 * The final canvas: the union of everything drawn plus `CANVAS_MARGIN` on every side (ticket 28).
 * Earlier stages may only expand the canvas inside their transactions, so growth during placement
 * — band clearance, label room, a grid, a push — leaves the skeleton's extent behind and a zero
 * margin on the side that grew. Publication owns the final extent and refits it, shrinking when
 * earlier growth was undone. A diagram that draws nothing gets the canonical empty canvas: the
 * margin alone, at the origin.
 */
export function refitCanvas(model: LayoutModel): Rect {
  const boxes = drawnBoxes(model);
  if (!boxes.length) return { x: 0, y: 0, width: 2 * CANVAS_MARGIN, height: 2 * CANVAS_MARGIN };
  // One pass over the boxes: a spread into `Math.min` would hit the engine's argument limit on a
  // large diagram, where every path segment and pill is a box.
  let left = Infinity, top = Infinity, farRight = -Infinity, farBottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x); top = Math.min(top, box.y);
    farRight = Math.max(farRight, right(box)); farBottom = Math.max(farBottom, bottom(box));
  }
  const x = left - CANVAS_MARGIN, y = top - CANVAS_MARGIN;
  return { x, y, width: farRight + CANVAS_MARGIN - x, height: farBottom + CANVAS_MARGIN - y };
}

const linkLabelDiagnostics = (model: LayoutModel): Diagnostic[] =>
  model.diagnostics.filter(item => (LINK_LABEL_CODES as readonly string[]).includes(item.code));

/** Recheck the exact stage-9 claims. Publication and restore run the one deterministic producer. */
export function validateLinkLabels(model: LayoutModel): void {
  const expected = JSON.parse(JSON.stringify(model)) as LayoutModel;
  expected.labels = expected.labels.filter(label => label.role !== 'link' && label.role !== 'legend' && label.role !== 'mesh-bus');
  for (const bus of expected.meshBuses ?? []) delete bus.label;
  delete expected.legend;
  expected.diagnostics = expected.diagnostics.filter(item => !(LINK_LABEL_CODES as readonly string[]).includes(item.code));
  produceLinkLabels(expected);
  if (!equal(model.labels, expected.labels)) throw new Error('Link labels contradict measured post-route placement');
  if (!equal(model.meshBuses, expected.meshBuses)) throw new Error('Bus labels contradict the rooms 7f reserved');
  if (!equal(model.legend, expected.legend)) throw new Error('Legend contradicts the measured classes and final geometry');
  if (!equal(linkLabelDiagnostics(model), linkLabelDiagnostics(expected))) throw new Error('Link-label diagnostics contradict measured post-route placement');
  // Restore has no predecessor transaction to compare against, so the canvas is stated
  // geometrically here: the published canvas is the drawn union plus the one margin, no more and no
  // less. A canvas that clips a drawn box or leaves dead space is a forged or stale extent.
  const refit = refitCanvas(model);
  if (!equal(model.canvas, refit)) {
    const clipped = drawnBoxes(model).some(box => !model.canvas || !contains(model.canvas, box));
    throw new Error(clipped ? 'Canvas does not contain the published diagram' : 'Canvas does not fit the published diagram');
  }
}

/** Stage 9: measure and place post-route link and multiplicity labels. */
export function linkLabels(model: LayoutModel, notes: readonly Diagnostic[] = []): LayoutModel {
  return withLayoutMutation(model, 'link-labels', draft => { draft.diagnostics.push(...notes); });
}
