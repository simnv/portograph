import type { Point, Rect } from '../model/geometry.js';
import type {
  Bundle, Layer, LayoutLabel, LayoutLink, LayoutModel, LayoutNode, PathSegment,
} from '../model/layout.js';
import { isDirect } from '../layout/link-labels.js';
import { crossableText, isDiagonal } from '../layout/diagonal-text.js';
import { isOriented } from '../geometry/oriented.js';
import { orderedNodeIds } from '../model/model.js';
import { iconKey, iconPath } from '../profiles/network/icons.js';
import { EPS, right } from '../geometry/planar.js';
import { effectiveLayer, labelArea, validate } from '../score/model.js';
import { visibleEnd } from '../layout/path-end.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS, OVERLAY_ENDPOINT_RADIUS, anonymousDotRadius, linkStrokeWidth } from '../theme/geometry.js';
import { washAssignment, washClass } from '../profiles/network/theme.js';
import { dotEnds } from './anonymous-end.js';
import { boxesBehind, groupShapes } from './frame-order.js';
import { GeometryLocks, haloCss, sheetClassWashCss, themeCss } from './theme.js';
import { legendKeyRadius, themeById } from '../profiles/network/themes.js';
import type { Theme } from '../profiles/network/themes.js';
import { authorClass, classes, element, escapeStyle, escapeText, num } from './svg.js';
import { boxClasses, frameTitled, groupLabelClasses, iconGlyphBox, legendSwatchClass, linkClassToken, pathRuns, svgClass } from './shared.js';
import { legendLineOverlay } from '../layout/legend.js';
import { busTooltip, linkTooltipLines } from './tooltips.js';

export { OVERLAY_ENDPOINT_RADIUS };
const MASK_ID = 'pg-overlay-mask';
/** The mask of one line that a text cuts (ticket 162; it replaced the routed layer's one mask of ticket 16). */
const LINE_MASK_ID = 'pg-line-mask';

/**
 * A mask id that names its cutouts: the base id plus a hash of the mask body. Two SVGs inlined on
 * one page then resolve each to its own mask, and the same sheet always renders the same id.
 */
function maskId(base: string, body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 0x01000193) >>> 0;
  return `${base}-${hash.toString(16).padStart(8, '0')}`;
}

export interface RenderOptions {
  /**
   * Effective link families to draw, as a nonempty selection. Omitted, both families are drawn and
   * `document.overlays` hides overlay links by class; an explicit selection overrides those
   * switches. Nodes, groups, ports and the generated legend are never hidden by it.
   */
  layers?: readonly Layer[];
}

const nodeStroke = (node: LayoutNode): number => node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node;
const centre = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** `node.port#ordinal` for a named port; anonymous ports draw nothing and need no identity. */
const portId = (node: string, name: string, ordinal: number): string => `${node}.${name}#${ordinal}`;

/** The authored class exactly as the document holds it; `document.overlays` is keyed by this. */
function documentClass(model: LayoutModel, link: LayoutLink): string | undefined {
  const value = model.document.links[link.sourceIndex]?.class;
  return value === '' ? undefined : value;
}


/** The effective visibility rule ticket 17's `--layers` consumes. */
export function linkVisible(model: LayoutModel, link: LayoutLink, options: RenderOptions): boolean {
  const layer = effectiveLayer(link);
  if (options.layers) return options.layers.includes(layer);
  if (layer !== 'overlay') return true;
  const authored = documentClass(model, link);
  return authored === undefined || model.document.overlays?.[authored] !== 'hidden';
}

function checkOptions(options: RenderOptions): void {
  if (options.layers === undefined) return;
  if (!options.layers.length) throw new Error('Layer selection must name at least one of routed, overlay');
  for (const layer of options.layers) {
    if (layer !== 'routed' && layer !== 'overlay') throw new Error(`Unknown link layer ${String(layer)}`);
  }
}

/** `d` for one chain of segments: one subpath per run (`pathRuns`), so a new one starts wherever the model's chain breaks. */
function pathData(segments: readonly PathSegment[]): string {
  const parts: string[] = [];
  for (const run of pathRuns(segments)) {
    parts.push(`M${num(segments[run.first]!.from.x)} ${num(segments[run.first]!.from.y)}`);
    for (const segment of segments.slice(run.first, run.last + 1)) parts.push(`L${num(segment.to.x)} ${num(segment.to.y)}`);
  }
  return parts.join(' ');
}

/** Merge runs of a bundle that really contain this member, as collinear intervals to remove. */
function trunkIntervals(bundle: Bundle | undefined, link: LayoutLink): PathSegment[] {
  if (!bundle?.mergeRuns) return [];
  return bundle.mergeRuns.filter(run => run.members.includes(link.id)).flatMap(run => run.path.segments);
}

