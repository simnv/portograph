import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/index.js';
import { linkIds } from '../../src/model/index.js';
import { drawio, render } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { rows } from '../../src/layout/rows.js';
import { NETWORK_THEME, washAssignment, washToken, portRolePaint } from '../../src/profiles/network/theme.js';
import { themeById, themeLinkClass, themePortRole, themeWashFill } from '../../src/profiles/network/themes.js';
import { route } from '../../src/route/index.js';
import { effectiveLayer } from '../../src/score/model.js';
import { OVERLAY_ENDPOINT_RADIUS } from '../../src/theme/geometry.js';
import { OVERLAY_PILL_CLEARANCE } from '../../src/layout/overlay-paths.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { flatCells, inFile } from './drawio-cells.js';

/** The exporter's id scheme, mirrored so a test names a cell the way the file does. */
const id = (kind: string, ...parts: readonly string[]): string =>
  parts.length ? `pg-${kind}~${parts.map(value => value.replace(/[%~]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join('~')}` : `pg-${kind}`;

/** The id a link carries in the file: its stable id, as `linkIds` derives it, spelled as the XML spells it. */
const stable = (model: LayoutModel, linkId: string): string => {
  const link = model.links.find(item => item.id === linkId);
  return inFile(link ? linkIds(model.document)[link.sourceIndex] ?? link.id : linkId);
};

/** The connector rule (maintainer, 2026-10-23): no bend is `none` with no jetty, a bend is orthogonal with `jettySize=0`. */
const styleRule = (cell: { style: Record<string, string> }): 'straight' | 'bent' => {
  if (cell.style['edgeStyle'] === 'none') {
    expect(cell.style['jettySize']).toBeUndefined();
    return 'straight';
  }
  expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
  expect(cell.style['jettySize']).toBe('0');
  return 'bent';
};

const fixture = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');

async function pipeline(yaml: string): Promise<LayoutModel> {
  const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return linkLabels(await route(placedModel, { createAttempt: createAvoidAttempt }));
}

interface Cell {
  id: string;
  parent?: string;
  style: Record<string, string>;
  tokens: string[];
  value?: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geometry: Record<string, string>;
  points: Point[];
  /** The ends the edge leaves free (`sourcePoint`, `targetPoint`): a free end stays behind when a node moves. */
  free: string[];
  offset?: Point;
}

