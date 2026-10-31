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
 * 1. A run with no bend (one straight segment, waypoints and drawn polyline both) is exported with
 *    `edgeStyle=none` and no `jettySize`, by the maintainer's decision of 2026-10-23: a straight
 *    connector is easier to edit in draw.io than an orthogonal one. Mesh-bus bars, stubs, risers and
 *    trunk pieces are single straight pieces and were already `none`. Every run with a bend takes the
 *    rule below. `edgeStyle=orthogonalEdgeStyle;jettySize=0` draws a square route on the reserved route. Over 61
 *    link edges in four diagrams, 59 render within 0.05 px of the model polyline — the orthogonal
 *    router rounds a waypoint to 0.1 px — and 2 within 0.51 px, which is an endpoint defect the
 *    export has with `edgeStyle=none` as well. No waypoint is dropped and no edge is re-routed.
 *    `jettySize=0` is the one key that matters: without it an edge whose two ends leave the same
 *    node side gains a 10 px loop, and `jettySize=auto` doubles that. `orthogonalLoop`, `curved` and
 *    the perimeter spacing keys are no-ops; `elbowEdgeStyle` re-routes by up to 265 px and is
 *    refused. A polyline with a segment that is not axis-aligned is outside that router's vocabulary
 *    and keeps `edgeStyle=none`, which reproduces any waypoints verbatim. Measured against
 *    drawio-desktop 31.4.5. The style is chosen from the published polyline and from nothing else —
 *    this file states no shape of its own — so **either family can reach either style**. A routed
 *    link is orthogonal unless it is a declared straight bundle member (ADR-0017: stem, one
 *    diagonal, stem); an **overlay** link is a stub out of each port and one straight segment
 *    between the two stub ends, angled whenever those ends do not line up and no node stood in the
 *    way (stress ticket 20). Measured over the 49 synthetic fixtures, four connectors take `none`:
 *    `author-ordered-bundle` link-1 and link-3, both **routed** bundle members on the links layer,
 *    and the overlay of `labelled-overlay-run` and `overlay-ports-that-do-not-line-up`. What `none`
 *    costs is a hand drag: it re-angles the run a moved terminal is on, the stub included —
 *    measured, a pill dragged 30 px along its side leaves an 82° kink where the stub was — which is
 *    the cost the maintainer took with the three renders in front of him.
 * 2. `points=` on a shape does not constrain an edge — it only decides which anchors the editor
 *    offers. An endpoint is pinned by `exitX`/`exitY` on the edge, and `exitPerimeter` defaults to
 *    1, which projects the point onto the perimeter instead of using it.
 * 3. `startSize` does not shift a child's origin: a child is always placed from the parent's
 *    top-left, so the title band's inset is ours to add.
 * 4. Every label is plain text: no `html` key, the lines one `\n` apart, no markup. An SVG export
 *    then draws each line as a native `<text>`, where `html=1` draws a `<foreignObject>` with a PNG
 *    fallback beside it — several times the bytes, softer type, and a warning in a dashboard that
 *    embeds the SVG. Plain text has one font per cell and draw.io's own line pitch, so a node's
 *    description is a cell of its own and every label states the `spacingTop` that puts its first
 *    baseline where `render` puts it (`middleSpacing`).
 *
 * Named styles do not exist in the file format — an `<mxStylesheet>` in an `mxfile` is dropped — so
 * the palette lives here and every cell carries its own resolved style string.
 */

import type { Point, Rect, Side } from '../model/geometry.js';
import type {
  Layer, LayoutLabel, LayoutLink, LayoutModel, LayoutPort, PathSegment,
} from '../model/layout.js';
import type { Meta } from '../model/document.js';
import { dotEnds } from './anonymous-end.js';
import { endpointId, linkIds } from '../model/link-ids.js';
import { orderedNodeIds } from '../model/model.js';
import { isDirect } from '../layout/link-labels.js';
import { nodeSymbolIds } from '../layout/legend.js';
import { iconKey, iconPath } from '../profiles/network/icons.js';
import type { ThemeMode } from '../profiles/network/theme.js';
import {
  LEGEND_DEFAULT_CLASS, washAssignment, washToken, type WashAssignment, portRolePaint,
} from '../profiles/network/theme.js';
import { legendKeyRadius, themeById, themeLinkClass, themePortRole, themeWashFill } from '../profiles/network/themes.js';
import type { Theme } from '../profiles/network/themes.js';
import { effectiveLayer, validate } from '../score/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { ANONYMOUS_DOT_SIZE, CORNER_RADII, DEFAULT_STROKE_WIDTHS, OVERLAY_ENDPOINT_RADIUS, linkStrokeWidth } from '../theme/geometry.js';
import { boxesBehind, groupShapes } from './frame-order.js';
import { backdropColour } from '../profiles/network/theme.js';
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

/** The node-name size the profile uses when a label does not state its own. */
const NODE_NAME_SIZE = 9;

/** The description size the profile uses when a label does not state its own. */
const NODE_DESCRIPTION_SIZE = 7;

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
 * Whether a polyline is one straight segment: every point lies within `within` of the line from the
 * first point to the last, and none steps back against that direction. A polyline with no distinct
 * ends is straight. Collinear waypoints stay in the file; `edgeStyle=none` draws them verbatim.
 */
const isStraight = (points: readonly Point[], within = EPS): boolean => {
  const a = points[0], b = points[points.length - 1];
  if (a === undefined || b === undefined) return true;
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length <= within) return points.every(point => Math.hypot(point.x - a.x, point.y - a.y) <= within);
  let along = 0;
  return points.every(point => {
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
    const off = Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length;
    const ok = off <= within && t >= along - within;
    along = Math.max(along, t);
    return ok;
  });
};

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

/** The version of the binding contract the export writes (docs/drawio-binding-contract.md). */
export const BINDING_SCHEMA = '1';

/** The binding attributes of one cell: the `pg-*` keys first, then the author's `meta:` keys in sorted order. */
type Binding = Readonly<Record<string, string>>;
const binding = (own: Binding, meta: Meta | undefined): Binding => ({
  ...own,
  ...Object.fromEntries(Object.keys(meta ?? {}).sort().map(key => [key, String(meta![key])])),
});

/**
 * A cell, bare or bound. A bound cell is a draw.io `UserObject`: an `<object>` that holds the id, the
 * label and the binding attributes, around an `<mxCell>` that holds the rest. draw.io keeps the
 * attributes through an edit and in an SVG export with the diagram embedded, and its *Edit Data*
 * dialog shows them.
 */
function cellElement(attributes: Readonly<Record<string, StyleValue>>, children: string | undefined, bound?: Binding): string {
  if (bound === undefined) return element('mxCell', attributes, children);
  const { id, value, ...rest } = attributes;
  return element('object', { id, label: value ?? '', ...bound }, element('mxCell', rest, children));
}

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

