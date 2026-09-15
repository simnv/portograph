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
 * 1. `edgeStyle=none` is the only setting that reproduces supplied waypoints. Every registered edge
 *    style treats them as *hints* and re-routes, which would discard the reserved geometry.
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
import { FONT_FAMILY } from '../text/index.js';
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

/** A side's outward direction as a fraction of a box: the point a link leaves its port from. */
const OUTWARD: Readonly<Record<Side, Point>> = {
  top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 }, right: { x: 1, y: 0.5 },
};

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
   * Which glyphs the icons use. `profile` draws the network profile's own five, as the SVG does.
   * `cisco19` uses draw.io's bundled Cisco-19 shapes where one matches, which are native shapes and
   * so take the palette — and therefore adapt to dark, which an embedded image never can.
   */
  icons?: 'profile' | 'cisco19';
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

/** A data URI draw.io can use as an image, with no `;` or `=` to break the style string. */
const svgImage = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;

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
  const iconSet = options.icons ?? 'profile';
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
        : { ...result, fill: 'none', stroke: rolePaint.stroke };
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
    const anchors = node.ports.filter(port => port.anchor !== undefined).map(port => {
      const at = port.anchor!;
      return `[${num((at.x - node.bounds!.x) / node.bounds!.width)},`
        + `${num((at.y - node.bounds!.y) / node.bounds!.height)},0]`;
    });
    // Beyond the ports in use, each side offers the rest of its own grid: the slots `sidePitch`
    // divides that side into. A hand-placed pill or a hand-drawn connector then lands where the
    // pipeline would have put one, instead of wherever the pointer was.
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const pitch = node.sidePitch?.[side];
      if (pitch === undefined || pitch <= 0) continue;
      const along = side === 'top' || side === 'bottom' ? node.bounds!.width : node.bounds!.height;
      const base = side === 'top' || side === 'bottom' ? node.bounds!.x : node.bounds!.y;
      const fixed = side === 'left' ? 0 : side === 'right' ? 1 : side === 'top' ? 0 : 1;
      for (let at = base + pitch; at < base + along - 1e-6; at += pitch) {
        const fraction = (at - base) / along;
        const taken = node.ports.some(port => port.anchor !== undefined && port.side === side
          && Math.abs((side === 'top' || side === 'bottom' ? port.anchor.x : port.anchor.y) - at) < 1e-6);
        if (taken) continue;
        anchors.push(side === 'top' || side === 'bottom'
          ? `[${num(fraction)},${num(fixed)},0]` : `[${num(fixed)},${num(fraction)},0]`);
      }
    }
    // The node's name is the node's own label, and its description follows it in the same label:
    // a shape carries its text in draw.io, and a reader who double-clicks the node expects to be
    // renaming the node. The description is a styled line rather than a second cell, and its colour
    // is a CSS `light-dark()` so it adapts with everything else.
    const named = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'node' && !item.omitted);
    const described = layout.labels.find(item => item.owner.kind === 'node' && item.owner.id === id
      && item.role === 'description' && !item.omitted);
    const description = described === undefined ? '' : `<span style="font-size:`
      + `${num(described.fontSize ?? NODE_DESCRIPTION_SIZE)}px;color:${paint.node.description}">`
      + `${htmlText(described.lines ?? [described.text])}</span>`;
    const text = [named ? htmlText(named.lines ?? [named.text]) : '', description]
      .filter(part => part !== '').join('<br>');
    // Stage 3 sized the box around these lines and stage 9 measured where they sit; `spacingTop`
    // states that offset so draw.io lays them out from the same place rather than centring them.
    const top = named?.bounds ? named.bounds.y - node.bounds!.y - LABEL_SPACING : undefined;
    vertex(cellId('node', id), group, styleString([], {
      // A node really does contain its ports and its icon, so it says so: a container moves,
      // copies and accepts a drop as one thing, which is what a node is.
      html: 1, container: 1, collapsible: 0, recursiveResize: 0,
      rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.node * 2,
      whiteSpace: 'nowrap', fillColor: paint.node.fill, strokeColor: paint.node.stroke,
      strokeWidth: node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node,
      points: `[${anchors.join(',')}]`,
      ...(text === '' ? {} : {
        align: 'center', verticalAlign: 'top', overflow: 'visible',
        spacingTop: top === undefined ? undefined : Math.max(0, top),
        fontFamily: FONT_FAMILY, fontSize: named?.fontSize, fontColor: paint.node.text,
        fontStyle: named?.fontWeight === 700 ? 1 : undefined,
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
        if (native.kind === 'silhouette') {
          vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
            html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
            fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
          }), tile);
        }
        const box = letterbox(native.kind === 'badge' ? tile
          : { x: tile.x + ICON_INSET, y: tile.y + ICON_INSET,
            width: tile.width - 2 * ICON_INSET, height: tile.height - 2 * ICON_INSET }, native);
        vertex(cellId('icon', id), cellId('node', id), styleString([], {
          sketch: 0, html: 1, aspect: 'fixed', points: '[]',
          shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
          ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
          // On a badge `fillColor` is the frame and `strokeColor` is the glyph; a silhouette is
          // filled with the glyph colour and has no frame to stroke.
          fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
          strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
        }), box);
      } else {
        vertex(cellId('iconTile', id), cellId('node', id), styleString([], {
          html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
          fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
        }), tile);
        // A profile glyph is a stroked 24-unit path with no bundled equivalent, so it is carried as
        // its own image. An embedded image is the one thing here that cannot adapt to dark — draw.io
        // has no way into it — which is the reason `cisco19` exists as an option at all.
        const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
          + `<path d="${iconPath(node.icon.icon)}" fill="none" stroke="${pick(mode).glyph}"`
          + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        vertex(cellId('icon', id), cellId('node', id), styleString([], {
          shape: 'image', html: 1, imageAspect: 0, points: '[]',
          image: svgImage(glyph),
        }), { x: tile.x + ICON_INSET, y: tile.y + ICON_INSET,
          width: tile.width - 2 * ICON_INSET, height: tile.height - 2 * ICON_INSET });
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

  /** Where a link label sits: on its supporting segment, or the box stage 9 measured. */
  const labelPoint = (label: LayoutLabel, link: LayoutLink): Point => {
    const support = label.support?.kind === 'link-segment'
      ? link.path!.segments[label.support.segment] : undefined;
    const measured = centre(shiftRect(label.bounds!));
    if (placement !== 'on-run' || support === undefined) return measured;
    return shift(project({ x: measured.x + canvas.x, y: measured.y + canvas.y }, support));
  };

  /** The paint and turn a link label takes, wherever it is carried. */
  const labelStyle = (label: LayoutLabel, at: Point): Readonly<Record<string, StyleValue>> => {
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
      horizontal: label.textRotation === -90 || label.textRotation === 90 ? 0 : undefined,
    };
  };

  /**
   * The one label an edge can carry as its own. draw.io gives a shape its text, and an edge is a
   * shape: a reader who double-clicks a connector expects to be editing its label. A quarter turn
   * is `horizontal=0`, which — contrary to what the format's own notes suggest — really does rotate
   * an edge's own label; measured. Anything else, an arbitrary reserved angle or a second label on
   * one link, stays a child cell, which is draw.io's own answer for exactly those cases.
   */
  const ownLabel = new Map<string, LayoutLabel>();
  for (const label of layout.labels) {
    if (label.role !== 'link' || label.omitted || !label.bounds) continue;
    const owner = label.owner.kind === 'barCross' ? label.owner.link
      : label.owner.kind === 'link' ? label.owner.id : undefined;
    if (owner === undefined) continue;
    const turn = label.textRotation ?? 0;
    if (turn !== 0 && turn !== -90 && turn !== 90) continue;
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
    // What draw.io draws is not what the model holds: a pinned end sits on the pill's outward edge,
    // not on the port anchor the waypoints start from. An edge label's coordinates are fractions of
    // that drawn polyline, so it is resolved here — the waypoints themselves are untouched.
    const shown: Connector[] = runs.map((run, index) => {
      const points = [...run.points];
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
        ? { label: mine, at: edgeLabel(shown[index]!.points, labelPoint(mine, link)) } : undefined;
      if (carried) taken.add(carried.label.id);
      // A connector holds one polyline; a path whose segment chain breaks becomes one connector per
      // run, each dangling where the chain did. Only the ends that are really ends are pinned.
      const style = styleString([], {
        edgeStyle: 'none', rounded: 0, html: 1, endArrow: 'none', startArrow: 'none',
        strokeColor: dual(of => overlay ? NETWORK_THEME[of].overlay.stroke : klass.strokes[of]),
        strokeWidth: linkStrokeWidth(link),
        opacity: overlay ? Math.round(paint.overlay.opacity * 100) : undefined,
        ...dashEntries(overlay ? undefined : klass.dash),
        ...(source?.style ?? {}),
        ...(target?.style ?? {}),
        ...(carried ? labelStyle(carried.label, labelPoint(carried.label, link)) : {}),
      });
      edgeCell(id, layer, style, run.points, {
        source: source?.cell,
        target: target?.cell,
        sourcePoint: source ? undefined : run.points[0],
        targetPoint: target ? undefined : run.points[run.points.length - 1],
      }, carried ? {
        value: htmlText(carried.label.lines ?? [carried.label.text]),
        at: carried.at,
      } : undefined);
    });
    edgeRuns.set(link.id, shown);

    if (overlay) {
      // The SVG masks an overlay stroke out of every box it would obscure; mxGraph has no mask, so
      // the overlay layer sits beneath the diagram instead and only the endpoint marks are carried.
      const ends = link.path!.segments;
      for (const [end, point] of [['from', ends[0]!.from], ['to', ends[ends.length - 1]!.to]] as const) {
        const at = shift(point);
        vertex(cellId('overlayMark', link.id, end), layerId('overlay'), styleString(['ellipse'], {
          html: 1, fillColor: paint.overlay.mark, strokeColor: 'none', points: '[]',
        }), { x: at.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - OVERLAY_ENDPOINT_RADIUS,
          width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS });
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
    const relativeAt = edgeLabel(run.points, at);
    cells.push(element('mxCell', {
      id: claim(cellId('linkLabel', label.id)), value: htmlText(label.lines ?? [label.text]),
      style: styleString(['edgeLabel'], {
        // `edgeLabel` is a named style in draw.io's bundled sheet and brings
        // `labelBackgroundColor=default` with it — the white box the SVG does not draw.
        html: 1, resizable: 0, points: '[]',
        ...labelStyle(label, at),
        // A turn `horizontal=0` cannot express is stated outright.
        rotation: label.textRotation && label.textRotation % 90 !== 0 ? label.textRotation : undefined,
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
        const resolved = role ? dual(of => portRolePaint(role, of)) : undefined;
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
          // The legend has to name what the diagram draws, so it takes the same glyph.
          if (native.kind === 'silhouette') {
            vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
              html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
              fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
            }), swatch);
          }
          vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
            sketch: 0, html: 1, aspect: 'fixed', points: '[]',
            shape: native.kind === 'badge' ? 'mxgraph.cisco19.rect' : `mxgraph.cisco19.${native.shape}`,
            ...(native.kind === 'badge' ? { prIcon: native.shape } : {}),
            fillColor: native.kind === 'badge' ? resolved.tile.fill : resolved.glyph,
            strokeColor: native.kind === 'badge' ? resolved.glyph : 'none',
          }), letterbox(native.kind === 'badge' ? swatch
            : { x: swatch.x + ICON_INSET, y: swatch.y + ICON_INSET,
              width: swatch.width - 2 * ICON_INSET, height: swatch.height - 2 * ICON_INSET }, native));
        } else {
        vertex(cellId('legendTile', entry.id), cellId('legendRow', entry.id), styleString([], {
          html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
          fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
        }), swatch);
        const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
          + `<path d="${iconPath(entry.icon)}" fill="none" stroke="${pick(mode).glyph}"`
          + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        vertex(cellId('legendSwatch', entry.id), cellId('legendRow', entry.id), styleString([], {
          shape: 'image', html: 1, imageAspect: 0, points: '[]', image: svgImage(glyph),
        }), { x: swatch.x + ICON_INSET, y: swatch.y + ICON_INSET,
          width: swatch.width - 2 * ICON_INSET, height: swatch.height - 2 * ICON_INSET });
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
 * Every whole-pixel position that could carry the label is read back the way draw.io reads it, and
 * the one leaving the smallest remainder wins. Between two that leave the same remainder the one
 * nearer the line wins, because that is the segment the label really sits beside and the one it
 * keeps following. The result is exact wherever the format allows it and exact by remainder
 * everywhere else. The work is linear in the number of segments: the candidates are read in
 * ascending order and draw.io's own walk only ever moves forward, so it is walked once.
 */
function edgeLabel(points: readonly Point[], at: Point): EdgeLabel {
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
  let span = spans[0] ?? 0, before = 0, index = 1;
  let best: { label: EdgeLabel; left: number; beside: number } | undefined;
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
    if (best === undefined || left < best.left - EPS
      || Math.abs(left - best.left) <= EPS && Math.abs(y) < best.beside - EPS) {
      best = { label: { x, y }, left, beside: Math.abs(y) };
    }
  }
  const label = best!.label;
  if (best!.left <= EPS) return label;
  const drawn = decodeEdgeLabel(points, label);
  return { ...label, offset: { x: at.x - drawn.x, y: at.y - drawn.y } };
}