/** Every `<mxCell>`, with its style string split the way draw.io splits it. */
function cells(xml: string): Map<string, Cell> {
  const found = new Map<string, Cell>();
  for (const match of flatCells(xml).matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    const attributes: Record<string, string> = {};
    for (const pair of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[pair[1]!] = pair[2]!;
    const body = match[3] ?? '';
    const geometry: Record<string, string> = {};
    const geometryTag = /<mxGeometry\b([^>]*)/.exec(body);
    if (geometryTag) for (const pair of geometryTag[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) geometry[pair[1]!] = pair[2]!;
    const offsetTag = /<mxPoint x="([^"]*)" y="([^"]*)" as="offset"\/>/.exec(body);
    const array = /<Array as="points">([\s\S]*?)<\/Array>/.exec(body);
    const points: Point[] = [...(array?.[1] ?? '').matchAll(/<mxPoint x="([^"]*)" y="([^"]*)"\/>/g)]
      .map(point => ({ x: Number(point[1]), y: Number(point[2]) }));
    const style: Record<string, string> = {};
    const tokens: string[] = [];
    for (const part of (attributes['style'] ?? '').split(';')) {
      if (part === '') continue;
      const at = part.indexOf('=');
      if (at === -1) tokens.push(part); else style[part.slice(0, at)] = part.slice(at + 1);
    }
    const id = attributes['id']!;
    found.set(id, {
      id, ...(attributes['parent'] === undefined ? {} : { parent: attributes['parent'] }),
      style, tokens, ...(attributes['value'] === undefined ? {} : { value: attributes['value'] }),
      vertex: attributes['vertex'] === '1', edge: attributes['edge'] === '1',
      ...(attributes['source'] === undefined ? {} : { source: attributes['source'] }),
      ...(attributes['target'] === undefined ? {} : { target: attributes['target'] }),
      geometry, points,
      free: [...body.matchAll(/<mxPoint [^>]*as="(sourcePoint|targetPoint)"/g)].map(point => point[1]!),
      ...(offsetTag ? { offset: { x: Number(offsetTag[1]), y: Number(offsetTag[2]) } } : {}),
    });
  }
  return found;
}

const box = (cell: Cell): { x: number; y: number; width: number; height: number } => ({
  x: Number(cell.geometry['x'] ?? 0), y: Number(cell.geometry['y'] ?? 0),
  width: Number(cell.geometry['width'] ?? 0), height: Number(cell.geometry['height'] ?? 0),
});

/** The layer a cell finally belongs to: mxGraph resolves z-order by the root ancestor. */
function layerOf(all: Map<string, Cell>, id: string): string | undefined {
  let at = all.get(id);
  while (at?.parent !== undefined && at.parent !== '0') at = all.get(at.parent);
  return at?.id;
}

describe('draw.io export', () => {
  it('reproduces every reserved coordinate, and pins each connector to the anchor the pipeline used', async () => {
    const model = await pipeline(goldenYaml);
    const xml = drawio(model);
    const all = cells(xml);
    const canvas = model.canvas!;

    // Every node keeps its measured rectangle, expressed from its group container's corner. A
    // child's geometry is always relative to the parent's top-left; `startSize` does not shift that
    // origin, which is the one arithmetic mistake this format invites.
    for (const [key, node] of Object.entries(model.nodes)) {
      const cell = all.get(id('node', key))!;
      expect(cell.parent).toBe(id('group', model.document.nodes[key]!.group));
      const group = model.groups[model.document.nodes[key]!.group]!.bounds!;
      expect(box(cell)).toEqual({
        x: node.bounds!.x - group.x, y: node.bounds!.y - group.y,
        width: node.bounds!.width, height: node.bounds!.height,
      });
    }

    const kinds = new Set<string>();
    let pinned = 0;
    for (const link of model.links) {
      if (link.technique === 'stub' || !link.path) continue;
      const cell = all.get(id('link', stable(model, link.id)));
      if (!cell) continue;
      // The claim: the connector carries the reserved polyline verbatim, under the orthogonal
      // router that keeps it square when a shape is moved. An overlay link is the one exception —
      // it is routed around its pills — and `maintainer edit principles` below covers it.
      if (effectiveLayer(link) === 'overlay') continue;
      kinds.add(styleRule(cell));
      const interior = link.path.segments.slice(0, -1)
        .map(segment => ({ x: segment.to.x - canvas.x, y: segment.to.y - canvas.y }));
      expect(cell.points).toEqual(interior);

      const from = link.attachments?.from;
      if (!from) continue;
      const node = model.nodes[from.node]!;
      const port = node.ports.find(item => item.ref.name === from.name && item.ref.ordinal === from.ordinal)!;
      // The claim: a connector terminates on the *port*, not on its node's box. That is what makes
      // it a connection — moving the port or the node carries the line — and it is the point the
      // SVG makes visible, since a pill straddles the boundary and is painted over the inner half
      // of its own stem. The endpoint is the middle of the pill's outward edge.
      expect(cell.source).toBe(id('port', from.node, from.name!, String(from.ordinal)));
      const outward = { top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5] }[port.side!]!;
      // Both fractions must be present or draw.io drops the constraint entirely, and
      // `exitPerimeter` defaults to 1, which would project the point onto the perimeter.
      expect(Number(cell.style['exitX'])).toBe(outward[0]!);
      expect(Number(cell.style['exitY'])).toBe(outward[1]!);
      expect(cell.style['exitPerimeter']).toBe('0');
      // That endpoint is the pill's outward edge, which is the anchor moved out by half the pill's
      // depth — so the waypoints are untouched and only the visible stub changes.
      const pill = port.pill!.bounds;
      const at = { x: pill.x + outward[0]! * pill.width, y: pill.y + outward[1]! * pill.height };
      const away = port.side === 'left' || port.side === 'right'
        ? Math.abs(at.x - port.anchor!.x) : Math.abs(at.y - port.anchor!.y);
      expect(away).toBeCloseTo(port.side === 'left' || port.side === 'right'
        ? pill.width / 2 : pill.height / 2, 9);
      pinned += 1;
    }
    expect(pinned).toBeGreaterThan(0);
  }, 60000);

  it('carries a group as a container titled on the band edge the pipeline reserved', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    // The fixture reserves one band on each edge, which is what makes it worth asserting here.
    expect(new Set(model.labelBands.map(band => band.side))).toEqual(new Set(['top', 'bottom']));
    for (const band of model.labelBands) {
      const cell = all.get(id('group', band.group))!;
      expect(cell.tokens).toContain('swimlane');
      expect(cell.style['container']).toBe('1');
      expect(Number(cell.style['startSize'])).toBe(band.bounds.height);
      // `flipV` mirrors the shape paths only: the label is rendered outside the flip, so a bottom
      // band keeps upright text, which `direction=south` would not.
      expect(cell.style['flipV']).toBe(band.side === 'bottom' ? '1' : undefined);
    }
  }, 60000);

  it('stacks the layers so nothing a group box would wash out is painted beneath it', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const xml = drawio(model);
    const all = cells(xml);
    const order = [...all.keys()].filter(key => key.startsWith('pg-layer~'));
    // mxGraph paints in tree order, so layer declaration order is z-order. A container paints with
    // its children, so this stack is the only place the SVG renderer's z-order can be expressed.
    expect(order).toEqual([id('layer', 'canvas'), id('layer', 'diagram'), id('layer', 'overlay'),
      id('layer', 'links'), id('layer', 'labels'), id('layer', 'legend')]);
    const overlay = model.links.find(link => link.technique === 'overlay' || link.layer === 'overlay')!;
    expect(layerOf(all, id('link', stable(model, overlay.id)))).toBe(id('layer', 'overlay'));
    const routed = model.links.find(link => link.path && link.technique !== 'stub' && link.id !== overlay.id)!;
    expect(layerOf(all, id('link', stable(model, routed.id)))).toBe(id('layer', 'links'));
    for (const key of Object.keys(model.nodes)) expect(layerOf(all, id('node', key))).toBe(id('layer', 'diagram'));
  }, 60000);

  it('writes every label as plain text, so an SVG export draws native text', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const node = Object.keys(model.nodes)[0]!;
    const label = model.labels.find(item => item.owner.kind === 'node' && item.owner.id === node
      && item.role === 'node')!;
    const marked = { ...model, labels: model.labels.map(item => item === label
      ? { ...item, text: 'a <b> & c', lines: ['a <b> & c', 'second'] } : item) };
    const xml = drawio(marked);
    // With `html=1` draw.io exports a `<foreignObject>` and a PNG fallback for every label. Plain
    // text is escaped once, for the XML, and its lines are a newline apart.
    expect(xml).not.toMatch(/html=/);
    expect(flatCells(xml)).toContain('value="a &lt;b&gt; &amp; c&#10;second"');
    expect(xml).not.toMatch(/&lt;(div|br|span)\b/);
  }, 60000);

  it('gives every cell its own id, so draw.io cannot silently drop one', async () => {
    // Codex round 1: `pg-node-<id>` for a node and `pg-node-<role>-<id>` for its title both read
    // `pg-node-node-a` when one node is called `a` and another `node-a`. draw.io neither rejects
    // nor reports a duplicate — it keeps one cell — so the whole `node-a` node disappeared from a
    // valid, link-free diagram. The scheme is now injective by construction and self-checked.
    const model = await pipeline(`
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, label: Alpha}
  node-a: {group: g, label: Beta}
links: []
`);
    const xml = drawio(model);
    const ids = [...flatCells(xml).matchAll(/<mxCell id="([^"]+)"/g)].map(match => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(id('node', 'a'));
    expect(ids).toContain(id('node', 'node-a'));
    // A node's name is the node's own label now, so there is no `nodeLabel` cell to collide with —
    // which is what made the original collision possible. The scheme still has to be injective.
    expect(ids).not.toContain(id('nodeLabel', 'a'));
    // A separator an author could otherwise smuggle in is escaped, not passed through.
    expect(id('node', 'a~b')).not.toBe(id('node', 'a', 'b'));
  }, 60000);

  it('keeps a reserved label angle, not only a quarter turn', async () => {
    // Codex round 1: only -90 and 90 were handled and every other reserved angle became zero,
    // which discards the rotation ADR-0017 gives a straight bundle member's label.
    const model = await pipeline(`
portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 1}, {name: r, side: bottom, order: 2}]}
  b: {group: gb, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 1}, {name: r, side: top, order: 2}]}
links: [[a.p, b.r, {label: X}], [a.q, b.q], [a.r, b.p]]
`);
    const label = model.labels.find(item => item.role === 'link' && !item.omitted
      && item.textRotation !== undefined && item.textRotation % 90 !== 0)!;
    expect(label).toBeDefined();
    const cell = cells(drawio(model)).get(id('linkLabel', stable(model, (label.owner as { id: string }).id)))!;
    expect(Number(cell.style['rotation'])).toBe(label.textRotation);
  }, 60000);

  it('keeps a counted merge label, which a bundle owns and no single connector carries', async () => {
    // Codex round 1: the owner expression accepted only `link` and `barCross`, so every
    // bundle-owned count reached `continue` and vanished. It names the shared trunk, and each
    // member exports its whole path, so no connector here is that trunk: it keeps its measured
    // box in the label layer rather than being attached to an arbitrary member.
    const model = await pipeline(`
portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 0}, {name: r, side: bottom, order: 0}]}
  b: {group: gb, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 0}, {name: r, side: top, order: 0}]}
links: [{from: a.p, to: b.p, route: merge}, {from: b.q, to: a.q, route: merge}, [a.r, b.r]]
`);
    const count = model.labels.find(item => item.support?.kind === 'merge-run' && !item.omitted)!;
    expect(count.owner.kind).toBe('bundle');
    const all = cells(drawio(model));
    const cell = all.get(id('linkLabel', count.id))!;
    expect(cell.value).toBe(count.text);
    expect(layerOf(all, cell.id)).toBe(id('layer', 'labels'));
    expect(box(cell)).toEqual({
      x: count.bounds!.x - model.canvas!.x, y: count.bounds!.y - model.canvas!.y,
      width: count.bounds!.width, height: count.bounds!.height,
    });
  }, 60000);

  it('puts a link label on its run, and gives it the backdrop it covers', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const label = model.labels.find(item => item.role === 'link' && !item.omitted
      && item.support?.kind === 'link-segment')!;
    expect(label).toBeDefined();
    // The claim: `on-run` moves a label onto the segment stage 9 says carries it, and nothing else.
    // A label centred on a line has to hide the line behind its glyphs, so it takes the colour that
    // is really behind it; `measured` keeps the box stage 9 placed, and takes that colour too: draw.io
    // has no outline for a plain-text label, so the backdrop stands in for the SVG halo (ticket 162).
    // The label is the connector's own, so it is the edge cell that carries it.
    const owner = (label.owner as { id: string }).id;
    const on = cells(drawio(model, { labels: 'on-run' })).get(id('link', stable(model, owner)))!;
    const measured = cells(drawio(model, { labels: 'measured' })).get(id('link', stable(model, owner)))!;
    expect(on.value).toBe(label.text);
    expect(measured.style['labelBackgroundColor']).toMatch(/^(#[0-9a-f]{6}|light-dark\(#[0-9a-f]{6},#[0-9a-f]{6}\))$/);
    expect(on.style['labelBackgroundColor']).toMatch(/^(#[0-9a-f]{6}|light-dark\(#[0-9a-f]{6},#[0-9a-f]{6}\))$/);
    // The claim: a label is stated in the edge's own relative terms — `x` arc length along it, `y`
    // signed perpendicular — so it follows its connector when a shape moves. `offset` is absolute
    // screen pixels, so it carries only the remainder the relative pair cannot: the label would stay
    // put and drift off the line if it carried more. On the run means a perpendicular of zero;
    // measured keeps the distance stage 9 gave.
    expect(Number(on.geometry['y'])).toBeCloseTo(0, 9);
    expect(Math.abs(Number(measured.geometry['y']))).toBeGreaterThan(1);
    expect(Number(on.geometry['x'])).toBeGreaterThanOrEqual(-1);
    expect(Number(on.geometry['x'])).toBeLessThanOrEqual(1);
    // At most the sub-pixel rounding of the arc length is left to `offset`: the label keeps the border
    // margin off the lower group (stage 9), so it stands a fraction of a pixel off a whole arc length.
    expect(Math.hypot(on.offset?.x ?? 0, on.offset?.y ?? 0)).toBeLessThan(0.5);
  }, 60000);

  it('attaches a label on a joined run of collinear pieces to the piece it stands on (ticket 142)', async () => {
    const model = await pipeline(fixture('a-side-lane-label-spans-the-collinear-pieces'));
    const link = model.links.find(item => item.fixedSegments !== undefined)!;
    const label = model.labels.find(item => item.owner.kind === 'link' && item.owner.id === link.id)!;
    const support = label.support as { segment: number; through: number };
    expect(support.through).toBeGreaterThan(support.segment);
    const segments = link.path!.segments, at = (n: number) => segments.slice(0, n).reduce((sum, s) => sum + Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y), 0);
    // The label stands where stage 9 put it on the joined run: in the window below the border it crosses (ticket 19), not always at the middle.
    const total = at(segments.length), middle = at(support.segment) + Math.abs(label.bounds!.y + label.bounds!.height / 2 - segments[support.segment]!.from.y);
    const cell = cells(drawio(model, { labels: 'on-run' })).get(id('link', stable(model, link.id)))!;
    // The label is stated where it stands on the joined run, on the line: not clamped to the 15 px stem, and with at most the sub-pixel rounding of the arc length as offset.
    expect(Math.hypot(cell.offset?.x ?? 0, cell.offset?.y ?? 0)).toBeLessThan(1);
    expect(Number(cell.geometry['y'])).toBeCloseTo(0, 9);
    // The export's polyline is a few px off the path (terminals), so the arc length is checked to within 10 px.
    expect(Math.abs((Number(cell.geometry['x']) / 2 + 0.5) * total - middle)).toBeLessThan(10);
    expect(middle).toBeGreaterThan(at(support.segment + 1));
  }, 60000);

  it('carries both appearances in one file, because draw.io inverts a colour it is given alone', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const auto = cells(drawio(model));
    const light = cells(drawio(model, { theme: 'light' }));
    const dark = cells(drawio(model, { theme: 'dark' }));
    const key = id('node', 'a');
    // The claim: `auto` states both palettes rather than one. draw.io does not leave an explicit
    // colour alone in dark mode — it puts it through a lightness inversion — so a single-palette
    // file is not faithful there. A `light-dark()` value short-circuits that, and both sides are
    // exactly the values the profile holds.
    const [, lightValue, darkValue] = /^light-dark\((#[0-9a-f]{6}),(#[0-9a-f]{6})\)$/
      .exec(auto.get(key)!.style['fillColor']!)!;
    expect(lightValue).toBe(light.get(key)!.style['fillColor']);
    expect(darkValue).toBe(dark.get(key)!.style['fillColor']);
    // A colour both palettes agree on is paired anyway: an unpaired colour is exactly what draw.io
    // inverts, so writing white once yields a dark glyph in dark mode. The Cisco glyph stroke found
    // this — it is `#ffffff` in both palettes and came out dark until it was written twice.
    const glyph = cells(drawio(model, { icons: 'cisco19' }));
    const badge = [...glyph.values()].find(cell => cell.style['prIcon'] !== undefined);
    expect(badge).toBeDefined();
    expect(badge!.style['strokeColor']).toBe('light-dark(#ffffff,#ffffff)');
    // A dash pattern is a string too; pairing it would be nonsense, so only colours are paired.
    for (const cell of auto.values()) {
      expect(cell.style['dashPattern'] ?? '').not.toContain('light-dark');
    }
    // Naming a mode pins the file to it, for a reader older than draw.io 26.0.0.
    expect(light.get(key)!.style['fillColor']).not.toContain('light-dark');
  }, 60000);

  it('letterboxes draw.io\u2019s own Cisco shapes into the tile, in their native proportions', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model, { icons: 'cisco19' }));
    const node = Object.entries(model.nodes).find(([, item]) => item.icon !== undefined)!;
    const cell = all.get(id('icon', node[0]))!;
    // These resolve from the style string alone — drawio-desktop loads every bundled stencil set
    // before it renders, so no sidebar library has to be enabled.
    expect(cell.style['shape']).toMatch(/^mxgraph\.cisco19\./);
    // `aspect=fixed` is only a hint to the editor's resize handles: a shape written into a box of
    // the wrong ratio is stretched, so each is letterboxed into the tile stage 3 measured.
    const drawn = box(cell);
    const tile = node[1].icon!.bounds;
    expect(drawn.width).toBeLessThanOrEqual(tile.width + 1e-9);
    expect(drawn.height).toBeLessThanOrEqual(tile.height + 1e-9);
    expect(Math.min(drawn.width / tile.width, drawn.height / tile.height)).toBeGreaterThan(0.5);
  }, 60000);

  it('defaults to the bundled stencils, and embeds the profile glyph only when that is asked for', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const node = Object.entries(model.nodes).find(([, item]) => item.icon !== undefined)!;
    // The claim: an export written with no icon set named carries `cisco19`. A bundled stencil
    // resolves from the style string and takes a paired `light-dark()` colour, so it follows
    // draw.io's own dark appearance. Library and CLI agree: `bin/compute.mjs` passes the option
    // through only when the command names it, so an unnamed option lands on this same default.
    const byDefault = cells(drawio(model)).get(id('icon', node[0]))!;
    expect(byDefault.style['shape']).toMatch(/^mxgraph\.cisco19\./);
    // `profile` is still reachable, and is what the SVG draws: a stroked 24-unit path carried as
    // an embedded data URI. That image is the one thing here no appearance can adapt, which is the
    // reason it is no longer the default.
    const asked = cells(drawio(model, { icons: 'profile' })).get(id('icon', node[0]))!;
    expect(asked.style['shape']).toBe('image');
    expect(asked.style['image']!.startsWith('data:image/svg+xml,')).toBe(true);
    expect(asked.style['prIcon']).toBeUndefined();
  }, 60000);

  it('gives every text to the shape that owns it, rather than parking a box on top', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const xml = drawio(model);
    const all = cells(xml);
    // The claim: a node's name, a port's name and a link's label are the *values* of the node, the
    // pill and the connector. draw.io gives a shape its text, so one cell moves, copies and is
    // renamed as one thing; a separate text box only looks the same until someone drags it.
    expect([...all.keys()].filter(key => key.startsWith('pg-nodeLabel~')
      || key.startsWith('pg-portLabel~'))).toEqual([]);
    // The one exception is a description: plain text has one font per cell. Its cell is a child of
    // the node, so it still moves and copies with it.
    for (const description of model.labels.filter(item => item.role === 'description' && !item.omitted)) {
      const owner = (description.owner as { id: string }).id;
      expect(all.get(id('nodeDescription', owner))!.parent).toBe(id('node', owner));
    }
    const named = model.labels.find(item => item.role === 'node' && !item.omitted)!;
    expect(all.get(id('node', (named.owner as { id: string }).id))!.value).toContain(named.text);
    const pill = model.labels.find(item => item.role === 'pill' && !item.omitted && item.port)!;
    const port = pill.port!;
    expect(all.get(id('port', port.node, port.name!, String(port.ordinal)))!.value).toBe(pill.text);
    // A quarter turn is the shape's own `horizontal=0`, which really does turn an edge's label too.
    const turned = model.labels.find(item => item.role === 'link' && !item.omitted
      && item.textRotation === -90);
    if (turned) {
      const owner = (turned.owner as { id: string }).id;
      expect(all.get(id('link', stable(model, owner)))!.style['horizontal']).toBe('0');
    }
  }, 60000);

  it('offers a node the rest of its own side grid as connection points', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const [key, node] = Object.entries(model.nodes).find(([, item]) => item.ports.length > 0)!;
    // A `points=` value holds no `;`, so the style parser hands it back whole.
    const listed = [...all.get(id('node', key))!.style['points']!.matchAll(/\[([-\d.]+),([-\d.]+),0\]/g)]
      .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    // Every port the pipeline placed is offered...
    for (const port of node.ports) {
      if (!port.anchor) continue;
      const at = { x: (port.anchor.x - node.bounds!.x) / node.bounds!.width,
        y: (port.anchor.y - node.bounds!.y) / node.bounds!.height };
      expect(listed.some(item => Math.abs(item.x - at.x) < 1e-9 && Math.abs(item.y - at.y) < 1e-9)).toBe(true);
    }
    // ...and so are the side's remaining slots, so a hand edit lands on the grid the layout
    // reserved rather than near it. A pill snaps to them.
    expect(listed.length).toBeGreaterThan(node.ports.filter(port => port.anchor).length);
    const port = node.ports.find(item => item.pill && item.ref.anonymous !== true)!;
    expect(all.get(id('port', key, port.ref.name!, String(port.ref.ordinal)))!.style['snapToPoint']).toBe('1');
  }, 60000);

  it('leaves the model untouched and gives the same bytes twice', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const before = JSON.stringify(model);
    const first = drawio(model);
    expect(JSON.stringify(model)).toBe(before);
    expect(drawio(model)).toBe(first);
  }, 60000);

  it('resolves one palette per export, since a draw.io file cannot carry three', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const light = cells(drawio(model, { theme: 'light' })).get(id('node', 'a'))!;
    const dark = cells(drawio(model, { theme: 'dark' })).get(id('node', 'a'))!;
    const print = cells(drawio(model, { theme: 'print' })).get(id('node', 'a'))!;
    expect(light.style['fillColor']).not.toBe(dark.style['fillColor']);
    expect(print.style['strokeColor']).not.toBe(light.style['strokeColor']);
  }, 60000);
});