/**
 * Label text for a plain-text cell: the lines as they are, one `\n` apart. The attribute serializer
 * writes a line break as `&#10;`, so the break survives the XML, and nothing here is markup.
 */
const plainText = (lines: readonly string[]): string => lines.join('\n');

/** The lines a label draws, which is none for an empty label. */
const labelLines = (label: LayoutLabel): readonly string[] => label.lines ?? (label.text === '' ? [] : [label.text]);

/**
 * A quantity a model states, or one derived from it, kept finite: no draw.io attribute can carry an
 * infinity, and a model far outside the contract is better exported than refused.
 */
const finite = (value: number): number => Number.isFinite(value) ? value : 0;

/** The size `render` draws a label at when the label does not state its own. */
const labelSize = (label: LayoutLabel): number => finite(label.fontSize ?? 9);

/**
 * draw.io's own line pitch for plain text, `round(fontSize × 1.2)`. It takes no `lineHeight` from a
 * style, so a wrapped label keeps its first baseline exact and its further lines move by the
 * difference to the measured pitch (Verdana: `ceil(1.215 × size)`): a pixel a line at 7, 10, 11 and
 * 12 px type, nothing at 8 and 9 px.
 */
const plainPitch = (fontSize: number): number => Math.round(fontSize * 1.2);

/** The size the font table is read at for `firstBaseline`, large enough that its rounding is lost. */
const METRIC_SIZE = 1000;

/**
 * Where `render` puts a label's first baseline, as an offset from the centre of its measured box,
 * along the text's own vertical — the same arithmetic as the SVG renderer's `textElement`. A
 * rotated box is already rotated, so a quarter turn takes its height from the box's width, and any
 * other angle from the line pitch.
 */
function firstBaseline(label: LayoutLabel, size: number): number {
  const lines = labelLines(label);
  const angle = label.textRotation ?? 0, box = label.bounds!;
  // The font table is read once at a fixed size and scaled, so a size far outside the contract is
  // exported rather than refused.
  const unit = measureText('', { fontSize: METRIC_SIZE, weight: label.fontWeight === 700 ? 700 : 400 });
  const pitch = label.lineHeight ?? finite(Math.ceil(unit.lineHeight / METRIC_SIZE * size));
  const height = angle === -90 || angle === 90 ? box.width : angle !== 0 ? pitch * lines.length : box.height;
  return finite(-height / 2 + finite(unit.ascent / METRIC_SIZE * size));
}

/**
 * The `spacingTop` that puts a middle-aligned plain-text label's first baseline where `render` puts
 * it. draw.io centres a block of plain text in the label box, and sets the first baseline at
 * `centre + size − 1 − (size + (lines − 1) × pitch) / 2`, plus half of `spacingTop − spacingBottom`
 * — on a vertex, a turned vertex, a swimlane head, an edge and a child edge label alike, along the
 * text's own vertical. An edge's own `horizontal=0` label is the one exception and takes the value
 * as `spacingLeft` (`labelStyle`). `offset` is how far the box draw.io centres on lies below the
 * label's own centre, for a cell whose box is larger than the label. Measured against
 * drawio-desktop 31.4.5.
 */
