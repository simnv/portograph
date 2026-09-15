/**
 * Serialize final layout geometry as a draw.io (mxGraph) document.
 *
 * This is the second consumer of `LayoutModel`, beside `render`, and it keeps the same contract:
 * a pure function that measures nothing, moves nothing and grows nothing. Every coordinate, size,
 * stroke width and label metric comes from the model, so what draw.io opens is the diagram the
 * gates measured — not a re-layout of it.
 *
 * The output is structural rather than primitive: a group is a container that carries its nodes, a
 * node carries its ports, and a link is one connector pinned to the two ports it joins. Four
 * measured facts about the format shape the code, and each is load-bearing:
 *
 * 1. `edgeStyle=orthogonalEdgeStyle;jettySize=0` draws a square route on the reserved route. Over 61
 *    link edges in four diagrams, 59 render within 0.05 px of the model polyline — the orthogonal
 *    router rounds a waypoint to 0.1 px — and 2 within 0.51 px, which is an endpoint defect the
 *    export has with `edgeStyle=none` as well. No waypoint is dropped and no edge is re-routed.
 *    `jettySize=0` is the one key that matters: without it an edge whose two ends leave the same
 *    node side gains a 10 px loop, and `jettySize=auto` doubles that. `orthogonalLoop`, `curved` and
 *    the perimeter spacing keys are no-ops; `elbowEdgeStyle` re-routes by up to 265 px and is
 *    refused. A polyline with a segment that is not axis-aligned is outside that router's vocabulary
 *    and keeps `edgeStyle=none`, which reproduces any waypoints verbatim. Measured against
 *    drawio-desktop 31.4.5.
 * 2. `points=` on a shape does not constrain an edge — it only decides which anchors the editor
 *    offers. An endpoint is pinned by `exitX`/`exitY` on the edge, and `exitPerimeter` defaults to
 *    1, which projects the point onto the perimeter instead of using it.
 * 3. `startSize` does not shift a child's origin: a child is always placed from the parent's
 *    top-left, so the title band's inset is ours to add.
 * 4. With `html=1` the value is assigned to `innerHTML`, so text is HTML-escaped first and then
 *    XML-escaped for the attribute. Single-escaped markup is swallowed without a word.
 *
 * Named styles do not exist in the file format — an `<mxStylesheet>` in an `mxfile` is dropped — so
 * the palette lives here and every cell carries its own resolved style string.
 */