/**
 * A member of a counted merge run keeps the shared trunk in its logical path, but the trunk is
 * painted once by its bundle. Subtract exactly the covered collinear intervals, so the member's own
 * approach and departure still draw and nothing is emitted twice.
 */
function withoutTrunks(link: LayoutLink, trunks: readonly PathSegment[]): PathSegment[] {
  if (!trunks.length) return [...(link.path?.segments ?? [])];
  const result: PathSegment[] = [];
  for (const segment of link.path?.segments ?? []) {
    const vertical = Math.abs(segment.to.x - segment.from.x) <= EPS;
    const horizontal = Math.abs(segment.to.y - segment.from.y) <= EPS;
    const at = (point: Point): number => vertical ? point.y : point.x;
    const fixed = (point: Point): number => vertical ? point.x : point.y;
    const covers = (!vertical && !horizontal) ? [] : trunks.filter(trunk =>
      (vertical ? Math.abs(trunk.to.x - trunk.from.x) <= EPS : Math.abs(trunk.to.y - trunk.from.y) <= EPS)
      && Math.abs(fixed(trunk.from) - fixed(segment.from)) <= EPS)
      .map(trunk => [Math.min(at(trunk.from), at(trunk.to)), Math.max(at(trunk.from), at(trunk.to))] as const)
      .sort((a, b) => a[0] - b[0]);
    if (!covers.length) { result.push(segment); continue; }
    const forward = at(segment.to) >= at(segment.from);
    const low = Math.min(at(segment.from), at(segment.to)), high = Math.max(at(segment.from), at(segment.to));
    const point = (value: number): Point => vertical ? { x: fixed(segment.from), y: value } : { x: value, y: fixed(segment.from) };
    let cursor = low;
    const keep: [number, number][] = [];
    for (const [start, end] of covers) {
      if (start > cursor + EPS) keep.push([cursor, Math.min(start, high)]);
      cursor = Math.max(cursor, end);
      if (cursor >= high - EPS) break;
    }
    if (cursor < high - EPS) keep.push([cursor, high]);
    for (const [start, end] of keep) {
      if (end - start <= EPS) continue;
      result.push({ ...segment, from: point(forward ? start : end), to: point(forward ? end : start) });
    }
  }
  return result;
}

/** First baseline of a measured label; the font table supplies the ascent, the model the box. */
function metrics(label: LayoutLabel): { ascent: number; lineHeight: number } {
  const size = label.fontSize ?? 9;
  return measureText('', { fontSize: size, weight: label.fontWeight ?? 400 });
}

function textElement(label: LayoutLabel, locks: GeometryLocks, structural: string, owner: string, extra?: string): string {
  const lines = label.lines ?? (label.text ? [label.text] : []);
  if (!lines.length || !label.bounds) return '';
  const angle = label.textRotation ?? 0, rotated = angle !== 0;
  const box = label.bounds, middle = centre(box);
  // A rotated label's stored box is already rotated, so lay the text out unrotated about the same
  // centre and turn only the text. The rectangle is never rotated twice. A quarter turn swaps the
  // box's sides; any other angle (a straight bundle member, ADR-0017) keeps the unrotated height,
  // which stage 9 measured before rotating the box.
  // At any other angle the stored height belongs to the rotated box, so it cannot set the line
  // pitch; the font's own line height stands in when a hand-written label carries none.
  const font = metrics(label);
  const quarter = angle === -90 || angle === 90;
  const height = quarter ? box.width
    : rotated ? (label.lineHeight ?? font.lineHeight) * lines.length : box.height;
  const lineHeight = label.lineHeight ?? (rotated && !quarter ? font.lineHeight : height / lines.length);
  const top = middle.y - height / 2;
  const first = top + font.ascent;
  // A card's title and subtitle (ticket 159) start at the left edge of their measured box; every other label is centred on its box.
  const start = label.textAlign === 'start';
  const spans = lines.map((line, index) => element('tspan',
    { x: start ? box.x : middle.x, y: first + index * lineHeight }, escapeText(line))).join('');
  const title = label.tooltip !== undefined && label.tooltip !== label.text
    ? element('title', {}, escapeText(label.tooltip)) : '';
  return element('text', {
    class: classes(structural, extra, locks.font(label.fontFamily ?? FONT_FAMILY, label.fontSize ?? 9, label.fontWeight ?? 400)),
    'data-owner': owner,
    'text-anchor': start ? 'start' : 'middle',
    ...(rotated ? { transform: `rotate(${num(angle)} ${num(middle.x)} ${num(middle.y)})` } : {}),
  }, title + spans);
}

function iconElement(icon: { icon: string; bounds: Rect; inset?: number; radius?: number }, locks: GeometryLocks, authored: string | undefined, themeRadius: number): string {
  const box = icon.bounds, radius = icon.radius ?? themeRadius, glyph = iconGlyphBox(box, icon.inset);
  return element('rect', { class: classes('icon-tile', authored, locks.stroke(DEFAULT_STROKE_WIDTHS.pill)),
    x: box.x, y: box.y, width: box.width, height: box.height, rx: radius, ry: radius })
    + element('use', { class: classes('node-icon', authored, locks.stroke(DEFAULT_STROKE_WIDTHS.glyph)),
      href: `#pg-icon-${iconKey(icon.icon)}`,
      x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height });
}