describe('node text', () => {
  // Verdana's own metrics, stated here rather than read from the font table, so the expected
  // positions are independent of the code that produces them.
  const UNITS_PER_EM = 2048, ASCENT = 2059;
  /** The first baseline, one ascent below the box stage 9 measured. */
  const ascentOf = (fontSize: number): number => ASCENT * fontSize / UNITS_PER_EM;

  /**
   * draw.io puts a top-aligned plain label's first baseline at
   * `bounds.y + spacing + baseSpacingTop + spacingTop + fontSize − 1`. `baseSpacingTop` is 5 and the
   * default `spacing` is 2 in drawio-desktop 31.4.5 — mxGraph's own `baseSpacingTop` is 0.
   */
  const DRAWIO_TOP = 7;
  /** A middle-aligned single line: `centre + spacingTop / 2 + fontSize − 1 − fontSize / 2`. Measured. */
  const middleBaseline = (cell: Cell, size: number): number =>
    box(cell).y + box(cell).height / 2 + Number(cell.style['spacingTop'] ?? 0) / 2 + size / 2 - 1;

  const nodeLabel = (model: LayoutModel, node: string, role: 'node' | 'description') =>
    model.labels.find(item => item.owner.kind === 'node' && item.owner.id === node
      && item.role === role && !item.omitted);

  it('puts the first baseline where the pipeline measured it', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    let checked = 0;
    for (const [key, node] of Object.entries(model.nodes)) {
      const name = nodeLabel(model, key, 'node');
      if (!name) continue;
      const cell = all.get(id('node', key))!;
      const size = name.fontSize!;
      const baseline = node.bounds!.y + DRAWIO_TOP + Number(cell.style['spacingTop']) + size - 1;
      expect(baseline).toBeCloseTo(name.bounds!.y + ascentOf(size), 9);
      if (cell.style['align'] === 'left') {
        // A card's name (ticket 159) starts at the left edge of its measured box: draw.io starts it `spacing` (2) plus `spacingLeft` in from the shape's edge.
        expect(name.textAlign).toBe('start');
        expect(node.bounds!.x + 2 + Number(cell.style['spacingLeft'] ?? 0)).toBeCloseTo(name.bounds!.x, 9);
      } else {
        // Centred on its own measured box, which may stand off the node's centre.
        const across = (Number(cell.style['spacingLeft'] ?? 0) - Number(cell.style['spacingRight'] ?? 0)) / 2;
        expect(node.bounds!.x + node.bounds!.width / 2 + across).toBeCloseTo(name.bounds!.x + name.bounds!.width / 2, 9);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 60000);

  it('gives the description a cell of its own, at its own weight, size and colour', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    const name = nodeLabel(model, 'both', 'node')!;
    const description = nodeLabel(model, 'both', 'description')!;
    // Plain text has one font per cell: in the name's cell the description would be bold and large.
    const node = all.get(id('node', 'both'))!;
    expect(node.value).toBe(name.text);
    expect(node.style['fontStyle']).toBe('1');
    const cell = all.get(id('nodeDescription', 'both'))!;
    expect(cell.parent).toBe(id('node', 'both'));
    expect(cell.value).toBe(description.text);
    expect(cell.style['fontSize']).toBe(String(description.fontSize));
    expect(cell.style['fontStyle']).toBeUndefined();
    expect(cell.style['fontColor']).toBe(NETWORK_THEME.light.node.description);
    // Its box is the measured one, stated from the node's top-left, and its baseline is `render`'s.
    const origin = model.nodes['both']!.bounds!;
    expect(box(cell).x + origin.x).toBeCloseTo(description.bounds!.x, 9);
    expect(middleBaseline(cell, description.fontSize!) + origin.y)
      .toBeCloseTo(description.bounds!.y + ascentOf(description.fontSize!), 9);
  }, 60000);

  // Snack-theme ticket 159: a card's name and subtitle are left-aligned and start at the left edge of their measured boxes. draw.io starts left-aligned
  // text `spacing` (2) plus `spacingLeft` in from the cell's edge: the name cell is the node, so `spacingLeft` states the rest of the offset; the subtitle
  // cell is its own measured box, so `spacingLeft` is -2. Checked with the drawio CLI (SVG export, 2026-10-31) on this input: both texts start at the measured x.
  it('starts the name and the subtitle of a card at the left edges of their measured boxes', async () => {
    const yaml = fixture('drawio-node-text').replace('portograph: 2\n', 'portograph: 2\nlayout: { nodeContent: card }\n');
    expect(yaml).toContain('nodeContent: card');
    const model = await pipeline(yaml);
    const all = cells(drawio(model, { theme: 'light' }));
    const name = nodeLabel(model, 'both', 'node')!, description = nodeLabel(model, 'both', 'description')!, origin = model.nodes['both']!.bounds!;
    expect([name.textAlign, description.textAlign]).toEqual(['start', 'start']);
    const node = all.get(id('node', 'both'))!, cell = all.get(id('nodeDescription', 'both'))!;
    expect([node.style['align'], cell.style['align']]).toEqual(['left', 'left']);
    expect(origin.x + 2 + Number(node.style['spacingLeft'])).toBeCloseTo(name.bounds!.x, 9);
    expect(cell.style['spacingLeft']).toBe('-2');
    expect(origin.x + box(cell).x + 2 + Number(cell.style['spacingLeft'])).toBeCloseTo(description.bounds!.x, 9);
    // The subtitle starts where the name starts: one left edge for the text block.
    expect(description.bounds!.x).toBeCloseTo(name.bounds!.x, 9);
  }, 60000);

  it('leaves a node with a description and no name without a label of its own', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    expect(nodeLabel(model, 'described', 'node')).toBeUndefined();
    const node = all.get(id('node', 'described'))!;
    expect(node.value).toBeUndefined();
    expect(node.style['spacingTop']).toBeUndefined();
    expect(all.get(id('nodeDescription', 'described'))!.value).toBe(nodeLabel(model, 'described', 'description')!.text);
    // A node with a name keeps the name's size and its bold.
    const named = all.get(id('node', 'named'))!;
    expect(named.style['fontSize']).toBe(String(nodeLabel(model, 'named', 'node')!.fontSize));
    expect(named.style['fontStyle']).toBe('1');
  }, 60000);

  it('emits no value and no text style for a node that draws no text', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const silent = JSON.parse(JSON.stringify(model)) as LayoutModel;
    silent.labels = silent.labels.filter(item => !(item.owner.kind === 'node'
      && item.owner.id === 'named' && item.role === 'node'));
    const cell = cells(drawio(silent, { theme: 'light' })).get(id('node', 'named'))!;
    expect(cell.value).toBeUndefined();
    expect(cell.style['spacingTop']).toBeUndefined();
    expect(cell.style['verticalAlign']).toBeUndefined();
  }, 60000);

  it('signs the offset, because a first line within 7 px of the node top needs a negative one', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    // draw.io honours a negative `spacingTop` — measured on drawio-desktop 31.4.5 — so the offset
    // is written as the arithmetic gives it. Clamping it at zero would drop the text down instead.
    const moved = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const label = moved.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'named' && item.role === 'node')!;
    label.bounds!.y = moved.nodes['named']!.bounds!.y + 1;
    const cell = cells(drawio(moved, { theme: 'light' })).get(id('node', 'named'))!;
    expect(Number(cell.style['spacingTop'])).toBeLessThan(0);
  }, 60000);

  it('exports label metrics that are out of contract, and states no length draw.io rejects', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    // `validate()` checks the boxes, not the type metrics, so a hand-made model can carry a zero
    // font size, a negative pitch or one that overflows when it is multiplied by the line count.
    const odd = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const name = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'node')!;
    name.lines = ['Beta', ''];
    name.lineHeight = -1;
    name.fontSize = 0;
    const description = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'description')!;
    description.lineHeight = 1e308;
    description.textRotation = 30;
    // An offset the model states can overflow when it is combined, not only when it is stated.
    const far = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'named' && item.role === 'node')!;
    far.bounds!.y = -1e308;
    far.lineHeight = 1.7e308;
    // Codex: a finite size too large for the font table, and a centre that overflows when doubled.
    const huge = JSON.parse(JSON.stringify(odd)) as LayoutModel;
    const hugeName = huge.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'node')!;
    hugeName.fontSize = 1.6e308;
    hugeName.bounds!.x = 1e308;
    expect(drawio(huge, { theme: 'light' })).not.toMatch(/Infinity|NaN/);
    const xml = drawio(odd, { theme: 'light' });
    expect(Number.isFinite(Number(cells(xml).get(id('node', 'named'))!.style['spacingTop']))).toBe(true);
    expect(Number.isFinite(Number(cells(xml).get(id('nodeDescription', 'both'))!.style['spacingTop']))).toBe(true);
    expect(xml).not.toMatch(/Infinity|NaN/);
  }, 60000);

  it('states the shift that puts a middle-aligned label on the baseline render draws', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model, { theme: 'light', labels: 'measured' }));
    // A group title kept as a text cell, and every pill: both are middle-aligned plain text.
    let checked = 0;
    for (const label of model.labels.filter(item => item.role === 'pill' && !item.omitted && item.port && item.bounds)) {
      const port = label.port!;
      const cell = all.get(id('port', port.node, port.name!, String(port.ordinal)))!;
      const size = label.fontSize!;
      const pill = box(cell), node = model.nodes[port.node]!.bounds!;
      // A turned pill's text runs along y, and its own vertical is the page's x.
      const turned = label.textRotation === -90;
      const centreAlong = turned ? node.x + pill.x + pill.width / 2 : node.y + pill.y + pill.height / 2;
      const labelCentre = turned ? label.bounds!.x + label.bounds!.width / 2 : label.bounds!.y + label.bounds!.height / 2;
      const thickness = turned ? label.bounds!.width : label.bounds!.height;
      expect(centreAlong + Number(cell.style['spacingTop']) / 2 + size / 2 - 1)
        .toBeCloseTo(labelCentre - thickness / 2 + ascentOf(size), 9);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 60000);
});