import type { Point, Rect, Side } from '../model/geometry.js';
import type {
  Layer, LayoutGroup, LayoutLabel, LayoutLink, LayoutModel, LayoutPort, PathSegment,
} from '../model/layout.js';
import { orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { iconKey, iconPath } from '../profiles/network/icons.js';
import type { ThemeMode } from '../profiles/network/theme.js';
import {
  LEGEND_DEFAULT_CLASS, NETWORK_PORT_STATUS, NETWORK_THEME,
  linkClassStyle, nodeClassPaint, nodeClassStyle, portRolePaint, portRoleStyle,
} from '../profiles/network/theme.js';
import { effectiveLayer, validate } from '../score/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { CORNER_RADII, DEFAULT_STROKE_WIDTHS, OVERLAY_ENDPOINT_RADIUS, linkStrokeWidth } from '../theme/geometry.js';
import { linkVisible } from './index.js';
import { authorClass, element, num } from './svg.js';

/** Inset of a scaled icon glyph inside its measured tile, matching the SVG renderer. */
const ICON_INSET = 1.5;
/** Stroke width of an icon glyph, matching `DEFAULT_STROKE_WIDTHS.glyph`. */
const GLYPH_STROKE = DEFAULT_STROKE_WIDTHS.glyph;
/** Points closer than this in both axes are the same point, as `render` treats them. */
const EPS = 1e-6;

/** Clear space a label on its run keeps around its glyphs, so the stroke it covers stays covered. */
const LABEL_MARGIN = 5;

/** draw.io's own default label spacing, which `spacingTop` adds to rather than replaces. */
const LABEL_SPACING = 2;

/**
 * draw.io's `mxText.baseSpacingTop`: a further 5 px every top-aligned label starts below the shape,
 * on top of `spacing` and `spacingTop`. The application sets it, mxGraph's own default is 0, so a
 * label positioned from the library's formula alone lands 5 px too low. Measured against
 * drawio-desktop 31.4.5 and read back from its bundle.
 */
const BASE_SPACING_TOP = 5;

/**
 * How far an overlay connector stands off the head of a pill it leaves, so it passes over the pill
 * rather than along it. The SVG masks an overlay stroke out of every pill it would cross and mxGraph
 * has no mask, so the export routes around the pill instead — and the gap is the endpoint mark's own
 * diameter, which is the smallest clearance the overlay layer already paints. No new size is
 * invented here: it is `OVERLAY_ENDPOINT_RADIUS` read twice.
 */
const OVERLAY_PILL_CLEARANCE = 2 * OVERLAY_ENDPOINT_RADIUS;

/** The node-name size the profile uses when a label does not state its own. */
const NODE_NAME_SIZE = 9;

/** The description size the profile uses when a label does not state its own. */
const NODE_DESCRIPTION_SIZE = 7;

/** `#rrggbb` to its three channels; anything else (a name, `none`) has no channels to mix. */
function channels(colour: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (!hex) return undefined;
  const value = Number.parseInt(hex[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `over` painted at `alpha` on `under`, as one opaque colour: what a reader actually sees. */
function composite(over: string, under: string, alpha: number): string {
  const a = channels(over), b = channels(under);
  if (!a || !b) return over;
  const mix = a.map((value, index) => Math.round(value * alpha + b[index]! * (1 - alpha)));
  return `#${mix.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/** The point on `segment` nearest `at`: where a label sits when it sits on its run. */
function project(at: Point, segment: { from: Point; to: Point }): Point {
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return { ...segment.from };
  const ratio = Math.min(1, Math.max(0, ((at.x - segment.from.x) * dx + (at.y - segment.from.y) * dy) / length));
  return { x: segment.from.x + dx * ratio, y: segment.from.y + dy * ratio };
}

/** A colour draw.io will resolve, as opposed to a dash pattern or a keyword that merely looks alike. */
const isColour = (value: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(value);

/**
 * Pair every colour of two same-shaped resolutions into one `light-dark(light, dark)` value.
 *
 * This is not a nicety. draw.io does **not** leave an explicit colour alone in dark mode: it puts
 * it through `mxUtils.getInverseColor`, a lightness inversion that keeps the hue and moves
 * everything else, so a generated palette comes out wrong rather than dark. A `light-dark()` value
 * short-circuits that (`mxUtils.parseLightDarkColor`) and both sides are exact. Supported from
 * draw.io 26.0.0 (December 2024).
 *
 * Only values that really are colours are paired. A dash pattern is a string too, and
 * `dashPattern=light-dark(2 2,2 2)` would be nonsense.
 *
 * A colour the two palettes agree on is paired **anyway**, as `light-dark(x, x)`. That looks
 * redundant and is not: an unpaired colour is precisely the thing draw.io inverts, so writing white
 * once yields a dark glyph in dark mode, while writing it twice keeps it white. Measured — the
 * Cisco glyph stroke is the case that found this.
 */
function adapt<T>(light: T, dark: T): T {
  if (typeof light === 'string' && typeof dark === 'string') {
    return (!isColour(light) || !isColour(dark) ? light : `light-dark(${light},${dark})`) as T;
  }
  if (light !== null && typeof light === 'object' && dark !== null && typeof dark === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(light as object)) {
      out[key] = adapt((light as Record<string, unknown>)[key], (dark as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return light;
}

/**
 * The profile's glyphs as draw.io's own Cisco-19 shapes. These resolve from the style string alone:
 * drawio-desktop loads every bundled stencil set before it renders, so a sidebar library never has
 * to be enabled — verified against a deliberately bogus shape name, which fell back to a plain
 * rectangle while every name here drew.
 *
 * `badge` is the framed form (`shape=mxgraph.cisco19.rect` plus a `prIcon`), where `fillColor`
 * paints the frame and **`strokeColor` paints the glyph**; it replaces the tile rather than sitting
 * on it. `silhouette` is a bare stencil filled with `fillColor` and no frame.
 *
 * `width`/`height` are the shape's native proportions, and they matter: `aspect=fixed` is only a
 * hint to the editor's resize handles and does not constrain rendering, so a shape written into a
 * box of the wrong ratio is simply stretched. Each is letterboxed into its measured tile instead.
 */
const CISCO19: Readonly<Record<string, { kind: 'badge' | 'silhouette'; shape: string; width: number; height: number }>> = {
  router: { kind: 'badge', shape: 'router', width: 50, height: 50 },
  switch: { kind: 'badge', shape: 'l2_switch', width: 50, height: 50 },
  server: { kind: 'badge', shape: 'server', width: 64, height: 50 },
  cloud: { kind: 'silhouette', shape: 'cloud', width: 50, height: 30 },
};

/** The smallest box containing both. */
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** The largest box of `ratio`'s proportions that fits inside `box`, centred in it. */
function letterbox(box: Rect, ratio: { width: number; height: number }): Rect {
  const scale = Math.min(box.width / ratio.width, box.height / ratio.height);
  const width = ratio.width * scale, height = ratio.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/**
 * A label on an edge, in draw.io's own terms: `x` and `y` are relative to the drawn polyline and
 * follow it, `offset` is absolute screen pixels and does not. See `edgeLabel`.
 */
interface EdgeLabel { x: number; y: number; offset?: Point }

/** One polyline of a path, with the range of path segments it draws. */
interface Run { points: Point[]; first: number; last: number }

/** One exported connector: a run, resolved to the polyline draw.io will really draw. */
interface Connector extends Run { id: string }

/** The absolute remainder of a label's position, written only when there is one to write. */
const residualPoint = (label: EdgeLabel | undefined): string =>
  label?.offset ? element('mxPoint', { x: label.offset.x, y: label.offset.y, as: 'offset' }) : '';

/**
 * A box with room in it. draw.io accepts a negative or `NaN` size in an `mxGeometry` and then draws
 * nothing for that cell — no error, no warning, an empty group in the exported SVG — so a box that
 * cannot hold a glyph is refused here instead of being written out.
 */
const positive = (box: Rect): boolean =>
  box.width > 0 && box.height > 0 && Number.isFinite(box.x) && Number.isFinite(box.y);

/** `box` pulled in by `by` on every side, or nothing when the box is smaller than twice the inset. */
function shrink(box: Rect, by: number): Rect | undefined {
  const inner = { x: box.x + by, y: box.y + by, width: box.width - 2 * by, height: box.height - 2 * by };
  return positive(inner) ? inner : undefined;
}

/**
 * Where a native shape is drawn inside its measured tile, or nothing when the tile has no room for
 * it. A badge replaces the tile and takes the whole of it; a silhouette sits on the tile and keeps
 * the glyph inset, which is what a tile thinner than `2 × ICON_INSET` cannot give it.
 */
function glyphBox(tile: Rect, native: { kind: 'badge' | 'silhouette'; width: number; height: number }): Rect | undefined {
  const box = native.kind === 'badge' ? (positive(tile) ? tile : undefined) : shrink(tile, ICON_INSET);
  return box === undefined ? undefined : letterbox(box, native);
}

/** A side's outward direction as a fraction of a box: the point a link leaves its port from. */
const OUTWARD: Readonly<Record<Side, Point>> = {
  top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 }, right: { x: 1, y: 0.5 },
};

/** A side's outward normal: the direction a link leaves the pill on that side. */
const NORMAL: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** Whether every segment of a polyline runs along one axis, which is all a square route may hold. */
const axisAligned = (points: readonly Point[], within = EPS): boolean =>
  points.slice(1).every((point, index) =>
    Math.abs(point.x - points[index]!.x) <= within || Math.abs(point.y - points[index]!.y) <= within);

/**
 * How far a **drawn** endpoint may sit off its segment's axis and still count as a square route.
 *
 * The waypoints are square or they are not, and that is tested exactly. The two ends are not
 * waypoints: draw.io resolves them from the terminal cell's own box, and the export puts a pill's
 * outward midpoint up to half a pixel off the model's stem axis — a defect with its own ticket,
 * present under `edgeStyle=none` as well. Both styles draw that residue at the same size: the
 * orthogonal router as a half-pixel jog, `edgeStyle=none` as a half-pixel diagonal, and the measured
 * 0.51 px worst case is exactly it. Anything larger is a real corner, and there the router would
 * invent a turn nothing reserved — so the link keeps `edgeStyle=none` and the line is drawn as
 * stated. A port that draws no pill and terminates on its node's box is the case that needs this.
 */
const SQUARE_ENDPOINT_TOLERANCE = 1;

/** The walked length of a polyline. */
const polylineLength = (points: readonly Point[]): number =>
  points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);

/**
 * How many connection points one side may offer beyond its real anchors. This is a guard against a
 * pitch that has no sensible relation to its side, not a budget: the widest node in the measured
 * corpus asks for about seventy points on its long side, and a pitch of 1e-8 on a 55 px side asks
 * for 5.5 billion. Anything below the bound is written in full.
 */
const MAX_SIDE_ANCHORS = 512;

/** How finely two anchors must agree before they count as slots of the same reserved run. */
const PHASE_GRAIN = 1e-4;

/**
 * The offset the most anchors agree on, modulo the pitch — the reserved run the side really holds.
 *
 * A later rule may move a single anchor off that run, and then the anchors no longer share one
 * phase. The run the rest of them still stand on is the grid; the moved anchor keeps its own
 * explicit connection point and nothing else moves with it. Ties go to the lowest offset, so one
 * anchor on each of two runs gives a deterministic answer rather than an arbitrary one.
 */
function modalPhase(offsets: readonly number[], pitch: number): number {
  const sorted = offsets.map(offset => {
    // `offset % pitch` already has the magnitude wanted and the sign of `offset`, so only a
    // negative one needs the pitch added. Adding it to every residue and taking the remainder
    // again overflows to Infinity, and then to NaN, for an offset near the top of the range.
    const rest = offset % pitch;
    return { offset, residue: rest < 0 ? rest + pitch : rest };
  }).sort((left, right) => left.residue - right.residue || left.offset - right.offset);
  // Grouped by proximity, never by a rounding key. A key splits two residues that straddle a bucket
  // edge however close they are, and the case this has to hold together is exactly a run whose
  // anchors differ by a float ulp. Each residue joins the run before it while it is within the
  // grain of it, so a run is a chain rather than a bucket.
  const runs: { phase: number; count: number; low: number; high: number }[] = [];
  for (const item of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && item.residue - last.high <= PHASE_GRAIN) {
      last.count += 1;
      last.phase = Math.min(last.phase, item.offset);
      last.high = item.residue;
    } else runs.push({ phase: item.offset, count: 1, low: item.residue, high: item.residue });
  }
  // A residue just below the pitch and one just above zero name the same run, one whole pitch apart.
  // The gap that closes runs from the last run's **highest** residue to the first run's **lowest**.
  const first = runs[0]!, last = runs[runs.length - 1]!;
  if (runs.length > 1 && pitch - last.high + first.low <= PHASE_GRAIN) {
    first.count += last.count;
    first.phase = Math.min(first.phase, last.phase);
    runs.pop();
  }
  let best = runs[0]!;
  for (const run of runs) {
    if (run.count > best.count || (run.count === best.count && run.phase < best.phase)) best = run;
  }
  return best.phase;
}

/**
 * The reserved-slot grid of one side, less the slots its ports already hold. `offsets` are the real
 * anchors measured along the side from its low end, and the result is measured the same way.
 *
 * The pipeline does not count slots from a corner. `rebuildNodeGeometry` centres them, at
 * `(length − (ports − 1) × pitch) / 2 + index × pitch`, so consecutive slots are one pitch apart but
 * the run as a whole is centred on the side. The grid is therefore the real anchors, continued by
 * whole pitches in **both** directions to the ends of the side. Start it at a corner instead and
 * every offered point misses every real port by the same fraction of a pitch — which is the one
 * thing the grid promises not to do.
 */
function sideGrid(offsets: readonly number[], along: number, pitch: number): number[] {
  if (!(along > 0) || !(pitch > 0) || !Number.isFinite(along) || !Number.isFinite(pitch)) return [];
  // An anchor off its own side is geometry `rebuildNodeGeometry` refuses outright, and it carries no
  // phase worth keeping. With none left, the slot the pipeline reserves for a single port is the
  // middle of the side.
  const on = offsets.filter(offset => offset >= -EPS && offset <= along + EPS);
  const phase = on.length > 0 ? modalPhase(on, pitch) : along / 2;
  if (!Number.isFinite(phase)) return [];
  const first = Math.ceil(-phase / pitch - EPS), last = Math.floor((along - phase) / pitch + EPS);
  const count = last - first + 1;
  if (!(count >= 1) || count > MAX_SIDE_ANCHORS) return [];
  const grid: number[] = [];
  // Counted, and each point indexed from the phase. Neither `at` nor `step` may be accumulated: past
  // 2^53 a sum stops advancing — `at + pitch === at`, and `step + 1 === step` — and a loop that
  // tests the accumulator then runs for ever. Only `index` is small enough to be trusted to grow.
  for (let index = 0; index < count; index += 1) {
    const raw = phase + (first + index) * pitch;
    if (!Number.isFinite(raw) || raw < -EPS || raw > along + EPS) continue;
    // A point within a rounding error of an end **is** that end. Two sides share a corner, and
    // they agree on it only if both name it exactly: `120.99999999999999` and `121` are one corner
    // to a reader and two connection points to draw.io. Snapped before the slot is tested for a
    // port, so a point that lands on an anchor once snapped is dropped rather than offered beside it.
    const at = raw < EPS ? 0 : raw > along - EPS ? along : raw;
    if (on.some(offset => Math.abs(offset - at) <= EPS)) continue;
    grid.push(at);
  }
  return grid;
}

export interface DrawioOptions {
  /** Effective link families to export; see `RenderOptions.layers`, whose rule this shares. */
  layers?: readonly Layer[];
  /**
   * Where a link label sits. `measured` keeps the box stage 9 placed, beside its run, which is what
   * the SVG draws. `on-run` centres it on the supporting segment instead and gives it the backdrop
   * behind it as a fill, so it costs a crowded diagram no room beside the line. `on-run` is the one
   * deliberate departure from the measured geometry, and it moves a label only — never a route.
   */
  labels?: 'measured' | 'on-run';
  /**
   * Which glyphs the icons use. `cisco19`, the default, uses draw.io's bundled Cisco-19 shapes
   * where one matches. They resolve from the style string alone and take paired `light-dark()`
   * colours, so they follow draw.io's dark appearance. `profile` draws the network profile's own
   * five, as the SVG does, as an embedded `shape=image` data URI, which cannot adapt at all.
   */
  icons?: 'cisco19' | 'profile';
  /**
   * Which palette the file carries. `auto`, the default, writes every colour as a
   * `light-dark(light, dark)` pair and lets draw.io pick — one file that is exact in both
   * appearances. Naming a mode pins the file to that one palette instead, which is what a reader
   * older than draw.io 26.0.0 needs, and the only way to get `print`.
   */
  theme?: ThemeMode | 'auto';
}

type StyleValue = string | number | undefined;

/**
 * A style string: leading named tokens, then `key=value` pairs. draw.io splits pairs on `;` and
 * then on the first `=`, so a value may hold `=` but never `;`.
 */
function styleString(tokens: readonly string[], entries: Readonly<Record<string, StyleValue>>): string {
  const parts = tokens.filter(token => token !== '');
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === 'number' ? num(value) : value}`);
  }
  return parts.length ? `${parts.join(';')};` : '';
}

const HTML = /[&<>]/g;
const HTML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Label text for a cell carrying `html=1`. The value is HTML-escaped here and XML-escaped again by
 * the attribute serializer, because draw.io assigns the XML-decoded string to `innerHTML`: text
 * escaped only once loses everything between a `<` and the next `>`.
 */
const htmlText = (lines: readonly string[]): string =>
  lines.map(line => line.replace(HTML, character => HTML_ENTITIES[character]!)).join('<br>');

/** One measured label of a node's own text, in the form draw.io lays text out in. */
interface TextBlock {
  /** The block's lines, HTML-escaped and joined the way a cell value joins them. */
  html: string;
  /** The pitch stage 9 put between two lines of this label, which is also its CSS `line-height`. */
  pitch: number;
  /** Where the block's first line box has to start for its baseline to land on the measured one. */
  top: number;
  /** One pitch per line: the box the next block is placed below, whatever the lines then do. */
  height: number;
  fontSize: number;
  fontWeight: 400 | 700;
  /** Stated only when the block does not take the cell's own `fontColor`. */
  colour?: string;
}

/**
 * A quantity a model states, or one derived from it, kept finite: no draw.io attribute can carry an
 * infinity, and a model far outside the contract is better exported than refused.
 */
const finite = (value: number): number => Number.isFinite(value) ? value : 0;

/**
 * A measured label as a draw.io text block, or nothing when the label draws no line.
 *
 * draw.io lays a label out as CSS line boxes, and a CSS line box centres its glyphs in the leading:
 * the baseline sits half a leading plus one ascent below the box top. The pipeline puts the first
 * baseline exactly one ascent below the box it measured, with all the leading underneath. So the
 * block states the pipeline's own line pitch as `line-height` — which also keeps a wrapped label's
 * further lines at the measured pitch — and starts half a leading higher, which puts every baseline
 * back where stage 9 measured it. Measured against drawio-desktop 31.4.5.
 *
 * The font table supplies the leading and the model supplies the box, which is the division of
 * labour `render` already uses to put a baseline inside a measured label. Nothing here sizes,
 * moves or grows anything: the same box is expressed in draw.io's own layout language. The table is
 * read for one pixel of type and scaled, so a model that states an absurd font size is exported
 * rather than refused.
 */
function textBlock(label: LayoutLabel, size: number, weight: 400 | 700, colour?: string): TextBlock | undefined {
  const lines = label.lines ?? (label.text === '' ? [] : [label.text]);
  if (lines.length === 0) return undefined;
  const fontSize = finite(label.fontSize ?? size);
  // The model knows two weights. Anything else is out of contract and reads as the regular one.
  const fontWeight = (label.fontWeight ?? weight) === 700 ? 700 : 400;
  const unit = measureText('', { fontSize: 1, weight: fontWeight });
  const glyphs = finite((unit.ascent + unit.descent) * fontSize);
  // A pitch is a length. A negative or infinite one is not CSS, and the arithmetic below and the
  // browser have to agree, so both use the clamped value.
  const pitch = Math.max(0, finite(label.lineHeight ?? label.bounds!.height / lines.length));
  return {
    html: htmlText(lines), pitch, top: finite(label.bounds!.y - (pitch - glyphs) / 2),
    height: finite(pitch * lines.length), fontSize, fontWeight,
    ...(colour === undefined ? {} : { colour }),
  };
}

/**
 * The blocks as one cell value: a `<div>` each, stacked by the gaps the pipeline measured.
 *
 * One `<div>` per block rather than one run of `<br>`-separated spans, because a block carries its
 * own weight, size and line pitch, and a `<span>` inside a shared line inherits the cell's weight —
 * which is how a 400-weight description came out bold beside a 700-weight name.
 *
 * Each block states its measured height as well as its pitch. A browser counts line boxes its own
 * way — a trailing `<br>` opens none — so the block that follows is placed below the height stage 9
 * measured, and never below a height the text happened to occupy.
 */
function blockValue(blocks: readonly TextBlock[]): string {
  return blocks.map((block, index) => {
    const previous = blocks[index - 1];
    const margin = previous === undefined ? undefined
      : finite(block.top - (previous.top + previous.height));
    return `<div style="line-height:${num(block.pitch)}px;height:${num(block.height)}px;`
      + `font-size:${num(block.fontSize)}px;font-weight:${block.fontWeight}`
      + (block.colour === undefined ? '' : `;color:${block.colour}`)
      + (margin === undefined ? '' : `;margin-top:${num(margin)}px`)
      + `">${block.html}</div>`;
  }).join('');
}

/** A data URI draw.io can use as an image, with no `;` or `=` to break the style string. */
const svgImage = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/**
 * The body colour of the outlined port role, which `portRolePaint` states as `fill: 'none'`.
 *
 * A pill is opaque. In the SVG the outlined pill shows the node body through it — a pill straddles
 * its node's edge, and the theme paints the body behind the inner half — and the overlay mask keeps
 * every other stroke off the box. mxGraph has neither: `fillColor=none` there is a hole through
 * which the connector the pill ends, and the group tint under it, both read. So the export paints
 * the colour the SVG reveals, the node body background of the same mode, and the two agree on what
 * a reader sees. Paired by `dual()` like every other colour, so both appearances stay exact.
 */
const outlinedFill = (of: ThemeMode): string => NETWORK_THEME[of].node.fill;

const centre = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

/** A rectangle expressed from another rectangle's top-left, as every child geometry must be. */
const relative = (box: Rect, origin: Point): Rect =>
  ({ x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height });

/**
 * One component of a cell id, with the separator escaped so it cannot be produced by an author's
 * own identifier. Ids are built by concatenation, and draw.io neither rejects nor reports a
 * duplicate — it keeps one cell and drops the other — so the scheme has to be injective by
 * construction: `pg-<kind>~<part>~<part>`, where no kind holds a `~` and no part can grow one.
 */
const part = (value: string): string => value.replace(/[%~]/g, character => `%${character.charCodeAt(0).toString(16)}`);
const cellId = (kind: string, ...parts: readonly string[]): string =>
  parts.length ? `pg-${kind}~${parts.map(part).join('~')}` : `pg-${kind}`;

/** The tokens an author put on a port: a role, a status and any free text, in any order. */
const portTokens = (port: LayoutPort): string[] => (authorClass(port.class) ?? '').split(/\s+/).filter(Boolean);

export function drawio(layout: LayoutModel, options: DrawioOptions = {}): string {
  validate(layout);
  const canvas = layout.canvas;
  if (!canvas) throw new Error('A draw.io export requires a final canvas');
  const chosen = options.theme ?? 'auto';
  const adaptive = chosen === 'auto';
  const mode: ThemeMode = adaptive ? 'light' : chosen;
  const placement = options.labels ?? 'on-run';
  const iconSet = options.icons ?? 'cisco19';
  /** One resolution of something the palette decides, adapted to both appearances when asked. */
  const dual = <T,>(pick: (of: ThemeMode) => T): T => adaptive ? adapt(pick('light'), pick('dark')) : pick(mode);
  const paint = dual(of => NETWORK_THEME[of]);
  const document = layout.document;
  const visible = (link: LayoutLink): boolean =>
    linkVisible(layout, link, options.layers ? { layers: options.layers } : {});

  // The canvas may start left of or above the origin; draw.io pages start at zero, so the whole
  // document is shifted once, here, and every coordinate below is already in page space.
  const shift = (point: Point): Point => ({ x: point.x - canvas.x, y: point.y - canvas.y });
  const shiftRect = (box: Rect): Rect => ({ ...shift(box), width: box.width, height: box.height });

  const cells: string[] = [];
  const claimed = new Set<string>();
  /**
   * Every id passes through here. A collision is silent corruption in draw.io, and the loss is
   * whichever cell it decides to drop, so it is refused at the source instead.
   */
  const claim = (id: string): string => {
    if (claimed.has(id)) throw new Error(`A draw.io export cannot reuse the cell id ${id}`);
    claimed.add(id);
    return id;
  };
  const vertex = (id: string, parent: string, style: string, box: Rect, value?: string,
    extra: Readonly<Record<string, StyleValue>> = {}): void => {
    cells.push(element('mxCell', { id: claim(id), value, style, vertex: 1, parent, ...extra },
      element('mxGeometry', { x: box.x, y: box.y, width: box.width, height: box.height, as: 'geometry' })));
  };

  /** A text cell placed at exactly the box stage 9 measured, so no label is re-flowed on open. */
  const textCell = (id: string, parent: string, label: LayoutLabel, box: Rect, colour: string): void => {
    // A label's `bounds` is already the rotated box and the model keeps no unrotated size, so the
    // angle is reproduced the way the SVG renderer reproduces it: the text is laid out unclipped
    // about the box centre and then turned. `rotation` is clockwise-positive in both formats, and
    // it takes every reserved angle — a straight bundle member's label is rotated to its own run
    // (ADR-0017), not to a quarter turn.
    vertex(id, parent, styleString(['text'], {
      html: 1, strokeColor: 'none', fillColor: 'none', align: 'center', verticalAlign: 'middle',
      whiteSpace: 'nowrap', overflow: 'visible', points: '[]', resizable: 0,
      fontFamily: FONT_FAMILY, fontSize: label.fontSize, fontColor: colour,
      fontStyle: label.fontWeight === 700 ? 1 : undefined,
      rotation: label.textRotation ? label.textRotation : undefined,
    }), box, htmlText(label.lines ?? [label.text]));
  };

  // ---- paint resolution -------------------------------------------------------------------
  // There is no resolved paint on the model: the SVG renderer states the palette as a class
  // cascade and lets the reader resolve it. A draw.io cell carries its own colours, so the same
  // cascade is walked here, in the sheet's own order — base, then node class, then port role,
  // then port status — because a later rule of equal specificity wins there.

  const nodeClassOf = (id: string): string | undefined => authorClass(document.nodes[id]?.class);

  const pillPaintIn = (of: ThemeMode, nodeClass: string | undefined, port: LayoutPort):
  { fill: string; stroke: string; text: string; dash: string | undefined; opacity: number | undefined } => {
    let result = { ...NETWORK_THEME[of].pill, dash: undefined as string | undefined, opacity: undefined as number | undefined };
    const known = nodeClassStyle(nodeClass);
    if (known) result = { ...result, ...nodeClassPaint(known, of).pill };
    for (const token of portTokens(port)) {
      const role = portRoleStyle(token);
      if (!role) continue;
      const rolePaint = portRolePaint(role, of);
      result = rolePaint.stroke === undefined
        ? { ...result, fill: rolePaint.fill, text: rolePaint.text }
        : { ...result, fill: outlinedFill(of), stroke: rolePaint.stroke };
    }
    for (const token of portTokens(port)) {
      const status = NETWORK_PORT_STATUS.find(([name]) => name === token)?.[1];
      if (!status) continue;
      if (status.kind === 'fade') { result = { ...result, opacity: status.opacity }; continue; }
      result = {
        ...result, stroke: status.stroke[of],
        dash: status.dash ? status.dash[of] : result.dash,
        fill: status.fill ? status.fill[of] : result.fill,
        text: status.text ? status.text[of] : result.text,
      };
    }
    return result;
  };
  const pillPaint = (nodeClass: string | undefined, port: LayoutPort): ReturnType<typeof pillPaintIn> =>
    dual(of => pillPaintIn(of, nodeClass, port));

  /** A dash pattern the model states in absolute pixels; `fixDash` stops draw.io scaling it. */
  const dashEntries = (dash: string | undefined): Readonly<Record<string, StyleValue>> =>
    dash === undefined || dash === 'none' ? {} : { dashed: 1, fixDash: 1, dashPattern: dash };

  // ---- layers -----------------------------------------------------------------------------
  // mxGraph paints in tree order and a container paints with its children, so the SVG renderer's
  // z-order cannot be reproduced cell by cell: a group box must sit under the links and its own
  // nodes over them, and those are one subtree. Layers carry what can be carried.
  //
  // Everything therefore paints above the group boxes. That is the right way round — between 45%
  // and 63% of routed length runs inside a group box on the measured diagrams, and the group fill
  // is translucent, so links underneath would be washed out rather than merely re-ordered. The
  // same reasoning puts the overlay layer above the diagram: below it, an overlay stroke is all
  // but invisible. The SVG masks overlay strokes out of the boxes they would obscure; mxGraph has
  // no mask, so they are drawn over instead of under.
  const LAYERS = ['canvas', 'diagram', 'overlay', 'links', 'labels', 'legend'] as const;
  const LAYER_NAMES: Readonly<Record<(typeof LAYERS)[number], string>> = {
    canvas: 'Canvas', overlay: 'Overlay', diagram: 'Diagram', links: 'Links', labels: 'Labels', legend: 'Legend',
  };
  const layerId = (name: (typeof LAYERS)[number]): string => cellId('layer', name);

  // The SVG paints the canvas as a rectangle rather than leaving it to the reader, and so does
  // this. The page `background` is an *attribute*, and jgraph's schema pins that to a plain colour,
  // so an attribute alone would leave the backdrop to draw.io's own inversion while every other
  // colour in the file is exact — and a label's backdrop fill would then not match what is behind
  // it. The rectangle is inert: it takes no pointer events and is locked, so it is backdrop rather
  // than furniture.
  vertex(cellId('canvas'), layerId('canvas'), styleString([], {
    html: 1, fillColor: paint.background, strokeColor: 'none', points: '[]',
    pointerEvents: 0, locked: 1, movable: 0, resizable: 0, deletable: 0, editable: 0, connectable: 0,
  }), { x: 0, y: 0, width: canvas.width, height: canvas.height });

  // ---- groups and their nodes ---------------------------------------------------------------
  const groupTitle = (group: LayoutGroup): LayoutLabel | undefined =>
    layout.labels.find(label => label.role === 'group' && !label.omitted
      && label.owner.kind === 'group' && label.owner.id === group.id);

  for (const id of orderedGroupIds(document)) {
    const group = layout.groups[id]!;
    const box = shiftRect(group.bounds!);
    const band = layout.labelBands.find(item => item.group === id);
    const title = groupTitle(group);
    // A swimlane's title is its own value, which is what makes the group editable as a group. The
    // band is only handed to draw.io when the reserved band really does hold a centred title:
    // otherwise the title keeps its measured box as a text cell and the container stays plain.
    const centred = band !== undefined && title !== undefined
      && Math.abs(centre(title.bounds!).x - centre(band.bounds).x) <= 0.5
      && Math.abs(centre(title.bounds!).y - centre(band.bounds).y) <= 0.5;
    const swimlane = centred ? band! : undefined;
    const style = swimlane
      ? styleString(['swimlane'], {
        html: 1, whiteSpace: 'nowrap', container: 1, collapsible: 0, rounded: 1,
        absoluteArcSize: 1, arcSize: CORNER_RADII.group * 2,
        horizontal: 1, startSize: swimlane.bounds.height,
        // `flipV` mirrors the shape paths only — the label group is rendered outside the flip, so
        // a bottom band keeps upright text, which `direction=south` would not.
        flipV: swimlane.side === 'bottom' ? 1 : undefined,
        align: 'center', verticalAlign: 'middle',
        fontFamily: FONT_FAMILY, fontSize: title!.fontSize, fontColor: paint.group.text,
        fontStyle: title!.fontWeight === 700 ? 1 : undefined,
        swimlaneLine: 0,
        // On a swimlane `fillColor` paints the head and `swimlaneFillColor` the body, the reverse
        // of what the format's own style reference says. Both take the group fill.
        fillColor: paint.group.fill, swimlaneFillColor: paint.group.fill,
        strokeColor: paint.group.stroke, fillOpacity: Math.round(paint.group.fillOpacity * 100),
      })
      : styleString([], {
        html: 1, container: 1, collapsible: 0, rounded: 1,
        absoluteArcSize: 1, arcSize: CORNER_RADII.group * 2,
        fillColor: paint.group.fill, strokeColor: paint.group.stroke,
        fillOpacity: Math.round(paint.group.fillOpacity * 100),
        verticalAlign: 'top', align: 'center',
      });
    vertex(cellId('group', id), layerId('diagram'), style, box, swimlane ? htmlText(title!.lines ?? [title!.text]) : undefined);
    if (title && !swimlane) {
      textCell(cellId('groupTitle', id), cellId('group', id), title,
        relative(shiftRect(title.bounds!), box), paint.group.text);
    }
  }

  for (const id of orderedNodeIds(document)) {
    const node = layout.nodes[id]!;
    const group = cellId('group', document.nodes[id]!.group);
    const box = shiftRect(node.bounds!);
    const origin = shift(layout.groups[document.nodes[id]!.group]!.bounds!);
    const authored = nodeClassOf(id);
    // Every port anchor is mirrored into `points=` so the editor offers the anchors the pipeline
    // actually used. It constrains nothing — the edges pin themselves — but without it a user
    // dragging a new connector gets draw.io's four default anchors instead of this node's ports.
    // A `Set` because two sides meet at a corner and would each offer it, and a real anchor on a
    // corner would be offered again by the next side's grid. Insertion order is kept, so a real
    // anchor is always the one that stays and the grid point is the copy that goes.
    const anchors = new Set(node.ports.filter(port => port.anchor !== undefined).map(port => {
      const at = port.anchor!;
      return `[${num((at.x - node.bounds!.x) / node.bounds!.width)},`
        + `${num((at.y - node.bounds!.y) / node.bounds!.height)},0]`;
    }));
    // Beyond the ports in use, each side offers the rest of its own grid: the slots `sidePitch`
    // divides that side into, in the phase the pipeline reserved them in. A hand-placed pill or a
    // hand-drawn connector then lands where the pipeline would have put one, instead of wherever
    // the pointer was. See `sideGrid` for why the phase is the anchors and not the corner.
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const pitch = node.sidePitch?.[side];
      if (pitch === undefined) continue;
      const horizontal = side === 'top' || side === 'bottom';
      const along = horizontal ? node.bounds!.width : node.bounds!.height;
      const base = horizontal ? node.bounds!.x : node.bounds!.y;
      const fixed = side === 'left' || side === 'top' ? 0 : 1;
      const offsets = node.ports.filter(port => port.side === side && port.anchor !== undefined)
        .map(port => (horizontal ? port.anchor!.x : port.anchor!.y) - base);
      for (const at of sideGrid(offsets, along, pitch)) {
        const fraction = at / along;
        anchors.add(horizontal
          ? `[${num(fraction)},${num(fixed)},0]` : `[${num(fixed)},${num(fraction)},0]`);
      }
    }
    // The node's name is the node's own label, and its description follows it in the same label:
    // a shape carries its text in draw.io, and a reader who double-clicks the node expects to be
    // renaming the node. The description is a styled block rather than a second cell, and its
    // colour is a CSS `light-dark()` so it adapts with everything else.
    const named = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'node' && !item.omitted);
    const described = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'description' && !item.omitted);
    // A node may carry a description and no name, so the geometry and the base font come from the
    // first block that draws, whichever it is, and not from the name.
    const blocks = [
      named === undefined ? undefined : textBlock(named, NODE_NAME_SIZE, 700),
      described === undefined ? undefined : textBlock(described, NODE_DESCRIPTION_SIZE, 400, paint.node.description),
    ].filter((block): block is TextBlock => block !== undefined);
    const text = blockValue(blocks);
    // Stage 3 sized the box around these blocks and stage 9 measured where they sit. `spacingTop`
    // states that offset, and it is stated in full: draw.io adds `spacing` and its own
    // `baseSpacingTop` to it, so a label that names only the measured offset lands 7 px low.
    const first = blocks[0];
    const top = first === undefined ? undefined
      : finite(first.top - node.bounds!.y - BASE_SPACING_TOP - LABEL_SPACING);
    vertex(cellId('node', id), group, styleString([], {
      // A node really does contain its ports and its icon, so it says so: a container moves,
      // copies and accepts a drop as one thing, which is what a node is.
      html: 1, container: 1, collapsible: 0, recursiveResize: 0,
      rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.node * 2,
      whiteSpace: 'nowrap', fillColor: paint.node.fill, strokeColor: paint.node.stroke,
      strokeWidth: node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node,
      points: `[${[...anchors].join(',')}]`,
      ...(text === '' ? {} : {
        align: 'center', verticalAlign: 'top', overflow: 'visible',
        // The offset is signed. draw.io honours a negative `spacingTop` — measured — and a node
        // whose first line starts within 7 px of its top edge needs one.
        spacingTop: top,
        fontFamily: FONT_FAMILY, fontSize: first?.fontSize, fontColor: paint.node.text,
        fontStyle: first?.fontWeight === 700 ? 1 : undefined,
      }),
    }), relative(box, origin), text === '' ? undefined : text);

    if (node.icon) {
      const tile = relative(shiftRect(node.icon.bounds), shift(node.bounds!));
      const pick = (of: ThemeMode): { tile: { fill: string; stroke: string }; glyph: string } => {
        const known = nodeClassStyle(authored);
        return known ? nodeClassPaint(known, of) : { tile: NETWORK_THEME[of].tile, glyph: NETWORK_THEME[of].glyph };
      };
      const resolved = dual(pick);
      const native = iconSet === 'cisco19' ? CISCO19[iconKey(node.icon.icon)] : undefined;
      if (native) {
        // A badge carries its own frame, so it replaces the tile; a silhouette keeps it.
        if (native.kind === 'silhouette' && positive(tile)) {
          vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
            html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
            fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
          }), tile);
        }
        // A tile with no room for the glyph inset leaves the glyph out. Subtracting the inset from
        // a tile thinner than it gives a negative width, which draw.io writes and then draws as
        // nothing at all — so the whole icon would go, silently, rather than just the inset.
        const box = glyphBox(tile, native);
        if (box) {
          vertex(cellId('icon', id), cellId('node', id), styleString([], {
            sketch: 0, html: 1, aspect: 'fixed', points: '[]',
            shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
            ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
            // On a badge `fillColor` is the frame and `strokeColor` is the glyph; a silhouette is
            // filled with the glyph colour and has no frame to stroke.
            fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
            strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
          }), box);
        }
      } else {
        if (positive(tile)) {
          vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
            html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
            fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
          }), tile);
        }
        // A profile glyph is a stroked 24-unit path with no bundled equivalent, so it is carried as
        // its own image. An embedded image is the one thing here that cannot adapt to dark — draw.io
        // has no way into it — which is the reason `cisco19` is the default.
        const inner = shrink(tile, ICON_INSET);
        if (inner) {
          const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
            + `<path d="${iconPath(node.icon.icon)}" fill="none" stroke="${pick(mode).glyph}"`
            + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
          vertex(cellId('icon', id), cellId('node', id), styleString([], {
            shape: 'image', html: 1, imageAspect: 0, points: '[]',
            image: svgImage(glyph),
          }), inner);
        }
      }
    }



    for (const port of node.ports) {
      if (!port.pill || port.ref.anonymous === true) continue;
      const identity = [id, port.ref.name!, String(port.ref.ordinal)];
      const resolved = pillPaint(authored, port);
      // The editor offers the one anchor this port's links leave from, so a connector a user draws
      // by hand starts where every exported connector starts.
      const outward = port.side ? OUTWARD[port.side] : undefined;
      const label = layout.labels.find(item => item.role === 'pill' && item.port !== undefined
        && item.port.node === id && item.port.name === port.ref.name && item.port.ordinal === port.ref.ordinal);
      const shown = label && !label.omitted ? label : undefined;
      // The pill's name is the pill's own label, not a text box parked on top of it: one cell that
      // moves, copies and is renamed as one thing. A quarter turn is `horizontal=0`, which is how a
      // vertical pill reads in the SVG too.
      //
      // `horizontal=0` is the only turn a vertex's own label takes on its own: measured against
      // drawio-desktop 31.4.5, it turns the label −90 and leaves the shape where it is, while
      // `rotation=` turns the shape and carries the label round with it. A pill needs no other
      // angle — `PillGeometry.textRotation` is `-90 | 0`, and `placePortPill` is its one producer,
      // which sets −90 on a top or bottom side and 0 on a left or right one. Were +90 ever
      // reserved it would be `horizontal=0` **and** `rotation=180`: the two compose, and a pill is
      // a rounded rectangle of uniform radius, fill and stroke, so a half turn of the shape is
      // invisible. Also measured.
      vertex(cellId('port', ...identity), cellId('node', id), styleString([], {
        html: 1, rounded: 1, absoluteArcSize: 1, arcSize: port.pill.radius * 2,
        fillColor: resolved.fill, strokeColor: resolved.stroke,
        strokeWidth: DEFAULT_STROKE_WIDTHS.pill,
        points: outward ? `[[${num(outward.x)},${num(outward.y)},0]]` : '[]',
        // A pill dragged loose snaps back onto one of the node's connection points, which are the
        // port anchors the pipeline itself allocated — so a hand edit lands on the grid the layout
        // reserved rather than near it.
        snapToPoint: 1,
        opacity: resolved.opacity === undefined ? undefined : Math.round(resolved.opacity * 100),
        ...dashEntries(resolved.dash),
        ...(shown ? {
          verticalAlign: 'middle', align: 'center', whiteSpace: 'nowrap', overflow: 'visible',
          fontFamily: FONT_FAMILY, fontSize: shown.fontSize, fontColor: resolved.text,
          fontStyle: shown.fontWeight === 700 ? 1 : undefined,
          horizontal: port.pill.textRotation === -90 ? 0 : undefined,
        } : {}),
      }), relative(shiftRect(port.pill.bounds), shift(node.bounds!)),
      shown ? htmlText(shown.lines ?? [shown.text]) : undefined);
    }
  }

  // ---- links --------------------------------------------------------------------------------
  const byId = new Map(layout.links.map(link => [link.id, link]));
  const linkClass = (link: LayoutLink): string | undefined => {
    const value = document.links[link.sourceIndex]?.class;
    return value === '' ? undefined : authorClass(value);
  };

  /**
   * The polylines a path draws: one per run of segments whose ends meet, as `pathData` splits.
   * Each run keeps the range of path segments it covers, because a label names its supporting
   * segment and has to be attached to the connector that really draws that segment.
   */
  function polylines(segments: readonly PathSegment[]): Run[] {
    const runs: Run[] = [];
    let current: Run | undefined;
    for (const [index, segment] of segments.entries()) {
      if (!current || !samePoint(current.points[current.points.length - 1]!, segment.from)) {
        current = { points: [segment.from], first: index, last: index };
        runs.push(current);
      }
      current.points.push(segment.to);
      current.last = index;
    }
    return runs.filter(run => run.points.length > 1)
      .map(run => ({ ...run, points: run.points.map(shift) }));
  }

  /**
   * Where an edge terminates, and on which cell. A port that draws a pill terminates on the **pill**,
   * at the middle of its outward edge, for two reasons. It makes the connector a real connection:
   * the pill is the port, so moving the port or its node carries the line, which pinning to the
   * node's box never did. And it is what the SVG makes visible — a pill straddles the boundary and
   * is painted over the inner half of its own stem, so the stroke the reader sees starts at the
   * pill's outer edge. The reserved waypoints are untouched; only the endpoint moves, by the pill's
   * half depth, onto the point the diagram already showed.
   */
  const terminal = (end: 'exit' | 'entry', ref: { node: string; name?: string; ordinal: number }):
  { cell: string; style: Readonly<Record<string, StyleValue>>; at: Point } | undefined => {
    const node = layout.nodes[ref.node];
    const port = node?.ports.find(item => item.ref.node === ref.node && item.ref.name === ref.name
      && item.ref.ordinal === ref.ordinal);
    if (!node?.bounds || !port?.anchor) return undefined;
    // Both fractions must be present or draw.io drops the constraint entirely, and `exitPerimeter`
    // defaults to 1, which would project the point onto the perimeter instead of using it.
    const fix = (at: Point): Readonly<Record<string, StyleValue>> =>
      ({ [`${end}X`]: at.x, [`${end}Y`]: at.y, [`${end}Dx`]: 0, [`${end}Dy`]: 0, [`${end}Perimeter`]: 0 });
    // `at` is where draw.io really puts the endpoint: the constraint fraction resolved against the
    // terminal cell's own box. The exported waypoints do not hold it, and an edge label is stated
    // relative to the whole drawn polyline, terminals included, so it has to be known here.
    if (port.pill && port.ref.anonymous !== true && port.side) {
      const pill = port.pill.bounds, outward = OUTWARD[port.side];
      return {
        cell: cellId('port', ref.node, ref.name!, String(ref.ordinal)), style: fix(outward),
        at: shift({ x: pill.x + outward.x * pill.width, y: pill.y + outward.y * pill.height }),
      };
    }
    return { cell: cellId('node', ref.node), style: fix({
      x: (port.anchor.x - node.bounds.x) / node.bounds.width,
      y: (port.anchor.y - node.bounds.y) / node.bounds.height,
    }), at: shift(port.anchor) };
  };

  /**
   * The pill a link ends on, in page space: its cell, its box, the point on its outward edge the
   * connector really starts from, and the direction that edge faces. Nothing here is measured — the
   * box is the one stage 9 reserved and the outward point is the one `terminal` already pins to.
   */
  interface PillEnd { cell: string; box: Rect; at: Point; out: Point }
  const pillEnd = (ref: { node: string; name?: string; ordinal: number }): PillEnd | undefined => {
    const port = layout.nodes[ref.node]?.ports.find(item => item.ref.node === ref.node
      && item.ref.name === ref.name && item.ref.ordinal === ref.ordinal);
    if (!port?.pill || port.ref.anonymous === true || !port.side) return undefined;
    const box = shiftRect(port.pill.bounds), outward = OUTWARD[port.side];
    return {
      cell: cellId('port', ref.node, ref.name!, String(ref.ordinal)), box,
      at: { x: box.x + outward.x * box.width, y: box.y + outward.y * box.height },
      out: NORMAL[port.side],
    };
  };

  /** Whether an axis-aligned segment reaches inside `box`, rather than only touching its edge. */
  const enters = (from: Point, to: Point, box: Rect): boolean =>
    Math.max(from.x, to.x) > box.x + EPS && Math.min(from.x, to.x) < box.x + box.width - EPS
    && Math.max(from.y, to.y) > box.y + EPS && Math.min(from.y, to.y) < box.y + box.height - EPS;

  /** A polyline with no repeated point, so a degenerate corner leaves no zero-length segment. */
  const compact = (points: readonly Point[]): Point[] =>
    points.filter((point, index) => index === 0 || !samePoint(points[index - 1]!, point));

  /**
   * The same polyline with every point that turns nothing dropped; for a detour candidate only.
   * A point is dropped when it lies **between** its two neighbours on one axis, which a point that
   * doubles back does not — so a candidate that reverses over its own pill keeps the reversal and is
   * refused by the box test rather than straightened into something it is not.
   */
  const straighten = (points: readonly Point[]): Point[] => {
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
  };

  /**
   * An overlay connector routed **around** the two pills it joins instead of along them: out of the
   * source pill's head by `OVERLAY_PILL_CLEARANCE`, across, and back into the target pill's head.
   *
   * The SVG masks an overlay stroke out of every pill it crosses. mxGraph has no mask, so the stroke
   * would otherwise be drawn along the pill heads it ends on. This is the one place the exporter
   * states a polyline the model does not hold — and it discovers nothing: every number is read off
   * the two pill boxes placement already reserved, plus one constant derived from the overlay's own
   * endpoint mark. No box is grown, no route is searched, and no other shape is consulted, so the
   * pipeline's rule still holds — nothing is found here that placement did not reserve.
   *
   * Eight candidates are tried, all of them read off the two boxes. The first two turn once between
   * the cleared points. Four go right round the pair, along a lane one clearance outside the pair's
   * own extent on each of the four sides. Two more run down the middle of the gap between the boxes,
   * on each axis — the case two heads that face away from each other over a gap need, and the one no
   * outside lane reaches. The shortest that enters neither pill box wins, and a tie goes to the one
   * listed first: the single turn that carries on the way the source pill faces, which is the
   * three-segment detour the maintainer drew when both pills face the same way. Two pills that
   * overlap on both axes can leave nothing usable; then the link keeps the model's own polyline,
   * which is what every release before this one drew.
   */
  const overlayPath = (head: PillEnd, tail: PillEnd): Point[] | undefined => {
    const clear = (end: PillEnd): Point => ({
      x: end.at.x + end.out.x * OVERLAY_PILL_CLEARANCE,
      y: end.at.y + end.out.y * OVERLAY_PILL_CLEARANCE,
    });
    const from = clear(head), to = clear(tail);
    const boxes = [head.box, tail.box];
    const before = (of: (box: Rect) => number): number =>
      Math.min(...boxes.map(of)) - OVERLAY_PILL_CLEARANCE;
    const after = (of: (box: Rect) => number): number =>
      Math.max(...boxes.map(of)) + OVERLAY_PILL_CLEARANCE;
    const above = before(box => box.y), below = after(box => box.y + box.height);
    const left = before(box => box.x), right = after(box => box.x + box.width);
    /** The middle of the gap the two boxes leave on one axis; inside a box when they overlap on it. */
    const gap = (low: (box: Rect) => number, high: (box: Rect) => number): number =>
      (Math.max(...boxes.map(low)) + Math.min(...boxes.map(high))) / 2;
    const midX = gap(box => box.x, box => box.x + box.width);
    const midY = gap(box => box.y, box => box.y + box.height);
    const turn = { x: to.x, y: from.y }, bend = { x: from.x, y: to.y };
    const ways: Point[][] = [
      // One turn, starting the way the source pill faces.
      ...(head.out.x !== 0 ? [[turn], [bend]] : [[bend], [turn]]),
      // Right round the pair, on each of its four sides.
      [{ x: from.x, y: above }, { x: to.x, y: above }],
      [{ x: from.x, y: below }, { x: to.x, y: below }],
      [{ x: left, y: from.y }, { x: left, y: to.y }],
      [{ x: right, y: from.y }, { x: right, y: to.y }],
      // Down the middle of the gap between them, on each axis. A lane that falls inside a box —
      // which is what an overlap gives — is refused by the same test as every other candidate.
      [{ x: midX, y: from.y }, { x: midX, y: to.y }],
      [{ x: from.x, y: midY }, { x: to.x, y: midY }],
    ];
    let best: { points: Point[]; length: number } | undefined;
    for (const way of ways) {
      // A lane can land on the line the two cleared points already share, and then it states a
      // corner that is not one. This is the exporter's own polyline, not the reserved waypoints —
      // those keep every collinear point they were given, because a hand drag needs them.
      const points = straighten(compact([head.at, from, ...way, to, tail.at]));
      if (!axisAligned(points)) continue;
      if (points.slice(1).some((point, index) =>
        enters(points[index]!, point, head.box) || enters(points[index]!, point, tail.box))) continue;
      const length = polylineLength(points);
      if (best === undefined || length < best.length - EPS) best = { points, length };
    }
    return best?.points;
  };

  const edgeCell = (id: string, layer: string, style: string, points: readonly Point[],
    ends: { source?: string | undefined; target?: string | undefined;
      sourcePoint?: Point | undefined; targetPoint?: Point | undefined },
    label?: { value: string; at: EdgeLabel }): void => {
    const waypoints = points.length > 2
      ? element('Array', { as: 'points' },
        points.slice(1, -1).map(point => element('mxPoint', { x: point.x, y: point.y })).join(''))
      : '';
    const dangling = (ends.sourcePoint ? element('mxPoint', { x: ends.sourcePoint.x, y: ends.sourcePoint.y, as: 'sourcePoint' }) : '')
      + (ends.targetPoint ? element('mxPoint', { x: ends.targetPoint.x, y: ends.targetPoint.y, as: 'targetPoint' }) : '');
    cells.push(element('mxCell', { id: claim(id), value: label?.value, style, edge: 1, parent: layer,
      source: ends.source, target: ends.target },
    element('mxGeometry', { ...(label ? { x: label.at.x, y: label.at.y } : {}), relative: 1, as: 'geometry' },
      waypoints + dangling + residualPoint(label?.at))));
  };

  const drawn = layout.links.filter(link => link.technique !== 'stub' && link.path && visible(link));
  /** Every connector a link became, with the polyline draw.io will really draw for each. */
  const edgeRuns = new Map<string, Connector[]>();

  /** An overlay link's detour, with the run of it a label measured against the model now names. */
  interface Detour { points: Point[]; carrier: { index: number; from: Point; to: Point } }

  /**
   * The overlay links that are routed round their pills, resolved once, before anything states a
   * label. A label names a *model* segment, and a detoured connector no longer draws that segment,
   * so the naming has to be carried over rather than reused: the detour's longest run is the one the
   * model's straight pill-to-pill segment became, and it is the run the label was measured beside.
   * Every other link draws its model polyline and is absent from here.
   */
  const detours = new Map<string, Detour>();
  for (const link of drawn) {
    if (effectiveLayer(link) !== 'overlay') continue;
    const from = link.attachments?.from, to = link.attachments?.to;
    const head = from ? pillEnd(from) : undefined, tail = to ? pillEnd(to) : undefined;
    if (!head || !tail || polylines(link.path!.segments).length !== 1) continue;
    const points = overlayPath(head, tail);
    if (!points) continue;
    let index = 0, longest = -1;
    for (const [at, point] of points.slice(1).entries()) {
      const span = Math.hypot(point.x - points[at]!.x, point.y - points[at]!.y);
      if (span > longest) { longest = span; index = at; }
    }
    detours.set(link.id, { points, carrier: { index, from: points[index]!, to: points[index + 1]! } });
  }

  /** Where a link label sits: on its supporting segment, or the box stage 9 measured. */
  const labelPoint = (label: LayoutLabel, link: LayoutLink): Point => {
    const measured = centre(shiftRect(label.bounds!));
    if (placement !== 'on-run' || label.support?.kind !== 'link-segment') return measured;
    // A detour is already in page space; the model's own segments are not.
    const detour = detours.get(link.id);
    if (detour) return project(measured, detour.carrier);
    const support = link.path!.segments[label.support.segment];
    if (support === undefined) return measured;
    return shift(project({ x: measured.x + canvas.x, y: measured.y + canvas.y }, support));
  };

  /**
   * The paint and turn a link label takes, on whichever of the two carriers holds it. The two do
   * **not** take the same keys, measured against drawio-desktop 31.4.5 on a horizontal edge:
   *
   * | style | edge's own label | child `edgeLabel` cell |
   * | --- | --- | --- |
   * | `horizontal=0` | `rotate(-90 …)` | `rotate(-90 …)` |
   * | `rotation=-90` | no transform | `rotate(-90 …)` |
   * | `rotation=90` | no transform | `rotate(90 …)` |
   * | `rotation=180` | no transform | `rotate(180 …)` |
   * | `rotation=45` | no transform | `rotate(45 …)` |
   * | `horizontal=0;rotation=180` | `rotate(-90 …)` | `rotate(90 …)` |
   *
   * So an edge's own label takes `horizontal=0` and ignores `rotation=` outright — it can express
   * −90 and nothing else. A child cell takes `rotation=` at any angle, and `horizontal=0` adds a
   * further −90 on top of it rather than replacing it, so a child states its angle once, in
   * `rotation=`, and never sets `horizontal`.
   */
  const labelStyle = (label: LayoutLabel, at: Point, carrier: 'edge' | 'child'): Readonly<Record<string, StyleValue>> => {
    const on = placement === 'on-run' && label.support?.kind === 'link-segment';
    const multiplicity = label.support?.kind === 'merge-run';
    const inside = Object.values(layout.groups).some(group => group.bounds
      && at.x >= group.bounds.x - canvas.x && at.x <= group.bounds.x - canvas.x + group.bounds.width
      && at.y >= group.bounds.y - canvas.y && at.y <= group.bounds.y - canvas.y + group.bounds.height);
    return {
      // A label on the line must hide the line behind its glyphs, and the honest colour to do that
      // with is whatever is really behind it: the group's tint composited over the canvas, or the
      // canvas. Sitting clear of its run, it fills nothing and needs no margin either.
      labelBackgroundColor: on
        ? dual(of => inside
          ? composite(NETWORK_THEME[of].group.fill, NETWORK_THEME[of].background, NETWORK_THEME[of].group.fillOpacity)
          : NETWORK_THEME[of].background)
        : 'none',
      ...(on ? { spacing: LABEL_MARGIN } : {}),
      align: 'center', verticalAlign: 'middle',
      fontFamily: FONT_FAMILY, fontSize: label.fontSize,
      fontColor: multiplicity ? paint.link.multiplicity : paint.link.label,
      fontStyle: label.fontWeight === 700 ? 1 : undefined,
      ...(carrier === 'edge'
        ? { horizontal: label.textRotation === -90 ? 0 : undefined }
        : { rotation: label.textRotation ? label.textRotation : undefined }),
    };
  };

  /**
   * The one label an edge can carry as its own. draw.io gives a shape its text, and an edge is a
   * shape: a reader who double-clicks a connector expects to be editing its label. An edge's own
   * label takes exactly two turns — none, and the `horizontal=0` quarter turn, which — contrary to
   * what the format's own notes suggest — really does rotate it; measured. `rotation=` on an edge
   * is ignored, so +90, 180 and every arbitrary reserved angle stay child cells, along with a
   * second label on one link. That is draw.io's own answer for exactly those cases, and a child
   * cell does take `rotation=` at any angle. See `labelStyle` for the measured table.
   *
   * ADR-0014 reserves 0° and −90° for a link label, so the common diagram loses nothing here: only
   * a straight bundle member's own run angle (ADR-0017) leaves the edge and becomes a child.
   */
  const ownLabel = new Map<string, LayoutLabel>();
  for (const label of layout.labels) {
    if (label.role !== 'link' || label.omitted || !label.bounds) continue;
    const owner = label.owner.kind === 'barCross' ? label.owner.link
      : label.owner.kind === 'link' ? label.owner.id : undefined;
    if (owner === undefined) continue;
    const turn = label.textRotation ?? 0;
    if (turn !== 0 && turn !== -90) continue;
    if (ownLabel.has(owner)) { ownLabel.delete(owner); continue; }
    ownLabel.set(owner, label);
  }
  /**
   * Which of a link's connectors carries a label: the one that draws the label's supporting
   * segment. A bundle whose path breaks becomes one connector per run, and attaching every label to
   * run 0 states the label against a polyline that does not hold the segment it was measured
   * against. With no usable support, the nearest run carries it.
   */
  const runFor = (label: LayoutLabel, link: LayoutLink, runs: readonly Run[]): number => {
    const support = label.support?.kind === 'link-segment' ? label.support.segment : undefined;
    if (support !== undefined) {
      const found = runs.findIndex(run => support >= run.first && support <= run.last);
      if (found >= 0) return found;
    }
    const at = labelPoint(label, link);
    let best = 0, nearest = Infinity;
    runs.forEach((run, index) => {
      for (const [step, to] of run.points.slice(1).entries()) {
        const on = project(at, { from: run.points[step]!, to });
        const distance = Math.hypot(at.x - on.x, at.y - on.y);
        if (distance < nearest) { nearest = distance; best = index; }
      }
    });
    return best;
  };

  /**
   * The supporting segment's place in a run's own polyline, when that run really draws it. It is
   * the segment stage 9 measured the label against, and stating the label against it is what keeps
   * the label on it when the diagram is edited. A detoured overlay draws none of its model segments,
   * so there the carrier the detour states takes the model segment's place.
   */
  const supportIn = (label: LayoutLabel, link: LayoutLink, run: Run): number | undefined => {
    if (label.support?.kind !== 'link-segment') return undefined;
    const detour = detours.get(link.id);
    if (detour) return detour.carrier.index;
    const at = label.support.segment;
    return at >= run.first && at <= run.last ? at - run.first : undefined;
  };

  const taken = new Set<string>();
  for (const link of drawn) {
    const layer = effectiveLayer(link) === 'overlay' ? layerId('overlay') : layerId('links');
    const authored = linkClass(link);
    const klass = linkClassStyle(authored);
    const overlay = effectiveLayer(link) === 'overlay';
    const runs = polylines(link.path!.segments);
    const from = link.attachments?.from, to = link.attachments?.to;
    const head = from ? terminal('exit', from) : undefined;
    const tail = to ? terminal('entry', to) : undefined;
    // An overlay link is the one connector whose exported polyline is not the model's: it is routed
    // around the two pills instead of along them. See `overlayPath` and `detours`. Every other link
    // exports the reserved waypoints verbatim, collinear ones included.
    const headPill = overlay && from ? pillEnd(from) : undefined;
    const tailPill = overlay && to ? pillEnd(to) : undefined;
    const detour = detours.get(link.id);
    /** The polyline each connector really carries, run by run. */
    const written = runs.map((run, index) => detour && index === 0 ? detour.points : run.points);
    // What draw.io draws is not what the model holds: a pinned end sits on the pill's outward edge,
    // not on the port anchor the waypoints start from. An edge label's coordinates are fractions of
    // that drawn polyline, so it is resolved here — the waypoints themselves are untouched.
    const shown: Connector[] = runs.map((run, index) => {
      const points = [...written[index]!];
      if (index === 0 && head) points[0] = head.at;
      if (index === runs.length - 1 && tail) points[points.length - 1] = tail.at;
      return {
        id: runs.length === 1 ? cellId('link', link.id) : cellId('link', link.id, String(index)),
        points, first: run.first, last: run.last,
      };
    });
    const mine = ownLabel.get(link.id);
    const mineRun = mine ? runFor(mine, link, shown) : -1;
    runs.forEach((run, index) => {
      const first = index === 0, last = index === runs.length - 1;
      const source = first ? head : undefined;
      const target = last ? tail : undefined;
      const id = shown[index]!.id;
      // The connector's own label, on the run that draws the segment it was measured against.
      const carried = mine && index === mineRun
        ? { label: mine, at: edgeLabel(shown[index]!.points, labelPoint(mine, link), supportIn(mine, link, shown[index]!)) }
        : undefined;
      if (carried) taken.add(carried.label.id);
      const points = written[index]!;
      // A square route is a square connector: draw.io then keeps it square when a pill or a node is
      // moved by hand, where `edgeStyle=none` leaves a diagonal stub. The orthogonal router draws
      // the supplied waypoints and does not re-route them, and `jettySize=0` keeps it from adding a
      // stub of its own; see fact 1 in the header for the numbers. A polyline that is not
      // axis-aligned is outside that router's vocabulary, so it keeps `edgeStyle=none`.
      //
      // Both polylines are tested, because they differ: the waypoints exactly, and the polyline
      // draw.io really draws — the pinned terminals included — within the endpoint tolerance. A port
      // that draws no pill terminates on its node's box, which can leave the drawn line diagonal
      // while every waypoint is square, and that is a corner the router would invent.
      const square = axisAligned(points) && axisAligned(shown[index]!.points, SQUARE_ENDPOINT_TOLERANCE);
      // A connector holds one polyline; a path whose segment chain breaks becomes one connector per
      // run, each dangling where the chain did. Only the ends that are really ends are pinned.
      const style = styleString([], {
        edgeStyle: square ? 'orthogonalEdgeStyle' : 'none',
        jettySize: square ? 0 : undefined,
        rounded: 0, html: 1, endArrow: 'none', startArrow: 'none',
        strokeColor: dual(of => overlay ? NETWORK_THEME[of].overlay.stroke : klass.strokes[of]),
        strokeWidth: linkStrokeWidth(link),
        opacity: overlay ? Math.round(paint.overlay.opacity * 100) : undefined,
        ...dashEntries(overlay ? undefined : klass.dash),
        ...(source?.style ?? {}),
        ...(target?.style ?? {}),
        ...(carried ? labelStyle(carried.label, labelPoint(carried.label, link), 'edge') : {}),
      });
      edgeCell(id, layer, style, points, {
        source: source?.cell,
        target: target?.cell,
        sourcePoint: source ? undefined : points[0],
        targetPoint: target ? undefined : points[points.length - 1],
      }, carried ? {
        value: htmlText(carried.label.lines ?? [carried.label.text]),
        at: carried.at,
      } : undefined);
    });
    edgeRuns.set(link.id, shown);

    if (overlay) {
      // A mark that belongs to a shape is a child of that shape. The mark names the port the overlay
      // link ends on, so it is a child of that port's pill, stated from the pill's own top-left: a
      // pill moved by hand carries its mark with it, where an absolute mark stayed behind. It keeps
      // the overlay layer's paint; what it no longer keeps is the overlay layer's parent. A port
      // that draws no pill has no shape to belong to, so its mark stays on the layer, at the anchor.
      // On a pill the mark sits on the pill's outward point, where the connector really ends: the
      // anchor is the pill's centre, and a mark there covers the port's name (maintainer, 2026-09-15).
      const ends = link.path!.segments;
      const marks = [
        { end: 'from', at: ends[0]!.from, host: headPill },
        { end: 'to', at: ends[ends.length - 1]!.to, host: tailPill },
      ] as const;
      for (const mark of marks) {
        const at = mark.host ? mark.host.at : shift(mark.at);
        const box = { x: at.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - OVERLAY_ENDPOINT_RADIUS,
          width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS };
        vertex(cellId('overlayMark', link.id, mark.end), mark.host?.cell ?? layerId('overlay'),
          styleString(['ellipse'], {
            html: 1, fillColor: paint.overlay.mark, strokeColor: 'none', points: '[]',
          }), mark.host ? relative(box, mark.host.box) : box);
      }
    }
  }

  // ---- link labels --------------------------------------------------------------------------
  // What is left after the edges took their own: a counted merge label, whose owner is a bundle,
  // and any label at an angle no shape's own label can take. A child label is stated in the same
  // relative terms its edge's own label is, on the connector that draws its supporting segment.
  for (const label of layout.labels) {
    if (label.role !== 'link' || label.omitted || !label.bounds) continue;
    if (taken.has(label.id)) continue;
    const owner = label.owner.kind === 'barCross' ? label.owner.link
      : label.owner.kind === 'link' ? label.owner.id : undefined;
    const link = owner === undefined ? undefined : byId.get(owner);
    const ids = owner === undefined ? undefined : edgeRuns.get(owner);
    if (!link || !ids?.length) {
      // A counted merge label is owned by its bundle, not by any one link: it names the shared
      // trunk, and no connector here is that trunk, because each member exports its whole path.
      // Attaching the count to an arbitrary member would say something false about which link
      // carries it, so it keeps its measured box in the label layer instead.
      if (label.owner.kind !== 'bundle') continue;
      const bundle = label.owner.id;
      if (!drawn.some(item => item.bundle === bundle)) continue;
      textCell(cellId('linkLabel', label.id), layerId('labels'), label, shiftRect(label.bounds),
        paint.link.multiplicity);
      continue;
    }
    const run = ids[runFor(label, link, ids)]!;
    const at = labelPoint(label, link);
    const relativeAt = edgeLabel(run.points, at, supportIn(label, link, run));
    cells.push(element('mxCell', {
      id: claim(cellId('linkLabel', label.id)), value: htmlText(label.lines ?? [label.text]),
      style: styleString(['edgeLabel'], {
        // `edgeLabel` is a named style in draw.io's bundled sheet and brings
        // `labelBackgroundColor=default` with it — the white box the SVG does not draw.
        html: 1, resizable: 0, points: '[]',
        // A child cell states its whole turn in `rotation=`, at any angle. `labelStyle` carries it.
        ...labelStyle(label, at, 'child'),
      }),
      vertex: 1, connectable: 0, parent: run.id,
    }, element('mxGeometry', { x: relativeAt.x, y: relativeAt.y, relative: 1, as: 'geometry' },
      residualPoint(relativeAt) || undefined)));
  }

  // ---- legend -------------------------------------------------------------------------------
  if (layout.legend) {
    const box = shiftRect(layout.legend.bounds);
    vertex(cellId('legend'), layerId('legend'), styleString(['group'], { html: 1, points: '[]' }), box);
    for (const entry of layout.legend.entries) {
      // A legend row is one thing: a swatch and the name of what it means. It is emitted as one
      // cell carrying that name as its own label, with the swatch inside it — so the row moves and
      // reads as a row, rather than as a mark and an unrelated caption that happens to sit beside
      // it. `spacingLeft` puts the text exactly where stage 9 measured it.
      const caption = layout.labels.find(item => item.id === entry.label);
      const shown = caption && !caption.omitted && caption.bounds ? caption : undefined;
      const outer = shown
        ? union(shiftRect(entry.swatch), shiftRect(shown.bounds!))
        : shiftRect(entry.swatch);
      const row = relative(outer, shift(layout.legend.bounds));
      vertex(cellId('legendRow', entry.id), cellId('legend'), styleString([], {
        html: 1, fillColor: 'none', strokeColor: 'none', points: '[]',
        ...(shown ? {
          align: 'left', verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'visible',
          spacingLeft: shiftRect(shown.bounds!).x - outer.x - LABEL_SPACING,
          fontFamily: FONT_FAMILY, fontSize: shown.fontSize, fontColor: paint.legend.text,
          fontStyle: shown.fontWeight === 700 ? 1 : undefined,
        } : {}),
      }), row, shown ? htmlText(shown.lines ?? [shown.text]) : undefined);
      const swatch = relative(shiftRect(entry.swatch), outer);
      if (entry.kind === 'line') {
        const klass = entry.key === LEGEND_DEFAULT_CLASS ? linkClassStyle(undefined) : linkClassStyle(entry.key);
        // `shape=line` draws the sample across its own box, so the swatch is a vertex like every
        // other one and sits in the row rather than floating over it.
        vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
          shape: 'line', html: 1, points: '[]',
          strokeColor: dual(of => klass.strokes[of]), strokeWidth: entry.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path,
          ...dashEntries(klass.dash),
        }), swatch);
      } else if (entry.kind === 'port') {
        const role = portRoleStyle(entry.key);
        // The legend has to name what the diagram draws, so an outlined role's swatch takes the
        // same opaque body the pill takes; see `outlinedFill`.
        const resolved = role ? dual(of => {
          const rolePaint = portRolePaint(role, of);
          return rolePaint.stroke === undefined ? rolePaint
            : { ...rolePaint, fill: outlinedFill(of) };
        }) : undefined;
        vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
          html: 1, rounded: 1, absoluteArcSize: 1,
          arcSize: (entry.radius ?? CORNER_RADII.pill) * 2,
          fillColor: resolved?.fill ?? paint.pill.fill,
          strokeColor: resolved?.stroke ?? paint.pill.stroke,
          strokeWidth: DEFAULT_STROKE_WIDTHS.pill, points: '[]',
        }), swatch);
      } else if (entry.icon) {
        const pick = (of: ThemeMode): { tile: { fill: string; stroke: string }; glyph: string } => {
          const known = nodeClassStyle(entry.key);
          return known ? nodeClassPaint(known, of) : { tile: NETWORK_THEME[of].tile, glyph: NETWORK_THEME[of].glyph };
        };
        const resolved = dual(pick);
        const native = iconSet === 'cisco19' ? CISCO19[iconKey(entry.icon)] : undefined;
        if (native) {
          // The legend has to name what the diagram draws, so it takes the same glyph — and the
          // same guard: a swatch with no room for the inset keeps its tile and drops the glyph,
          // rather than writing a negative box draw.io silently draws as nothing.
          if (native.kind === 'silhouette' && positive(swatch)) {
            vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
              html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
              fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
            }), swatch);
          }
          const box = glyphBox(swatch, native);
          if (box) {
            vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
              sketch: 0, html: 1, aspect: 'fixed', points: '[]',
              shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
              ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
              fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
              strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
            }), box);
          }
        } else {
          if (positive(swatch)) {
            vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
              html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
              fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
            }), swatch);
          }
          const inner = shrink(swatch, ICON_INSET);
          if (inner) {
            const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
              + `<path d="${iconPath(entry.icon)}" fill="none" stroke="${pick(mode).glyph}"`
              + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
              shape: 'image', html: 1, imageAspect: 0, points: '[]', image: svgImage(glyph),
            }), inner);
          }
        }
      }
    }
  }

  // ---- document -----------------------------------------------------------------------------
  // The root and the layers claim their ids like everything else. Their namespaces are ones no
  // other caller can reach, so this catches nothing today — but "every id is claimed" is a rule
  // worth being able to state without an exception, and an unclaimed id is how the last one hid.
  const layers = LAYERS.map(name =>
    element('mxCell', { id: claim(layerId(name)), value: LAYER_NAMES[name], parent: '0' })).join('');
  const model = element('mxGraphModel', {
    dx: 0, dy: 0, grid: 0, gridSize: 10, guides: 1, tooltips: 1, connect: 1, arrows: 0, fold: 1,
    page: 1, pageScale: 1, pageWidth: Math.ceil(canvas.width), pageHeight: Math.ceil(canvas.height),
    // The page background is an *attribute*, and jgraph's published schema pins it to a plain
    // colour — `light-dark()` belongs in a style string, which is where every other colour here
    // goes. So this one states the chosen palette's backdrop and lets draw.io's own inversion
    // darken it, which for a flat backdrop is exactly what inversion is good at.
    math: 0, shadow: 0, background: NETWORK_THEME[mode].background,
  }, element('root', {}, element('mxCell', { id: claim('0') }) + layers + cells.join('')));
  const title = document.title ?? 'portograph';
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + element('mxfile', { host: 'portograph' },
      element('diagram', { id: 'pg-diagram', name: title }, model)) + '\n';
}

