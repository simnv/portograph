import type { Rect } from '../model/geometry.js';
import type {
  Bundle, Diagnostic, LabelSupport, LayoutLabel, LayoutLink, LayoutModel, LayoutPath, Owner, PathSegment,
} from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { EPS, bottom, contains, rectDistance, right, segmentRect, segmentRectDistance } from '../score/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
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
  /** Set only for a routed path segment, so a supporting reference can waive its clearance zone. */
  link?: string;
  index?: number;
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
 * Only routed-layer segments participate: G3 measures labels against routed geometry, and the
 * renderer masks the overlay layer out of link labels. Every placed label is an obstacle whatever
 * its layer, which is stricter than G3 and never draws text over text.
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
    if (effectiveLayer(link) !== 'routed' || link.technique === 'stub' || !link.path) continue;
    const half = halfStroke(link.path);
    for (const [i, segment] of link.path.segments.entries()) {
      items.push({ bounds: segmentBounds(segment), clearance: half, segment, link: link.id, index: i });
    }
  }
  return new ObstacleIndex(items);
}

/**
 * True when G3 would report this box, plus a hair: every predicate rejects at `+ EPS` where G3
 * fails at `- EPS`, so an accepted placement cannot become a label hit.
 */
function collides(index: ObstacleIndex, box: Rect, support: LabelSupport | undefined): boolean {
  return index.some(box, item => {
    if (!item.segment) return rectDistance(box, item.bounds) < item.clearance + EPS;
    if (segmentRect(item.segment, box)) return true;
    const supporting = support?.kind === 'link-segment' && support.link === item.link && support.segment === item.index;
    return !supporting && segmentRectDistance(item.segment, box) < item.clearance + EPS;
  });
}

/**
 * The measured box for one side of one segment. Text stays horizontal and is centred on the
 * segment's midpoint; the 4 px normal gap is visible clearance beyond the stroke edge. A segment
 * that is neither axis-aligned — only an overlay link can be one — uses its dominant axis.
 */
function candidateBox(segment: PathSegment, half: number, size: { width: number; height: number }, second: boolean): Rect {
  const midX = (segment.from.x + segment.to.x) / 2, midY = (segment.from.y + segment.to.y) / 2;
  const gap = LINK_LABEL_GEOMETRY.normalGap + half;
  if (Math.abs(segment.to.x - segment.from.x) >= Math.abs(segment.to.y - segment.from.y)) {
    return { x: midX - size.width / 2, y: second ? midY + gap : midY - gap - size.height, ...size };
  }
  return { x: second ? midX - gap - size.width : midX + gap, y: midY - size.height / 2, ...size };
}

interface Placement { segment: number; bounds: Rect; text: string; lines: string[]; lineHeight: number }
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
 * The ladder of `pipeline.md` stage 9, in the order the parent fixed: the first side across every
 * segment in descending length order, then the opposite side across that order, then the same two
 * passes with shortened text. Above and right are the deterministic first sides; ties break on the
 * source-to-target segment index.
 */
function placeLabel(index: ObstacleIndex, supported: Supported, text: string, shortenable: boolean): Placement | undefined {
  const ordered = supported.segments
    .map((segment, at) => ({ segment, at, length: segmentLength(segment) }))
    .filter(item => item.length > EPS)
    .sort((a, b) => b.length - a.length || a.at - b.at);
  const widths = shortenable ? prefixWidths(text) : undefined;
  for (const shortened of widths ? [false, true] : [false]) {
    for (const second of [false, true]) {
      for (const { segment, at, length } of ordered) {
        const drawn = shortened ? shorten(widths!, length - LINK_LABEL_GEOMETRY.shortenMargin) : text;
        if (drawn === undefined) continue;
        const measured = measure(drawn);
        if (!measured.lines.length) continue;
        const bounds = candidateBox(segment, supported.half, { width: measured.width, height: measured.height }, second);
        if (collides(index, bounds, supported.support(at))) continue;
        return { segment: at, bounds, text: drawn, lines: measured.lines, lineHeight: measured.lineHeight };
      }
    }
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
  return { ...label, ...(support ? { support } : {}), text: placement.text,
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
  const emit = (label: LayoutLabel, supported: Supported | undefined, shortenable: boolean): void => {
    const placement = supported && supported.segments.length
      ? placeLabel(index, supported, label.text, shortenable) : undefined;
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
  for (const box of drawnBoxes(model)) {
    if (!model.canvas) break;
    const x = Math.min(model.canvas.x, box.x), y = Math.min(model.canvas.y, box.y);
    model.canvas = { x, y, width: Math.max(right(model.canvas), right(box)) - x,
      height: Math.max(bottom(model.canvas), bottom(box)) - y };
  }
}

/**
 * Everything the canvas has to hold, with the outer half of every stroke. `expandCanvas` reserves
 * groups and lanes on their centrelines; a route may leave both, and stage 9 adds label and legend
 * boxes, so stage 9 is where the canvas is finally settled. An orthogonal chain is covered by the
 * boxes of its segments.
 */
const drawnBoxes = (model: LayoutModel): Rect[] => paintedBoxes(model, true);

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
  // Restore has no predecessor transaction to compare against, so the canvas-only-expands rule has
  // to be stated geometrically here: the published canvas must hold everything that is drawn. The
  // producer expands the canvas to exactly that union, so this containment is the same statement as
  // comparing it with the re-derived one, and it names the box that is actually clipped.
  for (const box of drawnBoxes(model)) {
    if (model.canvas && !contains(model.canvas, box)) throw new Error('Canvas does not contain the published diagram');
  }
}

/** Stage 9: measure and place post-route link and multiplicity labels. */
export function linkLabels(model: LayoutModel): LayoutModel {
  return withLayoutMutation(model, 'link-labels', () => {});
}
