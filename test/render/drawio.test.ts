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
import { route } from '../../src/route/index.js';
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
      // The claim: the connector carries the reserved polyline verbatim. `edgeStyle=none` is the
      // only setting that reproduces given waypoints — every registered style treats them as hints
      // and re-routes — so this assertion and the one below it stand or fall together.
      expect(cell.style['edgeStyle']).toBe('none');
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
    const xml = drawio(odd, { theme: 'light' });
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