describe('link labels', () => {
  /**
   * `mxGraphView.getPoint`, written out here from what drawio-desktop 31.4.5 really does rather
   * than borrowed from the exporter, so a test can say where a label will land. Two properties of
   * it are what these cases are about: the arc-length position is rounded to a **whole pixel**
   * before the walk along the polyline, and a position that lands on a joint decodes onto the
   * *later* segment — and then takes that segment's normal, not the earlier one's.
   */
  const getPoint = (points: readonly Point[], at: { x: number; y: number; offset?: Point }): Point => {
    const spans = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
    const total = spans.reduce((sum, span) => sum + span, 0);
    const dist = Math.round((at.x / 2 + 0.5) * total);
    let span = spans[0] ?? 0, walked = 0, index = 1;
    while (dist >= Math.round(walked + span) && index < points.length - 1) {
      walked += span;
      span = spans[index]!;
      index += 1;
    }
    const from = points[index - 1]!, to = points[index]!;
    const dx = to.x - from.x, dy = to.y - from.y;
    const factor = span === 0 ? 0 : (dist - walked) / span;
    return {
      x: from.x + dx * factor + (span === 0 ? 0 : dy / span) * at.y + (at.offset?.x ?? 0),
      y: from.y + dy * factor - (span === 0 ? 0 : dx / span) * at.y + (at.offset?.y ?? 0),
    };
  };

  /** A cell's box in page space: a child geometry is always relative to its parent's top-left. */
  const absolute = (all: Map<string, Cell>, key: string): { x: number; y: number; width: number; height: number } => {
    let at: Cell | undefined = all.get(key), x = 0, y = 0;
    while (at) {
      x += Number(at.geometry['x'] ?? 0);
      y += Number(at.geometry['y'] ?? 0);
      at = at.parent === undefined ? undefined : all.get(at.parent);
    }
    return { ...box(all.get(key)!), x, y };
  };

  /**
   * The polyline draw.io really draws for a connector: the exported waypoints, with each pinned end
   * resolved against the cell it is pinned to. A pinned end sits on the pill's outward edge, which
   * is not where the model's own polyline starts — and an edge label is a fraction of *this*.
   */
  const drawnBy = (xml: string, all: Map<string, Cell>, cell: Cell): Point[] => {
    const end = (as: 'sourcePoint' | 'targetPoint'): Point => {
      const body = new RegExp(`<mxCell id="${cell.id.replace(/[%]/g, '\\$&')}"[\\s\\S]*?</mxCell>`).exec(flatCells(xml))![0];
      const match = new RegExp(`<mxPoint x="([^"]*)" y="([^"]*)" as="${as}"/>`).exec(body)!;
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    const pin = (key: string | undefined, prefix: 'exit' | 'entry'): Point | undefined => {
      if (key === undefined || cell.style[`${prefix}X`] === undefined) return undefined;
      const on = absolute(all, key);
      return { x: on.x + Number(cell.style[`${prefix}X`]) * on.width,
        y: on.y + Number(cell.style[`${prefix}Y`]) * on.height };
    };
    return [pin(cell.source, 'exit') ?? end('sourcePoint'), ...cell.points,
      pin(cell.target, 'entry') ?? end('targetPoint')];
  };

  /** Where a label carried by `edge` lands, read back the way draw.io reads it. */
  const landing = (xml: string, all: Map<string, Cell>, edge: Cell, label: Cell): Point =>
    getPoint(drawnBy(xml, all, edge), {
      x: Number(label.geometry['x'] ?? 0), y: Number(label.geometry['y'] ?? 0),
      ...(label.offset ? { offset: label.offset } : {}),
    });

  const point = (x: number, y: number): Point => ({ x, y });

  /**
   * A model holding nothing but the given links and their labels, so a run can be stated outright.
   * The canvas starts at the origin, which keeps the exported numbers the same as the written ones.
   */
  const probe = (base: LayoutModel, cases: readonly {
    id: string; runs: Point[][]; labels: { at: Point; support?: number; bar?: string }[];
  }[]): LayoutModel => ({
    ...base,
    document: { ...base.document, nodes: {}, groups: {}, links: cases.map(item => ({ id: item.id, from: { node: 'from', name: 'a', ordinal: 1 }, to: { node: 'to', name: 'b', ordinal: 1 } })) as never },
    nodes: {}, groups: {}, lanes: [], labelBands: [], tierBands: [], bundles: [], junctions: [],
    barDrops: [], groupLinks: [], regions: [], obstacles: [],
    canvas: { x: 0, y: 0, width: 800, height: 700 },
    links: cases.map((item, index) => {
      const owner = { kind: 'link', id: item.id } as const;
      return {
        id: item.id, sourceIndex: index, owner,
        from: { node: 'from', name: 'a', ordinal: 1 }, to: { node: 'to', name: 'b', ordinal: 1 },
        family: 'routed', layer: 'routed', technique: 'orthogonal',
        path: { owner, layer: 'routed', fixed: true, segments: item.runs.flatMap(run =>
          run.slice(1).map((to, step) => ({ from: run[step]!, to, owner }))) },
      } as const;
    }),
    labels: cases.flatMap(item => item.labels.map((label, index) => ({
      id: `${item.id}-${index}`,
      owner: label.bar === undefined ? { kind: 'link', id: item.id } as const : { kind: 'barCross', node: label.bar, link: item.id } as const,
      layer: 'routed' as const, role: 'link' as const,
      text: `${item.id}-${index}`, lines: [`${item.id}-${index}`], fontSize: 9, fontWeight: 400 as const,
      bounds: { x: label.at.x - 20, y: label.at.y - 6, width: 40, height: 12 },
      ...(label.support === undefined ? {}
        : { support: { kind: 'link-segment' as const, link: item.id, segment: label.support } }),
    }))),
  });

  const blank = (): Promise<LayoutModel> => pipeline(`
portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g}}
links: []
`);

  it('states a label against the polyline draw.io draws, terminals included', async () => {
    // Codex round 3: the fractions were computed from the model's own polyline, whose ends are the
    // port anchors — but the exporter moves each pinned end onto the pill's outward edge, so
    // draw.io resolved the same fraction of a shorter line and the label slid along the run.
    const model = await pipeline(fixture('drawio-constructs'));
    const label = model.labels.find(item => item.role === 'link' && !item.omitted
      && item.support?.kind === 'link-segment')!;
    const owner = (label.owner as { id: string }).id;
    const link = model.links.find(item => item.id === owner)!;
    const xml = drawio(model, { labels: 'measured' });
    const all = cells(xml);
    const edge = all.get(id('link', stable(model, owner)))!;

    const reserved = [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)]
      .map(at => ({ x: at.x - model.canvas!.x, y: at.y - model.canvas!.y }));
    const drawn = drawnBy(xml, all, edge);
    // The case is only worth making if the two polylines really do differ at the ends.
    expect(drawn[0]).not.toEqual(reserved[0]);
    expect(drawn.length).toBe(reserved.length);
    // `measured` asks for the box stage 9 placed, so that centre is what draw.io must resolve to.
    const want = { x: label.bounds!.x + label.bounds!.width / 2 - model.canvas!.x,
      y: label.bounds!.y + label.bounds!.height / 2 - model.canvas!.y };
    expect(landing(xml, all, edge, edge).x).toBeCloseTo(want.x, 9);
    expect(landing(xml, all, edge, edge).y).toBeCloseTo(want.y, 9);
    // Read against the reserved polyline instead — what the exporter used to state — and the same
    // numbers land somewhere else. That difference is the whole of this finding.
    const wrong = getPoint(reserved, { x: Number(edge.geometry['x']), y: Number(edge.geometry['y']),
      ...(edge.offset ? { offset: edge.offset } : {}) });
    expect(Math.hypot(wrong.x - want.x, wrong.y - want.y)).toBeGreaterThan(1);
  }, 60000);

  it('keeps a residual offset for a position the relative pair cannot reach', async () => {
    // Codex round 3: an arc-length fraction clamps at an endpoint, a corner decodes onto the later
    // segment and takes its normal, and a zero-length polyline has no direction at all. Each loses
    // part of the measured displacement, and the loss was silent. The relative pair still carries
    // everything it can — that is what makes a label follow its connector — and `offset` carries
    // only the remainder.
    const cases = [
      { id: 'inside', runs: [[point(100, 100), point(300, 100)]], labels: [{ at: point(180, 80) }] },
      { id: 'beyond', runs: [[point(100, 180), point(300, 180)]], labels: [{ at: point(350, 160) }] },
      { id: 'corner', runs: [[point(500, 250), point(700, 250), point(700, 350)]],
        labels: [{ at: point(700, 230) }] },
      { id: 'zero-first', runs: [[point(100, 400), point(100, 400), point(300, 400)]],
        labels: [{ at: point(100, 380) }] },
      { id: 'zero-total', runs: [[point(400, 400), point(400, 400)]], labels: [{ at: point(440, 380) }] },
    ];
    const xml = drawio(probe(await blank(), cases), { labels: 'measured' });
    const all = cells(xml);
    for (const item of cases) {
      const edge = all.get(id('link', item.id))!;
      const at = landing(xml, all, edge, edge);
      const want = item.labels[0]!.at;
      expect([item.id, at.x, at.y]).toEqual([item.id, want.x, want.y]);
      // `x` stays a fraction of the whole, as the format states it.
      expect(Number(edge.geometry['x'])).toBeGreaterThanOrEqual(-1);
      expect(Number(edge.geometry['x'])).toBeLessThanOrEqual(1);
    }
    // An ordinary interior position needs no remainder at all, so one is not written.
    expect(all.get(id('link', 'inside'))!.offset).toBeUndefined();
    // The corner label is north of the joint, which only the eastbound segment's normal reaches.
    // Stating the position *at* the joint would hand it to the southbound segment, whose normal
    // points east, so the arc length steps back one whole pixel and the remainder is that pixel.
    expect(all.get(id('link', 'corner'))!.offset).toEqual({ x: 1, y: 0 });
  }, 60000);

  it('attaches a label to the connector that draws its supporting segment', async () => {
    // Codex round 3: a path whose segment chain breaks becomes one connector per run, and every
    // label went to run 0 — so a label supported by a later run was stated against a polyline that
    // does not contain it, 300px away in the reproducer.
    const runs = [[point(100, 500), point(200, 500)], [point(400, 500), point(600, 500)]];
    const model = probe(await blank(), [
      { id: 'own', runs, labels: [{ at: point(500, 480), support: 1 }] },
      { id: 'children', runs,
        labels: [{ at: point(150, 480), support: 0 }, { at: point(500, 480), support: 1, bar: 'x' }] },
    ]);
    const xml = drawio(model, { labels: 'measured' });
    const all = cells(xml);
    // The connector's own label, carried by the run that draws segment 1.
    const later = all.get(id('link', 'own', '1'))!;
    expect(later.value).toBe('own-0');
    expect(all.get(id('link', 'own', '0'))!.value).toBeUndefined();
    expect(landing(xml, all, later, later)).toEqual({ x: 500, y: 480 });
    // A child label follows the same rule: two eligible labels on one link are both children, and
    // each belongs to the connector that draws the segment it was measured against. A link's own
    // label takes the id of the link; a second label on it is a bar crossing, and takes the bar's node too.
    for (const [index, want] of [point(150, 480), point(500, 480)].entries()) {
      const child = all.get(index === 0 ? id('linkLabel', 'children') : id('linkLabel', 'children', 'x'))!;
      expect(child.parent).toBe(id('link', 'children', String(index)));
      expect(landing(xml, all, all.get(child.parent!)!, child)).toEqual(want);
    }
  }, 60000);

  it('anchors a label to its supporting segment, not to a parallel one that reaches it', async () => {
    // Codex rounds 4 and 5: two positions can reach the same point, one from the segment stage 9
    // measured the label against and one from a parallel segment 200px away with a perpendicular
    // of -200. Both draw the label in the right place, and only one keeps it there when the shape
    // moves. Whole lengths made it a tie; a fractional length let the far segment win outright.
    for (const depth of [300, 300.4]) {
      const run = [point(100, 100), point(300, 100), point(300, depth), point(100, depth)];
      const model = probe(await blank(),
        [{ id: 'facing', runs: [run], labels: [{ at: point(200, depth + 20), support: 2 }] }]);
      const xml = drawio(model, { labels: 'on-run' });
      const all = cells(xml);
      const edge = all.get(id('link', 'facing'))!;
      expect(landing(xml, all, edge, edge)).toEqual({ x: 200, y: depth });
      // On its run means a perpendicular of zero — against the supporting segment, not against the
      // one that faces it. Drag that segment 100px down and the label goes with it.
      expect(Number(edge.geometry['y'])).toBeCloseTo(0, 9);
      const moved = [run[0]!, run[1]!, point(300, depth + 100), point(100, depth + 100)];
      expect(getPoint(moved, { x: Number(edge.geometry['x']), y: Number(edge.geometry['y']) }).y)
        .toBeCloseTo(depth + 100, 9);
    }
  }, 60000);

  it('reaches a label beyond a run shorter than a pixel without an absolute offset', async () => {
    // Codex round 4: the arc length was held to whole pixels inside the run, but draw.io rounds the
    // fraction it is given, so x=1 on a 0.8px run resolves a fraction past the last point. Holding
    // the candidates short of that spent an absolute offset on a position the pair could reach.
    const model = probe(await blank(), [
      { id: 'short', runs: [[point(100, 100), point(100.8, 100)]], labels: [{ at: point(101, 120) }] },
    ]);
    const all = cells(drawio(model, { labels: 'measured' }));
    expect(all.get(id('link', 'short'))!.offset).toBeUndefined();
    expect(Number(all.get(id('link', 'short'))!.geometry['x'])).toBeLessThanOrEqual(1);
  }, 60000);

  it('states a label in time linear in the length of its run', async () => {
    // Codex round 4: every candidate position walked the whole polyline, and the candidates grow
    // with it, so a 500-segment path cost 37x what it did before. The candidates are read in
    // ascending order and draw.io's walk only moves forward, so one walk serves them all.
    const long = (count: number): Point[] =>
      Array.from({ length: count + 1 }, (_, step) => point(30 * step, 100 + 30 * (step % 2)));
    const model = probe(await blank(), Array.from({ length: 60 }, (_, index) => ({
      id: `long-${index}`, runs: [long(400)], labels: [{ at: point(6000.3, 130.2) }],
    })));
    const started = Date.now();
    const all = cells(drawio(model, { labels: 'measured' }));
    // Generous by design: the point is the shape of the growth, not the machine it ran on.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(all.get(id('link', 'long-0'))!.value).toBe('long-0-0');
  }, 60000);
});