/**
 * Whether a stage-9 label is drawn at all. A link label follows its own link; a multiplicity label
 * belongs to a **bundle** and follows any visible member of it. The mask and the label layer read
 * this one predicate, so a drawn label is always protected and a hidden one never leaves a hole.
 */
function labelDrawn(model: LayoutModel, label: LayoutLabel, visible: (link: LayoutLink) => boolean): boolean {
  if (label.omitted || !label.bounds) return false;
  const owner = label.owner;
  if (owner.kind === 'barCross') {
    const crossing = model.links.find(link => link.id === owner.link);
    return crossing === undefined || visible(crossing);
  }
  if (label.support?.kind === 'merge-run' || owner.kind === 'bundle') {
    return model.links.some(link => link.bundle === owner.id && visible(link));
  }
  const link = model.links.find(item => item.id === owner.id);
  return link === undefined || visible(link);
}

/**
 * What one mask rectangle keeps to itself. The overlay mask is internal render structure, not an
 * author styling surface: its cutouts are what keeps node interiors, pills and labels readable under
 * an overlay link, and the theme deliberately states no rule for them. An author `css:` block is one
 * author-origin style sheet, and an important inline declaration outranks every rule in it whatever
 * its specificity, its importance or its source order, so these are the declarations that decide the
 * mask. Each one can turn a cutout into paint, or the shown region into a hole: the colour, its
 * alpha, the element's opacity, a stroke painted over a cutout edge, removal from the render, and
 * blending that would lighten black over white. An outline and a mask border are pinned for the same
 * reason and are not covered by the others: an outline is painted after the shape and independently
 * of `stroke`, so a wide white one over a cutout reopens it, and a mask border removes the element's
 * paint altogether. `mask`, `clip-path` and `filter` are locked in `css:` for this mask's sake; they
 * are pinned here as well, so the renderer does not depend on a document having passed the parser —
 * a restored layout model carries its CSS as published.
 */
const MASK_PAINT = 'fill-opacity:1!important;opacity:1!important;stroke:none!important'
  + ';outline:none!important;display:inline!important;visibility:visible!important'
  + ';mix-blend-mode:normal!important;mask:none!important;clip-path:none!important'
  + ';filter:none!important;mask-border:none!important;-webkit-mask-box-image:none!important';

/**
 * One rectangle of the overlay mask: `shown` keeps the overlay, otherwise it is a cutout. The paint
 * is a presentation attribute as well, so a renderer that reads no style at all still draws the mask
 * the layout intends rather than the initial fill.
 */
interface Cutout { box: Rect; turn?: number }

function maskRect(shown: boolean, box: Rect, turn?: number): string {
  const colour = shown ? '#ffffff' : '#000000';
  const middle = centre(box);
  return element('rect', { class: shown ? 'pg-mask-show' : 'pg-mask-hide', fill: colour,
    style: `fill:${colour}!important;${MASK_PAINT}`,
    x: box.x, y: box.y, width: box.width, height: box.height,
    ...(turn ? { transform: `rotate(${num(turn)} ${num(middle.x)} ${num(middle.y)})` } : {}) });
}

/**
 * The turned rectangle of a turned label (ticket 20), read from the label (`labelArea`): its text rectangle (with the halo on a
 * line) turned by its heading about its centre. Undefined for an upright label, which is cut out by its stored box.
 */
function turnedCutout(label: LayoutLabel): Cutout | undefined {
  if (!label.bounds || label.turnedSize === undefined) return undefined;
  const area = labelArea(label);
  if (!isOriented(area)) return undefined;
  return { box: { x: area.centre.x - area.width / 2, y: area.centre.y - area.height / 2, width: area.width, height: area.height }, turn: area.degrees };
}

/**
 * The cutout of a label that lies on a direct line (ticket 16): the rectangle of its text plus the
 * halo, turned to the line's angle about its centre (`turnedCutout`), so the line is cut away under
 * the glyphs and no more. Undefined for every other label.
 */
function onLineCutout(model: LayoutModel, label: LayoutLabel): Cutout | undefined {
  if (label.role !== 'link' || label.onLine !== true || label.support?.kind !== 'link-segment' || !label.bounds || !label.lines?.length) return undefined;
  const support = label.support;
  const segment = model.links.find(link => link.id === support.link)?.path?.segments[support.segment];
  if (segment === undefined || !isDirect(segment)) return undefined;
  return turnedCutout(label);
}

