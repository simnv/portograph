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

import type { Point, Rect } from '../model/geometry.js';
import type {
  Layer, LayoutGroup, LayoutLabel, LayoutLink, LayoutModel, LayoutPort, PathSegment,
} from '../model/layout.js';
import { orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { iconPath } from '../profiles/network/icons.js';
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

export interface DrawioOptions {
  /** Effective link families to export; see `RenderOptions.layers`, whose rule this shares. */
  layers?: readonly Layer[];
  /**
   * Which of the profile's three palettes to resolve. A draw.io file carries one set of colours —
   * it has no equivalent of the SVG sheet's `prefers-color-scheme` override — so the mode is chosen
   * at export rather than by the reader.
   */
  theme?: ThemeMode;
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

/** The tokens an author put on a port: a role, a status and any free text, in any order. */
const portTokens = (port: LayoutPort): string[] => (authorClass(port.class) ?? '').split(/\s+/).filter(Boolean);

export function drawio(layout: LayoutModel, options: DrawioOptions = {}): string {
  validate(layout);
  const canvas = layout.canvas;
  if (!canvas) throw new Error('A draw.io export requires a final canvas');
  const mode = options.theme ?? 'light';
  const paint = NETWORK_THEME[mode];
  const document = layout.document;
  const visible = (link: LayoutLink): boolean =>
    linkVisible(layout, link, options.layers ? { layers: options.layers } : {});

  // The canvas may start left of or above the origin; draw.io pages start at zero, so the whole
  // document is shifted once, here, and every coordinate below is already in page space.
  const shift = (point: Point): Point => ({ x: point.x - canvas.x, y: point.y - canvas.y });
  const shiftRect = (box: Rect): Rect => ({ ...shift(box), width: box.width, height: box.height });

  const cells: string[] = [];
  const vertex = (id: string, parent: string, style: string, box: Rect, value?: string,
    extra: Readonly<Record<string, StyleValue>> = {}): void => {
    cells.push(element('mxCell', { id, value, style, vertex: 1, parent, ...extra },
      element('mxGeometry', { x: box.x, y: box.y, width: box.width, height: box.height, as: 'geometry' })));
  };

  /** A text cell placed at exactly the box stage 9 measured, so no label is re-flowed on open. */
  const textCell = (id: string, parent: string, label: LayoutLabel, box: Rect, colour: string): void => {
    // `bounds` on a rotated label is already the rotated box, and draw.io rotates a vertex label
    // about the cell centre, so the same box with `horizontal=0` reproduces a quarter turn exactly.
    const quarter = label.textRotation === -90 || label.textRotation === 90;
    vertex(id, parent, styleString(['text'], {
      html: 1, strokeColor: 'none', fillColor: 'none', align: 'center', verticalAlign: 'middle',
      whiteSpace: 'nowrap', overflow: 'visible', points: '[]', resizable: 0,
      fontFamily: FONT_FAMILY, fontSize: label.fontSize, fontColor: colour,
      fontStyle: label.fontWeight === 700 ? 1 : undefined,
      horizontal: quarter ? 0 : undefined,
    }), box, htmlText(label.lines ?? [label.text]));
  };

  // ---- paint resolution -------------------------------------------------------------------
  // There is no resolved paint on the model: the SVG renderer states the palette as a class
  // cascade and lets the reader resolve it. A draw.io cell carries its own colours, so the same
  // cascade is walked here, in the sheet's own order — base, then node class, then port role,
  // then port status — because a later rule of equal specificity wins there.

  const nodeClassOf = (id: string): string | undefined => authorClass(document.nodes[id]?.class);

  const pillPaint = (nodeClass: string | undefined, port: LayoutPort):
  { fill: string; stroke: string; text: string; dash: string | undefined; opacity: number | undefined } => {
    let result = { ...paint.pill, dash: undefined as string | undefined, opacity: undefined as number | undefined };
    const known = nodeClassStyle(nodeClass);
    if (known) result = { ...result, ...nodeClassPaint(known, mode).pill };
    for (const token of portTokens(port)) {
      const role = portRoleStyle(token);
      if (!role) continue;
      const rolePaint = portRolePaint(role, mode);
      result = rolePaint.stroke === undefined
        ? { ...result, fill: rolePaint.fill, text: rolePaint.text }
        : { ...result, fill: 'none', stroke: rolePaint.stroke };
    }
    for (const token of portTokens(port)) {
      const status = NETWORK_PORT_STATUS.find(([name]) => name === token)?.[1];
      if (!status) continue;
      if (status.kind === 'fade') { result = { ...result, opacity: status.opacity }; continue; }
      result = {
        ...result, stroke: status.stroke[mode],
        dash: status.dash ? status.dash[mode] : result.dash,
        fill: status.fill ? status.fill[mode] : result.fill,
        text: status.text ? status.text[mode] : result.text,
      };
    }
    return result;
  };

  /** A dash pattern the model states in absolute pixels; `fixDash` stops draw.io scaling it. */
  const dashEntries = (dash: string | undefined): Readonly<Record<string, StyleValue>> =>
    dash === undefined || dash === 'none' ? {} : { dashed: 1, fixDash: 1, dashPattern: dash };

  // ---- layers -----------------------------------------------------------------------------
  // mxGraph paints in tree order and a container paints with its children, so the SVG renderer's
  // z-order cannot be reproduced cell by cell. Layers carry it instead. Every routed link ends up
  // above every node body, where the SVG puts only the bar bodies a crossing declares: G2 keeps
  // routed segments out of foreign nodes, so the one place a link meets a body is a declared bar
  // crossing, which is exactly where it must be painted on top.
  const LAYERS = ['overlay', 'diagram', 'links', 'labels', 'legend'] as const;
  const LAYER_NAMES: Readonly<Record<(typeof LAYERS)[number], string>> = {
    overlay: 'Overlay', diagram: 'Diagram', links: 'Links', labels: 'Labels', legend: 'Legend',
  };
  const layerId = (name: (typeof LAYERS)[number]): string => `pg-layer-${name}`;

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
        strokeColor: paint.group.stroke, opacity: Math.round(paint.group.fillOpacity * 100),
      })
      : styleString([], {
        html: 1, container: 1, collapsible: 0, rounded: 1,
        absoluteArcSize: 1, arcSize: CORNER_RADII.group * 2,
        fillColor: paint.group.fill, strokeColor: paint.group.stroke,
        opacity: Math.round(paint.group.fillOpacity * 100),
        verticalAlign: 'top', align: 'center',
      });
    vertex(`pg-group-${id}`, layerId('diagram'), style, box, swimlane ? htmlText(title!.lines ?? [title!.text]) : undefined);
    if (title && !swimlane) {
      textCell(`pg-group-title-${id}`, `pg-group-${id}`, title,
        relative(shiftRect(title.bounds!), box), paint.group.text);
    }
  }

  for (const id of orderedNodeIds(document)) {
    const node = layout.nodes[id]!;
    const group = `pg-group-${document.nodes[id]!.group}`;
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
    vertex(`pg-node-${id}`, group, styleString([], {
      html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.node * 2,
      whiteSpace: 'nowrap', fillColor: paint.node.fill, strokeColor: paint.node.stroke,
      strokeWidth: node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node,
      points: `[${anchors.join(',')}]`,
    }), relative(box, origin));

    if (node.icon) {
      const tile = relative(shiftRect(node.icon.bounds), shift(node.bounds!));
      const known = nodeClassStyle(authored);
      const resolved = known ? nodeClassPaint(known, mode) : { tile: paint.tile, glyph: paint.glyph };
      vertex(`pg-icon-tile-${id}`, `pg-node-${id}`, styleString([], {
        html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
        fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
      }), tile);
      // The glyphs are stroked 24-unit paths with no draw.io stencil equivalent, so each is carried
      // as its own image: exact, self-contained, and independent of any shape library being present.
      const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
        + `<path d="${iconPath(node.icon.icon)}" fill="none" stroke="${resolved.glyph}"`
        + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      vertex(`pg-icon-${id}`, `pg-node-${id}`, styleString([], {
        shape: 'image', html: 1, imageAspect: 0, points: '[]',
        image: svgImage(glyph),
      }), { x: tile.x + ICON_INSET, y: tile.y + ICON_INSET,
        width: tile.width - 2 * ICON_INSET, height: tile.height - 2 * ICON_INSET });
    }

    for (const label of layout.labels) {
      if (label.owner.kind !== 'node' || label.owner.id !== id) continue;
      if (label.role !== 'node' && label.role !== 'description') continue;
      if (label.omitted) continue;
      textCell(`pg-node-${label.role}-${id}`, `pg-node-${id}`, label,
        relative(shiftRect(label.bounds!), shift(node.bounds!)),
        label.role === 'node' ? paint.node.text : paint.node.description);
    }

    for (const port of node.ports) {
      if (!port.pill || port.ref.anonymous === true) continue;
      const identity = `${id}.${port.ref.name!}#${port.ref.ordinal}`;
      const resolved = pillPaint(authored, port);
      vertex(`pg-port-${identity}`, `pg-node-${id}`, styleString([], {
        html: 1, rounded: 1, absoluteArcSize: 1, arcSize: port.pill.radius * 2,
        fillColor: resolved.fill, strokeColor: resolved.stroke,
        strokeWidth: DEFAULT_STROKE_WIDTHS.pill, points: '[]',
        opacity: resolved.opacity === undefined ? undefined : Math.round(resolved.opacity * 100),
        ...dashEntries(resolved.dash),
      }), relative(shiftRect(port.pill.bounds), shift(node.bounds!)));
      const label = layout.labels.find(item => item.role === 'pill' && item.port !== undefined
        && item.port.node === id && item.port.name === port.ref.name && item.port.ordinal === port.ref.ordinal);
      if (label && !label.omitted) {
        textCell(`pg-port-label-${identity}`, `pg-node-${id}`, label,
          relative(shiftRect(label.bounds!), shift(node.bounds!)), resolved.text);
      }
    }
  }

  // ---- links --------------------------------------------------------------------------------
  const byId = new Map(layout.links.map(link => [link.id, link]));
  const linkClass = (link: LayoutLink): string | undefined => {
    const value = document.links[link.sourceIndex]?.class;
    return value === '' ? undefined : authorClass(value);
  };

  /** The polylines a path draws: one per run of segments whose ends meet, as `pathData` splits. */
  function polylines(segments: readonly PathSegment[]): Point[][] {
    const runs: Point[][] = [];
    let current: Point[] | undefined;
    for (const segment of segments) {
      if (!current || !samePoint(current[current.length - 1]!, segment.from)) {
        current = [segment.from];
        runs.push(current);
      }
      current.push(segment.to);
    }
    return runs.filter(run => run.length > 1).map(run => run.map(shift));
  }

  /** The fraction of a node's box at which a port sits, which is how an edge pins an endpoint. */
  const pin = (end: 'exit' | 'entry', ref: { node: string; name?: string; ordinal: number }):
  Readonly<Record<string, StyleValue>> => {
    const node = layout.nodes[ref.node];
    const port = node?.ports.find(item => item.ref.node === ref.node && item.ref.name === ref.name
      && item.ref.ordinal === ref.ordinal);
    if (!node?.bounds || !port?.anchor) return {};
    // Both fractions must be present or draw.io drops the constraint entirely, and `exitPerimeter`
    // defaults to 1, which would project the anchor onto the perimeter instead of using it.
    return {
      [`${end}X`]: (port.anchor.x - node.bounds.x) / node.bounds.width,
      [`${end}Y`]: (port.anchor.y - node.bounds.y) / node.bounds.height,
      [`${end}Dx`]: 0, [`${end}Dy`]: 0, [`${end}Perimeter`]: 0,
    };
  };

  const edgeCell = (id: string, layer: string, style: string, points: readonly Point[],
    ends: { source?: string | undefined; target?: string | undefined;
      sourcePoint?: Point | undefined; targetPoint?: Point | undefined }): void => {
    const waypoints = points.length > 2
      ? element('Array', { as: 'points' },
        points.slice(1, -1).map(point => element('mxPoint', { x: point.x, y: point.y })).join(''))
      : '';
    const dangling = (ends.sourcePoint ? element('mxPoint', { x: ends.sourcePoint.x, y: ends.sourcePoint.y, as: 'sourcePoint' }) : '')
      + (ends.targetPoint ? element('mxPoint', { x: ends.targetPoint.x, y: ends.targetPoint.y, as: 'targetPoint' }) : '');
    cells.push(element('mxCell', { id, style, edge: 1, parent: layer, source: ends.source, target: ends.target },
      element('mxGeometry', { relative: 1, as: 'geometry' }, waypoints + dangling)));
  };

  const drawn = layout.links.filter(link => link.technique !== 'stub' && link.path && visible(link));
  const edgeIds = new Map<string, string[]>();
  for (const link of drawn) {
    const layer = effectiveLayer(link) === 'overlay' ? layerId('overlay') : layerId('links');
    const authored = linkClass(link);
    const klass = linkClassStyle(authored);
    const overlay = effectiveLayer(link) === 'overlay';
    const runs = polylines(link.path!.segments);
    const ids: string[] = [];
    runs.forEach((run, index) => {
      const first = index === 0, last = index === runs.length - 1;
      const from = link.attachments?.from, to = link.attachments?.to;
      const id = runs.length === 1 ? `pg-link-${link.id}` : `pg-link-${link.id}-${index}`;
      ids.push(id);
      // A connector holds one polyline; a path whose segment chain breaks becomes one connector per
      // run, each dangling where the chain did. Only the ends that are really ends are pinned.
      const style = styleString([], {
        edgeStyle: 'none', rounded: 0, html: 1, endArrow: 'none', startArrow: 'none',
        strokeColor: overlay ? paint.overlay.stroke : klass.strokes[mode],
        strokeWidth: linkStrokeWidth(link),
        opacity: overlay ? Math.round(paint.overlay.opacity * 100) : undefined,
        ...dashEntries(overlay ? undefined : klass.dash),
        ...(first && from ? pin('exit', from) : {}),
        ...(last && to ? pin('entry', to) : {}),
      });
      edgeCell(id, layer, style, run, {
        source: first && from ? `pg-node-${from.node}` : undefined,
        target: last && to ? `pg-node-${to.node}` : undefined,
        sourcePoint: first && from ? undefined : run[0],
        targetPoint: last && to ? undefined : run[run.length - 1],
      });
    });
    edgeIds.set(link.id, ids);

    if (overlay) {
      // The SVG masks an overlay stroke out of every box it would obscure; mxGraph has no mask, so
      // the overlay layer sits beneath the diagram instead and only the endpoint marks are carried.
      const ends = link.path!.segments;
      for (const [end, point] of [['from', ends[0]!.from], ['to', ends[ends.length - 1]!.to]] as const) {
        const at = shift(point);
        vertex(`pg-overlay-${link.id}-${end}`, layerId('overlay'), styleString(['ellipse'], {
          html: 1, fillColor: paint.overlay.mark, strokeColor: 'none', points: '[]',
        }), { x: at.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - OVERLAY_ENDPOINT_RADIUS,
          width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS });
      }
    }
  }

  // ---- link labels --------------------------------------------------------------------------
  // An edge label's `x` is arc length along the polyline and its `y` a signed perpendicular offset,
  // positive to the left of travel. Both are left at zero and the whole displacement goes in
  // `offset`, which is measured in screen axes: exact, and free of the sign convention.
  for (const label of layout.labels) {
    if (label.role !== 'link' || label.omitted || !label.bounds) continue;
    const owner = label.owner.kind === 'barCross' ? label.owner.link
      : label.owner.kind === 'link' ? label.owner.id : undefined;
    const link = owner === undefined ? undefined : byId.get(owner);
    const ids = owner === undefined ? undefined : edgeIds.get(owner);
    if (!link || !ids?.length) continue;
    const parent = ids[0]!;
    const anchor = midpoint(polylines(link.path!.segments)[0] ?? []);
    if (!anchor) continue;
    const at = centre(shiftRect(label.bounds));
    const multiplicity = label.support?.kind === 'merge-run';
    const quarter = label.textRotation === -90 || label.textRotation === 90;
    cells.push(element('mxCell', {
      id: `pg-link-label-${label.id}`, value: htmlText(label.lines ?? [label.text]),
      style: styleString(['edgeLabel'], {
        html: 1, align: 'center', verticalAlign: 'middle', resizable: 0, points: '[]',
        fontFamily: FONT_FAMILY, fontSize: label.fontSize,
        fontColor: multiplicity ? paint.link.multiplicity : paint.link.label,
        fontStyle: label.fontWeight === 700 ? 1 : undefined,
        horizontal: quarter ? 0 : undefined,
      }),
      vertex: 1, connectable: 0, parent,
    }, element('mxGeometry', { x: 0, y: 0, relative: 1, as: 'geometry' },
      element('mxPoint', { x: at.x - anchor.x, y: at.y - anchor.y, as: 'offset' }))));
  }

  // ---- legend -------------------------------------------------------------------------------
  if (layout.legend) {
    const box = shiftRect(layout.legend.bounds);
    vertex('pg-legend', layerId('legend'), styleString(['group'], { html: 1, points: '[]' }), box);
    for (const entry of layout.legend.entries) {
      const swatch = relative(shiftRect(entry.swatch), shift(layout.legend.bounds));
      if (entry.kind === 'line') {
        const klass = entry.key === LEGEND_DEFAULT_CLASS ? linkClassStyle(undefined) : linkClassStyle(entry.key);
        const middle = swatch.y + swatch.height / 2;
        edgeCell(`pg-legend-${entry.id}`, 'pg-legend', styleString([], {
          edgeStyle: 'none', rounded: 0, html: 1, endArrow: 'none', startArrow: 'none',
          strokeColor: klass.strokes[mode], strokeWidth: entry.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path,
          ...dashEntries(klass.dash),
        }), [], { sourcePoint: { x: swatch.x, y: middle }, targetPoint: { x: swatch.x + swatch.width, y: middle } });
      } else if (entry.kind === 'port') {
        const role = portRoleStyle(entry.key);
        const resolved = role ? portRolePaint(role, mode) : undefined;
        vertex(`pg-legend-${entry.id}`, 'pg-legend', styleString([], {
          html: 1, rounded: 1, absoluteArcSize: 1,
          arcSize: (entry.radius ?? CORNER_RADII.pill) * 2,
          fillColor: resolved?.fill ?? paint.pill.fill,
          strokeColor: resolved?.stroke ?? paint.pill.stroke,
          strokeWidth: DEFAULT_STROKE_WIDTHS.pill, points: '[]',
        }), swatch);
      } else if (entry.icon) {
        const known = nodeClassStyle(entry.key);
        const resolved = known ? nodeClassPaint(known, mode) : { tile: paint.tile, glyph: paint.glyph };
        vertex(`pg-legend-tile-${entry.id}`, 'pg-legend', styleString([], {
          html: 1, rounded: 1, absoluteArcSize: 1, arcSize: CORNER_RADII.tile * 2,
          fillColor: resolved.tile.fill, strokeColor: resolved.tile.stroke, points: '[]',
        }), swatch);
        const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
          + `<path d="${iconPath(entry.icon)}" fill="none" stroke="${resolved.glyph}"`
          + ` stroke-width="${num(GLYPH_STROKE)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        vertex(`pg-legend-${entry.id}`, 'pg-legend', styleString([], {
          shape: 'image', html: 1, imageAspect: 0, points: '[]', image: svgImage(glyph),
        }), { x: swatch.x + ICON_INSET, y: swatch.y + ICON_INSET,
          width: swatch.width - 2 * ICON_INSET, height: swatch.height - 2 * ICON_INSET });
      }
      const label = layout.labels.find(item => item.id === entry.label);
      if (label && !label.omitted && label.bounds) {
        textCell(`pg-legend-label-${entry.id}`, 'pg-legend', label,
          relative(shiftRect(label.bounds), shift(layout.legend.bounds)), paint.legend.text);
      }
    }
  }

  // ---- document -----------------------------------------------------------------------------
  const layers = LAYERS.map(name =>
    element('mxCell', { id: layerId(name), value: LAYER_NAMES[name], parent: '0' })).join('');
  const model = element('mxGraphModel', {
    dx: 0, dy: 0, grid: 0, gridSize: 10, guides: 1, tooltips: 1, connect: 1, arrows: 0, fold: 1,
    page: 1, pageScale: 1, pageWidth: Math.ceil(canvas.width), pageHeight: Math.ceil(canvas.height),
    math: 0, shadow: 0, background: paint.background,
  }, element('root', {}, element('mxCell', { id: '0' }) + layers + cells.join('')));
  const title = document.title ?? 'portograph';
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + element('mxfile', { host: 'portograph' },
      element('diagram', { id: 'pg-diagram', name: title }, model)) + '\n';
}

/** The point half way along a polyline by arc length: where draw.io anchors an edge label at x=0. */
function midpoint(points: readonly Point[]): Point | undefined {
  if (points.length < 2) return points[0];
  const spans = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  const total = spans.reduce((sum, span) => sum + span, 0);
  if (total === 0) return points[0];
  let walked = 0;
  for (let i = 0; i < spans.length; i++) {
    if (walked + spans[i]! >= total / 2) {
      const ratio = spans[i] === 0 ? 0 : (total / 2 - walked) / spans[i]!;
      return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * ratio,
        y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * ratio };
    }
    walked += spans[i]!;
  }
  return points[points.length - 1];
}