describe('connection grid, rotation and tiles', () => {
  /** The `points=` of one node, as fractions of its box, the way draw.io reads them. */
  const listed = (all: Map<string, Cell>, key: string): Point[] =>
    [...all.get(id('node', key))!.style['points']!.matchAll(/\[([-\d.]+),([-\d.]+),0\]/g)]
      .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));

  it('puts the side grid in the phase the pipeline reserved its slots in', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const node = model.nodes['a']!, bounds = node.bounds!;
    const points = listed(cells(drawio(model)), 'a');
    const bottom = points.filter(point => point.y === 1).map(point => bounds.x + point.x * bounds.width);
    const anchors = node.ports.filter(port => port.side === 'bottom' && port.anchor)
      .map(port => port.anchor!.x).sort((a, b) => a - b);
    const pitch = node.sidePitch!.bottom!;
    expect(anchors.length).toBeGreaterThan(1);

    // The claim: the pipeline centres a side's slots — `(length - (ports - 1) * pitch) / 2 +
    // index * pitch` in `src/layout/node-geometry.ts` — so the grid is the reserved anchors carried
    // on by whole pitches, not the box corner plus a pitch. Counted from the corner, every offered
    // point misses every real port by the same fraction of a pitch: the pills fixture put them
    // 1.25 px out, which is near enough to look right and far enough to be wrong.
    for (const at of bottom) {
      const steps = (at - anchors[0]!) / pitch;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
    // Every real anchor is on the grid, and the grid reaches past the outermost port in both
    // directions — which is what "the rest of this side's slots" has to mean.
    for (const anchor of anchors) expect(bottom.some(at => Math.abs(at - anchor) < 1e-6)).toBe(true);
    expect(bottom.some(at => at < anchors[0]! - pitch / 2)).toBe(true);
    expect(bottom.some(at => at > anchors[anchors.length - 1]! + pitch / 2)).toBe(true);

    // A side with no port at all takes the slot the pipeline would reserve for a single port: the
    // middle of the side. `a` has no top port, and the top grid is centred on the node.
    expect(node.ports.some(port => port.side === 'top')).toBe(false);
    const top = points.filter(point => point.y === 0).map(point => point.x);
    expect(top.some(at => Math.abs(at - 0.5) < 1e-9)).toBe(true);
  }, 60000);

  it('keeps the phase the rest of the anchors still agree on', async () => {
    const model = await pipeline(fixture('author-ordered-bundle'));
    const node = model.nodes['source']!, bounds = node.bounds!, pitch = node.sidePitch!.bottom!;
    const order = node.ports.filter(port => port.side === 'bottom' && port.anchor)
      .map(port => port.ref.ordinal).sort((left, right) => left - right);
    expect(order.length).toBe(3);

    // A rule may move one anchor off the reserved run. Taking the lowest anchor as the phase hands
    // the whole grid to the one slot that moved, and every offered point then misses the anchors
    // that did not move. The run the rest of them still stand on is the grid instead.
    const moved = structuredClone(model);
    const first = moved.nodes['source']!.ports.find(port => port.ref.ordinal === order[0])!;
    first.anchor!.x -= pitch / 4;
    const points = listed(cells(drawio(moved)), 'source')
      .filter(point => point.y === 1).map(point => bounds.x + point.x * bounds.width);
    const kept = node.ports.find(port => port.ref.ordinal === order[1])!.anchor!.x;
    for (const at of points) {
      // Every point is either the moved anchor, which keeps its own explicit point, or a slot of
      // the run the two unmoved anchors still hold.
      if (Math.abs(at - first.anchor!.x) < 1e-6) continue;
      const steps = (at - kept) / pitch;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
    expect(points.some(at => Math.abs(at - first.anchor!.x) < 1e-6)).toBe(true);
    // Nothing else moves with it: the slot the moved anchor left is still offered.
    expect(points.some(at => Math.abs(at - node.ports.find(port => port.ref.ordinal === order[0])!.anchor!.x) < 1e-6))
      .toBe(true);
  }, 60000);

  it('bounds the side grid instead of walking a pitch that never advances', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    // Three shapes `validate()` accepts and the old loop could not leave. A pitch of 1e-8 on a
    // 55 px side asks for 5.5 billion points. At x=1e20 the sum `at + pitch` equals `at`, so an
    // accumulating loop appends one fraction for ever — and an anchor at 1e20 does the same to the
    // step index, since `step + 1 === step` there too. All three are refused by counting the slots
    // first and then indexing each one from the phase by a counter small enough to grow.
    for (const patch of [
      { pitch: 1e-8, x: undefined, width: undefined, anchor: undefined },
      { pitch: 1, x: 1e20, width: 1e7, anchor: undefined },
      { pitch: 1, x: undefined, width: 55, anchor: 1e20 },
    ]) {
      const probe = structuredClone(model);
      const node = probe.nodes['a']!;
      if (patch.anchor === undefined) node.ports = [];
      else for (const port of node.ports) { port.side = 'top'; port.anchor = { x: patch.anchor, y: node.bounds!.y }; }
      node.sidePitch = { top: patch.pitch };
      if (patch.x !== undefined) node.bounds!.x = patch.x;
      if (patch.width !== undefined) node.bounds!.width = patch.width;
      const started = Date.now();
      const all = cells(drawio(probe));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(listed(all, 'a').length).toBeLessThanOrEqual(node.ports.length + 512);
    }
    // An ordinary side still offers its slots, so the bound is a guard and not a switch.
    expect(listed(cells(drawio(model)), 'a').length).toBeGreaterThan(2);
  }, 60000);

  /** The top-side grid of `drawio-constructs`'s node `a`, given anchors of our own to reason from. */
  const topGrid = (source: LayoutModel, at: readonly number[], width: number, pitch: number): number[] => {
    const probe = structuredClone(source);
    const node = probe.nodes['a']!;
    node.bounds = { x: 0, y: 0, width, height: 48 };
    node.sidePitch = { top: pitch };
    const first = node.ports[0]!;
    node.ports = at.map((x, index) => {
      const copy = structuredClone(first);
      copy.side = 'top';
      copy.anchor = { x, y: 0 };
      copy.ref = { node: copy.ref.node, name: `p${index}`, ordinal: index + 1 };
      delete copy.pill;
      return copy;
    });
    return listed(cells(drawio(probe)), 'a').filter(point => point.y === 0).map(point => point.x * width);
  };

  /** The offered points that are not one of the node's own anchors: the grid the export added. */
  const added = (points: readonly number[], at: readonly number[]): number[] =>
    points.filter(point => !at.some(anchor => Math.abs(point - anchor) < 1e-6));

  /** Whether `at` stands on the run through `phase`, one pitch to a slot. */
  const onRun = (at: number, phase: number, pitch: number): boolean => {
    const steps = (at - phase) / pitch;
    return Math.abs(steps - Math.round(steps)) < 1e-6;
  };

  it('holds a run together across a rounding boundary', async () => {
    const source = await pipeline(fixture('drawio-constructs'));
    // Two anchors one pitch apart, on a residue a bucket key rounds to two different keys. Grouping
    // by a key splits that majority and hands the grid to the single stray anchor at 1.
    const split = [1, 12.00005, 24.00005];
    const grid = added(topGrid(source, split, 60, 12), split);
    expect(grid.length).toBeGreaterThan(0);
    for (const at of grid) expect(onRun(at, 12.00005, 12)).toBe(true);

    // Four anchors of one run whose residues straddle zero: two just below the pitch and two just
    // above it. They are one run and outnumber the three at residue 2, but only if the gap that
    // closes the wrap is measured from the last group's highest residue to the first group's
    // lowest. Measured from the wrong end of the first group, the merge is missed by 0.00009 and
    // the minority takes the grid.
    const wrap = [10, 20.00009, 9.99995, 19.99996, 2, 12, 22];
    const wrapped = added(topGrid(source, wrap, 50, 10), wrap);
    expect(wrapped.length).toBeGreaterThan(0);
    for (const at of wrapped) expect(onRun(at, 9.99995, 10)).toBe(true);
  }, 60000);

  it('does not offer a slot beside an anchor it snapped onto', async () => {
    const source = await pipeline(fixture('drawio-constructs'));
    // The candidate at 48.0000009 clears the port test, then snaps to the side's end at 48 — where
    // the anchor at 47.9999991 already is. Snapped after the test, both are offered, a rounding
    // error apart. The test now sees the snapped point, so the slot is dropped instead.
    const points = topGrid(source, [12.0000009, 24.0000009, 47.9999991], 48, 12);
    for (const at of points) expect(points.filter(other => Math.abs(other - at) < 1e-3).length).toBe(1);
  }, 60000);

  it('still offers a wide node its grid, and each corner only once', async () => {
    // 800 px of node at the pipeline's own 12 px pitch is 67 slots a side. A bound that a measured
    // diagram reaches is not a guard against a degenerate pitch — it is a silent loss of the grid.
    const model = await pipeline([
      'portograph: 2', 'groups: { g: { tier: 0 } }',
      'nodes: { a: { group: g, label: Wide, size: { width: 800, height: 50 } } }', 'links: []',
    ].join('\n'));
    const points = listed(cells(drawio(model)), 'a');
    expect(points.filter(point => point.y === 0).length).toBeGreaterThan(60);
    // Two sides meet at a corner and each would offer it. draw.io keeps both, and the file carries
    // a point a pointer can never choose twice.
    const seen = points.map(point => `${point.x},${point.y}`);
    expect(new Set(seen).size).toBe(seen.length);

    // A corner two sides reach by different arithmetic: a 51 px side at a 0.3 px pitch lands the
    // top grid's last slot on 50.99999999999999, which is the same corner as the right side's 51
    // to a reader and a second connection point to draw.io.
    const source = await pipeline(fixture('drawio-constructs'));
    const probe = structuredClone(source);
    const node = probe.nodes['a']!;
    node.bounds = { x: 0, y: 0, width: 51, height: 48 };
    node.sidePitch = { top: 0.3, right: 12 };
    node.ports = node.ports.slice(0, 1).map(port => {
      const copy = structuredClone(port);
      copy.side = 'top';
      copy.anchor = { x: 0.3, y: 0 };
      delete copy.pill;
      return copy;
    });
    const corners = listed(cells(drawio(probe)), 'a');
    // Two points a reader cannot tell apart are one point. A `Set` of the written strings does not
    // catch this on its own: `0.9999999999999999` and `1` are two strings and one corner.
    for (const [index, point] of corners.entries()) {
      for (const other of corners.slice(index + 1)) {
        expect(Math.abs(point.x - other.x) > 1e-9 || Math.abs(point.y - other.y) > 1e-9).toBe(true);
      }
    }
    expect(corners.filter(point => point.x === 1 && point.y === 0).length).toBe(1);
  }, 60000);

  /** One link label at `angle`, and the cells the export makes of it. */
  const turned = (source: LayoutModel, angle: number): { all: Map<string, Cell>; label: string; link: string } => {
    const model = structuredClone(source);
    const label = model.labels.find(item => item.role === 'link' && !item.omitted && item.bounds)!;
    label.textRotation = angle;
    const link = stable(model, (label.owner as { id: string }).id);
    return { all: cells(drawio(model)), label: link, link };
  };

  it('encodes a link label turn on the carrier that honours it', async () => {
    const source = await pipeline(fixture('drawio-constructs'));
    // Measured against drawio-desktop 31.4.5, on a horizontal edge, reading the `transform` of the
    // exported SVG. An edge's own label takes `horizontal=0` (-90) and ignores `rotation=` outright;
    // a child `edgeLabel` cell takes `rotation=` at any angle, and `horizontal=0` then adds a
    // further -90 on top rather than replacing it. So -90 stays on the edge and every other angle
    // becomes a child, which is where `rotation=` is read.
    const minus = turned(source, -90);
    const edge = minus.all.get(id('link', minus.link))!;
    expect(edge.style['horizontal']).toBe('0');
    expect(edge.style['rotation']).toBeUndefined();
    expect(minus.all.has(id('linkLabel', minus.label))).toBe(false);

    for (const angle of [90, 180, 45]) {
      const probe = turned(source, angle);
      // +90 written as `horizontal=0` rendered as -90, and 180 was dropped altogether by a fallback
      // that skipped every multiple of 90. Both now state their own angle, once.
      expect(probe.all.get(id('link', probe.link))!.style['horizontal']).toBeUndefined();
      const child = probe.all.get(id('linkLabel', probe.label))!;
      expect(child.style['rotation']).toBe(String(angle));
      expect(child.style['horizontal']).toBeUndefined();
    }

    // An unturned label needs neither key.
    const flat = turned(source, 0);
    expect(flat.all.get(id('link', flat.link))!.style['horizontal']).toBeUndefined();
    expect(flat.all.get(id('link', flat.link))!.style['rotation']).toBeUndefined();
  }, 120000);

  it('turns a pill label with the one key a vertex honours', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    // `PillGeometry.textRotation` is `-90 | 0`: `placePortPill` is its one producer and it turns a
    // pill only on a top or bottom side. On a vertex `rotation=` would turn the shape as well, so
    // `horizontal=0` is both the right key and the only one.
    let checked = 0;
    for (const [key, node] of Object.entries(model.nodes)) {
      for (const port of node.ports) {
        if (!port.pill || port.ref.anonymous === true) continue;
        const cell = all.get(id('port', key, port.ref.name!, String(port.ref.ordinal)))!;
        expect(cell.style['horizontal']).toBe(port.pill.textRotation === -90 ? '0' : undefined);
        expect(cell.style['rotation']).toBeUndefined();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);

    const flat = structuredClone(model);
    const upright = Object.values(flat.nodes).flatMap(node => node.ports).find(port => port.pill)!;
    upright.pill!.textRotation = 0;
    const cell = cells(drawio(flat)).get(id('port', upright.ref.node, upright.ref.name!, String(upright.ref.ordinal)))!;
    expect(cell.style['horizontal']).toBeUndefined();
  }, 60000);

  it('leaves out a glyph a tile has no room for, rather than writing a negative box', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    for (const icons of ['profile', 'cisco19'] as const) {
      const normal = cells(drawio(model, { icons }));
      expect(normal.has(id('icon', 'a'))).toBe(true);
      for (const cell of normal.values()) {
        expect(box(cell).width).toBeGreaterThanOrEqual(0);
        expect(box(cell).height).toBeGreaterThanOrEqual(0);
      }

      // A zero-width tile: subtracting the 1.5 px inset from it gives width -3, which draw.io
      // writes without complaint and then draws as nothing at all — an empty group where the icon
      // was. The whole icon goes rather than only its inset, so the tile is dropped with it.
      const thin = structuredClone(model);
      thin.nodes['a']!.icon!.bounds.width = 0;
      thin.nodes['a']!.icon!.icon = 'cloud';
      const all = cells(drawio(thin, { icons }));
      expect(all.has(id('icon', 'a'))).toBe(false);
      expect(all.has(id('iconTile', 'a'))).toBe(false);
      for (const cell of all.values()) {
        expect(Number.isNaN(box(cell).width)).toBe(false);
        expect(box(cell).width).toBeGreaterThanOrEqual(0);
        expect(box(cell).height).toBeGreaterThanOrEqual(0);
      }

      // A tile 2 px across keeps the tile and drops the glyph: there is something to draw, and no
      // room inside it for the inset the glyph needs.
      const tight = structuredClone(model);
      tight.nodes['a']!.icon!.bounds.width = 2;
      tight.nodes['a']!.icon!.icon = 'cloud';
      const some = cells(drawio(tight, { icons }));
      expect(some.has(id('iconTile', 'a'))).toBe(true);
      expect(some.has(id('icon', 'a'))).toBe(false);
    }
  }, 60000);

  it('applies the same guard to a legend swatch', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const entry = model.legend!.entries.find(item => item.kind === 'symbol' && item.icon)!;
    for (const icons of ['profile', 'cisco19'] as const) {
      expect(cells(drawio(model, { icons })).has(id('legendSwatch', entry.id))).toBe(true);
      const thin = structuredClone(model);
      thin.legend!.entries.find(item => item.id === entry.id)!.swatch.width = 0;
      const all = cells(drawio(thin, { icons }));
      expect(all.has(id('legendSwatch', entry.id))).toBe(false);
      expect(all.has(id('legendTile', entry.id))).toBe(false);
      for (const cell of all.values()) expect(box(cell).width).toBeGreaterThanOrEqual(0);
    }
  }, 60000);
});

