import type { Rect } from '../model/geometry.js';
import type {
  Bundle, Diagnostic, LabelSupport, LayoutLabel, LayoutLink, LayoutModel, LayoutPath, Owner, PathSegment,
} from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { EPS, bottom, contains, rectDistance, right, segmentRect, segmentRectDistance } from '../score/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { CANVAS_MARGIN, DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { drawnBoxes as paintedBoxes, produceLegend } from './legend.js';
import { withLayoutMutation } from './mutation.js';
import { RectangleIndex, type RectangleBounds } from './rectangle-index.js';

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
} as const;

/** Overlay labels are suppressed strictly above this density (overlay links per node). */
export const OVERLAY_LABEL_DENSITY = 3;

export const LINK_LABEL_CODES = ['LINK_LABEL_OMITTED', 'LINK_LABEL_SHORTENED', 'LINK_LABELS_OVERLAY_SUPPRESSED'] as const;

/** Diagram density as `pipeline.md` defines it; an empty diagram divides by one, not by zero. */
export function overlayDensity(model: LayoutModel): number {
  const overlay = model.links.filter(link => effectiveLayer(link) === 'overlay').length;
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
    items.push({ bounds: label.bounds, clearance: 0 });
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

/**
 * True when G3 would report this box, plus a hair: every predicate rejects at `+ EPS` where G3
 * fails at `- EPS`, so an accepted placement cannot become a label hit.
 */
function collides(index: ObstacleIndex, box: Rect, support: LabelSupport | undefined,
  overlayCounts = true): boolean {
  return index.some(box, item => {
    if (item.overlay && !overlayCounts) return false;
    if (!item.segment) return rectDistance(box, item.bounds) < item.clearance + EPS;
    if (segmentRect(item.segment, box)) return true;
    const supporting = support?.kind === 'link-segment' && support.link === item.link && support.segment === item.index;
    return !supporting && segmentRectDistance(item.segment, box) < item.clearance + EPS;
  });
}

/**
 * The measured box for one side of one segment. Text follows the segment (ADR-0014): along a
 * horizontal run it stays upright; along a vertical run it turns by `verticalRotation`; along a
 * declared straight bundle member (ADR-0017) it turns by the run's own angle, flipped by 180° when
 * that would read upside down (Visio gravity). The stored box is the rotated one, so its long side
 * lies along the run. The box is centred on the segment's midpoint; the 4 px normal gap is visible
 * clearance beyond the stroke edge. A segment that is neither axis-aligned nor a declared straight
 * member — only an overlay link can be one — uses its dominant axis.
 */
export function candidateBox(segment: PathSegment, half: number, size: { width: number; height: number }, second: boolean): { bounds: Rect; textRotation: number } {
  const midX = (segment.from.x + segment.to.x) / 2, midY = (segment.from.y + segment.to.y) / 2;
  const gap = LINK_LABEL_GEOMETRY.normalGap + half;
  if (segment.straight === true) {
    const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
    // Gravity: the heading that keeps the text upright, then the box rotated about the midpoint.
    let degrees = Math.atan2(dy, dx) * 180 / Math.PI;
    if (degrees > 90) degrees -= 180;
    if (degrees <= -90) degrees += 180;
    const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    // The label sits beside the run on the chosen side. The stored box is the axis-aligned box of
    // the rotated text, and every gate measures that box, so the offset clears *it* — half its
    // extent along the run's normal plus the visible gap — not merely half the text height.
    const side = second ? -1 : 1, nx = side * sin, ny = -side * cos;
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

interface Placement { segment: number; bounds: Rect; textRotation: number; text: string; lines: string[]; lineHeight: number }
interface Supported { segments: PathSegment[]; half: number; support: (index: number) => LabelSupport | undefined }

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
 * obstacles on it. The caller decides the order of the four, because the two choices are not nested
 * (ticket 04 C).
 */
function placeLabel(index: ObstacleIndex, supported: Supported, text: string, shortenable: boolean,
  shortened: boolean, overlayCounts: boolean): Placement | undefined {
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
      const drawn = shortened ? shorten(widths!, length - LINK_LABEL_GEOMETRY.shortenMargin) : text;
      if (drawn === undefined) continue;
      const measured = measure(drawn);
      if (!measured.lines.length) continue;
      if (!shortened && shortenable && measured.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin > length + EPS) continue;
      const { bounds, textRotation } = candidateBox(segment, supported.half, { width: measured.width, height: measured.height }, second);
      if (collides(index, bounds, supported.support(at), overlayCounts)) continue;
      const placement = { segment: at, bounds, textRotation, text: drawn, lines: measured.lines, lineHeight: measured.lineHeight };
      if (!shortened) return placement;
      if (!best || drawn.length > best.text.length) best = placement;
    }
  }
  return best;
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
    lines: placement.lines, lineHeight: placement.lineHeight, bounds: placement.bounds,
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
  /**
   * The four rungs, in the order the diagram is best read in: the whole text clear of every drawn
   * overlay run, the whole text allowed to cross one, then the same two with shortened text
   * (ticket 04 C). The relaxed rungs exist because the ladder does not slide a label along its run —
   * it is the midpoint of a segment or nothing — and a label that is drawn beats a line that is
   * whole. A truncated label is the last thing tried, because the mask cuts the overlay back under
   * a whole label but nothing gives a shortened one its characters back.
   */
  const emit = (label: LayoutLabel, supported: Supported | undefined, shortenable: boolean): void => {
    const rung = (shortened: boolean, overlayCounts: boolean): Placement | undefined =>
      supported && supported.segments.length
        ? placeLabel(index, supported, label.text, shortenable, shortened, overlayCounts) : undefined;
    const placement = rung(false, true) ?? rung(false, false)
      ?? (shortenable ? rung(true, true) ?? rung(true, false) : undefined);
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
    index.add({ bounds: final.bounds!, clearance: 0 });
  };

  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (text === undefined || text === '') continue;
    // A removed link (ticket 24) has no path to label; its removal diagnostic already names it.
    if (link.removed === true) continue;
    const layer = effectiveLayer(link);
    if (layer === 'overlay' && suppressOverlay) { suppressed.push(link.id); continue; }
    const label = baseLabel(`label:link:${link.id}`, link.owner, layer, text);
    const drawable = link.technique !== 'stub' && link.path !== undefined;
    emit(label, drawable ? { segments: link.path!.segments, half: halfStroke(link.path),
      support: at => ({ kind: 'link-segment', link: link.id, segment: at }) } : undefined, true);
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
  expected.labels = expected.labels.filter(label => label.role !== 'link' && label.role !== 'legend');
  delete expected.legend;
  expected.diagnostics = expected.diagnostics.filter(item => !(LINK_LABEL_CODES as readonly string[]).includes(item.code));
  produceLinkLabels(expected);
  if (!equal(model.labels, expected.labels)) throw new Error('Link labels contradict measured post-route placement');
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
export function linkLabels(model: LayoutModel): LayoutModel {
  return withLayoutMutation(model, 'link-labels', () => {});
}
