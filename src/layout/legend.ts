import type { Rect } from '../model/geometry.js';
import type { Legend, LegendEntry, LayoutLabel, LayoutModel } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { LEGEND_DEFAULT_CLASS, classDisplayLabel, classOrder } from '../profiles/network/theme.js';
import { resolveNodeIcon } from '../profiles/network/icons.js';
import { bottom, boundingBox } from '../score/geometry.js';
import { measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS, OVERLAY_ENDPOINT_RADIUS, linkStrokeWidth } from '../theme/geometry.js';
import { LEGEND_GEOMETRY as theme } from '../theme/legend.js';

const OWNER = { kind: 'legend', id: 'legend' } as const;

/**
 * One field of a legend entry ID, with the separator, the escape itself and every character an XML
 * attribute cannot carry unchanged encoded. Without the separator escape a class literally named
 * `router:server` would produce the same ID as class `router` drawn with icon `server`, and one of
 * the two classes present would silently vanish from the legend. Without the rest, two classes that
 * differ only in a control character, a literal newline or a lone surrogate would reach the reader
 * as one `data-id`: the serializer substitutes U+FFFD for a character XML forbids, and an XML parser
 * normalizes a literal tab, carriage return or newline in an attribute value to a space. A class is
 * accepted free text, so identity is encoded here, where it is built, rather than in the serializer,
 * which has to leave the text a legend row displays exactly as the author wrote it.
 *
 * The encoding is percent-and-code-unit: `%XX` below U+0100, `%uXXXX` above it. `%` itself always
 * encodes, so no ordinary class can spell the encoded form of another: `a%0Ab` is class `a`, a
 * newline and `b`, while the class literally spelled `a%0Ab` becomes `a%250Ab`.
 */
