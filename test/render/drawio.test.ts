import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/index.js';
import { drawio } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { rows } from '../../src/layout/rows.js';
import { NETWORK_THEME, portRolePaint, portRoleStyle } from '../../src/profiles/network/theme.js';
import { route } from '../../src/route/index.js';
import { effectiveLayer } from '../../src/score/model.js';
import { OVERLAY_ENDPOINT_RADIUS } from '../../src/theme/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** The exporter's id scheme, mirrored so a test names a cell the way the file does. */
const id = (kind: string, ...parts: readonly string[]): string =>
  parts.length ? `pg-${kind}~${parts.map(value => value.replace(/[%~]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join('~')}` : `pg-${kind}`;

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
  offset?: Point;
}

/** Every `<mxCell>`, with its style string split the way draw.io splits it. */
function cells(xml: string): Map<string, Cell> {
  const found = new Map<string, Cell>();
  for (const match of xml.matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
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

    let pinned = 0;
    for (const link of model.links) {
      if (link.technique === 'stub' || !link.path) continue;
      const cell = all.get(id('link', link.id));
      if (!cell) continue;
      // The claim: the connector carries the reserved polyline verbatim, under the orthogonal
      // router that keeps it square when a shape is moved. An overlay link is the one exception —
      // it is routed around its pills — and `maintainer edit principles` below covers it.
      if (effectiveLayer(link) === 'overlay') continue;
      expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
      expect(cell.style['jettySize']).toBe('0');
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
    expect(layerOf(all, id('link', overlay.id))).toBe(id('layer', 'overlay'));
    const routed = model.links.find(link => link.path && link.technique !== 'stub' && link.id !== overlay.id)!;
    expect(layerOf(all, id('link', routed.id))).toBe(id('layer', 'links'));
    for (const key of Object.keys(model.nodes)) expect(layerOf(all, id('node', key))).toBe(id('layer', 'diagram'));
  }, 60000);

  it('double-escapes a label, because draw.io assigns the decoded value to innerHTML', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const node = Object.keys(model.nodes)[0]!;
    const label = model.labels.find(item => item.owner.kind === 'node' && item.owner.id === node
      && item.role === 'node')!;
    const angled = { ...model, labels: model.labels.map(item => item === label
      ? { ...item, text: 'a <b> & c', lines: ['a <b> & c'] } : item) };
    const xml = drawio(angled);
    // Escaped once, draw.io's innerHTML assignment would swallow everything from `<` to `>`.
    expect(xml).toContain('a &amp;lt;b&amp;gt; &amp;amp; c');
    expect(xml).not.toContain('value="a &lt;b&gt; &amp; c"');
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
    const ids = [...xml.matchAll(/<mxCell id="([^"]+)"/g)].map(match => match[1]!);
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
    const cell = cells(drawio(model)).get(id('linkLabel', label.id))!;
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
    // is really behind it; `measured` keeps the box stage 9 placed and needs no fill at all.
    // The label is the connector's own, so it is the edge cell that carries it.
    const owner = (label.owner as { id: string }).id;
    const on = cells(drawio(model, { labels: 'on-run' })).get(id('link', owner))!;
    const measured = cells(drawio(model, { labels: 'measured' })).get(id('link', owner))!;
    expect(on.value).toBe(label.text);
    expect(measured.style['labelBackgroundColor']).toBe('none');
    expect(on.style['labelBackgroundColor']).toMatch(/^(#[0-9a-f]{6}|light-dark\(#[0-9a-f]{6},#[0-9a-f]{6}\))$/);
    // The claim: a label is stated in the edge's own relative terms — `x` arc length along it, `y`
    // signed perpendicular — so it follows its connector when a shape moves. `offset` would be
    // absolute screen pixels, which is why it is not used: the label would stay put and drift off
    // the line. On the run means a perpendicular of zero; measured keeps the distance stage 9 gave.
    expect(Number(on.geometry['y'])).toBeCloseTo(0, 9);
    expect(Math.abs(Number(measured.geometry['y']))).toBeGreaterThan(1);
    expect(Number(on.geometry['x'])).toBeGreaterThanOrEqual(-1);
    expect(Number(on.geometry['x'])).toBeLessThanOrEqual(1);
    expect(on.offset).toBeUndefined();
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

  it('draws draw.io\u2019s own Cisco shapes when asked, in their native proportions', async () => {
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

  it('gives every text to the shape that owns it, rather than parking a box on top', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const xml = drawio(model);
    const all = cells(xml);
    // The claim: a node's name, a port's name and a link's label are the *values* of the node, the
    // pill and the connector. draw.io gives a shape its text, so one cell moves, copies and is
    // renamed as one thing; a separate text box only looks the same until someone drags it.
    expect([...all.keys()].filter(key => key.startsWith('pg-nodeLabel~')
      || key.startsWith('pg-portLabel~') || key.startsWith('pg-nodeDescription~'))).toEqual([]);
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
      expect(all.get(id('link', owner))!.style['horizontal']).toBe('0');
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
  // Arial's own metrics, stated here rather than read from the font table, so the expected
  // positions are independent of the code that produces them.
  const UNITS_PER_EM = 2048, ASCENT = 1854, DESCENT = 434;
  /** The height the glyphs of one line occupy: what a CSS line box centres in its own leading. */
  const content = (fontSize: number): number => (ASCENT + DESCENT) * fontSize / UNITS_PER_EM;
  /** The first baseline, one ascent below the box stage 9 measured. */
  const ascentOf = (fontSize: number): number => ASCENT * fontSize / UNITS_PER_EM;

  /**
   * draw.io starts a top-aligned label at `bounds.y + baseSpacingTop + spacing + spacingTop`.
   * `baseSpacingTop` is 5 and the default `spacing` is 2 in drawio-desktop 31.4.5 — mxGraph's own
   * `baseSpacingTop` is 0, and reading the formula from the library alone puts the label 5 px low.
   */
  const DRAWIO_TOP = 7;

  /** Every `<div>` of a cell value, with its inline style split into declarations. */
  const blocksOf = (value: string): Record<string, string>[] =>
    [...value.matchAll(/&lt;div style=&quot;([^&]*)&quot;&gt;/g)].map(match => {
      const style: Record<string, string> = {};
      for (const part of match[1]!.split(';')) {
        const at = part.indexOf(':');
        if (at !== -1) style[part.slice(0, at)] = part.slice(at + 1);
      }
      return style;
    });

  const nodeLabel = (model: LayoutModel, node: string, role: 'node' | 'description') =>
    model.labels.find(item => item.owner.kind === 'node' && item.owner.id === node
      && item.role === role && !item.omitted);

  it('puts the first baseline where the pipeline measured it, not a line box lower', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    for (const [key, node] of Object.entries(model.nodes)) {
      const first = nodeLabel(model, key, 'node') ?? nodeLabel(model, key, 'description');
      if (!first) continue;
      const cell = all.get(id('node', key))!;
      const blocks = blocksOf(cell.value!);
      expect(blocks.length).toBeGreaterThan(0);
      const size = first.fontSize!;
      const pitch = first.bounds!.height / (first.lines ?? [first.text]).length;
      // A CSS line box centres its glyphs in the leading; the pipeline puts the baseline one full
      // ascent below its box and leaves the rest of the leading underneath. So the block starts
      // half a leading higher, and the two baselines then coincide.
      const lift = (pitch - content(size)) / 2;
      const top = Number(cell.style['spacingTop']) + node.bounds!.y + DRAWIO_TOP;
      expect(top + lift + ascentOf(size)).toBeCloseTo(first.bounds!.y + ascentOf(size), 9);
      // The line pitch is stated, so a wrapped label keeps the pitch stage 9 measured as well.
      expect(Number(blocks[0]!['line-height']!.replace('px', ''))).toBeCloseTo(pitch, 9);
    }
  }, 60000);

  it('takes the offset and the base font from the first block that draws, name or not', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    // A node with a description and no name: everything used to come from the name, so the node
    // carried no offset at all and its description was drawn against the icon.
    const description = nodeLabel(model, 'described', 'description')!;
    expect(nodeLabel(model, 'described', 'node')).toBeUndefined();
    const cell = all.get(id('node', 'described'))!;
    expect(cell.style['fontSize']).toBe(String(description.fontSize));
    expect(cell.style['fontStyle']).toBeUndefined();
    const lift = (description.bounds!.height - content(description.fontSize!)) / 2;
    expect(Number(cell.style['spacingTop'])).toBeCloseTo(
      description.bounds!.y - model.nodes['described']!.bounds!.y - DRAWIO_TOP - lift, 9);
    // A node with a name keeps the name's size and its bold.
    const named = all.get(id('node', 'named'))!;
    expect(named.style['fontSize']).toBe(String(nodeLabel(model, 'named', 'node')!.fontSize));
    expect(named.style['fontStyle']).toBe('1');
  }, 60000);

  it('keeps each block at its own weight and at the measured gap below the block above', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    const all = cells(drawio(model, { theme: 'light' }));
    const name = nodeLabel(model, 'both', 'node')!;
    const description = nodeLabel(model, 'both', 'description')!;
    const blocks = blocksOf(all.get(id('node', 'both'))!.value!);
    expect(blocks).toHaveLength(2);
    // A `<span>` inside the name's own line inherits the cell's bold, which made a 400-weight
    // description render bold. Each block is its own `<div>` and states its own weight.
    expect(blocks[0]!['font-weight']).toBe(String(name.fontWeight));
    expect(blocks[1]!['font-weight']).toBe(String(description.fontWeight));
    expect(blocks[0]!['font-weight']).not.toBe(blocks[1]!['font-weight']);
    expect(blocks[1]!['font-size']).toBe(`${description.fontSize}px`);
    // The gap between the two blocks is the measured one: the description's own lift, minus the
    // name's, minus the name's full height.
    const nameLift = (name.bounds!.height - content(name.fontSize!)) / 2;
    const descriptionLift = (description.bounds!.height - content(description.fontSize!)) / 2;
    const margin = (description.bounds!.y - descriptionLift)
      - (name.bounds!.y - nameLift + name.bounds!.height);
    expect(Number(blocks[1]!['margin-top']!.replace('px', ''))).toBeCloseTo(margin, 9);
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

  it('exports label metrics that are out of contract, and states no length a browser rejects', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    // `validate()` checks the boxes, not the type metrics, so a hand-made model can carry a zero
    // font size, a negative pitch or one that overflows when it is multiplied by the line count.
    // The exporter states a length the browser and its own arithmetic agree on, and exports.
    const odd = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const name = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'node')!;
    name.lines = ['Beta', ''];
    name.lineHeight = -1;
    name.fontSize = 0;
    const description = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'description')!;
    description.lineHeight = 1e308;
    // An offset the model states can overflow when it is combined, not only when it is stated.
    const far = odd.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'named' && item.role === 'node')!;
    far.bounds!.y = -1e308;
    far.lineHeight = 1.7e308;
    const xml = drawio(odd, { theme: 'light' });
    expect(Number.isFinite(Number(cells(xml).get(id('node', 'named'))!.style['spacingTop']))).toBe(true);
    expect(xml).not.toMatch(/Infinity|NaN/);
    const blocks = blocksOf(cells(xml).get(id('node', 'both'))!.value!);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const length = (key: string): number => Number(block[key]!.replace('px', ''));
      expect(length('line-height')).toBeGreaterThanOrEqual(0);
      expect(length('height')).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(length('height'))).toBe(true);
    }
    expect(Number.isFinite(Number(blocks[1]!['margin-top']!.replace('px', '')))).toBe(true);
  }, 60000);

  it('places the block below from the measured height, not from the line boxes the text opens', async () => {
    const model = await pipeline(fixture('drawio-node-text'));
    /** Where the second block starts, as draw.io adds the cell's own offsets up. */
    const secondTop = (from: LayoutModel): number => {
      const cell = cells(drawio(from, { theme: 'light' })).get(id('node', 'both'))!;
      const blocks = blocksOf(cell.value!);
      const length = (index: number, key: string): number => Number(blocks[index]![key]!.replace('px', ''));
      return from.nodes['both']!.bounds!.y + DRAWIO_TOP + Number(cell.style['spacingTop'])
        + length(0, 'height') + length(1, 'margin-top');
    };
    // A browser counts line boxes its own way: a trailing `<br>` opens none. Each block states the
    // height stage 9 measured, so the description stays where it was measured even then.
    const trailing = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const name = trailing.labels.find(item => item.owner.kind === 'node'
      && item.owner.id === 'both' && item.role === 'node')!;
    name.lines = [name.text, ''];
    name.lineHeight = name.bounds!.height / 2;
    const blocks = blocksOf(cells(drawio(trailing, { theme: 'light' })).get(id('node', 'both'))!.value!);
    // The stated height is one pitch per measured line, which is the box stage 9 reserved.
    expect(Number(blocks[0]!['height']!.replace('px', ''))).toBeCloseTo(name.bounds!.height, 9);
    expect(secondTop(trailing)).toBeCloseTo(secondTop(model), 9);
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
      const body = new RegExp(`<mxCell id="${cell.id.replace(/[%]/g, '\\$&')}"[\\s\\S]*?</mxCell>`).exec(xml)![0];
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
    id: string; runs: Point[][]; labels: { at: Point; support?: number }[];
  }[]): LayoutModel => ({
    ...base,
    document: { ...base.document, nodes: {}, groups: {}, links: cases.map(() => ({})) as never },
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
      id: `${item.id}-${index}`, owner: { kind: 'link', id: item.id } as const,
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
    const edge = all.get(id('link', owner))!;

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
        labels: [{ at: point(150, 480), support: 0 }, { at: point(500, 480), support: 1 }] },
    ]);
    const xml = drawio(model, { labels: 'measured' });
    const all = cells(xml);
    // The connector's own label, carried by the run that draws segment 1.
    const later = all.get(id('link', 'own', '1'))!;
    expect(later.value).toBe('own-0');
    expect(all.get(id('link', 'own', '0'))!.value).toBeUndefined();
    expect(landing(xml, all, later, later)).toEqual({ x: 500, y: 480 });
    // A child label follows the same rule: two eligible labels on one link are both children, and
    // each belongs to the connector that draws the segment it was measured against.
    for (const [index, want] of [point(150, 480), point(500, 480)].entries()) {
      const child = all.get(id('linkLabel', `children-${index}`))!;
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
    return { all: cells(drawio(model)), label: label.id, link: (label.owner as { id: string }).id };
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
  /** Twice the endpoint mark's radius, which is the stand-off `overlayPath` keeps off a pill head. */
  const CLEARANCE = 2 * OVERLAY_ENDPOINT_RADIUS;

  /** One pill of an overlay end, in page space: the side it sits on and the box placement reserved. */
  interface Pill { side: string; x: number; y: number; width: number; height: number }

  /** An overlay link of a fixture with its connector cell, its two pills and the drawn polyline. */
  async function overlayOf(name: string): Promise<{ cell: Cell; head: Pill; tail: Pill; path: Point[] }> {
    const model = await pipeline(fixture(name));
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
    const cell = all.get(id('link', link.id))!;
    const head = pillOf(link.attachments!.from), tail = pillOf(link.attachments!.to);
    return { cell, head, tail, path: [outward(head), ...cell.points, outward(tail)] };
  }

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
    let square = 0;
    for (const link of model.links) {
      if (link.technique === 'stub' || !link.path || effectiveLayer(link) === 'overlay') continue;
      const cell = all.get(id('link', link.id))!;
      expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
      expect(cell.style['jettySize']).toBe('0');
      expect(cell.points).toEqual(link.path.segments.slice(0, -1)
        .map(segment => ({ x: segment.to.x - canvas.x, y: segment.to.y - canvas.y })));
      square += 1;
    }
    expect(square).toBeGreaterThan(0);
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
    const cell = cells(drawio(bent)).get(id('link', straight.id))!;
    expect(cell.style['edgeStyle']).toBe('none');
    expect(cell.style['jettySize']).toBeUndefined();
    // The waypoints are still the stated ones: the guard changes the style, never the geometry.
    expect(cell.points[0]).toEqual({ x: off.x - model.canvas!.x, y: off.y - model.canvas!.y });
  }, 60000);

  it('routes an overlay link around the pill heads instead of along them', async () => {
    // The SVG masks an overlay stroke out of every pill it crosses; mxGraph has no mask. So the
    // connector leaves each pill head outward by the clearance and crosses above them. Every number
    // comes off the two pill boxes placement reserved — nothing is discovered here.
    const { cell, head, tail, path } = await overlayOf('drawio-constructs');
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(cell.style['jettySize']).toBe('0');
    // Both pills sit on a top side here, so this is the three-segment detour the maintainer drew.
    expect([head.side, tail.side]).toEqual(['top', 'top']);
    const across = Math.min(head.y, tail.y) - CLEARANCE;
    expect(cell.points).toEqual([
      { x: head.x + head.width / 2, y: across },
      { x: tail.x + tail.width / 2, y: across },
    ]);
    square(path, [head, tail]);
  }, 60000);

  it('turns once when the two overlay pills face different ways', async () => {
    // The other branch: no single cross-run clears both heads, so the shortest orthogonal path that
    // leaves each head outward and enters neither box wins. `drawio-overlay-sides` is that fixture.
    const { cell, head, tail, path } = await overlayOf('drawio-overlay-sides');
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
    expect(new Set([head.side, tail.side]).size).toBe(2);
    // Out of each head by the clearance, then one turn between the two cleared points.
    expect(path[1]).toEqual({ x: path[0]!.x + (head.side === 'left' ? -CLEARANCE : head.side === 'right' ? CLEARANCE : 0),
      y: path[0]!.y + (head.side === 'top' ? -CLEARANCE : head.side === 'bottom' ? CLEARANCE : 0) });
    expect(path.length).toBe(5);
    square(path, [head, tail]);
  }, 60000);

  it('paints every pill opaque, the outlined role included', async () => {
    // Nothing may show through a pill. draw.io has no mask and no `fill:none` a reader can see the
    // node body through, so the outlined role paints the colour the SVG reveals under it.
    const model = await pipeline(fixture('drawio-constructs'));
    const all = cells(drawio(model));
    const body = `light-dark(${NETWORK_THEME.light.node.fill},${NETWORK_THEME.dark.node.fill})`;
    const loopback = portRoleStyle('loopback')!;
    let outlined = 0;
    for (const [key, node] of Object.entries(model.nodes)) {
      for (const port of node.ports) {
        if (!port.pill || port.ref.anonymous === true) continue;
        const cell = all.get(id('port', key, port.ref.name!, String(port.ref.ordinal)))!;
        expect(cell.style['fillColor']).not.toBe('none');
        if (!(port.class ?? '').split(/\s+/).includes('loopback')) continue;
        expect(cell.style['fillColor']).toBe(body);
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
    for (const { end, at, ref } of ends) {
      const port = model.nodes[ref.node]!.ports.find(item => item.ref.name === ref.name
        && item.ref.ordinal === ref.ordinal)!;
      const pill = port.pill!.bounds;
      const cell = all.get(id('overlayMark', link.id, end))!;
      expect(cell.parent).toBe(id('port', ref.node, ref.name!, String(ref.ordinal)));
      // Relative to the pill's own top-left, which is what makes the mark move with the pill.
      expect(box(cell)).toEqual({
        x: at.x - pill.x - OVERLAY_ENDPOINT_RADIUS, y: at.y - pill.y - OVERLAY_ENDPOINT_RADIUS,
        width: 2 * OVERLAY_ENDPOINT_RADIUS, height: 2 * OVERLAY_ENDPOINT_RADIUS,
      });
      // The mark lies inside its own pill, so the connector routed clear of that pill never meets it.
      expect(at.x).toBeGreaterThanOrEqual(pill.x);
      expect(at.x).toBeLessThanOrEqual(pill.x + pill.width);
      expect(at.y).toBeGreaterThanOrEqual(pill.y);
      expect(at.y).toBeLessThanOrEqual(pill.y + pill.height);
      expect(cell.style['fillColor']).toBe(
        `light-dark(${NETWORK_THEME.light.overlay.mark},${NETWORK_THEME.dark.overlay.mark})`);
    }
  }, 60000);
});
