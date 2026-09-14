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
    for (const [id, node] of Object.entries(model.nodes)) {
      const cell = all.get(`pg-node-${id}`)!;
      expect(cell.parent).toBe(`pg-group-${model.document.nodes[id]!.group}`);
      const group = model.groups[model.document.nodes[id]!.group]!.bounds!;
      expect(box(cell)).toEqual({
        x: node.bounds!.x - group.x, y: node.bounds!.y - group.y,
        width: node.bounds!.width, height: node.bounds!.height,
      });
    }

    let pinned = 0;
    for (const link of model.links) {
      if (link.technique === 'stub' || !link.path) continue;
      const cell = all.get(`pg-link-${link.id}`);
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
      expect(cell.source).toBe(`pg-node-${from.node}`);
      // Both fractions must be present or draw.io drops the constraint entirely, and
      // `exitPerimeter` defaults to 1, which would project the anchor onto the perimeter.
      expect(Number(cell.style['exitX'])).toBeCloseTo((port.anchor!.x - node.bounds!.x) / node.bounds!.width, 12);
      expect(Number(cell.style['exitY'])).toBeCloseTo((port.anchor!.y - node.bounds!.y) / node.bounds!.height, 12);
      expect(cell.style['exitPerimeter']).toBe('0');
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
      const cell = all.get(`pg-group-${band.group}`)!;
      expect(cell.tokens).toContain('swimlane');
      expect(cell.style['container']).toBe('1');
      expect(Number(cell.style['startSize'])).toBe(band.bounds.height);
      // `flipV` mirrors the shape paths only: the label is rendered outside the flip, so a bottom
      // band keeps upright text, which `direction=south` would not.
      expect(cell.style['flipV']).toBe(band.side === 'bottom' ? '1' : undefined);
    }
  }, 60000);

  it('puts connectors above the diagram and overlay strokes below it', async () => {
    const model = await pipeline(fixture('drawio-constructs'));
    const xml = drawio(model);
    const all = cells(xml);
    const order = [...all.keys()].filter(id => id.startsWith('pg-layer-'));
    // mxGraph paints in tree order, so layer declaration order is z-order. A container paints with
    // its children, so this stack is the only place the SVG renderer's z-order can be expressed.
    expect(order).toEqual(['pg-layer-overlay', 'pg-layer-diagram', 'pg-layer-links',
      'pg-layer-labels', 'pg-layer-legend']);
    const overlay = model.links.find(link => link.technique === 'overlay' || link.layer === 'overlay')!;
    expect(layerOf(all, `pg-link-${overlay.id}`)).toBe('pg-layer-overlay');
    const routed = model.links.find(link => link.path && link.technique !== 'stub' && link.id !== overlay.id)!;
    expect(layerOf(all, `pg-link-${routed.id}`)).toBe('pg-layer-links');
    for (const id of Object.keys(model.nodes)) expect(layerOf(all, `pg-node-${id}`)).toBe('pg-layer-diagram');
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
    expect(xml).toContain('value="a &amp;lt;b&amp;gt; &amp;amp; c"');
    expect(xml).not.toContain('value="a &lt;b&gt; &amp; c"');
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
    const light = cells(drawio(model, { theme: 'light' })).get('pg-node-a')!;
    const dark = cells(drawio(model, { theme: 'dark' })).get('pg-node-a')!;
    const print = cells(drawio(model, { theme: 'print' })).get('pg-node-a')!;
    expect(light.style['fillColor']).not.toBe(dark.style['fillColor']);
    expect(print.style['strokeColor']).not.toBe(light.style['strokeColor']);
  }, 60000);
});