function middleSpacing(label: LayoutLabel, size: number, offset = 0): number | undefined {
  if (!label.bounds) return undefined;
  const lines = Math.max(1, labelLines(label).length);
  const drawn = size - 1 - (size + (lines - 1) * plainPitch(size)) / 2;
  return finite(2 * (firstBaseline(label, size) - offset - drawn));
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
const outlinedFill = (theme: Theme, of: ThemeMode, washes: WashAssignment, nodeClass?: string): string => themeWashFill(theme, washToken(nodeClass), of, washes);

const centre = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
/** The cell of a label at `box`: the turned label's text rectangle about the box centre (`turnedSize`), or the box. */
const turnedCell = (label: LayoutLabel, box: Rect): Rect => {
  if (label.turnedSize === undefined) return box;
  const middle = centre(box);
  return { x: middle.x - label.turnedSize.width / 2, y: middle.y - label.turnedSize.height / 2, ...label.turnedSize };
};
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
  // The document's theme (ticket 158); `--theme` picks the mode of it, never the theme.
  const theme: Theme = themeById(layout.document.theme);
  const paint = dual(of => theme.paint[of]);
  const washes = washAssignment(orderedNodeIds(layout.document).map(id => authorClass(layout.document.nodes[id]!.class)));
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
    extra: Readonly<Record<string, StyleValue>> = {}, bound?: Binding): void => {
    cells.push(cellElement({ id: claim(id), value, style, vertex: 1, parent, ...extra },
      element('mxGeometry', { x: box.x, y: box.y, width: box.width, height: box.height, as: 'geometry' }), bound));
  };

  // ---- binding ------------------------------------------------------------------------------
  // The ids a dashboard binds to. A link's id comes from its ends, not from its place in the YAML,
  // so reordering the links does not move a binding; the layout model keeps its positional ids.
  const stableIds = linkIds(document);
  const stableId = (link: LayoutLink): string => stableIds[link.sourceIndex] ?? link.id;
  const linkBinding = (link: LayoutLink, run?: { index: number; count: number }): Binding => {
    const source = document.links[link.sourceIndex];
    return binding({
      'pg-kind': 'link', 'pg-id': stableId(link),
      'pg-from': endpointId(source?.from ?? link.from), 'pg-to': endpointId(source?.to ?? link.to),
      ...(run ? { 'pg-run': String(run.index), 'pg-runs': String(run.count) } : {}),
    }, source?.meta);
  };

  /** A text cell placed at exactly the box stage 9 measured, so no label is re-flowed on open. */
  const textCell = (id: string, parent: string, label: LayoutLabel, box: Rect, colour: string,
    size = labelSize(label), backdrop?: string): void => {
    // draw.io turns a cell's own rectangle about its centre. A turned label (ticket 20) records its
    // text rectangle (`turnedSize`), so the cell is that rectangle about the box centre, and draw.io
    // turns the rectangle the text really occupies. Any other label's `bounds` is its box: a quarter
    // turn keeps it, as the SVG renderer does. `rotation` is clockwise-positive in both formats, and
    // it takes every reserved angle — a straight bundle member's label is rotated to its own run
    // (ADR-0017), not to a quarter turn.
    // `spacingTop` turns with the text, so one value puts the first baseline where `render` does.
    vertex(id, parent, styleString(['text'], {
      strokeColor: 'none', fillColor: 'none', align: 'center', verticalAlign: 'middle',
      whiteSpace: 'nowrap', overflow: 'visible', points: '[]', resizable: 0,
      spacingTop: middleSpacing(label, size),
      fontFamily: FONT_FAMILY, fontSize: size, fontColor: colour,
      fontStyle: label.fontWeight === 700 ? 1 : undefined,
      rotation: label.textRotation ? label.textRotation : undefined,
      labelBackgroundColor: backdrop,
    }), turnedCell(label, box), plainText(labelLines(label)));
  };

  // ---- paint resolution -------------------------------------------------------------------
  // There is no resolved paint on the model: the SVG renderer states the palette as a class
  // cascade and lets the reader resolve it. A draw.io cell carries its own colours, so the same
  // cascade is walked here, in the sheet's own order — base, then node class, then port role,
  // then port status — because a later rule of equal specificity wins there.

  const nodeClassOf = (id: string): string | undefined => authorClass(document.nodes[id]?.class);

  const pillPaintIn = (of: ThemeMode, nodeClass: string | undefined, port: LayoutPort):
  { fill: string; stroke: string; text: string; dash: string | undefined; opacity: number | undefined } => {
    let result = { ...theme.paint[of].pill, dash: undefined as string | undefined, opacity: undefined as number | undefined };
    const known = theme.classPaint(nodeClass, of);
    if (known) result = { ...result, ...known.pill };
    for (const token of portTokens(port)) {
      const role = themePortRole(theme, token);
      if (!role) continue;
      const rolePaint = portRolePaint(role, of);
      result = rolePaint.stroke === undefined
        ? { ...result, fill: rolePaint.fill, text: rolePaint.text }
        : { ...result, fill: outlinedFill(theme, of, washes, nodeClass), stroke: rolePaint.stroke };
    }
    for (const token of portTokens(port)) {
      const status = theme.portStatus.find(([name]) => name === token)?.[1];
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
    fillColor: paint.background, strokeColor: 'none', points: '[]',
    pointerEvents: 0, locked: 1, movable: 0, resizable: 0, deletable: 0, editable: 0, connectable: 0,
  }), { x: 0, y: 0, width: canvas.width, height: canvas.height });

  // ---- groups and their nodes ---------------------------------------------------------------
  // A frame is drawn in its cells' place, and a cell never is (ranked-groups spec, section 2). A parent
  // frame comes before its child, and a box that lies on another after it (frame-order.ts).
  const shapes = groupShapes(layout);
  /**
   * The halo of a text outside node bodies (ticket 162), as draw.io can state it. A plain-text label has no outline: `textShadow` with no
   * offset draws a soft glow through which a crossing line still shows (measured with the drawio CLI, 2026-10-31), so a text in the
   * labels layer takes a backdrop in the colour behind it instead (`backdropColour`, the SVG halo's colour). A group title lies in the
   * diagram layer, under the links, and no backdrop of its own can cover a line drawn above it.
   */
  const backdrop = (point: Point): string => dual(of => backdropColour(theme.paint[of], boxesBehind(shapes, point)));
  // A frame nests as the model nests it: a zone in a location, a location in a continent. Its cell is a
  // child of its parent frame's cell, stated from that cell's top-left, so a parent moved by hand carries
  // its children; a group that no frame holds stays on the diagram layer. `startSize` shifts nothing here.
  const frameBox = new Map((layout.frames ?? []).map(frame => [frame.id, shiftRect(frame.box)]));
  const frameParent = new Map((layout.frames ?? []).filter(frame => frame.parent !== undefined && frameBox.has(frame.parent))
    .map(frame => [frame.id, frame.parent!]));
  const groupTitle = (owner: string): LayoutLabel | undefined =>
    layout.labels.find(label => label.role === 'group' && !label.omitted
      && label.owner.kind === 'group' && label.owner.id === owner);

  for (const { id, bounds, frame } of shapes) {
    const box = shiftRect(bounds);
    const band = layout.labelBands.find(item => item.group === id);
    const title = groupTitle(band?.host ?? id);
    // A swimlane's title is its own value, which is what makes the group editable as a group. The
    // band is only handed to draw.io when the reserved band really does hold a centred title:
    // otherwise the title keeps its measured box as a text cell and the container stays plain.
    // A frame's band sits in one of its cells, so it must also span the frame edge to edge.
    const centred = band !== undefined && title !== undefined
      && Math.abs(centre(title.bounds!).x - centre(band.bounds).x) <= 0.5
      && Math.abs(centre(title.bounds!).y - centre(band.bounds).y) <= 0.5
      && (!frame || (Math.abs(band.bounds.x - bounds.x) <= 0.5 && Math.abs(band.bounds.width - bounds.width) <= 0.5
        && Math.abs(band.side === 'top' ? band.bounds.y - bounds.y
          : band.bounds.y + band.bounds.height - bounds.y - bounds.height) <= 0.5));
    const swimlane = centred ? band! : undefined;
    const style = swimlane
      ? styleString(['swimlane'], {
        whiteSpace: 'nowrap', container: 1, collapsible: 0, rounded: 1,
        absoluteArcSize: 1, arcSize: theme.radii.group * 2,
        horizontal: 1, startSize: swimlane.bounds.height,
        // `flipV` mirrors the shape paths only — the label group is rendered outside the flip, so
        // a bottom band keeps upright text, which `direction=south` would not.
        flipV: swimlane.side === 'bottom' ? 1 : undefined,
        align: 'center', verticalAlign: 'middle',
        // The head is centred on the band, which may sit up to half a pixel off the title's centre.
        spacingTop: middleSpacing(title!, labelSize(title!), centre(swimlane.bounds).y - centre(title!.bounds!).y),
        fontFamily: FONT_FAMILY, fontSize: labelSize(title!), fontColor: paint.group.text,
        fontStyle: title!.fontWeight === 700 ? 1 : undefined,
        swimlaneLine: 0,
        // On a swimlane `fillColor` paints the head and `swimlaneFillColor` the body, the reverse
        // of what the format's own style reference says. Both take the group fill.
        fillColor: paint.group.fill, swimlaneFillColor: paint.group.fill,
        strokeColor: paint.group.stroke, fillOpacity: Math.round(paint.group.fillOpacity * 100),
      })
      : styleString([], {
        container: 1, collapsible: 0, rounded: 1,
        absoluteArcSize: 1, arcSize: theme.radii.group * 2,
        fillColor: paint.group.fill, strokeColor: paint.group.stroke,
        fillOpacity: Math.round(paint.group.fillOpacity * 100),
        verticalAlign: 'top', align: 'center',
      });
    const holder = frame ? frameParent.get(id) : undefined;
    vertex(cellId('group', id), holder === undefined ? layerId('diagram') : cellId('group', holder), style,
      holder === undefined ? box : relative(box, frameBox.get(holder)!), swimlane ? plainText(labelLines(title!)) : undefined);
    if (title && !swimlane) {
      textCell(cellId('groupTitle', id), cellId('group', id), title,
        relative(shiftRect(title.bounds!), box), paint.group.text);
    }
  }

  const symbolIds = nodeSymbolIds(layout);
  for (const id of orderedNodeIds(document)) {
    const node = layout.nodes[id]!;
    // A node hangs under its frame when its cell has one, and under its own group otherwise.
    const cell = layout.groups[document.nodes[id]!.group]!;
    const frame = cell.frame === undefined ? undefined : layout.frames?.find(item => item.id === cell.frame);
    const group = cellId('group', frame?.id ?? cell.id);
    const box = shiftRect(node.bounds!);
    const origin = shift(frame?.box ?? cell.bounds!);
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
    // The node's name is the node's own label: a shape carries its text in draw.io, and a reader
    // who double-clicks the node expects to be renaming the node. The description is a second,
    // unbound text cell inside the node. Plain text has one font per cell, and a 400-weight 7 px
    // description in the name's cell would draw at the name's 700-weight 9 px. As a child of the
    // node it still moves and copies with it.
    const named = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'node' && !item.omitted && labelLines(item).length > 0);
    const described = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'description' && !item.omitted && labelLines(item).length > 0);
    const nameSize = named === undefined ? NODE_NAME_SIZE : finite(named.fontSize ?? NODE_NAME_SIZE);
    // Stage 3 sized the box around the name and stage 9 measured where it sits. draw.io sets a
    // top-aligned plain label's first baseline at `spacing + baseSpacingTop + spacingTop + size − 1`
    // below the shape, so `spacingTop` states the rest of the measured offset in full — measured
    // against drawio-desktop 31.4.5. The baseline itself is `render`'s.
    const top = named === undefined ? undefined
      : finite(centre(named.bounds!).y + firstBaseline(named, nameSize) - node.bounds!.y
        - LABEL_SPACING - BASE_SPACING_TOP - (nameSize - 1));
    const across = named === undefined ? 0 : finite(centre(named.bounds!).x - centre(node.bounds!).x);
    vertex(cellId('node', id), group, styleString([], {
      // A node really does contain its ports and its icon, so it says so: a container moves,
      // copies and accepts a drop as one thing, which is what a node is.
      container: 1, collapsible: 0, recursiveResize: 0,
      rounded: 1, absoluteArcSize: 1, arcSize: theme.radii.node * 2,
      whiteSpace: 'nowrap', fillColor: dual(of => themeWashFill(theme, washToken(authored), of, washes)), strokeColor: paint.node.stroke,
      strokeWidth: node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node,
      points: `[${[...anchors].join(',')}]`,
      ...(named === undefined ? {} : {
        align: 'center', verticalAlign: 'top', overflow: 'visible',
        // The offset is signed. draw.io honours a negative `spacingTop` — measured — and a node
        // whose first line starts within 7 px of its top edge needs one.
        spacingTop: top,
        // A name may stand off the node's centre — clear of a pill on the same row — and `render`
        // centres it on its own measured box, as the description cell is. Centred text moves by
        // half of `spacingLeft − spacingRight`, and only the positive side is stated.
        ...(across > 0 ? { spacingLeft: finite(2 * across) } : across < 0 ? { spacingRight: finite(-2 * across) } : {}),
        fontFamily: FONT_FAMILY, fontSize: nameSize, fontColor: paint.node.text,
        fontStyle: (named.fontWeight ?? 700) === 700 ? 1 : undefined,
      }),
    }), relative(box, origin), named === undefined ? undefined : plainText(labelLines(named)), {},
    binding({
      'pg-kind': 'node', 'pg-id': id,
      // The legend's own id for this node's symbol, without its `symbol:` prefix, so the two cannot drift.
      ...(symbolIds.has(id) ? { 'pg-symbol': part(symbolIds.get(id)!.slice('symbol:'.length)) } : {}),
    }, document.nodes[id]?.meta));
    if (described !== undefined) {
      textCell(cellId('nodeDescription', id), cellId('node', id), described,
        relative(shiftRect(described.bounds!), shift(node.bounds!)), paint.node.description,
        finite(described.fontSize ?? NODE_DESCRIPTION_SIZE));
    }

    if (node.icon) {
      const tile = relative(shiftRect(node.icon.bounds), shift(node.bounds!));
      const pick = (of: ThemeMode): { tile: { fill: string; stroke: string }; glyph: string } => {
        return theme.classPaint(authored, of) ?? { tile: theme.paint[of].tile, glyph: theme.paint[of].glyph };
      };
      const resolved = dual(pick);
      const native = iconSet === 'cisco19' ? CISCO19[iconKey(node.icon.icon)] : undefined;
      // The icon is bound like a link label: by the node it belongs to, so a dashboard can colour
      // the icon rather than the whole node. The tile behind a silhouette stays unbound.
      const iconBinding: Binding = { 'pg-kind': 'node-icon', 'pg-of': id };
      if (native) {
        // A badge carries its own frame, so it replaces the tile; a silhouette keeps it.
        if (native.kind === 'silhouette' && positive(tile)) {
          vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
            rounded: 1, absoluteArcSize: 1, arcSize: theme.radii.tile * 2,
            fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
          }), tile);
        }
        // A tile with no room for the glyph inset leaves the glyph out. Subtracting the inset from
        // a tile thinner than it gives a negative width, which draw.io writes and then draws as
        // nothing at all — so the whole icon would go, silently, rather than just the inset.
        const box = glyphBox(tile, native);
        if (box) {
          vertex(cellId('icon', id), cellId('node', id), styleString([], {
            sketch: 0, aspect: 'fixed', points: '[]',
            shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
            ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
            // On a badge `fillColor` is the frame and `strokeColor` is the glyph; a silhouette is
            // filled with the glyph colour and has no frame to stroke.
            fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
            strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
          }), box, undefined, {}, iconBinding);
        }
      } else {
        if (positive(tile)) {
          vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
            rounded: 1, absoluteArcSize: 1, arcSize: theme.radii.tile * 2,
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
            shape: 'image', imageAspect: 0, points: '[]',
            image: svgImage(glyph),
          }), inner, undefined, {}, iconBinding);
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
        rounded: 1, absoluteArcSize: 1, arcSize: port.pill.radius * 2,
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
          // `horizontal=0` turns `spacingTop` with the text, as `rotation=` does.
          spacingTop: shown.bounds && middleSpacing(shown, labelSize(shown), port.pill.textRotation === -90
            ? centre(port.pill.bounds).x - centre(shown.bounds).x : centre(port.pill.bounds).y - centre(shown.bounds).y),
          fontFamily: FONT_FAMILY, fontSize: labelSize(shown), fontColor: resolved.text,
          fontStyle: shown.fontWeight === 700 ? 1 : undefined,
          horizontal: port.pill.textRotation === -90 ? 0 : undefined,
        } : {}),
      }), relative(shiftRect(port.pill.bounds), shift(node.bounds!)),
      shown ? plainText(labelLines(shown)) : undefined, {},
      binding({
        'pg-kind': 'port', 'pg-id': endpointId({ node: id, name: port.ref.name!, ordinal: port.ref.ordinal }),
        'pg-node': id, 'pg-port': port.ref.name!,
      }, document.nodes[id]?.ports.find(item => item.name === port.ref.name && item.ordinal === port.ref.ordinal)?.meta));
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
  { cell: string; style: Readonly<Record<string, StyleValue>>; at: Point; anonymous?: true } | undefined => {
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
    }), at: shift(port.anchor), ...(port.ref.anonymous === true ? { anonymous: true as const } : {}) };
  };

  /**
   * The marker an anonymous end carries (`render.anonymousPortMarker`, default `dot`): a filled oval in the edge stroke, so the end
   * does not look unfinished beside a pill. Which ends are bare is `dotEnds`, the predicate the SVG shares. An end on a port cell is
   * unchanged. Paint only; no point or cell moves. The oval is stated on the connector whatever its `edgeStyle` is.
   */
  const dotMarker = (link: LayoutLink, end: 'from' | 'to'): Readonly<Record<string, StyleValue>> => {
    if (!dotEnds(layout.document, link).includes(end)) return {};
    const side = end === 'from' ? 'start' : 'end';
    return { [`${side}Arrow`]: 'oval', [`${side}Fill`]: 1, [`${side}Size`]: ANONYMOUS_DOT_SIZE };
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

  /**
   * The shape a link-end mark belongs to: the port's pill, at its outward point, or for a port that
   * draws no pill the port's node, with the mark staying where the model put it. Either way the mark is a
   * child of that shape and stated from its top-left, so the shape carries it. Only a port whose node
   * the model does not hold leaves the mark on the overlay layer.
   */
  const markHost = (ref: { node: string; name?: string; ordinal: number }): { cell: string; box: Rect; at?: Point } | undefined => {
    const pill = pillEnd(ref);
    if (pill) return pill;
    const bounds = layout.nodes[ref.node]?.bounds;
    return bounds ? { cell: cellId('node', ref.node), box: shiftRect(bounds) } : undefined;
  };

  const edgeCell = (id: string, layer: string, style: string, points: readonly Point[],
    ends: { source?: string | undefined; target?: string | undefined;
      sourcePoint?: Point | undefined; targetPoint?: Point | undefined },
    label?: { value: string; at: EdgeLabel }, bound?: Binding): void => {
    const waypoints = points.length > 2
      ? element('Array', { as: 'points' },
        points.slice(1, -1).map(point => element('mxPoint', { x: point.x, y: point.y })).join(''))
      : '';
    const dangling = (ends.sourcePoint ? element('mxPoint', { x: ends.sourcePoint.x, y: ends.sourcePoint.y, as: 'sourcePoint' }) : '')
      + (ends.targetPoint ? element('mxPoint', { x: ends.targetPoint.x, y: ends.targetPoint.y, as: 'targetPoint' }) : '');
    cells.push(cellElement({ id: claim(id), value: label?.value, style, edge: 1, parent: layer,
      source: ends.source, target: ends.target },
    element('mxGeometry', { ...(label ? { x: label.at.x, y: label.at.y } : {}), relative: 1, as: 'geometry' },
      waypoints + dangling + residualPoint(label?.at)), bound));
  };

  // A mesh bus member is not a connector of its own: the bus is a bar and its stubs, exported below (mesh-bus.md, section 6).
  const drawn = layout.links.filter(link => link.technique !== 'stub' && link.path && link.meshBus === undefined && visible(link));
  /** Every connector a link became, with the polyline draw.io will really draw for each. */
  const edgeRuns = new Map<string, Connector[]>();

  /** Where a link label sits: on its supporting segment, or the box stage 9 measured. */
  const labelPoint = (label: LayoutLabel, link: LayoutLink): Point => {
    const measured = centre(shiftRect(label.bounds!));
    if (placement !== 'on-run' || label.support?.kind !== 'link-segment') return measured;
    const first = link.path!.segments[label.support.segment], last = link.path!.segments[label.support.through ?? label.support.segment];
    if (first === undefined || last === undefined) return measured;
    const support = { from: first.from, to: last.to };
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
  const labelStyle = (label: LayoutLabel, at: Point, carrier: 'edge' | 'child', link: LayoutLink): Readonly<Record<string, StyleValue>> => {
    // A label on a direct line (ticket 16) lies on it in either mode, so it always hides the line behind its glyphs.
    const segment = label.support?.kind === 'link-segment' ? link.path?.segments[label.support.segment] : undefined;
    const on = label.support?.kind === 'link-segment' && (placement === 'on-run' || label.onLine === true && segment !== undefined && isDirect(segment));
    const multiplicity = label.support?.kind === 'merge-run';
    return {
      // A label hides a line behind its glyphs (ticket 16 on its own line, ticket 162 under a diagonal that crosses it), and the honest
      // colour to do that with is whatever is really behind it: the group fills composited over the canvas, or the canvas (`backdrop`).
      labelBackgroundColor: backdrop({ x: at.x + canvas.x, y: at.y + canvas.y }),
      ...(on ? { spacing: LABEL_MARGIN } : {}),
      align: 'center', verticalAlign: 'middle',
      fontFamily: FONT_FAMILY, fontSize: labelSize(label),
      fontColor: multiplicity ? paint.link.multiplicity : paint.link.label,
      fontStyle: label.fontWeight === 700 ? 1 : undefined,
      // The label is centred on its point, and the shift that puts its baseline where `render`
      // does turns with the text — except on an edge's own `horizontal=0` label, which draw.io
      // shifts by `spacingLeft` instead: measured, `spacingTop` there moves it along its own line.
      ...(carrier === 'edge'
        ? label.textRotation === -90
          ? { horizontal: 0, spacingLeft: middleSpacing(label, labelSize(label)) }
          : { spacingTop: middleSpacing(label, labelSize(label)) }
        : { rotation: label.textRotation ? label.textRotation : undefined, spacingTop: middleSpacing(label, labelSize(label)) }),
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
   * the label on it when the diagram is edited.
   */
  const supportIn = (label: LayoutLabel, link: LayoutLink, run: Run): readonly [number, number] | undefined => {
    if (label.support?.kind !== 'link-segment') return undefined;
    // A label on a joined run of collinear pieces (ticket 142) may be attached to any of them: the
    // remainder rule picks the piece the label stands on, not the first.
    const first = Math.max(label.support.segment, run.first), last = Math.min(label.support.through ?? label.support.segment, run.last);
    return first <= last ? [first - run.first, last - run.first] : undefined;
  };

  const taken = new Set<string>();
  for (const link of drawn) {
    const layer = effectiveLayer(link) === 'overlay' ? layerId('overlay') : layerId('links');
    const authored = linkClass(link);
    const klass = themeLinkClass(theme, authored);
    const overlay = effectiveLayer(link) === 'overlay';
    // An overlay link of a class the theme names (`signal`) states that class's stroke and dash, as the SVG's
    // `.link-line.<class>` rule beats `.overlay-line`; sync, flow and unknown classes keep the overlay stroke.
    const themed = authored !== undefined && theme.linkClasses.some(([key]) => key === authored);
    const runs = polylines(link.path!.segments);
    const from = link.attachments?.from, to = link.attachments?.to;
    const head = from ? terminal('exit', from) : undefined;
    const tail = to ? terminal('entry', to) : undefined;
    const headHost = overlay && from ? markHost(from) : undefined;
    const tailHost = overlay && to ? markHost(to) : undefined;
    // What draw.io draws is not what the model holds: a pinned end sits on the pill's outward edge,
    // not on the port anchor the waypoints start from. An edge label's coordinates are fractions of
    // that drawn polyline, so it is resolved here — the waypoints themselves are untouched.
    const shown: Connector[] = runs.map((run, index) => {
      const points = [...run.points];
      if (index === 0 && head) points[0] = head.at;
      if (index === runs.length - 1 && tail) points[points.length - 1] = tail.at;
      return {
        id: runs.length === 1 ? cellId('link', stableId(link)) : cellId('link', stableId(link), String(index)),
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
      const points = run.points;
      // A square route is a square connector: draw.io then keeps it square when a pill or a node is
      // moved by hand, where `edgeStyle=none` leaves a diagonal stub. The orthogonal router draws
      // the supplied waypoints and does not re-route them, and `jettySize=0` keeps it from adding a
      // stub of its own; see fact 1 in the header for the numbers. A polyline that is not
      // axis-aligned is outside that router's vocabulary, so it keeps `edgeStyle=none`. Either
      // family reaches it: a routed declared straight bundle member (ADR-0017) and an overlay link
      // the straight branch answered with an angled segment. See fact 1 for the four in the corpus.
      //
      // Both polylines are tested, because they differ: the waypoints exactly, and the polyline
      // draw.io really draws — the pinned terminals included — within the endpoint tolerance. A port
      // that draws no pill terminates on its node's box, which can leave the drawn line diagonal
      // while every waypoint is square, and that is a corner the router would invent.
      //
      // A run with no bend is the exception (maintainer, 2026-10-23): it is a straight connector,
      // `edgeStyle=none`, because a straight line is easier to edit in draw.io than an orthogonal one.
      // It is tested on both polylines, as `square` is. Only a run with a bend keeps the orthogonal style.
      const straight = isStraight(points) && isStraight(shown[index]!.points, SQUARE_ENDPOINT_TOLERANCE);
      const square = !straight && axisAligned(points) && axisAligned(shown[index]!.points, SQUARE_ENDPOINT_TOLERANCE);
      // A connector holds one polyline; a path whose segment chain breaks becomes one connector per
      // run, each dangling where the chain did. Only the ends that are really ends are pinned.
      const style = styleString([], {
        edgeStyle: square ? 'orthogonalEdgeStyle' : 'none',
        jettySize: square ? 0 : undefined,
        rounded: 0, endArrow: 'none', startArrow: 'none',
        strokeColor: dual(of => overlay && !themed ? theme.paint[of].overlay.stroke : klass.strokes[of]),
        strokeWidth: linkStrokeWidth(link),
        opacity: overlay ? Math.round(paint.overlay.opacity * 100) : undefined,
        ...dashEntries(overlay && !themed ? theme.paint[mode].overlay.dash : klass.dash),
        ...(source ? dotMarker(link, 'from') : {}),
        ...(target ? dotMarker(link, 'to') : {}),
        ...(source?.style ?? {}),
        ...(target?.style ?? {}),
        ...(carried ? labelStyle(carried.label, labelPoint(carried.label, link), 'edge', link) : {}),
      });
      edgeCell(id, layer, style, points, {
        source: source?.cell,
        target: target?.cell,
        sourcePoint: source ? undefined : points[0],
        targetPoint: target ? undefined : points[points.length - 1],
      }, carried ? {
        value: plainText(labelLines(carried.label)),
        at: carried.at,
      } : undefined, linkBinding(link, runs.length === 1 ? undefined : { index, count: runs.length }));
    });
    edgeRuns.set(link.id, shown);

    if (overlay) {
      // A mark that belongs to a shape is a child of that shape. The mark names the port the overlay
      // link ends on, so it is a child of that port's pill, stated from the pill's own top-left: a
      // pill moved by hand carries its mark with it, where an absolute mark stayed behind. A port
      // that draws no pill is a child of its node, stated from the node's top-left (issue 03), at the
      // point the model gives. It paints with its host now, not with the overlay layer.
      // On a pill the mark sits on the pill's outward point, where the connector really ends: the
      // anchor is the pill's centre, and a mark there covers the port's name (maintainer, 2026-09-15).
      const ends = link.path!.segments;
      const marks = [
        { end: 'from', at: ends[0]!.from, host: headHost },
        { end: 'to', at: ends[ends.length - 1]!.to, host: tailHost },
      ] as const;
      const bare = dotEnds(layout.document, link);
      for (const mark of marks) {
        // A bare end is closed by the connector's own oval, so it takes no second mark.
        if (bare.includes(mark.end) && (mark.end === 'from' ? head : tail)) continue;
        const at = mark.host?.at ?? shift(mark.at);
        const box = { x: at.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - OVERLAY_ENDPOINT_RADIUS,
          width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS };
        vertex(cellId('overlayMark', stableId(link), mark.end), mark.host?.cell ?? layerId('overlay'),
          styleString(['ellipse'], {
            fillColor: paint.overlay.mark, strokeColor: 'none', points: '[]',
          }), mark.host ? relative(box, mark.host.box) : box);
      }
    }
  }

  // ---- mesh buses ---------------------------------------------------------------------------
  // The bar is one edge with `edgeStyle=none` and two free points; each stub is an edge from its port's cell to a free point on the
  // bar, orthogonal with `jettySize=0`, as an axis-aligned overlay is exported. All take the class stroke and dash an overlay link
  // takes, on the overlay layer, and the label is a text vertex on the labels layer.
  for (const bus of layout.meshBuses ?? []) {
    if (bus.bar === undefined || bus.stubs === undefined) continue;
    const first = bus.members.map(id => byId.get(id)).find(link => link !== undefined && visible(link));
    if (first === undefined) continue;
    const authored = linkClass(first), klass = themeLinkClass(theme, authored);
    const themed = authored !== undefined && theme.linkClasses.some(([key]) => key === authored);
    const stroke = (square: boolean, extra: Readonly<Record<string, StyleValue>> = {}): string => styleString([], {
      edgeStyle: square ? 'orthogonalEdgeStyle' : 'none', jettySize: square ? 0 : undefined,
      rounded: 0, endArrow: 'none', startArrow: 'none',
      strokeColor: dual(of => !themed ? theme.paint[of].overlay.stroke : klass.strokes[of]),
      strokeWidth: linkStrokeWidth(first),
      opacity: Math.round(paint.overlay.opacity * 100),
      ...dashEntries(!themed ? theme.paint[mode].overlay.dash : klass.dash),
      ...extra,
    });
    // Every end of the bus geometry is a joint: a 2 px invisible, locked vertex, a child of a member's node or pill and
    // stated from its top-left, so a node dragged by hand carries its stub's end and its piece of the bar with it. A free
    // end (`sourcePoint`/`targetPoint`) stays behind, and draw.io shows it as a loose handle (issue 04).
    // The bar is one edge per pair of neighbouring joints, so a move bends the bar beside the moved node only, and every
    // stub stays on its own joint. Ids are `pg-busJoint~<bus>~<n>`, with `n` the joint's place along the bar: no author
    // name enters them, so no node name can collide with one.
    const JOINT = 2;
    type PortKey = { node: string; name?: string; ordinal: number };
    interface Spot { at: Point; ref: PortKey; id: string }
    /** The joints of one bus, left to right: a stub's end, the bar's two ends, and where a riser meets the bar. */
    const spots = (of: typeof bus): Spot[] => {
      if (of.bar === undefined || of.stubs === undefined) return [];
      const found: { at: Point; ref: PortKey }[] = [];
      const add = (at: Point, ref?: PortKey): void => {
        if (found.some(item => samePoint(item.at, at))) return;
        let host = ref, gap = Infinity;
        if (host === undefined) {
          for (const candidate of of.ports) {
            const bounds = layout.nodes[candidate.node]?.bounds;
            const distance = bounds ? Math.abs(bounds.x + bounds.width / 2 - canvas.x - at.x) : Infinity;
            if (distance < gap) { gap = distance; host = candidate; }
          }
        }
        if (host !== undefined && markHost(host) !== undefined) found.push({ at, ref: host });
      };
      for (const stub of of.stubs) add(shift(stub.to), of.ports.find(port => port.node === stub.node));
      add(shift(of.bar.from)); add(shift(of.bar.to));
      if (of.riser?.from !== undefined) add(shift(of.riser.from));
      const upper = layout.meshBuses?.find(other => other.joined === of.id && other.riser?.to !== undefined);
      if (upper?.riser?.to !== undefined) add(shift(upper.riser.to));
      found.sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y);
      return found.map((item, index) => ({ ...item, id: cellId('busJoint', of.id, String(index)) }));
    };
    const mine = spots(bus);
    const jointAt = (list: readonly Spot[], at: Point): string | undefined => list.find(item => samePoint(item.at, at))?.id;
    for (const spot of mine) {
      const host = markHost(spot.ref)!;
      const box = { x: spot.at.x - JOINT / 2, y: spot.at.y - JOINT / 2, width: JOINT, height: JOINT };
      vertex(spot.id, host.cell, styleString(['ellipse'], {
        fillColor: 'none', strokeColor: 'none', points: '[]',
        movable: 0, resizable: 0, rotatable: 0, editable: 0, connectable: 0, deletable: 0, pointerEvents: 0,
      }), relative(box, host.box));
    }
    /** The style that pins an edge end to the centre of its joint. */
    const centred = (end: 'exit' | 'entry'): Readonly<Record<string, StyleValue>> =>
      ({ [`${end}X`]: 0.5, [`${end}Y`]: 0.5, [`${end}Dx`]: 0, [`${end}Dy`]: 0, [`${end}Perimeter`]: 0 });
    const pinned = (from: string | undefined, to: string | undefined): Readonly<Record<string, StyleValue>> =>
      ({ ...(from ? centred('exit') : {}), ...(to ? centred('entry') : {}) });
    for (const stub of bus.stubs) {
      const ref = bus.ports.find(port => port.node === stub.node)!;
      const head = terminal('exit', ref), pill = markHost(ref);
      const to = shift(stub.to);
      const points = [head?.at ?? shift(stub.from), to];
      const end = jointAt(mine, to);
      // A stub is one straight run (port face to bar) and both its ends move with one node, so `edgeStyle=none` keeps it straight.
      edgeCell(cellId('busStub', bus.id, stub.node), layerId('overlay'), stroke(false, { ...(head?.style ?? {}), ...(end ? centred('entry') : {}) }), points,
        { source: head?.cell, target: end, sourcePoint: head ? undefined : points[0], targetPoint: end ? undefined : points[1] });
      const at = pill?.at ?? shift(stub.from);
      const box = { x: at.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - OVERLAY_ENDPOINT_RADIUS,
        width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS };
      vertex(cellId('busMark', bus.id, stub.node), pill?.cell ?? layerId('overlay'),
        styleString(['ellipse'], { fillColor: paint.overlay.mark, strokeColor: 'none', points: '[]' }),
        pill ? relative(box, pill.box) : box);
    }
    // The bar, one piece between each two neighbouring joints.
    for (let index = 0; index + 1 < mine.length; index++) {
      const a = mine[index]!, b = mine[index + 1]!;
      edgeCell(cellId('bus', bus.id, String(index)), layerId('overlay'), stroke(false, pinned(a.id, b.id)), [a.at, b.at],
        { source: a.id, target: b.id });
    }
    // The riser of a join is one more edge between the two bars, exported with the upper bus (mesh-bus.md, section 11.7);
    // each end is the joint the bar's own piece ends on.
    if (bus.riser?.from !== undefined && bus.riser.to !== undefined) {
      const riser = [shift(bus.riser.from), shift(bus.riser.to)];
      const lower = layout.meshBuses?.find(other => other.id === bus.joined);
      const riserFrom = jointAt(mine, riser[0]!), riserTo = lower ? jointAt(spots(lower), riser[1]!) : undefined;
      edgeCell(cellId('busRiser', bus.id), layerId('overlay'), stroke(false, pinned(riserFrom, riserTo)), riser,
        { source: riserFrom, target: riserTo, sourcePoint: riserFrom ? undefined : riser[0], targetPoint: riserTo ? undefined : riser[1] });
    }
    // The trunk of a three-row join is `N - 1` pieces, one per pair of neighbouring bars, exported with the head bus (mesh-bus.md, section 12.7);
    // each end is the joint where that bar ends at the trunk x, so a drag of a member node bends only the pieces that end on its joint.
    const joins = bus.trunk?.joins;
    if (bus.trunk !== undefined && joins !== undefined) {
      const bars = bus.trunk.buses.map(id => layout.meshBuses?.find(other => other.id === id));
      const ends = joins.map((at, index) => { const bar = bars[index]; return bar === undefined ? undefined : jointAt(spots(bar), shift(at)); });
      for (let index = 0; index + 1 < joins.length; index++) {
        const piece = [shift(joins[index]!), shift(joins[index + 1]!)], from = ends[index], to = ends[index + 1];
        edgeCell(cellId('busTrunk', bus.id, String(index)), layerId('overlay'), stroke(false, pinned(from, to)), piece,
          { source: from, target: to, sourcePoint: from ? undefined : piece[0], targetPoint: to ? undefined : piece[1] });
      }
    }
    const label = layout.labels.find(item => item.id === bus.label);
    if (label !== undefined && !label.omitted && label.bounds !== undefined) {
      textCell(cellId('busLabel', bus.id), layerId('labels'), label, shiftRect(label.bounds), paint.link.label, undefined, backdrop(centre(label.bounds)));
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
        paint.link.multiplicity, undefined, backdrop(centre(label.bounds)));
      continue;
    }
    const run = ids[runFor(label, link, ids)]!;
    const at = labelPoint(label, link);
    const relativeAt = edgeLabel(run.points, at, supportIn(label, link, run));
    const labelId = label.owner.kind === 'barCross' ? cellId('linkLabel', stableId(link), label.owner.node) : cellId('linkLabel', stableId(link));
    cells.push(cellElement({
      id: claim(labelId), value: plainText(labelLines(label)),
      style: styleString(['edgeLabel'], {
        // `edgeLabel` is a named style in draw.io's bundled sheet and brings
        // `labelBackgroundColor=default` with it — the white box the SVG does not draw.
        resizable: 0, points: '[]',
        // A child cell states its whole turn in `rotation=`, at any angle. `labelStyle` carries it.
        ...labelStyle(label, at, 'child', link),
      }),
      vertex: 1, connectable: 0, parent: run.id,
    }, element('mxGeometry', { x: relativeAt.x, y: relativeAt.y, relative: 1, as: 'geometry' },
      residualPoint(relativeAt) || undefined), { 'pg-kind': 'link-label', 'pg-of': stableId(link) }));
  }

  // ---- legend -------------------------------------------------------------------------------
  if (layout.legend) {
    const box = shiftRect(layout.legend.bounds);
    vertex(cellId('legend'), layerId('legend'), styleString(['group'], { points: '[]' }), box);
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
        fillColor: 'none', strokeColor: 'none', points: '[]',
        ...(shown ? {
          align: 'left', verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'visible',
          spacingLeft: shiftRect(shown.bounds!).x - outer.x - LABEL_SPACING,
          // The row is centred on the swatch and the caption together, not on the caption alone.
          spacingTop: middleSpacing(shown, labelSize(shown), centre(outer).y - centre(shiftRect(shown.bounds!)).y),
          fontFamily: FONT_FAMILY, fontSize: labelSize(shown), fontColor: paint.legend.text,
          fontStyle: shown.fontWeight === 700 ? 1 : undefined,
        } : {}),
      }), row, shown ? plainText(labelLines(shown)) : undefined);
      const swatch = relative(shiftRect(entry.swatch), outer);
      if (entry.kind === 'line') {
        const klass = entry.key === LEGEND_DEFAULT_CLASS ? themeLinkClass(theme, undefined) : themeLinkClass(theme, entry.key);
        // `shape=line` draws the sample across its own box, so the swatch is a vertex like every
        // other one and sits in the row rather than floating over it.
        vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
          shape: 'line', points: '[]',
          strokeColor: dual(of => klass.strokes[of]), strokeWidth: entry.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path,
          ...dashEntries(klass.dash),
        }), swatch);
      } else if (entry.kind === 'port') {
        const role = themePortRole(theme, entry.key);
        // The legend has to name what the diagram draws, so an outlined role's swatch takes the
        // same opaque body the pill takes; see `outlinedFill`.
        const resolved = role ? dual(of => {
          const rolePaint = portRolePaint(role, of);
          return rolePaint.stroke === undefined ? rolePaint
            : { ...rolePaint, fill: outlinedFill(theme, of, washes) };
        }) : undefined;
        vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
          rounded: 1, absoluteArcSize: 1,
          arcSize: (entry.radius ?? CORNER_RADII.pill) * 2,
          fillColor: resolved?.fill ?? paint.pill.fill,
          strokeColor: resolved?.stroke ?? paint.pill.stroke,
          strokeWidth: DEFAULT_STROKE_WIDTHS.pill, points: '[]',
        }), swatch);
      } else if (entry.icon) {
        // The key shows the class's body wash behind its tile, as a node of the class shows it.
        const body = swatch, grow = 2;
        vertex(cellId('legendBody', entry.id), cellId('legendRow', entry.id), styleString([], {
          rounded: 1, absoluteArcSize: 1, arcSize: legendKeyRadius(theme, grow) * 2,
          fillColor: dual(of => themeWashFill(theme, washToken(authorClass(entry.key)), of, washes)), strokeColor: paint.node.stroke,
          strokeWidth: DEFAULT_STROKE_WIDTHS.pill, points: '[]',
        }), { x: body.x - grow, y: body.y - grow, width: body.width + 2 * grow, height: body.height + 2 * grow });
        const pick = (of: ThemeMode): { tile: { fill: string; stroke: string }; glyph: string } => {
          return theme.classPaint(entry.key, of) ?? { tile: theme.paint[of].tile, glyph: theme.paint[of].glyph };
        };
        const resolved = dual(pick);
        const native = iconSet === 'cisco19' ? CISCO19[iconKey(entry.icon)] : undefined;
        if (native) {
          // The legend has to name what the diagram draws, so it takes the same glyph — and the
          // same guard: a swatch with no room for the inset keeps its tile and drops the glyph,
          // rather than writing a negative box draw.io silently draws as nothing.
          if (native.kind === 'silhouette' && positive(swatch)) {
            vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
              rounded: 1, absoluteArcSize: 1, arcSize: theme.radii.tile * 2,
              fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
            }), swatch);
          }
          const box = glyphBox(swatch, native);
          if (box) {
            vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
              sketch: 0, aspect: 'fixed', points: '[]',
              shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
              ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
              fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
              strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
            }), box);
          }
        } else {
          if (positive(swatch)) {
            vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
              rounded: 1, absoluteArcSize: 1, arcSize: theme.radii.tile * 2,
              fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
            }), swatch);
          }
          const inner = shrink(swatch, ICON_INSET);
          if (inner) {
            const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
              + `<path d="${iconPath(entry.icon)}" fill="none" stroke="${pick(mode).glyph}"`
              + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
              shape: 'image', imageAspect: 0, points: '[]', image: svgImage(glyph),
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
    math: 0, shadow: 0, background: theme.paint[mode].background,
  }, element('root', {}, cellElement({ id: claim('0') }, undefined, binding({ 'pg-schema': BINDING_SCHEMA }, document.meta))
    + layers + cells.join('')));
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
function edgeLabel(points: readonly Point[], at: Point, support?: readonly [number, number]): EdgeLabel {
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
    if (support !== undefined && index - 1 >= support[0] && index - 1 <= support[1] && span > 0 && closer(candidate, onSupport)) onSupport = candidate;
  }
  const chosen = onSupport ?? best!;
  if (chosen.left <= EPS) return chosen.label;
  const drawn = decodeEdgeLabel(points, chosen.label);
  return { ...chosen.label, offset: { x: at.x - drawn.x, y: at.y - drawn.y } };
}