/** The link a link label belongs to: its owner, or the link of a bar crossing. */
const labelLink = (label: LayoutLabel): string | undefined =>
  label.owner.kind === 'link' ? label.owner.id : label.owner.kind === 'barCross' ? label.owner.link : undefined;

/**
 * The cutouts of one link's own labels: the label that lies on a direct line of the link (ticket 16), else its turned rectangle,
 * else its box. They mask that link's line only (ticket 162): a foreign line that crosses the label is not cut by them. A routed
 * link is cut only under a label on a direct line; placement keeps its other labels clear of it.
 */
function ownCutouts(model: LayoutModel, link: LayoutLink, visible: (link: LayoutLink) => boolean): Cutout[] {
  const routed = effectiveLayer(link) === 'routed';
  return model.labels.flatMap(label => {
    if (label.role !== 'link' || labelLink(label) !== link.id || !crossableText(label) || !labelDrawn(model, label, visible)) return [];
    const cut = onLineCutout(model, label);
    if (routed) return cut && label.layer !== 'overlay' ? [cut] : [];
    return [cut ?? turnedCutout(label) ?? { box: label.bounds! }];
  });
}

/**
 * Where an orthogonal run of an overlay line meets a group title or a foreign link label (ticket 162): the text box cut to the run's
 * stroke rectangle, so the run breaks under the text and nothing else is cut. A diagonal is not cut: it may cross the text, and the
 * text's halo breaks it under the letters.
 */
function crossedTextCutouts(model: LayoutModel, lines: readonly { from: Point; to: Point }[], half: number, owner: string | undefined,
  visible: (link: LayoutLink) => boolean): Cutout[] {
  const runs = lines.filter(line => !isDiagonal(line)).map(line => ({
    x: Math.min(line.from.x, line.to.x) - half, y: Math.min(line.from.y, line.to.y) - half,
    width: Math.abs(line.to.x - line.from.x) + 2 * half, height: Math.abs(line.to.y - line.from.y) + 2 * half }));
  if (!runs.length) return [];
  return model.labels.flatMap(label => {
    const text = label.role === 'group' ? !label.omitted && label.bounds !== undefined
      : label.role === 'link' && crossableText(label) && labelLink(label) !== owner && labelDrawn(model, label, visible);
    if (!text) return [];
    return runs.flatMap(run => { const box = overlap(run, label.bounds!); return box ? [{ box }] : []; });
  });
}

/** The common part of two rectangles, or undefined where they do not overlap. */
function overlap(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * Every rectangle the whole overlay layer is masked out of, per `pipeline.md` stage 11: node bodies, pills, and the text a diagonal
 * may not cross (a multiplicity label, a bus label). A group title and a link's own label cut one line each (`ownCutouts`,
 * `crossedTextCutouts`, ticket 162).
 */
function maskedBoxes(model: LayoutModel, visible: (link: LayoutLink) => boolean): Cutout[] {
  const boxes: Cutout[] = [];
  for (const node of Object.values(model.nodes)) {
    if (node.bounds) boxes.push({ box: node.bounds });
    for (const port of node.ports) if (port.pill) boxes.push({ box: port.pill.bounds });
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds) continue;
    // A hidden link's label is not drawn, so masking it would leave an unexplained gap.
    if (label.role === 'link' && !crossableText(label) && labelDrawn(model, label, visible)) boxes.push(turnedCutout(label) ?? { box: label.bounds });
    // The bus label is cut out of the overlay layer as a link label is: the bar and stubs are overlay strokes.
    if (label.role === 'mesh-bus') {
      const bus = model.meshBuses?.find(item => item.label === label.id);
      if (bus?.members.some(id => { const link = model.links.find(item => item.id === id); return link !== undefined && visible(link); })) boxes.push({ box: label.bounds });
    }
  }
  return boxes;
}

/**
 * Serialize final layout geometry as SVG. This is a pure function: it measures nothing, moves
 * nothing, and grows nothing. Every coordinate, size, rotation, stroke width and label metric comes
 * from the model, and the emitted stroke widths are the ones `score` measured.
 */