/** The segment lengths of a polyline, as `mxGraphView.updateEdgeBounds` measures them. */
const spansOf = (points: readonly Point[]): number[] =>
  points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));

/**
 * The segment draw.io decodes an arc-length position onto, and how far the walk had gone when it
 * got there. This is `mxGraphView.getPoint`'s own loop, and it has two properties worth stating:
 * the position is **rounded to a whole pixel** before the walk, and the walk leaves a segment as
 * soon as the position reaches its rounded far end. So a position exactly on a joint decodes onto
 * the *later* segment, and the label then takes that segment's normal rather than the earlier one's.
 */
function decodeSegment(points: readonly Point[], spans: readonly number[], dist: number):
{ index: number; walked: number; span: number } {
  let span = spans[0] ?? 0, walked = 0, index = 1;
  while (dist >= Math.round(walked + span) && index < points.length - 1) {
    walked += span;
    span = spans[index]!;
    index += 1;
  }
  return { index, walked, span };
}

/**
 * Where draw.io will really draw a label carried by `points` with this geometry: the whole of
 * `mxGraphView.getPoint`, at scale 1. Written so the encoder below can measure its own output
 * instead of trusting an inverse.
 */
function decodeEdgeLabel(points: readonly Point[], label: EdgeLabel): Point {
  const spans = spansOf(points);
  const total = spans.reduce((sum, span) => sum + span, 0);
  const dist = Math.round((label.x / 2 + 0.5) * total);
  const { index, walked, span } = decodeSegment(points, spans, dist);
  const from = points[index - 1]!, to = points[index]!;
  const dx = to.x - from.x, dy = to.y - from.y;
  const factor = span === 0 ? 0 : (dist - walked) / span;
  // The left normal of the direction of travel, in screen axes where y grows downward.
  const nx = span === 0 ? 0 : dy / span, ny = span === 0 ? 0 : dx / span;
  return {
    x: from.x + dx * factor + nx * label.y + (label.offset?.x ?? 0),
    y: from.y + dy * factor - ny * label.y + (label.offset?.y ?? 0),
  };
}