describe('maintainer edit principles', () => {
  /** The overlay port clearance at the default stroke, the stand-off `overlayPath` keeps off a pill head (ticket 23). */
  const CLEARANCE = OVERLAY_PILL_CLEARANCE;

  /** One pill of an overlay end, in page space: the side it sits on and the box placement reserved. */
  interface Pill { side: string; x: number; y: number; width: number; height: number }

  /** The overlay link of a diagram with its connector cell, its two pills and the drawn polyline. */
  async function overlayOf(yaml: string): Promise<{ cell: Cell; head: Pill; tail: Pill; path: Point[] }> {
    const model = await pipeline(yaml);
    const all = cells(drawio(model));
    const origin = model.canvas!;
    const link = model.links.find(item => effectiveLayer(item) === 'overlay' && item.path)!;
    const pillOf = (ref: { node: string; name?: string; ordinal: number }): Pill => {
      const port = model.nodes[ref.node]!.ports.find(item => item.ref.name === ref.name
        && item.ref.ordinal === ref.ordinal)!;
      const pill = port.pill!.bounds;
      return { side: port.side!, x: pill.x - origin.x, y: pill.y - origin.y,
        width: pill.width, height: pill.height };
    };
    const outward = (pill: Pill): Point => ({
      x: pill.x + (pill.side === 'right' ? pill.width : pill.side === 'left' ? 0 : pill.width / 2),
      y: pill.y + (pill.side === 'bottom' ? pill.height : pill.side === 'top' ? 0 : pill.height / 2),
    });
    const cell = all.get(id('link', stable(model, link.id)))!;
    const head = pillOf(link.attachments!.from), tail = pillOf(link.attachments!.to);
    return { cell, head, tail, path: [outward(head), ...cell.points, outward(tail)] };
  }

  /** Whether two points of the drawn polyline share an axis. */
  const onOneAxis = (one: Point, two: Point): boolean =>
    Math.abs(one.x - two.x) < 1e-6 || Math.abs(one.y - two.y) < 1e-6;

  /** A point one clearance outward of `at`, the way a pill on `side` faces. */
  const out = (at: Point, side: string): Point => ({
    x: at.x + (side === 'left' ? -CLEARANCE : side === 'right' ? CLEARANCE : 0),
    y: at.y + (side === 'top' ? -CLEARANCE : side === 'bottom' ? CLEARANCE : 0),
  });

  /** Every segment of the drawn polyline runs on one axis and reaches inside neither pill. */
  const square = (path: readonly Point[], pills: readonly Pill[]): void => {
    for (const [index, point] of path.slice(1).entries()) {
      const before = path[index]!;
      expect(Math.abs(point.x - before.x) < 1e-6 || Math.abs(point.y - before.y) < 1e-6).toBe(true);
      for (const pill of pills) {
        expect(Math.max(before.x, point.x) > pill.x && Math.min(before.x, point.x) < pill.x + pill.width
          && Math.max(before.y, point.y) > pill.y && Math.min(before.y, point.y) < pill.y + pill.height).toBe(false);
      }
    }
  };

  it('writes a square route as a square connector, waypoints and all', async () => {
    // The maintainer's words: "if it's routed square, style should also be like that." Measured on
    // drawio-desktop 31.4.5 over 61 link edges in four diagrams: `orthogonalEdgeStyle;jettySize=0`
    // draws every one of them on the pipeline's route — 59 within 0.05 px, 2 within 0.51 px, which
    // is an endpoint defect `edgeStyle=none` shares. Collinear midpoints stay: pruning them moves
    // the crossover a hand drag produces out of the reserved stem band into mid-span.
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const canvas = model.canvas!;
    const kinds = new Set<string>();
    let square = 0;
    for (const link of model.links) {
      if (link.technique === 'stub' || !link.path || effectiveLayer(link) === 'overlay') continue;
      const cell = all.get(id('link', stable(model, link.id)))!;
      kinds.add(styleRule(cell));
      expect(cell.points).toEqual(link.path.segments.slice(0, -1)
        .map(segment => ({ x: segment.to.x - canvas.x, y: segment.to.y - canvas.y })));
      square += 1;
    }
    expect(square).toBeGreaterThan(0);
  }, 60000);

  it('exports a straight link as `edgeStyle=none` and a bent link as orthogonal with `jettySize=0`', async () => {
    // Maintainer, 2026-10-23: a run with no bend is a straight connector, because that is easier to
    // edit in draw.io. A run with a bend keeps the orthogonal style.
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const kinds = new Set<string>();
    for (const link of model.links) {
      if (!link.path || link.technique === 'stub' || effectiveLayer(link) === 'overlay') continue;
      const cell = all.get(id('link', stable(model, link.id)))!;
      const kind = styleRule(cell);
      kinds.add(kind);
      const points = [link.path.segments[0]!.from, ...link.path.segments.map(segment => segment.to)];
      const turns = points.some(point => Math.abs(point.x - points[0]!.x) > 1e-6)
        && points.some(point => Math.abs(point.y - points[0]!.y) > 1e-6);
      expect(kind).toBe(turns ? 'bent' : 'straight');
    }
    expect([...kinds].sort()).toEqual(['bent', 'straight']);
  }, 60000);

  it('keeps `edgeStyle=none` for a polyline the orthogonal router cannot hold', async () => {
    // The guard. No diagram in the corpus routes a diagonal today, but the orthogonal router reads
    // a waypoint one coordinate at a time, so a segment on neither axis would be re-routed rather
    // than drawn. Such a link keeps the style that reproduces any polyline verbatim.
    const model = await pipeline(fixture('drawio-constructs'));
    const straight = model.links.find(link => link.path && link.technique !== 'stub'
      && effectiveLayer(link) === 'routed')!;
    const bent = structuredClone(model);
    const path = bent.links.find(link => link.id === straight.id)!.path!;
    // One midpoint pushed off both axes, which leaves the two segments around it diagonal.
    const corner = path.segments[0]!;
    const off = { x: corner.to.x + 7, y: corner.to.y + 3 };
    path.segments = [{ ...corner, to: off }, { ...corner, from: off }, ...path.segments.slice(1)];
    const cell = cells(drawio(bent)).get(id('link', stable(model, straight.id)))!;
    expect(cell.style['edgeStyle']).toBe('none');
    expect(cell.style['jettySize']).toBeUndefined();
    // The waypoints are still the stated ones: the guard changes the style, never the geometry.
    expect(cell.points[0]).toEqual({ x: off.x - model.canvas!.x, y: off.y - model.canvas!.y });
  }, 60000);

  it('reads the guard off the polyline draw.io draws, terminals included', async () => {
    // Codex round 1: the guard read the waypoints alone. An end is pinned to the pill's outward
    // midpoint, not to the port anchor the path starts from, so a pill that does not sit on its own
    // anchor's axis moves the endpoint *across* that axis — and a link whose every waypoint is
    // square is then drawn as a diagonal the orthogonal router would answer with a corner nothing
    // reserved.
    const model = await pipeline(fixture('drawio-constructs'));
    const link = model.links.find(item => effectiveLayer(item) === 'overlay' && item.path)!;
    const square = cells(drawio(model)).get(id('link', stable(model, link.id)))!;
    // Ticket 34: the overlay is a U, square from terminal to terminal, so it is a square connector.
    expect(square.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(square.points).toHaveLength(2);
    const skewed = structuredClone(model);
    const ref = link.attachments!.from;
    // The pill moved — a hand edit the model knows nothing about. Since ticket 34 the path leaves the
    // top pill by a vertical leg (the U), so moving the pill in y keeps the pinned endpoint on that
    // leg's axis and skews nothing; moving it 12 px in x moves the pinned endpoint off the leg's axis,
    // which is the case this guard is for.
    skewed.nodes[ref.node]!.ports.find(item => item.ref.name === ref.name
      && item.ref.ordinal === ref.ordinal)!.pill!.bounds.x += 12;
    const cell = cells(drawio(skewed)).get(id('link', stable(model, link.id)))!;
    expect(cell.points).toEqual(square.points);
    expect(cell.style['edgeStyle']).toBe('none');
    expect(cell.style['jettySize']).toBeUndefined();
  }, 60000);

  it('leaves an overlay end that draws no pill by the node it terminates on', async () => {
    // Review finding 6. A link written to a bare node gets an anonymous port, which draws no pill:
    // the box the overlay leaves is the node body and the anchor is already on its face, so the path
    // steps out by the clearance from there. draw.io pins such an end to the same point — the
    // node-relative anchor — so the connector is square and carries the model's own interior points.
    // Before the geometry moved into the model this link exported `edgeStyle=none` with no waypoint
    // at all, because the exporter's own detour needed two pills.
    const model = await pipeline(`
portograph: 2
render: {anonymousPortMarker: none}
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  a: {group: upper, ports: [{name: d1, side: bottom}]}
  b: {group: lower, ports: [{name: u1, side: top}]}
  c: {group: lower, ports: [{name: lo, side: bottom}]}
links:
  - [a.d1, b.u1]
  - [b, c.lo, {route: overlay}]
`);
    const link = model.links.find(item => effectiveLayer(item) === 'overlay')!;
    const bare = model.nodes['b']!.ports.find(port => port.ref.anonymous === true)!;
    expect(bare.pill).toBeUndefined();
    const points = [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
    expect(points[0]).toEqual(bare.anchor);
    expect(points[1]).toEqual({ x: bare.anchor!.x + CLEARANCE, y: bare.anchor!.y });
    const canvas = model.canvas!, cell = cells(drawio(model)).get(id('link', stable(model, link.id)))!;
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(cell.style['jettySize']).toBe('0');
    expect(cell.points).toEqual(points.slice(1, -1)
      .map(point => ({ x: point.x - canvas.x, y: point.y - canvas.y })));
    // A port with no pill hangs its mark on its node (issue 03), so the node carries it.
    const marks = cells(drawio(model));
    expect(marks.get(id('overlayMark', stable(model, link.id), 'from'))!.parent).toBe(id('node', 'b'));
    expect(marks.get(id('overlayMark', stable(model, link.id), 'to'))!.parent)
      .toBe(id('port', 'c', 'lo', '1'));
  }, 60000);

  it('runs an overlay link between two level top pills as a U with the two waypoints over the heads', async () => {
    // The SVG masks an overlay stroke out of every pill it crosses; mxGraph has no mask, so the
    // connector may not reach inside one. Both pills sit on a top side here and their two faces are
    // level. Architecture-2 ticket 34 (user, 2026-10-25, "purple line looks wrong, no margins"): an
    // overlay never rides along a face, so the path is a U whose run stands one overlay port
    // clearance above the pill tips. The connector is square and carries the U's two waypoints; it
    // was one segment along both outward edges with no waypoint (stress ticket 30).
    const { cell, head, tail, path } = await overlayOf(fixture('drawio-constructs'));
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect([head.side, tail.side]).toEqual(['top', 'top']);
    expect(cell.points).toHaveLength(2);
    expect(path).toHaveLength(4);
    expect(path[0]).toEqual({ x: head.x + head.width / 2, y: head.y });
    expect(path[1]!.x).toBeCloseTo(path[0]!.x, 6);
    expect(path[1]!.y).toBeCloseTo(path[0]!.y - CLEARANCE, 6);
    expect(path[2]!.x).toBeCloseTo(path[3]!.x, 6);
    expect(path[2]!.y).toBeCloseTo(path[1]!.y, 6);
    expect(path[3]).toEqual({ x: tail.x + tail.width / 2, y: tail.y });
    square(path, [head, tail]);
  }, 60000);

  it('turns once when the two overlay pills face different ways', async () => {
    // The exception branch of stress ticket 20: the straight segment between the two stub ends
    // enters Reflector C's own body, so the link is routed orthogonally — and there no single
    // cross-run clears both heads, so the shortest path that leaves each head outward and enters
    // neither box wins. `drawio-overlay-sides` is that fixture, and it stays a square connector.
    const { cell, head, tail, path } = await overlayOf(fixture('drawio-overlay-sides'));
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(new Set([head.side, tail.side]).size).toBe(2);
    // Out of each head by the clearance, then one turn between the two cleared points.
    expect(path[1]).toEqual(out(path[0]!, head.side));
    expect(path.length).toBe(5);
    square(path, [head, tail]);
  }, 60000);

  it('keeps `edgeStyle=none` for the overlay that stays straight and angled', async () => {
    // Stress ticket 20's default branch, which is the one case in the corpus that reaches the guard
    // of principle 1: `overlay-ports-that-do-not-line-up` has nothing between its two `sync` ports,
    // so the segment between the two pill faces is drawn at its own angle — outside the orthogonal
    // router's vocabulary. Since stress ticket 30 that segment is the whole link, so the connector
    // is two pinned terminals, no waypoint and nothing to reproduce.
    const { cell, head, tail, path } = await overlayOf(fixture('overlay-ports-that-do-not-line-up'));
    expect(cell.style['edgeStyle']).toBe('none');
    expect(cell.style['jettySize']).toBeUndefined();
    expect([head.side, tail.side]).toEqual(['bottom', 'top']);
    expect(cell.points).toEqual([]);
    expect(path.length).toBe(2);
    expect(path[0]).toEqual({ x: head.x + head.width / 2, y: head.y + head.height });
    expect(path[1]).toEqual({ x: tail.x + tail.width / 2, y: tail.y });
    expect(onOneAxis(path[0]!, path[1]!)).toBe(false);
  }, 60000);

  it('goes right round the pair when no single turn clears both pills', async () => {
    // Codex round 1: with both heads facing away from each other, neither single turn clears the
    // source pill, and the fall-back was the model's own straight segment — which runs through it.
    // Four more ways round the pair, one per side, answer the case; the shortest still wins.
    const { cell, head, tail, path } = await overlayOf(`
portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  a: {group: upper, ports: [{name: down, side: bottom}]}
  b: {group: lower, ports: [{name: up, side: top}, {name: west, side: left}]}
  c: {group: lower, ports: [{name: up, side: top}, {name: west, side: left}]}
links:
  - [a.down, b.up]
  - [b.west, c.west, {route: overlay}]
`);
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect([head.side, tail.side]).toEqual(['left', 'left']);
    // Each end still leaves its own head outward, and the run between clears both boxes.
    expect(path[1]).toEqual(out(path[0]!, head.side));
    expect(path[path.length - 2]).toEqual(out(path[path.length - 1]!, tail.side));
    expect(path.length).toBe(6);
    square(path, [head, tail]);
  }, 60000);

  it('states a detoured overlay label against the run the connector really draws', async () => {
    // Codex round 1: the label kept naming the model's segment, which a detoured overlay no longer
    // draws, so `on-run` parked it beside the 4 px source stem and 16 px off the line. The detour's
    // longest run is what that segment became, and the label rides it.
    const model = await pipeline(`
portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  a: {group: upper, ports: [{name: down, side: bottom}]}
  b: {group: lower, ports: [{name: up, side: top}, {name: alt, side: top}]}
  c: {group: lower, ports: [{name: up, side: top}]}
links:
  - [a.down, b.up]
  - [b.alt, c.up, {route: overlay, label: sync}]
`);
    const link = model.links.find(item => effectiveLayer(item) === 'overlay')!;
    const cell = cells(drawio(model)).get(id('link', stable(model, link.id)))!;
    expect(cell.value).toBe('sync');
    // `y` is the signed perpendicular distance from the drawn polyline, so on the run means nearly
    // zero — and what the relative pair cannot reach is left as an absolute offset, which here is
    // the rounding alone.
    expect(Math.abs(Number(cell.geometry['y'] ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.hypot(cell.offset?.x ?? 0, cell.offset?.y ?? 0)).toBeLessThanOrEqual(1);
  }, 60000);

  it('paints every pill opaque, the outlined role included', async () => {
    // Nothing may show through a pill. draw.io has no mask and no `fill:none` a reader can see the
    // node body through, so the outlined role paints the colour the SVG reveals under it.
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const body = `light-dark(${NETWORK_THEME.light.node.fill},${NETWORK_THEME.dark.node.fill})`;
    const loopback = themePortRole(themeById(undefined), 'loopback')!;
    let outlined = 0;
    for (const [key, node] of Object.entries(model.nodes)) {
      for (const port of node.ports) {
        if (!port.pill || port.ref.anonymous === true) continue;
        const cell = all.get(id('port', key, port.ref.name!, String(port.ref.ordinal)))!;
        expect(cell.style['fillColor']).not.toBe('none');
        if (!(port.class ?? '').split(/\s+/).includes('loopback')) continue;
        const washes = washAssignment(Object.values(model.document.nodes).map(node => node.class));
        const token = washToken(model.document.nodes[key]!.class);
        expect(cell.style['fillColor']).toBe(`light-dark(${themeWashFill(themeById(undefined), token, 'light', washes)},${themeWashFill(themeById(undefined), token, 'dark', washes)})`);
        expect(cell.style['strokeColor']).toBe(`light-dark(${portRolePaint(loopback, 'light').stroke!},`
          + `${portRolePaint(loopback, 'dark').stroke!})`);
        outlined += 1;
      }
    }
    expect(outlined).toBeGreaterThan(0);
    // The legend has to name what the diagram draws, so its swatch takes the same body.
    const entry = model.legend?.entries.find(item => item.kind === 'port' && item.key === 'loopback');
    if (entry) expect(all.get(id('legendSwatch', entry.id))!.style['fillColor']).toBe(body);
    // And no pill anywhere in the file is a hole.
    for (const cell of all.values()) {
      if (cell.id.startsWith('pg-port~')) expect(cell.style['fillColor']).not.toBe('none');
    }
  }, 60000);

  it('hangs an overlay endpoint mark on the pill it sits on, so the pill carries it', async () => {
    // A mark that belongs to a shape is a child of the shape. It keeps the overlay layer's paint;
    // what it gives up is the overlay layer's parent, so a pill moved by hand takes its mark along.
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const link = model.links.find(item => effectiveLayer(item) === 'overlay' && item.path)!;
    const segments = link.path!.segments;
    const ends = [
      { end: 'from', at: segments[0]!.from, ref: link.attachments!.from },
      { end: 'to', at: segments[segments.length - 1]!.to, ref: link.attachments!.to },
    ] as const;
    const outward = { top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 }, left: { x: 0, y: 0.5 }, right: { x: 1, y: 0.5 } };
    for (const { end, at, ref } of ends) {
      const port = model.nodes[ref.node]!.ports.find(item => item.ref.name === ref.name
        && item.ref.ordinal === ref.ordinal)!;
      const pill = port.pill!.bounds;
      const cell = all.get(id('overlayMark', stable(model, link.id), end))!;
      expect(cell.parent).toBe(id('port', ref.node, ref.name!, String(ref.ordinal)));
      // The mark sits on the pill's outward point, where the connector really ends — not on the
      // anchor, which is the pill's centre and the port's name. Relative to the pill's own
      // top-left, which is what makes the mark move with the pill.
      const tip = outward[port.side!];
      expect(box(cell)).toEqual({
        x: tip.x * pill.width - OVERLAY_ENDPOINT_RADIUS, y: tip.y * pill.height - OVERLAY_ENDPOINT_RADIUS,
        width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS,
      });
      // The anchor the model ends on lies inside the pill, so the mark on the pill's edge is on the
      // pill the connector was routed clear of, and the connector never meets it.
      expect(at.x).toBeGreaterThanOrEqual(pill.x);
      expect(at.x).toBeLessThanOrEqual(pill.x + pill.width);
      expect(at.y).toBeGreaterThanOrEqual(pill.y);
      expect(at.y).toBeLessThanOrEqual(pill.y + pill.height);
      expect(cell.style['fillColor']).toBe(
        `light-dark(${NETWORK_THEME.light.overlay.mark},${NETWORK_THEME.dark.overlay.mark})`);
    }
  }, 60000);
});

describe('direct lines', () => {
  it('keeps every direct line square, the unaligned overlay detour included', async () => {
    // A direct line is a link whose model path is one segment. The maintainer's rule, verbatim:
    // "straight direct line should be horizontal or vertical. angled direct lines should be
    // straight." — then "orthogonal then maybe?". The decision taken on 2026-09-15 was all
    // orthogonal; stress ticket 20 narrows it to the **routed** family. A routed direct line the
    // pipeline laid on one axis carries that axis and nothing else, and a dragged end makes a
    // Z-bend, never a diagonal. The overlay between two pill heads that share neither axis is
    // straight by default here too — but its straight segment runs through two node bodies, so this
    // one takes the orthogonal detour round both pill boxes and the whole file stays square.
    //
    // Every number below is read out of the exported file and only then compared with the model,
    // because a test that states the model against itself agrees with any export at all.
    const model = await pipeline(fixture('drawio-direct-lines'));
    const all = cells(drawio(model));
    const origin = model.canvas!;
    /** The clearance `overlayPath` keeps off a pill head: the overlay port clearance (ticket 23). */
    const CLEARANCE = OVERLAY_PILL_CLEARANCE;
    /** The outward fraction of each side, which is what the exporter pins an endpoint with. */
    const OUTWARD: Readonly<Record<string, Point>> = {
      top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 },
      left: { x: 0, y: 0.5 }, right: { x: 1, y: 0.5 },
    };
    interface Pill { cell: string; side: string; x: number; y: number; width: number; height: number }
    /**
     * A cell's box in page space, walked out of the file itself. A child's geometry is stated from
     * its parent's top-left and `startSize` does not shift that origin, so the origins simply add.
     */
    const absolute = (key: string): { x: number; y: number; width: number; height: number } => {
      const own = box(all.get(key)!);
      let at = all.get(key)!.parent, x = own.x, y = own.y;
      while (at !== undefined && at !== '0') {
        const parent = all.get(at)!;
        x += box(parent).x; y += box(parent).y;
        at = parent.parent;
      }
      return { x, y, width: own.width, height: own.height };
    };
    /**
     * The pill a `node.port` draws, in page space, read off the exported cell hierarchy — and then
     * checked against the box placement reserved, so the two cannot drift apart unnoticed.
     */
    const pillOf = (ref: string): Pill => {
      const [node, name] = ref.split('.') as [string, string];
      const port = model.nodes[node]!.ports.find(item => item.ref.name === name)!;
      const key = id('port', node, name, String(port.ref.ordinal));
      const reserved = port.pill!.bounds, drawn = absolute(key);
      expect(drawn).toEqual({ x: reserved.x - origin.x, y: reserved.y - origin.y,
        width: reserved.width, height: reserved.height });
      return { cell: key, side: port.side!, ...drawn };
    };
    const linkOf = (from: string, to: string): LayoutModel['links'][number] => {
      const [fromNode, fromPort] = from.split('.'), [toNode, toPort] = to.split('.');
      return model.links.find(item => item.attachments !== undefined
        && item.attachments.from.node === fromNode && item.attachments.from.name === fromPort
        && item.attachments.to.node === toNode && item.attachments.to.name === toPort)!;
    };
    /**
     * Where draw.io really puts one end of a connector: the **exported** constraint read against the
     * pill's own box. mxGraph resolves an end from four keys, not two — the fraction pair places a
     * point on the box and the `Dx`/`Dy` pair then moves it in absolute pixels — so all four are
     * read, and a non-zero offset would carry the end off the pill head the fraction names.
     */
    const endOf = (cell: Cell, which: 'exit' | 'entry', pill: Pill): Point => {
      expect(cell.style[`${which}Perimeter`]).toBe('0');
      const fraction = { x: Number(cell.style[`${which}X`]), y: Number(cell.style[`${which}Y`]) };
      expect(fraction).toEqual(OUTWARD[pill.side]);
      const offset = { x: Number(cell.style[`${which}Dx`] ?? 0), y: Number(cell.style[`${which}Dy`] ?? 0) };
      expect(offset).toEqual({ x: 0, y: 0 });
      return { x: pill.x + fraction.x * pill.width + offset.x,
        y: pill.y + fraction.y * pill.height + offset.y };
    };

    // Two vertical direct lines and one horizontal one, the last carrying its own label. Each is a
    // square connector with **no** waypoint: the two pinned ends are the whole connector, so there
    // is nothing in the file that could bend it or send it past its target and back.
    const routed = [
      { from: 'a.d1', to: 'b.u1', along: 'x', across: 'y', value: undefined },
      { from: 'a.d2', to: 'c.u2', along: 'x', across: 'y', value: undefined },
      { from: 'b.east', to: 'c.west', along: 'y', across: 'x', value: 'peer' },
    ] as const;
    for (const stated of routed) {
      const link = linkOf(stated.from, stated.to);
      expect(effectiveLayer(link)).toBe('routed');
      expect(link.path!.segments.length).toBe(1);
      const head = pillOf(stated.from), tail = pillOf(stated.to);
      const cell = all.get(id('link', stable(model, link.id)))!;
      expect(cell.source).toBe(head.cell);
      expect(cell.target).toBe(tail.cell);
      expect(cell.value).toBe(stated.value);
      expect(cell.style['edgeStyle']).toBe('none');
      expect(cell.style['jettySize']).toBeUndefined();
      expect(cell.points).toEqual([]);
      const ends = [endOf(cell, 'exit', head), endOf(cell, 'entry', tail)] as const;
      expect(ends[0][stated.along]).toBeCloseTo(ends[1][stated.along], 6);
      expect(Math.abs(ends[0][stated.across] - ends[1][stated.across])).toBeGreaterThan(1);
    }

    // The overlay joins a top pill to a bottom pill that share neither x nor y. It stays square all
    // the same, and the route is the exact one the two reserved boxes give: out of each head by the
    // clearance, then down the middle of the gap the two boxes leave on x.
    const overlay = linkOf('b.lo', 'c.lo');
    expect(effectiveLayer(overlay)).toBe('overlay');
    // The model holds that route, not the exporter: the waypoints are its own interior points, and
    // the two stubs it leaves are the ones the pinned terminals stand for (synthetics review 01).
    expect(overlay.path!.segments.length).toBe(5);
    expect(all.get(id('link', stable(model, overlay.id)))!.points).toEqual(overlay.path!.segments.slice(1)
      .map(segment => ({ x: segment.from.x - model.canvas!.x, y: segment.from.y - model.canvas!.y })));
    const head = pillOf('b.lo'), tail = pillOf('c.lo');
    const cell = all.get(id('link', stable(model, overlay.id)))!;
    expect([head.side, tail.side]).toEqual(['top', 'bottom']);
    expect(cell.source).toBe(head.cell);
    expect(cell.target).toBe(tail.cell);
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(cell.style['jettySize']).toBe('0');
    const ends = [endOf(cell, 'exit', head), endOf(cell, 'entry', tail)] as const;
    expect(Math.abs(ends[0].x - ends[1].x)).toBeGreaterThan(1);
    expect(Math.abs(ends[0].y - ends[1].y)).toBeGreaterThan(1);
    const middle = (Math.max(head.x, tail.x)
      + Math.min(head.x + head.width, tail.x + tail.width)) / 2;
    const above = ends[0].y - CLEARANCE, below = ends[1].y + CLEARANCE;
    expect(cell.points).toEqual([
      { x: ends[0].x, y: above }, { x: middle, y: above },
      { x: middle, y: below }, { x: ends[1].x, y: below },
    ]);
    // And that route is square end to end, and reaches inside neither pill box.
    const path = [ends[0], ...cell.points, ends[1]];
    for (const [index, point] of path.slice(1).entries()) {
      const before = path[index]!;
      expect(Math.abs(point.x - before.x) < 1e-6 || Math.abs(point.y - before.y) < 1e-6).toBe(true);
      for (const pill of [head, tail]) {
        expect(Math.max(before.x, point.x) > pill.x && Math.min(before.x, point.x) < pill.x + pill.width
          && Math.max(before.y, point.y) > pill.y && Math.min(before.y, point.y) < pill.y + pill.height).toBe(false);
      }
    }
  }, 60000);
});

describe('signal links', () => {
  it('export dashed with the signal stroke and the overlay opacity, where sync and flow keep the overlay stroke (ticket 73)', async () => {
    const model = await pipeline(fixture('a-dashed-signal-feed-is-one-straight-segment'));
    const all = cells(drawio(model));
    const signal = themeLinkClass(themeById(undefined), 'signal');
    const edges = model.links.filter(link => model.document.links[link.sourceIndex]!.class === 'signal');
    expect(edges).toHaveLength(4);
    for (const link of edges) {
      const style = all.get(id('link', stable(model, link.id)))!.style;
      expect([style['dashed'], style['dashPattern']]).toEqual(['1', signal.dash]);
      expect(style['dashPattern']).toBe('4 4');
      expect(style['strokeColor']).toContain(signal.strokes.light);
      expect(style['strokeColor']).not.toBe(`light-dark(${NETWORK_THEME.light.overlay.stroke},${NETWORK_THEME.dark.overlay.stroke})`);
      expect(style['opacity']).toBeDefined();
    }
  }, 60000);
});

describe('link ends and nested groups move with their owner (issue 03)', () => {
  const absolute = (all: Map<string, Cell>, cellId: string): { x: number; y: number } => {
    const cell = all.get(cellId)!, at = box(cell);
    if (cell.parent === undefined || !all.get(cell.parent)?.vertex) return { x: at.x, y: at.y };
    const parent = absolute(all, cell.parent);
    return { x: at.x + parent.x, y: at.y + parent.y };
  };
  const ancestors = (all: Map<string, Cell>, cellId: string): string[] => {
    const found: string[] = [];
    for (let at = all.get(cellId)?.parent; at !== undefined && all.get(at)?.vertex; at = all.get(at)!.parent) found.push(at);
    return found;
  };

  it('hangs each frame cell on its parent frame cell, in the parent\'s terms', async () => {
    const model = await pipeline(fixture('drawio-nested-groups'));
    const all = cells(drawio(model)), canvas = model.canvas!;
    const nested = model.frames!.filter(frame => frame.parent !== undefined);
    expect(nested.length).toBeGreaterThanOrEqual(2);
    for (const frame of model.frames!) {
      const cell = all.get(id('group', frame.id))!;
      expect(cell.parent).toBe(frame.parent === undefined ? id('layer', 'diagram') : id('group', frame.parent));
      // Whatever the parent, the cell stands where the model put it.
      const at = absolute(all, cell.id);
      expect(at.x).toBeCloseTo(frame.box.x - canvas.x, 6);
      expect(at.y).toBeCloseTo(frame.box.y - canvas.y, 6);
    }
    // Every ancestor chain is the model's: moving a parent moves everything below it.
    for (const frame of nested) expect(ancestors(all, id('group', frame.id))).toContain(id('group', frame.parent!));
  }, 60000);

  it('hangs a mark on a port that draws no pill on its node, and ends the connector on that node', async () => {
    // The mark is what an overlay end draws when the dot is off; with the dot on, the connector's own oval replaces it.
    const model = await pipeline(fixture('drawio-nested-groups').replace('portograph: 2\n', 'portograph: 2\nrender: {anonymousPortMarker: none}\n'));
    const all = cells(drawio(model)), canvas = model.canvas!;
    const overlays = model.links.filter(item => effectiveLayer(item) === 'overlay');
    expect(overlays).toHaveLength(2);
    for (const link of overlays) {
      const edge = all.get(id('link', stable(model, link.id)))!;
      const ends = [['from', edge.source, link.path!.segments[0]!.from], ['to', edge.target, link.path!.segments.at(-1)!.to]] as const;
      for (const [end, terminal, point] of ends) {
        const mark = all.get(id('overlayMark', stable(model, link.id), end))!;
        expect(terminal).toMatch(/^pg-node~/);
        expect(mark.parent).toBe(terminal);
        // Relative to the node, and on the point the model gave: the shape carries it.
        const at = absolute(all, mark.id);
        expect(at.x + OVERLAY_ENDPOINT_RADIUS).toBeCloseTo(point.x - canvas.x, 6);
        expect(at.y + OVERLAY_ENDPOINT_RADIUS).toBeCloseTo(point.y - canvas.y, 6);
      }
    }
    // No mark of any kind is left loose on a layer where the model holds its node.
    for (const cell of all.values()) {
      if (cell.id.startsWith('pg-overlayMark~') || cell.id.startsWith('pg-busMark~')) expect(all.get(cell.parent!)!.vertex).toBe(true);
    }
  }, 60000);
});

describe('link ends follow a moved node (issue 04)', () => {
  /** The node a cell hangs on, itself or an ancestor: the cell a hand drag of that node carries along. */
  const owner = (all: Map<string, Cell>, cellId: string): string | undefined => {
    for (let at = all.get(cellId); at !== undefined; at = at.parent === undefined ? undefined : all.get(at.parent)) {
      if (at.id.startsWith('pg-node~')) return at.id;
    }
    return undefined;
  };

  it.each(['a-full-mesh-on-one-row-draws-as-one-bus', 'drawio-nested-groups', 'drawio-constructs'])(
    'binds every end of every edge to a cell a node carries, and leaves no free end (%s)', async name => {
      const all = cells(drawio(await pipeline(fixture(name))));
      const edges = [...all.values()].filter(cell => cell.edge && cell.id.startsWith('pg-') && !cell.id.startsWith('pg-linkLabel'));
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        // A free `sourcePoint` or `targetPoint` stays where it was when the node moves: draw.io shows it as a loose handle.
        expect(edge.free, edge.id).toEqual([]);
        for (const end of [edge.source, edge.target]) {
          expect(end, edge.id).toBeDefined();
          expect(owner(all, end!), `${edge.id} ends on ${end}`).toBeDefined();
        }
      }
    }, 60000);

  it('carries the bus joints with the member node, locked, and cuts the bar at every joint', async () => {
    const model = await pipeline(fixture('a-full-mesh-on-one-row-draws-as-one-bus'));
    const all = cells(drawio(model)), canvas = model.canvas!, bus = model.meshBuses![0]!;
    const absolute = (cell: Cell): { x: number; y: number } => {
      const at = box(cell), parent = cell.parent === undefined ? undefined : all.get(cell.parent);
      if (!parent?.vertex) return at;
      const base = absolute(parent);
      return { x: at.x + base.x, y: at.y + base.y };
    };
    const joints = [...all.values()].filter(cell => cell.id.startsWith('pg-busJoint~'));
    expect(joints.length).toBeGreaterThanOrEqual(bus.stubs!.length);
    for (const joint of joints) {
      expect(box(joint)).toMatchObject({ width: 2, height: 2 });
      expect(owner(all, joint.id)).toBeDefined();
      for (const key of ['movable', 'resizable', 'rotatable', 'editable', 'connectable', 'deletable']) expect(joint.style[key], key).toBe('0');
    }
    for (const stub of bus.stubs!) {
      const end = all.get(all.get(id('busStub', bus.id, stub.node))!.target!)!;
      expect(owner(all, end.id)).toBe(id('node', stub.node));
      expect(absolute(end).x + 1).toBeCloseTo(stub.to.x - canvas.x, 6);
      expect(absolute(end).y + 1).toBeCloseTo(stub.to.y - canvas.y, 6);
    }
    // One piece of bar per pair of neighbouring joints, each bound to both; they chain from the first joint to the last.
    const pieces = [...all.values()].filter(cell => cell.id.startsWith(`pg-bus~${bus.id}~`));
    expect(pieces).toHaveLength(joints.length - 1);
    for (const [index, piece] of pieces.entries()) {
      expect(piece.source).toBeDefined();
      if (index > 0) expect(piece.source).toBe(pieces[index - 1]!.target);
    }
  }, 60000);

  it('keeps a joint id apart from a node named like a bar end', async () => {
    const yaml = fixture('a-full-mesh-on-one-row-draws-as-one-bus')
      .replace(/\bn1\b/g, 'bar-from').replace(/\bn5\b/g, 'riser-to').replace(/\bn2\b/g, 'bar-to');
    const all = cells(drawio(await pipeline(yaml)));
    expect([...all.keys()].some(key => key.startsWith('pg-busJoint~'))).toBe(true);
    expect(all.has(id('node', 'bar-from'))).toBe(true);
  }, 60000);
});

describe('a sheet class wash reads the same in the SVG and in draw.io (ticket 09)', () => {
  const sheet = [
    'portograph: 2', 'groups:', '  top: { tier: 0, label: Top }', '  low: { tier: 1, label: Low }', 'nodes:',
    '  a: { group: top, class: switch router, icon: server, label: A }', '  b: { group: top, class: switch, label: B }',
    '  c: { group: low, class: router tbr, icon: server, label: C }', '  d: { group: low, class: tbr router, label: D }',
    '  e: { group: low, class: lb switch, icon: server, label: E }', 'links:', '  - [a, c]', '  - [b, d]', '  - [a, e]', '',
  ].join('\n');

  it('gives a multi-token node the one hue in both exports, and the key shows the wash', async () => {
    const model = await pipeline(sheet);
    const svg = render(model);
    const light = svg.slice(svg.indexOf('<style'));
    const rulesInOrder = [...light.matchAll(/^\.node-body:where\(\.([\w-]+)\)\{fill:(#[0-9a-f]{6})\}/gm)].map(match => [match[1]!, match[2]!] as const);
    const all = cells(drawio(model, { theme: 'light' }));
    const fills: Record<string, string> = {};
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      const classAttr = model.document.nodes[key]!.class!;
      const body = new RegExp(`<rect class="node-body ${classAttr}( pg-[^"]*)?"`).exec(svg);
      expect(body, key).not.toBeNull();
      const tokens = new Set(`node-body ${classAttr}${body![1] ?? ''}`.split(' '));
      // The cascade: the last rule whose token the body carries (`:where()` keeps all at one specificity).
      const fill = [...rulesInOrder].reverse().find(([token]) => tokens.has(token))?.[1];
      expect(fill, key).toBeDefined();
      expect(all.get(id('node', key))!.style['fillColor'], key).toBe(fill);
      fills[key] = fill!;
    }
    expect(fills['a']).not.toBe(fills['b']);
    expect(fills['b']).not.toBe(fills['e']);
    expect(fills['c']).toBe(fills['d']);
    // The key paints the wash behind a class's tile, in both.
    expect(svg).toMatch(/<rect class="node-body switch pg-wash-\d+/);
    expect([...all.values()].filter(cell => cell.id.startsWith('pg-legendBody~')).length).toBeGreaterThan(0);
  }, 60000);
});
