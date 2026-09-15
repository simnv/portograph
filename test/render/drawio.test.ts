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