/**
 * How to state `at` as an edge label on `points`, in the terms draw.io reads: `x` is arc length as a
 * fraction of the whole, from -1 at the source to 1 at the target, `y` is the signed perpendicular
 * distance, positive to the **left** of the direction of travel, and `offset` is absolute screen
 * pixels added to both.
 *
 * The relative pair carries as much as it can, because that is what makes a label follow its
 * connector when a shape moves; `offset` carries only the remainder, and stays absolute. There is
 * always a remainder to consider, because draw.io rounds the arc length to a whole pixel before it
 * resolves the point, and three cases leave more than a rounding behind: a label beyond an endpoint
 * (no arc length reaches it), a label at a corner (the joint decodes onto the later segment, whose
 * normal points elsewhere), and a zero-length polyline (there is no direction at all).
 *
 * Every whole-pixel position that could carry the label is read back the way draw.io reads it.
 * `support` names the segment stage 9 measured the label against, and a position that decodes onto
 * that segment wins outright: the label belongs to that segment and must keep following it, where
 * a position on a parallel segment far away can draw the label in the same place today and leave
 * it behind tomorrow. The remainder it costs is the rounding alone, under half a pixel, as long as
 * the label really was measured beside the segment it names — which is what stage 9 gives. A label
 * measured past the end of its own supporting segment pays the whole overshoot instead, and that
 * is the honest price of saying which segment carries it. Otherwise the smallest remainder wins,
 * and between two equal remainders the one nearer the line. The result is exact wherever the format allows it and exact by remainder
 * everywhere else. The work is linear in the number of segments: the candidates are read in
 * ascending order and draw.io's own walk only ever moves forward, so it is walked once.
 */