export function render(layout: LayoutModel, options: RenderOptions = {}): string {
  checkOptions(options);
  validate(layout);
  const canvas = layout.canvas;
  if (!canvas) throw new Error('Render requires a final canvas');
  const locks = new GeometryLocks();
  // The theme is paint: it picks colours and corner radii, and no size or position (ticket 158).
  const theme: Theme = themeById(layout.document.theme);
  const visible = (link: LayoutLink): boolean => linkVisible(layout, link, options);
  const icons = new Set<string>();

  // A frame is drawn in its cells' place: a cell never is (ranked-groups spec, section 2). A parent
  // frame is painted before its children, and a box that lies on another after it (frame-order.ts).
  const shapes = groupShapes(layout);
  // Every text outside a node body carries a halo in the colour behind it (ticket 162): the class names the depth of group fills behind
  // its centre, and `haloCss` states the colour of each depth used, in every mode.
  const haloDepths: number[] = [];
  const halo = (label: LayoutLabel): string => {
    const depth = boxesBehind(shapes, centre(label.bounds!));
    haloDepths.push(depth);
    return svgClass.halo(depth);
  };
  const groups = shapes.map(box => {
    const { authored, uniform } = boxClasses(layout, box);
    return element('g', { class: svgClass.group(authored), 'data-id': box.id,
      ...(uniform ? { 'data-node-class': uniform } : {}) },
    element('rect', { class: classes(svgClass.groupBox(authored, uniform), locks.stroke(DEFAULT_STROKE_WIDTHS.group)),
      x: box.bounds.x, y: box.bounds.y, width: box.bounds.width, height: box.bounds.height,
      rx: theme.radii.group, ry: theme.radii.group }));
  }).join('');

  /**
   * Text the link carries but does not draw: an omitted label keeps its full text as a tooltip, and
   * an M1 group-link fallback keeps its membership. Neither may disappear, and neither becomes an
   * aggregated glyph: the members are still drawn one by one.
   */
  const linkTooltip = (link: LayoutLink): string => {
    const lines = linkTooltipLines(layout, link);
    return lines.length ? element('title', {}, escapeText(lines.join('\n'))) : '';
  };

  /**
   * Bars that painted geometry declares it crosses. A drop onto a lower bar crosses the upper bar's
   * body by design — reserved during placement, annotated `barCross`, exempt from G2 — so that body
   * may not be painted over the run that crosses it. The bars named here paint their body beneath
   * the routed layer instead and keep their icon, label and pills above it; read from the segments
   * that are really drawn, so a crossing nothing paints moves nothing.
   */
  const crossedBars = new Set<string>();
  const noteCrossings = (segments: readonly PathSegment[]): void => {
    for (const segment of segments) for (const id of segment.barCross ?? []) crossedBars.add(id);
  };

  const maskElement = (id: string, inner: string): string => element('mask', { id, maskUnits: 'userSpaceOnUse',
    // The mask means luminance: white shows the overlay, black cuts it out. Said here, on the
    // element, so no rule can reinterpret the cutouts as opaque alpha.
    style: 'mask-type:luminance!important',
    x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height }, inner);
  // One mask per line that a text cuts (ticket 162): a label cuts its own line, and a group title or a foreign link label cuts an
  // orthogonal overlay run where it meets it. A foreign diagonal is not cut; the text's halo breaks it under the letters.
  const lineMasks = new Map<string, string>();
  const lineMask = (cuts: readonly Cutout[]): { mask: string } | undefined => {
    if (!cuts.length) return undefined;
    const inner = maskRect(true, canvas) + cuts.map(cut => maskRect(false, cut.box, cut.turn)).join('');
    const id = maskId(LINE_MASK_ID, inner);
    lineMasks.set(id, maskElement(id, inner));
    return { mask: `url(#${id})` };
  };

  const linkElement = (link: LayoutLink, bundle: Bundle | undefined): string => {
    const authored = linkClassToken(layout, link);
    const layer = effectiveLayer(link);
    const segments = withoutTrunks(link, trunkIntervals(bundle, link));
    const data = pathData(segments);
    if (!data) return '';
    noteCrossings(segments);
    const cuts = [...ownCutouts(layout, link, visible),
      ...(layer === 'overlay' ? crossedTextCutouts(layout, segments, linkStrokeWidth(link) / 2, link.id, visible) : [])];
    return element('g', { class: svgClass.link(authored, layer === 'overlay'), 'data-id': link.id, ...lineMask(cuts) },
      linkTooltip(link)
      + element('path', { class: classes(svgClass.linkLine(authored, layer === 'overlay'), locks.stroke(linkStrokeWidth(link))), d: data }));
  };

  // A mesh bus member draws no line of its own: the bus draws one bar and one stub per member port (mesh-bus.md, section 6).
  const drawn = layout.links.filter(link => link.technique !== 'stub' && link.path && link.meshBus === undefined && visible(link));
  const memberOf = (id: string): LayoutLink | undefined => layout.links.find(link => link.id === id);
  const buses = (layout.meshBuses ?? []).filter(bus => bus.bar !== undefined && bus.stubs !== undefined
    && bus.members.some(id => { const link = memberOf(id); return link !== undefined && visible(link); }));
  const busElements = buses.map(bus => {
    const first = memberOf(bus.members[0]!)!, authored = linkClassToken(layout, first);
    const line = (from: Point, to: Point, extra?: string): string => element('path', { class: classes(svgClass.linkLine(authored, true, extra), locks.stroke(linkStrokeWidth(first))),
      d: pathData([{ from, to, owner: { ...bus.owner } }]) });
    // The riser of a join is one more line in the upper bus's group (mesh-bus.md, section 11.7); it carries no mark.
    const riser = bus.riser?.from !== undefined && bus.riser.to !== undefined ? line(bus.riser.from, bus.riser.to, 'riser') : '';
    // The trunk of a three-row join is one line per pair of neighbouring bars, in the head bus's group (mesh-bus.md, section 12.7).
    const joins = bus.trunk?.joins ?? [];
    const trunk = joins.slice(1).map((point, index) => line(joins[index]!, point, 'trunk')).join('');
    const runs = [bus.bar!, ...bus.stubs!, ...(bus.riser?.from !== undefined && bus.riser.to !== undefined ? [{ from: bus.riser.from, to: bus.riser.to }] : []),
      ...joins.slice(1).map((point, index) => ({ from: joins[index]!, to: point }))];
    return element('g', { class: svgClass.meshBus(authored), 'data-id': bus.id, 'data-members': bus.members.join(' '),
      ...(bus.joined !== undefined ? { 'data-joined': bus.joined } : {}), ...(bus.mesh !== undefined ? { 'data-mesh': bus.mesh } : {}),
      ...lineMask(crossedTextCutouts(layout, runs, linkStrokeWidth(first) / 2, undefined, visible)) },
      element('title', {}, escapeText(busTooltip(layout, bus))) + line(bus.bar!.from, bus.bar!.to) + bus.stubs!.map(stub => line(stub.from, stub.to)).join('') + riser + trunk);
  }).join('');
  const byId = new Map(layout.links.map(link => [link.id, link]));
  const bundleOf = new Map(layout.bundles.map(bundle => [bundle.id, bundle]));
  const overlayPaths = drawn.filter(link => effectiveLayer(link) === 'overlay')
    .map(link => linkElement(link, undefined)).join('') + busElements;
  const routedPaths = drawn.filter(link => effectiveLayer(link) === 'routed')
    .map(link => linkElement(link, link.bundle ? bundleOf.get(link.bundle) : undefined)).join('');
  // One counted merge trunk is painted once by its bundle, never once per member.
  const trunks = layout.bundles.flatMap(bundle => (bundle.mergeRuns ?? []).flatMap(run => {
    const members = run.members.map(id => byId.get(id)).filter((link): link is LayoutLink => link !== undefined);
    if (!members.length || !members.some(visible)) return [];
    noteCrossings(run.path.segments);
    const shared = new Set(members.map(member => linkClassToken(layout, member)));
    const authored = shared.size === 1 ? [...shared][0] : undefined;
    return [element('g', { class: classes('merge-run', authored), 'data-id': run.id, 'data-owner': bundle.id },
      element('path', { class: classes('link-line', authored, locks.stroke(run.path.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path)),
        d: pathData(run.path.segments) }))];
  })).join('');

  // Bodies detached to the layer beneath the links, in node order; see `crossedBars`.
  const crossedBodies: string[] = [];
  // The sheet's own node classes take wash hues in document order; one structural class per body carries the hue.
  const nodeClassAttrs = orderedNodeIds(layout.document).map(id => authorClass(layout.document.nodes[id]!.class));
  const washes = washAssignment(nodeClassAttrs);
  const nodes = orderedNodeIds(layout.document).map(id => {
    const node = layout.nodes[id]!, authored = authorClass(layout.document.nodes[id]!.class);
    const crossed = crossedBars.has(id);
    const body = element('rect', { class: classes(svgClass.nodeBody(authored, washClass(authored, washes)), locks.stroke(nodeStroke(node))),
      x: node.bounds!.x, y: node.bounds!.y, width: node.bounds!.width, height: node.bounds!.height, rx: theme.radii.node, ry: theme.radii.node });
    // The detached body is the same rectangle, in a container of the same kind, inside a second
    // node layer, so what a document styles by name still reaches it: the theme, the geometry locks
    // and a `css:` rule naming the body, the class, the container or the layer. What it cannot
    // reach is the element's place in the tree, which no detached element here has ever kept. The
    // container carries `data-owner`; the node's one `data-id` stays on its content group.
    if (crossed) crossedBodies.push(element('g', { class: svgClass.node(authored), 'data-owner': id }, body));
    if (node.icon) icons.add(iconKey(node.icon.icon));
    const icon = node.icon ? iconElement(node.icon, locks, authored, theme.radii.tile) : '';
    const text = layout.labels.filter(label => label.owner.kind === 'node' && label.owner.id === id
      && (label.role === 'node' || label.role === 'description'))
      .map(label => textElement(label, locks, label.role === 'node' ? 'node-label' : 'node-description', id, authored)).join('');
    const pills = node.ports.filter(port => port.pill && port.ref.anonymous !== true).map(port => {
      const pill = port.pill!, identity = portId(id, port.ref.name!, port.ref.ordinal);
      const label = layout.labels.find(item => item.role === 'pill' && item.port !== undefined
        && item.port.node === id && item.port.name === port.ref.name && item.port.ordinal === port.ref.ordinal);
      // The port's own tokens (a role, a status, free text) follow the node class on the pill, its
      // label and the port group, so `.pill.<role>` paints the fill, `.pill.<status>` the stroke
      // and `.port.unused` fades the whole port. Reserved tokens are stripped like any author class.
      const authoredPort = classes(authored, authorClass(port.class)) || undefined;
      return element('g', { class: svgClass.port(authoredPort), 'data-id': identity },
        element('rect', { class: classes(svgClass.pill(authoredPort), locks.stroke(DEFAULT_STROKE_WIDTHS.pill)),
          x: pill.bounds.x, y: pill.bounds.y, width: pill.bounds.width, height: pill.bounds.height,
          rx: pill.radius, ry: pill.radius })
        + (label ? textElement(label, locks, 'pill-label', identity, authoredPort) : ''));
    }).join('');
    return element('g', { class: svgClass.node(authored), 'data-id': id },
      (crossed ? '' : body) + icon + text + pills);
  }).join('');

  const groupLabels = layout.labels.filter(label => label.role === 'group' && !label.omitted)
    .map(label => {
      const frame = label.owner.kind === 'group' ? frameTitled(layout, label) : undefined;
      return textElement(label, locks, classes('group-label', halo(label)), label.owner.kind === 'barCross' ? label.owner.node : (frame?.id ?? label.owner.id),
        groupLabelClasses(layout, label));
    }).join('');
  const linkLabels = layout.labels.filter(label => label.role === 'link' && labelDrawn(layout, label, visible))
    .map(label => {
      const owner = label.owner.kind === 'barCross' ? label.owner.link : label.owner.id;
      const link = byId.get(owner);
      const multiplicity = label.support?.kind === 'merge-run';
      return textElement(label, locks, classes('link-label', multiplicity ? 'multiplicity-label' : undefined, halo(label)),
        owner, link ? linkClassToken(layout, link) : undefined);
    }).join('');

  const busLabels = buses.flatMap(bus => {
    const label = layout.labels.find(item => item.id === bus.label);
    return label === undefined || label.omitted || label.bounds === undefined ? []
      : [textElement(label, locks, classes('link-label', 'mesh-bus-label', halo(label)), bus.id, authorClass(bus.class))];
  });
  // A link end on an anonymous port (ADR-0002: no geometry, no pill) is closed by a dot in the link stroke, so it does not look
  // unfinished beside a pill. `dotEnds` is the predicate draw.io shares. Paint only. A routed dot stands in a group after the nodes,
  // as draw.io's links layer stands above its diagram layer, so the node body does not cut the dot on the border. An overlay dot
  // stands among the overlay marks and replaces the small mark of its end, so one dot shows.
  const dotFor = (link: LayoutLink, overlay: boolean): string => {
    const ends = dotEnds(layout.document, link), segments = link.path?.segments ?? [];
    if (!ends.length || !segments.length) return '';
    // A disc drawn as a stroke: radius r/2 with a stroke r wide covers the disc of radius r, in the colour of the link's own
    // `.link-line` rules, so a document `css:` rule that recolours the line recolours the dot.
    const radius = anonymousDotRadius(linkStrokeWidth(link));
    return ends.map(end => {
      // An anonymous end draws no pill, so its visible end is the path end itself (`visibleEnd`, D-Q7).
      const point = visibleEnd(layout, link, end) ?? (end === 'from' ? segments[0]!.from : segments.at(-1)!.to);
      return element('circle', { class: classes(svgClass.linkDot(linkClassToken(layout, link), overlay), locks.stroke(radius)),
        style: 'stroke-dasharray:none', 'data-owner': link.id, 'data-end': end, cx: point.x, cy: point.y, r: radius / 2 });
    }).join('');
  };
  const dots = drawn.filter(link => effectiveLayer(link) === 'routed').map(link => dotFor(link, false)).join('');
  const overlayDots = drawn.filter(link => effectiveLayer(link) === 'overlay').map(link => dotFor(link, true)).join('');

  const busMarks = buses.flatMap(bus => bus.stubs!.map(stub => element('circle', { class: svgClass.overlayEndpoint(authorClass(bus.class)),
    'data-owner': bus.id, 'data-end': stub.node, cx: stub.from.x, cy: stub.from.y, r: OVERLAY_ENDPOINT_RADIUS }))).join('');
  const marks = busMarks + drawn.filter(link => effectiveLayer(link) === 'overlay').flatMap(link => {
    const segments = link.path!.segments;
    if (!segments.length) return [];
    const bare = dotEnds(layout.document, link);
    // The mark stands where the line is seen to end (`visibleEnd`, D-Q7): an overlay path is chord-built and ends on that point.
    return ([['from', visibleEnd(layout, link, 'from') ?? segments[0]!.from], ['to', visibleEnd(layout, link, 'to') ?? segments.at(-1)!.to]] as const)
      .filter(([end]) => !bare.includes(end)).map(([end, point]) =>
      element('circle', { class: svgClass.overlayEndpoint(linkClassToken(layout, link)),
        'data-owner': link.id, 'data-end': end, cx: point.x, cy: point.y, r: OVERLAY_ENDPOINT_RADIUS }));
  }).join('') + overlayDots;

  const legendSwatch = (entry: NonNullable<LayoutModel['legend']>['entries'][number]): string => {
    if (entry.kind === 'line') {
      const middle = centre(entry.swatch).y;
      // The sample takes the paint its links take: an overlay line when every link the row keys is one (audit A1-16).
      return element('line', { class: classes(svgClass.linkLine(legendSwatchClass('line', entry.key), legendLineOverlay(layout, entry.key)),
        locks.stroke(entry.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path)),
      x1: entry.swatch.x, y1: middle, x2: right(entry.swatch), y2: middle });
    }
    if (entry.kind === 'port') {
      // A role's swatch is a pill drawn with the role class, so it takes the same paint as the pills.
      return element('rect', { class: classes(svgClass.pill(legendSwatchClass('port', entry.key)), locks.stroke(DEFAULT_STROKE_WIDTHS.pill)),
        x: entry.swatch.x, y: entry.swatch.y, width: entry.swatch.width, height: entry.swatch.height,
        ...(entry.radius !== undefined ? { rx: entry.radius, ry: entry.radius } : {}) });
    }
    if (!entry.icon) return '';
    icons.add(iconKey(entry.icon));
    // The key shows the class's body wash behind its tile, as a node of the class shows it.
    const at = entry.swatch, grow = 2;
    const keyClass = legendSwatchClass('symbol', entry.key);
    const wash = element('rect', { class: classes(svgClass.nodeBody(keyClass, washClass(keyClass, washes)), locks.stroke(DEFAULT_STROKE_WIDTHS.pill)),
      x: at.x - grow, y: at.y - grow, width: at.width + 2 * grow, height: at.height + 2 * grow, rx: legendKeyRadius(theme, grow), ry: legendKeyRadius(theme, grow) });
    return wash + iconElement({ icon: entry.icon, bounds: entry.swatch }, locks, keyClass, theme.radii.tile);
  };
  const legend = layout.legend ? element('g', { class: 'legend', 'data-id': layout.legend.id },
    layout.legend.entries.map(entry => {
      const label = layout.labels.find(item => item.id === entry.label);
      return element('g', { class: svgClass.legendEntry(entry.kind, entry.key), 'data-id': entry.id },
        legendSwatch(entry) + (label && label.bounds ? textElement(label, locks, classes('legend-label', halo(label)), entry.id) : ''));
    }).join('')) : '';

  const overlayVisible = drawn.some(link => effectiveLayer(link) === 'overlay') || buses.length > 0;
  const overlayInner = overlayVisible
    ? maskRect(true, canvas) + maskedBoxes(layout, visible).map(cut => maskRect(false, cut.box, cut.turn)).join('') : '';
  const overlayMaskId = maskId(MASK_ID, overlayInner);
  const mask = overlayVisible ? maskElement(overlayMaskId, overlayInner) : '';

  const symbols = [...icons].sort().map(name => element('symbol',
    { id: `pg-icon-${name}`, viewBox: '0 0 24 24' }, element('path', { d: iconPath(name) }))).join('');
  const documentCss = layout.document.css ?? '';
  const style = element('style', { type: 'text/css' },
    escapeStyle([themeCss(theme), sheetClassWashCss(nodeClassAttrs, theme), haloCss(haloDepths, theme), locks.css(), documentCss].filter(part => part.trim()).join('\n')));

  const body = element('rect', { class: 'pg-canvas', x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height })
    + element('g', { class: 'groups' }, groups)
    + (overlayPaths ? element('g', { class: 'overlay-links', mask: `url(#${overlayMaskId})` }, overlayPaths) : '')
    + (crossedBodies.length ? element('g', { class: 'nodes crossed-bars' }, crossedBodies.join('')) : '')
    + element('g', { class: 'links' }, routedPaths + trunks)
    + element('g', { class: 'nodes' }, nodes)
    + (dots ? element('g', { class: 'link-dots' }, dots) : '')
    + element('g', { class: 'labels' }, groupLabels + linkLabels + busLabels.join(''))
    + (marks ? element('g', { class: 'overlay-marks' }, marks) : '')
    + legend;
  const title = layout.document.title !== undefined && layout.document.title !== ''
    ? element('title', {}, escapeText(layout.document.title)) : '';
  return element('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    class: svgClass.root(layout.document.profile),
    viewBox: `${num(canvas.x)} ${num(canvas.y)} ${num(canvas.width)} ${num(canvas.height)}`,
    width: canvas.width, height: canvas.height,
  }, title + element('defs', {}, style + symbols + mask + [...lineMasks.values()].join('')) + body) + '\n';
}
