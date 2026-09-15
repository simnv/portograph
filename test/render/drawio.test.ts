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
});