function edgeLabel(points: readonly Point[], at: Point, support?: number): EdgeLabel {
  const spans = spansOf(points);
  const total = spans.reduce((sum, span) => sum + span, 0);
  const start = points[0] ?? at;
  if (total === 0) return { x: 0, y: 0, offset: { x: at.x - start.x, y: at.y - start.y } };
  // `x` stays inside the stated -1..1. Both ends of that range are candidates in their own right:
  // at the far end the rounded arc length runs a fraction *past* the last point, which is the only
  // way a label beyond the end is reached without an absolute offset at all.
  const limit = Math.round(total);
  const fraction = (pixel: number): number => Math.min(1, Math.max(-1, 2 * (pixel / total) - 1));
  const wanted = new Set<number>([fraction(0), fraction(limit)]);
  let walked = 0;
  for (const [index, span] of spans.entries()) {
    if (span > 0) {
      const from = points[index]!, to = points[index + 1]!;
      const ratio = ((at.x - from.x) * (to.x - from.x) + (at.y - from.y) * (to.y - from.y)) / (span * span);
      const along = walked + Math.min(1, Math.max(0, ratio)) * span;
      // Either whole pixel around the wanted position, and one either side of those: a position on
      // a joint has to be able to step back into the earlier segment to keep that segment's normal.
      for (const step of [-1, 0, 1]) {
        wanted.add(fraction(Math.min(limit, Math.max(0, Math.floor(along) + step))));
        wanted.add(fraction(Math.min(limit, Math.max(0, Math.ceil(along) + step))));
      }
    }
    walked += span;
  }
  type Candidate = { label: EdgeLabel; left: number; beside: number };
  const closer = (candidate: Candidate, than: Candidate | undefined): boolean =>
    than === undefined || candidate.left < than.left - EPS
    || Math.abs(candidate.left - than.left) <= EPS && candidate.beside < than.beside - EPS;
  let span = spans[0] ?? 0, before = 0, index = 1;
  let best: Candidate | undefined, onSupport: Candidate | undefined;
  for (const x of [...wanted].sort((a, b) => a - b)) {
    // Read the position back the way draw.io will, so the chosen segment is the one it will choose.
    const dist = Math.round((x / 2 + 0.5) * total);
    while (dist >= Math.round(before + span) && index < points.length - 1) {
      before += span;
      span = spans[index]!;
      index += 1;
    }
    const from = points[index - 1]!, to = points[index]!;
    const dx = to.x - from.x, dy = to.y - from.y;
    const factor = span === 0 ? 0 : (dist - before) / span;
    const on = { x: from.x + dx * factor, y: from.y + dy * factor };
    // What the relative pair reaches is the perpendicular; what it leaves behind is the tangent.
    const y = span === 0 ? 0 : ((at.x - on.x) * dy - (at.y - on.y) * dx) / span;
    const left = span === 0 ? Math.hypot(at.x - on.x, at.y - on.y)
      : Math.abs(((at.x - on.x) * dx + (at.y - on.y) * dy) / span);
    const candidate = { label: { x, y }, left, beside: Math.abs(y) };
    if (closer(candidate, best)) best = candidate;
    // A zero-length supporting segment states no direction, so it can carry nothing.
    if (index - 1 === support && span > 0 && closer(candidate, onSupport)) onSupport = candidate;
  }
  const chosen = onSupport ?? best!;
  if (chosen.left <= EPS) return chosen.label;
  const drawn = decodeEdgeLabel(points, chosen.label);
  return { ...chosen.label, offset: { x: at.x - drawn.x, y: at.y - drawn.y } };
}