function token(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // A valid surrogate pair is one code point above U+FFFF, which XML carries; a lone surrogate,
    // the two non-characters and every C0 control — including the whitespace a parser folds — is
    // not, so each of those is spelled out instead.
    const encode = character === '%' || character === ':'
      || code < 0x20 || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff;
    result += !encode ? character
      : code <= 0xff ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
        : `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return result;
}

/** One legend variant before it is measured: its identity, its style source and its first use. */
interface Variant {
  id: string;
  kind: 'symbol' | 'line';
  key: string;
  icon?: string;
  strokeWidth?: number;
  order: number;
}

const inflate = (box: Rect, by: number): Rect =>
  by === 0 ? box : { x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by };

/**
 * The paint of one stroked segment. Half the stroke lies on each side of the centreline, and a
 * square or round cap also extends it along its own direction, so for a segment at any angle the
 * painted extent on each axis grows by `(stroke / 2) · (|dx| + |dy|) / length`: exactly half the
 * stroke for an axis-aligned run, and its diagonal for anything else.
 */
function segmentBox(from: { x: number; y: number }, to: { x: number; y: number }, stroke: number): Rect {
  const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y);
  const length = Math.hypot(dx, dy);
  return inflate({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: dx, height: dy },
    stroke / 2 * (length > 0 ? (dx + dy) / length : 1));
}

/**
 * Every rectangle the diagram actually paints, including the outer half of each stroke: a rectangle
 * is drawn on its centreline, so a canvas measured from bare bounds clips half the outline.
 * `includeLegend` is false while the legend is being placed against this geometry and true once the
 * canvas has to contain the published result.
 */
export function drawnBoxes(model: LayoutModel, includeLegend: boolean): Rect[] {
  const boxes: Rect[] = [];
  for (const group of Object.values(model.groups)) {
    if (group.bounds) boxes.push(inflate(group.bounds, DEFAULT_STROKE_WIDTHS.group / 2));
  }
  for (const node of Object.values(model.nodes)) {
    if (node.bounds) boxes.push(inflate(node.bounds, (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2));
    for (const port of node.ports) if (port.pill) boxes.push(inflate(port.pill.bounds, DEFAULT_STROKE_WIDTHS.pill / 2));
  }
  for (const lane of model.lanes) boxes.push(lane.bounds);
  for (const link of model.links) {
    if (link.technique === 'stub') continue;
    const stroke = linkStrokeWidth(link);
    const segments = link.path?.segments ?? [];
    for (const segment of segments) boxes.push(segmentBox(segment.from, segment.to, stroke));
    // An overlay endpoint keeps a mark drawn above the masked layer, so it too has to fit.
    if (segments.length && (link.layer ?? link.family) === 'overlay') {
      for (const point of [segments[0]!.from, segments.at(-1)!.to]) {
        boxes.push(inflate({ ...point, width: 0, height: 0 }, OVERLAY_ENDPOINT_RADIUS));
      }
    }
  }
  for (const bundle of model.bundles) for (const run of bundle.mergeRuns ?? []) {
    const stroke = run.path.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path;
    for (const segment of run.path.segments) boxes.push(segmentBox(segment.from, segment.to, stroke));
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds) continue;
    if (label.role === 'legend' ? includeLegend : true) boxes.push(label.bounds);
  }
  if (includeLegend) boxes.push(...legendBoxes(model));
  return boxes;
}

/**
 * Everything the diagram draws apart from the legend itself. The legend is placed against this box,
 * never against the canvas, so re-deriving it from a published model — which already contains it —
 * puts it back in exactly the same place. Strokes are included, so the reserved gap below the
 * diagram stays visible however wide a path is.
 */
export function diagramBounds(model: LayoutModel): Rect | undefined {
  return boundingBox(drawnBoxes(model, false));
}

/**
 * The distinct symbol and line variants the diagram really draws, in the accepted order: known
 * profile classes by declaration order, then author classes by first use. A node without a class
 * contributes no symbol; a link without one contributes the profile's default line style, because
 * that style is what its line really uses.
 */
export function legendVariants(model: LayoutModel): { symbols: Variant[]; lines: Variant[] } {
  const symbols: Variant[] = [], lines: Variant[] = [];
  // A class drawn with two different icons needs two rows, so the icon qualifies the id then.
  const icons = new Map<string, Set<string>>();
  for (const id of orderedNodeIds(model.document)) {
    const node = model.document.nodes[id]!;
    if (node.class === undefined || node.class === '' || !model.nodes[id]) continue;
    const set = icons.get(node.class) ?? new Set<string>();
    set.add(resolveNodeIcon(node) ?? '');
    icons.set(node.class, set);
  }
  // Identity is the structured pair, never the joined string: two different pairs must not collide
  // into one entry, and an author class containing the separator must not impersonate another.
  const seen = new Set<string>();
  for (const id of orderedNodeIds(model.document)) {
    const node = model.document.nodes[id]!;
    if (node.class === undefined || node.class === '' || !model.nodes[id]) continue;
    const icon = resolveNodeIcon(node) ?? '';
    const qualified = (icons.get(node.class)?.size ?? 0) > 1;
    const identity = JSON.stringify(['symbol', node.class, qualified ? icon : null]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    symbols.push({ id: `symbol:${token(node.class)}${qualified ? `:${token(icon)}` : ''}`,
      kind: 'symbol', key: node.class, ...(icon ? { icon } : {}), order: symbols.length });
  }
  for (const link of model.links) {
    if (link.technique === 'stub') continue;
    const key = model.document.links[link.sourceIndex]?.class ?? LEGEND_DEFAULT_CLASS;
    const identity = JSON.stringify(['line', key]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    lines.push({ id: `line:${token(key)}`, kind: 'line', key, order: lines.length,
      strokeWidth: linkStrokeWidth(link) });
  }
  const sort = (items: Variant[]): Variant[] => [...items].sort((a, b) => {
    const left = classOrder(a.kind, a.key), rightOrder = classOrder(b.kind, b.key);
    if (left !== undefined && rightOrder !== undefined) return left - rightOrder || a.order - b.order;
    if (left !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return a.order - b.order;
  });
  return { symbols: sort(symbols), lines: sort(lines) };
}

/** `quality.md` item 10: a legend exists once more than one symbol or one line style is drawn. */
export function legendRequired(model: LayoutModel): boolean {
  const { symbols, lines } = legendVariants(model);
  return symbols.length > 1 || lines.length > 1;
}

interface Measured extends Variant {
  swatchWidth: number;
  swatchHeight: number;
  text: ReturnType<typeof measureText>;
  label: string;
  width: number;
  height: number;
}

function measure(variant: Variant): Measured {
  const label = classDisplayLabel(variant.kind, variant.key);
  const text = measureText(label, { fontSize: theme.fontSize, weight: theme.fontWeight });
  const swatchWidth = variant.kind === 'symbol' ? theme.symbolWidth : theme.lineWidth;
  const swatchHeight = variant.kind === 'symbol' ? theme.symbolHeight
    : Math.max(variant.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path, 2);
  return { ...variant, label, text, swatchWidth, swatchHeight,
    width: swatchWidth + theme.swatchGap + text.width, height: Math.max(swatchHeight, text.height) };
}

/**
 * Measure and place the generated legend in newly reserved space below the drawn diagram. This is a
 * pure function of final geometry: it moves nothing, and the caller expands the canvas over the
 * result. It is stage 9's last producer step, after the ordinary link labels it must not disturb.
 */
export function produceLegend(model: LayoutModel): void {
  if (!legendRequired(model)) return;
  const diagram = diagramBounds(model);
  if (!diagram) return;
  const { symbols, lines } = legendVariants(model);
  const measured = [...symbols, ...lines].map(measure);
  const widest = Math.max(...measured.map(item => item.width));
  const limit = Math.max(diagram.width, widest);

  const rows: Measured[][] = [];
  let row: Measured[] = [], used = 0;
  for (const item of measured) {
    const advance = row.length ? theme.columnGap + item.width : item.width;
    if (row.length && used + advance > limit + 1e-9) { rows.push(row); row = [item]; used = item.width; continue; }
    row.push(item);
    used += advance;
  }
  if (row.length) rows.push(row);

  const entries: LegendEntry[] = [], labels: LayoutLabel[] = [], boxes: Rect[] = [];
  // The gap is visible separation, so it is measured from the legend's painted top, not from a
  // box edge. A tile is outlined on its bounds and paints half a stroke above them; a line sample
  // is stroked along its box's centreline and paints inside a box at least as tall as it is.
  const paintedTop = (item: Measured, height: number): number => {
    const swatchTop = (height - item.swatchHeight) / 2;
    const text = (height - item.text.height) / 2;
    const swatch = item.kind === 'symbol' ? swatchTop - DEFAULT_STROKE_WIDTHS.pill / 2
      : swatchTop + (item.swatchHeight - (item.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path)) / 2;
    return Math.min(swatch, text);
  };
  const firstRow = rows[0]!, firstHeight = Math.max(...firstRow.map(item => item.height));
  let y = bottom(diagram) + theme.gap - Math.min(...firstRow.map(item => paintedTop(item, firstHeight)));
  for (const current of rows) {
    const height = Math.max(...current.map(item => item.height));
    let x = diagram.x;
    for (const item of current) {
      const swatch: Rect = { x, y: y + (height - item.swatchHeight) / 2,
        width: item.swatchWidth, height: item.swatchHeight };
      const bounds: Rect = { x: x + item.swatchWidth + theme.swatchGap, y: y + (height - item.text.height) / 2,
        width: item.text.width, height: item.text.height };
      const label = `label:legend:${item.id}`;
      labels.push({ id: label, owner: { ...OWNER }, layer: 'routed', role: 'legend', text: item.label,
        fontFamily: theme.fontFamily, fontSize: theme.fontSize, fontWeight: theme.fontWeight,
        lineHeight: item.text.lineHeight, lines: item.text.lines, textRotation: 0, bounds });
      const entry: LegendEntry = { id: item.id, kind: item.kind, key: item.key,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.strokeWidth !== undefined ? { strokeWidth: item.strokeWidth } : {}), swatch, label };
      entries.push(entry);
      // `bounds` is the legend's painted region, so a thin line's taller box never enlarges it.
      boxes.push(paintedSwatch(entry), bounds);
      x += item.width + theme.columnGap;
    }
    y += height + theme.rowGap;
  }
  const legend: Legend = { id: 'legend', owner: { ...OWNER }, layer: 'routed',
    bounds: boundingBox(boxes)!, entries };
  model.legend = legend;
  model.labels.push(...labels);
}

/**
 * What one swatch really paints. A symbol tile is outlined on its bounds, so its paint reaches half
 * a stroke outside them; a line sample is stroked along its box's centreline, so its paint is that
 * stroke tall wherever the box is taller — inflating the whole box would count the same width
 * twice — and reaches half a stroke past each end when the cap is not butt.
 */
export function paintedSwatch(entry: LegendEntry): Rect {
  if (entry.kind === 'symbol') return inflate(entry.swatch, DEFAULT_STROKE_WIDTHS.pill / 2);
  const stroke = entry.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path;
  const middle = entry.swatch.y + entry.swatch.height / 2;
  return { x: entry.swatch.x - stroke / 2, y: middle - stroke / 2,
    width: entry.swatch.width + stroke, height: stroke };
}

/** Every box the published legend paints; the canvas must contain all of them. */
export function legendBoxes(model: LayoutModel): Rect[] {
  if (!model.legend) return [];
  return [model.legend.bounds, ...model.legend.entries.map(paintedSwatch)];
}
