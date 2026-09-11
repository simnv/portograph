import { APPROVED_Q } from '../golden-baseline.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GateId, LayoutModel, Rect } from '../../src/index.js';
import { DEFAULT_STROKE_WIDTHS, OVERLAY_ENDPOINT_RADIUS, linkVisible, parseWithDiagnostics, produceLegend, render, score } from '../../src/index.js';
import { segments as scoreSegments } from '../../src/score/model.js';
import { xmlSafe } from '../../src/render/svg.js';
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
import { pillLabel, scene } from './fixture.js';

const GATES: GateId[] = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
const fittingYaml = readFileSync(new URL('../../goldens/synthetic/fitting-link-label.yaml', import.meta.url), 'utf8');

async function pipeline(yaml: string): Promise<LayoutModel> {
  const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return linkLabels(await route(placedModel, { createAttempt: createAvoidAttempt }));
}

/** Every `<tag ... />` of one element name, as attribute maps. */
function elements(svg: string, name: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const match of svg.matchAll(new RegExp(`<${name}\\b([^>]*?)/?>`, 'g'))) {
    const attributes: Record<string, string> = {};
    for (const pair of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[pair[1]!] = pair[2]!;
    found.push(attributes);
  }
  return found;
}
const rect = (values: Record<string, string>): Rect =>
  ({ x: Number(values['x']), y: Number(values['y']), width: Number(values['width']), height: Number(values['height']) });
const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
/** The `<g>` block carrying one `data-id`, including nested children. */
function block(svg: string, id: string): string {
  const start = svg.indexOf(`data-id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const open = svg.lastIndexOf('<g', start);
  let depth = 0;
  for (let at = open; at < svg.length; at++) {
    if (svg.startsWith('<g', at)) depth++;
    if (svg.startsWith('</g>', at)) { depth--; if (!depth) return svg.slice(open, at + 4); }
  }
  throw new Error(`Unclosed block for ${id}`);
}

describe('golden render', () => {
  it('serializes the approved golden from final geometry alone', async () => {
    const model = await pipeline(goldenYaml);
    const svg = render(model);

    // The layout is untouched by rendering, and the gates and score still hold.
    const before = JSON.stringify(model);
    expect(render(model)).toBe(svg);
    expect(JSON.stringify(model)).toBe(before);
    const report = score(model, { golden: true }).snapshot;
    for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
    expect(report.Q).toBeCloseTo(APPROVED_Q, 12);

    // One canvas for layout, score and render.
    const canvas = model.canvas!;
    const root = elements(svg, 'svg')[0]!;
    expect(root['viewBox']).toBe(`${canvas.x} ${canvas.y} ${canvas.width} ${canvas.height}`);
    expect([Number(root['width']), Number(root['height'])]).toEqual([canvas.width, canvas.height]);
    expect(report.canvas).toEqual(canvas);

    // Every node, group and named port is present, identified and drawn at its measured bounds.
    const boxes = elements(svg, 'rect').map(rect);
    for (const node of Object.values(model.nodes)) {
      expect(svg).toContain(`data-id="${node.id}"`);
      expect(boxes.some(box => sameRect(box, node.bounds!))).toBe(true);
      for (const port of node.ports) {
        expect(block(svg, node.id)).toContain(`data-id="${node.id}.${port.ref.name}#${port.ref.ordinal}"`);
        expect(boxes.some(box => sameRect(box, port.pill!.bounds))).toBe(true);
      }
    }
    for (const group of Object.values(model.groups)) {
      expect(boxes.some(box => sameRect(box, group.bounds!))).toBe(true);
    }

    // Every routed path point is serialized verbatim, in source-to-target order.
    for (const link of model.links) {
      const data = elements(block(svg, link.id), 'path')[0]!['d']!;
      const expected = link.path!.segments
        .map((segment, index) => `${index ? '' : `M${segment.from.x} ${segment.from.y} `}L${segment.to.x} ${segment.to.y}`)
        .join(' ');
      expect([link.id, data]).toEqual([link.id, expected]);
    }

    // Structural and author classes stay separate tokens.
    expect(block(svg, 'EAC-01')).toContain('class="node router"');
    expect(block(svg, 'link-5')).toContain('class="link dotted"');
    expect(block(svg, 'link-13')).toContain('class="link dashed"');
    expect(block(svg, 'link-1')).toContain('class="link"');
  }, 60000);

  it('lists exactly the classes present, once, in profile order', async () => {
    const model = await pipeline(goldenYaml);
    const svg = render(model);
    const ids = [...svg.matchAll(/<g class="legend-entry[^"]*" data-id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toEqual(['symbol:provider', 'symbol:router', 'symbol:tbr', 'symbol:rr',
      'line:default', 'line:dotted', 'line:dashed']);
    expect(ids).toEqual(model.legend!.entries.map(entry => entry.id));
    // The legend describes drawn classes, so it never invents one the document does not use.
    const present = new Set(model.document.links.map(link => link.class ?? 'default'));
    expect(ids.filter(id => id!.startsWith('line:')).map(id => id!.slice(5)).sort()).toEqual([...present].sort());
  }, 60000);

  it('draws a measured link label and its owner', async () => {
    const model = await pipeline(fittingYaml);
    const label = model.labels.find(item => item.role === 'link')!;
    expect(label.omitted).toBeFalsy();
    const svg = render(model);
    const text = elements(svg, 'text').find(item => item['class']!.includes('link-label'))!;
    expect(text['data-owner']).toBe(label.owner.kind === 'barCross' ? label.owner.link : label.owner.id);
    expect(svg).toContain(`>${label.lines![0]!}</tspan>`);
  }, 60000);
});

describe('geometry is consumed, never recomputed', () => {
  const rotated = scene({
    nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 }, class: 'router', icon: 'router',
      iconBounds: { x: 24, y: 110, width: 12, height: 12 } },
    { id: 'b', bounds: { x: 200, y: 100, width: 60, height: 40 } }],
    ports: [{ node: 'a', name: '100G', side: 'top', anchor: { x: 30, y: 100 } },
      { node: 'b', name: '10G', side: 'left', anchor: { x: 200, y: 120 } }],
    labels: [pillLabel('a', '100G', 1, { x: 25, y: 110.2, width: 10, height: 19.6 }, -90),
      pillLabel('b', '10G', 1, { x: 190, y: 115, width: 19.6, height: 10 }, 0)],
  });

  it('draws a top pill at its already rotated rectangle and rotates only the text', () => {
    const svg = render(rotated);
    const pill = rotated.nodes['a']!.ports[0]!.pill!;
    expect(pill.bounds).toEqual({ x: 25, y: 87, width: 10, height: 26 });
    const drawn = elements(block(svg, 'a.100G#1'), 'rect')[0]!;
    expect(rect(drawn)).toEqual(pill.bounds);
    // The rectangle is never rotated a second time; only the text carries the stored rotation.
    expect(drawn['transform']).toBeUndefined();
    const text = elements(block(svg, 'a.100G#1'), 'text')[0]!;
    expect(text['transform']).toBe('rotate(-90 30 120)');
    const horizontal = elements(block(svg, 'b.10G#1'), 'text')[0]!;
    expect(horizontal['transform']).toBeUndefined();
  });

  it('keeps stored typography and emits it as a locked style', () => {
    const svg = render(rotated);
    const text = elements(block(svg, 'a.100G#1'), 'text')[0]!;
    const font = text['class']!.split(' ').find(token => token.startsWith('pg-f-'))!;
    expect(font).toBe('pg-f-8-400');
    expect(svg).toContain(`.${font}{font-family:Arial, Helvetica, sans-serif!important;font-size:8px!important;font-weight:400!important;`);
  });

  it('uses the stroke width score measures, for every element', () => {
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 }, strokeWidth: 4 },
        { id: 'b', bounds: { x: 120, y: 0, width: 40, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 120, y: 20 } }],
      links: [{ id: 'l', from: 'a', to: 'b', points: [{ x: 40, y: 20 }, { x: 120, y: 20 }], strokeWidth: 3 }],
    });
    const svg = render(model);
    expect(elements(block(svg, 'a'), 'rect')[0]!['class']).toContain('pg-w-4');
    expect(elements(block(svg, 'l'), 'path')[0]!['class']).toContain('pg-w-3');
    expect(svg).toContain('.pg-w-4{stroke-width:4px!important}');
    expect(svg).toContain('.pg-w-3{stroke-width:3px!important}');
    // The default path width is the one the scorer assumes when a path stores none.
    const plain = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
      { id: 'b', bounds: { x: 120, y: 0, width: 40, height: 40 } }],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
      { node: 'b', name: 'p', side: 'left', anchor: { x: 120, y: 20 } }],
    links: [{ id: 'l', from: 'a', to: 'b', points: [{ x: 40, y: 20 }, { x: 120, y: 20 }] }] });
    expect(render(plain)).toContain(`.pg-w-${String(DEFAULT_STROKE_WIDTHS.path).replace('.', '_')}{stroke-width:${DEFAULT_STROKE_WIDTHS.path}px!important}`);
  });

  it('draws the authored weight as one width, shared by score, every layer and the legend', () => {
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 120 }, class: 'router' },
        { id: 'b', bounds: { x: 200, y: 0, width: 40, height: 120 }, class: 'tbr' }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 20 } },
        { node: 'a', name: 'q', side: 'right', anchor: { x: 40, y: 60 } },
        { node: 'b', name: 'q', side: 'left', anchor: { x: 200, y: 60 } },
        { node: 'a', name: 'r', side: 'right', anchor: { x: 40, y: 100 } },
        { node: 'b', name: 'r', side: 'left', anchor: { x: 200, y: 100 } }],
      links: [
        { id: 'thick', from: 'a', to: 'b', class: 'dashed', strokeWidth: 6, points: [{ x: 40, y: 20 }, { x: 200, y: 20 }] },
        { id: 'member', from: 'a', to: 'b', class: 'dotted', strokeWidth: 4.5, bundle: 'bundle-1',
          points: [{ x: 40, y: 60 }, { x: 200, y: 60 }] },
        { id: 'flow', from: 'a', to: 'b', class: 'flow', layer: 'overlay', strokeWidth: 3,
          points: [{ x: 40, y: 100 }, { x: 200, y: 100 }] }],
    });
    const svg = render(model);
    const widths = new Map(model.links.map(link => [link.id, link.path!.strokeWidth!]));
    for (const [id, width] of widths) {
      const token = `pg-w-${String(width).replace('.', '_')}`;
      expect([id, elements(block(svg, id), 'path')[0]!['class']!.includes(token)]).toEqual([id, true]);
      expect(svg).toContain(`.${token}{stroke-width:${width}px!important}`);
    }
    // The scorer's effective width for each routed segment is the same number.
    for (const segment of scoreSegments(model)) expect(segment.stroke).toBe(widths.get(segment.link.id));
    // Each legend line sample carries its class's own resolved width, not the shared default.
    produceLegend(model);
    const samples = new Map(model.legend!.entries.filter(entry => entry.kind === 'line')
      .map(entry => [entry.key, entry.strokeWidth]));
    expect(samples).toEqual(new Map([['dashed', 6], ['dotted', 4.5], ['flow', 3]]));
    const drawn = render(model);
    for (const [key, width] of samples) {
      expect([key, block(drawn, `line:${key}`).includes(`pg-w-${String(width).replace('.', '_')}`)]).toEqual([key, true]);
    }
  });

  it('never lets an author class claim a generated geometry lock', () => {
    // `pg-w-2` as an authored class would put a second stroke-width rule on the element and win by
    // source order, drawing 2 px where score measures 3 px.
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 }, class: 'pg-f-9-700 real' },
        { id: 'b', bounds: { x: 200, y: 0, width: 40, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 20 } }],
      links: [{ id: 'l', from: 'a', to: 'b', class: 'pg-w-2', strokeWidth: 3,
        points: [{ x: 40, y: 20 }, { x: 200, y: 20 }] }],
    });
    const svg = render(model);
    const line = elements(block(svg, 'l'), 'path')[0]!['class']!.split(' ');
    expect(line).toContain('pg-w-3');
    // Exactly one lock class reaches the element, so no second stroke-width rule can win.
    expect(line.filter(token => token.startsWith('pg-w-'))).toEqual(['pg-w-3']);
    expect(block(svg, 'l')).not.toContain('pg-w-2');
    // A real author class beside the rejected one survives; the typography lock is not spoofable.
    expect(elements(block(svg, 'a'), 'rect')[0]!['class']!.split(' ')).toContain('real');
    expect(block(svg, 'a')).not.toContain('pg-f-9-700');
  });

  it('substitutes characters XML cannot carry, so every accepted input serializes', () => {
    const hostile = `control${String.fromCharCode(1)}${String.fromCharCode(0xd800)}end`;
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 } }], title: hostile,
      labels: [{ id: 'node:a', owner: { kind: 'node', id: 'a' }, layer: 'routed', role: 'node',
        text: hostile, lines: [hostile], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9,
        fontWeight: 700, lineHeight: 11, bounds: { x: 5, y: 15, width: 50, height: 11 } }],
    });
    const svg = render(model);
    expect(xmlSafe(hostile)).toBe(`control��end`);
    for (const character of svg) {
      const code = character.codePointAt(0)!;
      const allowed = code === 0x09 || code === 0x0a || code === 0x0d
        || code >= 0x20 && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff;
      expect([code, allowed]).toEqual([code, true]);
    }
    // A valid astral character is not a forbidden one and survives intact.
    expect(xmlSafe('a\u{1F600}b')).toBe('a\u{1F600}b');
  });

  it('keeps the text a label only carries, and group-link membership', () => {
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
        { id: 'b', bounds: { x: 200, y: 0, width: 40, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
        { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 20 } }],
      links: [{ id: 'l', from: 'a', to: 'b', points: [{ x: 40, y: 20 }, { x: 200, y: 20 }], label: 'Too long to fit' }],
      labels: [{ id: 'label:link:l', owner: { kind: 'link', id: 'l' }, layer: 'routed', role: 'link',
        text: 'Too long to fit', tooltip: 'Too long to fit', omitted: true,
        fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, fontWeight: 400, lineHeight: 11 }],
    });
    model.links[0]!.groupLink = 'group-link-1';
    model.groupLinks.push({ id: 'group-link-1', owner: { kind: 'group-link', id: 'group-link-1' },
      layer: 'routed', groups: ['left', 'right'], members: ['l', 'other'] });
    const svg = render(model);
    // The omitted label draws nothing, so its retained text has to survive on its link.
    expect(svg).not.toContain('class="link-label');
    expect(block(svg, 'l')).toContain('<title>Too long to fit\nleft – right: 2 links</title>');
    // M1 draws the members, so no aggregated glyph is invented for the group link.
    expect(svg).not.toContain('group-link-1"');
  });

  it('refuses a model without final geometry and an empty layer selection', () => {
    const model = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } }] });
    delete model.canvas;
    expect(() => render(model)).toThrow(/canvas/);
    const ok = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } }] });
    expect(() => render(ok, { layers: [] })).toThrow(/at least one/);
  });
});

describe('escaping', () => {
  const hostile = '</style><script>alert(1)</script> & "quoted" <tag>';
  it('never interpolates a source string as markup', () => {
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 }, label: hostile }],
      title: hostile,
      labels: [{ id: 'node:a', owner: { kind: 'node', id: 'a' }, layer: 'routed', role: 'node', text: hostile,
        lines: [hostile], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, fontWeight: 700, lineHeight: 11,
        bounds: { x: 5, y: 15, width: 50, height: 11 } }],
    });
    const svg = render(model);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('alert(1)</script>');
    // The style element is closed exactly once, by the renderer.
    expect(svg.match(/<\/style>/g)!.length).toBe(1);
    expect(svg).toContain('&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quoted" &lt;tag&gt;');
    // The document title is escaped too, and stays a single title element.
    expect(svg.match(/<title>/g)!.length).toBe(1);
  });

  it('cannot be closed early by a document style sheet', () => {
    const model = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 } }],
      css: '.a { /* </style><rect width="9999" height="9999"/> */ fill: red }' });
    const svg = render(model);
    expect(svg).not.toContain('</style><rect');
    expect(svg).toContain('&lt;/style&gt;');
    expect(elements(svg, 'rect').every(item => Number(item['width']) < 9999)).toBe(true);
  });
});

describe('legend identity', () => {
  /** XML attribute-value normalization: a literal tab, newline or carriage return becomes a space. */
  const normalized = (value: string): string => value.replace(/\r\n|[\t\n\r]/g, ' ');
  const drawn = (classes: string[]): LayoutModel => {
    const model = scene({ nodes: classes.map((value, index) => ({ id: `n${index}`, class: value,
      bounds: { x: index * 120, y: 0, width: 60, height: 40 } })) });
    produceLegend(model);
    return model;
  };

  it('keeps distinct classes distinct in the serialized data-id', () => {
    // Accepted free-text classes, including two that spell the escapes of two others and one
    // spelled with the substitute the serializer uses for a character XML forbids.
    const hostile = ['a\u0001', 'a\u0002', 'a\nb', 'a b', 'a\tb', 'a\ud800', 'a\ud801', 'a%01', 'a%uD800', 'a\ufffd'];
    const model = drawn(hostile);
    const svg = render(model);
    const ids = [...svg.matchAll(/<g class="legend-entry[^"]*" data-id="([^"]*)"/g)].map(match => match[1]!);
    expect(ids).toEqual(model.legend!.entries.map(entry => entry.id));
    expect(ids).toHaveLength(hostile.length);
    // The serialized attribute is what a consumer reads back: the renderer substitutes U+FFFD for a
    // character XML forbids, and an XML parser folds literal attribute whitespace to a space. An
    // identity that survives both unchanged is one no other identity can collide with.
    expect(ids.map(id => normalized(xmlSafe(id)))).toEqual(ids);
    expect(new Set(ids).size).toBe(hostile.length);
  });

  it('replaces the text a row displays without touching the row identity', () => {
    const svg = render(drawn(['a\u0001', 'a\u0002']));
    // Visible text is substituted, so both rows read the same; identity is encoded, so they differ.
    expect(svg.match(/>a\ufffd<\/tspan>/g)).toHaveLength(2);
    expect(svg).toContain('data-id="symbol:a%01"');
    expect(svg).toContain('data-id="symbol:a%02"');
  });
});

describe('document CSS', () => {
  it('ignores a locked font-size with a parse warning and keeps the colour', () => {
    const parsed = parseWithDiagnostics(['portograph: 2', 'css: |', '  .router { font-size: 40px; fill: #123456; }',
      'groups: {g: {tier: 0}}', 'nodes: {a: {group: g, class: router}}'].join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.some(item => item.code === 'LOCKED_CSS' && item.severity === 'warning')).toBe(true);
    const filtered = (parsed as { document: { css?: string } }).document.css!;
    const model = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 }, class: 'router' }],
      css: filtered,
      labels: [{ id: 'node:a', owner: { kind: 'node', id: 'a' }, layer: 'routed', role: 'node', text: 'a',
        lines: ['a'], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, fontWeight: 700, lineHeight: 11,
        bounds: { x: 5, y: 15, width: 20, height: 11 } }] });
    const svg = render(model);
    expect(svg).toContain('fill: #123456');
    expect(svg).not.toContain('font-size: 40px');
    // The theme still states the locked properties itself, so nothing else can reach them.
    expect(svg).toMatch(/font-size:\d+(\.\d+)?px!important/);
  });

  it('rejects a stored font family that could break out of the style sheet', () => {
    const model = scene({ nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 } }],
      labels: [{ id: 'node:a', owner: { kind: 'node', id: 'a' }, layer: 'routed', role: 'node', text: 'a',
        lines: ['a'], fontFamily: 'Arial}.x{fill:red', fontSize: 9, fontWeight: 700, lineHeight: 11,
        bounds: { x: 5, y: 15, width: 20, height: 11 } }] });
    expect(() => render(model)).toThrow(/Font family/);
  });
});

describe('overlay layer', () => {
  const overlaid = (overlays?: Record<string, 'hidden' | 'visible'>): LayoutModel => scene({
    nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
      { id: 'b', bounds: { x: 200, y: 0, width: 40, height: 40 } }],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 10 } },
      { node: 'b', name: 'p', side: 'left', anchor: { x: 200, y: 10 } },
      { node: 'a', name: 'q', side: 'right', anchor: { x: 40, y: 30 } },
      { node: 'b', name: 'q', side: 'left', anchor: { x: 200, y: 30 } }],
    links: [{ id: 'routed-1', from: 'a', to: 'b', points: [{ x: 40, y: 10 }, { x: 200, y: 10 }], label: 'wire' },
      { id: 'flow-1', from: 'a', to: 'b', points: [{ x: 40, y: 30 }, { x: 200, y: 30 }], class: 'flow', layer: 'overlay' }],
    labels: [{ id: 'label:link:routed-1', owner: { kind: 'link', id: 'routed-1' }, layer: 'routed', role: 'link',
      text: 'wire', lines: ['wire'], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, fontWeight: 400,
      lineHeight: 11, bounds: { x: 110, y: 0, width: 20, height: 11 },
      support: { kind: 'link-segment', link: 'routed-1', segment: 0 } },
    { id: 'label:group:row-group', owner: { kind: 'group', id: 'row-group' }, layer: 'routed', role: 'group',
      text: 'Row group', lines: ['Row group'], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12,
      fontWeight: 700, lineHeight: 14, bounds: { x: -12, y: -16, width: 50, height: 14 } }],
    ...(overlays ? { overlays } : {}),
  });

  it('masks the overlay below the routed layer and keeps unmasked endpoint marks', () => {
    const model = overlaid();
    const svg = render(model);
    expect(svg.indexOf('class="overlay-links"')).toBeLessThan(svg.indexOf('class="links"'));
    expect(elements(svg, 'g').find(item => item['class'] === 'overlay-links')!['mask']).toBe('url(#pg-overlay-mask)');
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    const hidden = elements(mask, 'rect').filter(item => item['class'] === 'pg-mask-hide').map(rect);
    for (const box of [model.nodes['a']!.bounds!, model.nodes['b']!.bounds!,
      model.nodes['a']!.ports[0]!.pill!.bounds,
      model.labels.find(label => label.role === 'group')!.bounds!,
      model.labels.find(label => label.role === 'link')!.bounds!]) {
      expect(hidden.some(item => sameRect(item, box))).toBe(true);
    }
    // The 2 px endpoint marks live above the protected elements, outside the masked group.
    const marks = elements(svg, 'circle');
    expect(marks.map(item => [item['data-owner'], item['data-end'], Number(item['cx']), Number(item['cy']), Number(item['r'])]))
      .toEqual([['flow-1', 'from', 40, 30, OVERLAY_ENDPOINT_RADIUS], ['flow-1', 'to', 200, 30, OVERLAY_ENDPOINT_RADIUS]]);
    expect(svg.indexOf('class="overlay-marks"')).toBeGreaterThan(svg.indexOf('class="nodes"'));
  });

  it('applies document overlay switches by class, and an explicit selection overrides them', () => {
    const hiddenByDocument = overlaid({ flow: 'hidden' });
    const svg = render(hiddenByDocument);
    expect(svg).not.toContain('data-id="flow-1"');
    expect(elements(svg, 'circle')).toEqual([]);
    expect(svg).toContain('data-id="routed-1"');
    expect(svg).toContain('data-id="a"');
    expect(linkVisible(hiddenByDocument, hiddenByDocument.links[1]!, {})).toBe(false);

    const forced = render(hiddenByDocument, { layers: ['routed', 'overlay'] });
    expect(forced).toContain('data-id="flow-1"');
    const overlayOnly = render(hiddenByDocument, { layers: ['overlay'] });
    expect(overlayOnly).toContain('data-id="flow-1"');
    expect(overlayOnly).not.toContain('data-id="routed-1"');
    // Nodes, ports, groups and the legend never follow a link selection.
    expect(overlayOnly).toContain('data-id="a"');
    expect(overlayOnly).toContain('data-id="a.p#1"');
    expect(overlayOnly).toContain('data-id="row-group"');
  });

  it('omits a hidden link label from the mask and from the drawing', () => {
    const model = overlaid();
    const visible = render(model);
    const hidden = render(model, { layers: ['overlay'] });
    const boxOf = (svg: string): Rect[] => {
      const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
      return elements(mask, 'rect').filter(item => item['class'] === 'pg-mask-hide').map(rect);
    };
    const label = model.labels.find(item => item.role === 'link')!.bounds!;
    expect(boxOf(visible).some(box => sameRect(box, label))).toBe(true);
    expect(boxOf(hidden).some(box => sameRect(box, label))).toBe(false);
    expect(hidden).not.toContain('class="link-label"');
    // A hidden routed label must not leave an unexplained gap in the overlay that is displayed.
    expect(hidden).toContain('class="overlay-links"');
  });
});

describe('internal overlay mask', () => {
  /**
   * Direct-model CSS that targets internal mask elements: the reported override, a variant with
   * higher specificity, global palette rules, and outline paint. The parser now rejects outlines;
   * injecting the CSS into this test model also checks the renderer's own mask protection.
   */
  const hostileCss = ['.pg-mask-hide { fill: #ffffff !important; }',
    'svg .pg-mask-hide.pg-mask-hide { fill: #ffffff !important; opacity: 0 !important; }',
    '.pg-mask-show { fill: #000000 !important; visibility: hidden !important; }',
    'rect { fill: #ffffff !important; fill-opacity: 0 !important; mix-blend-mode: screen !important; }',
    '.pg-mask-hide:last-child { outline: 1000px solid #ffffff !important; }',
    '.pg-mask-hide { -webkit-mask-box-image: linear-gradient(#000000, #000000) !important; }',
    '.node-body { fill: none; }'].join('\n');

  /** The finding's diagram: three nodes in a row with an overlay link from the first to the last. */
  const masked = (css?: string): LayoutModel => scene({
    nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 40, height: 40 } },
      { id: 'b', bounds: { x: 100, y: 0, width: 40, height: 40 } },
      { id: 'c', bounds: { x: 200, y: 0, width: 40, height: 40 } }],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 40, y: 20 } },
      { node: 'c', name: 'p', side: 'left', anchor: { x: 200, y: 20 } }],
    links: [{ id: 'flow-1', from: 'a', to: 'c', class: 'flow', layer: 'overlay',
      points: [{ x: 40, y: 20 }, { x: 200, y: 20 }] }],
    labels: [{ id: 'label:group:row-group', owner: { kind: 'group', id: 'row-group' }, layer: 'routed',
      role: 'group', text: 'Row group', lines: ['Row group'], fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 12, fontWeight: 700, lineHeight: 14, bounds: { x: -12, y: -16, width: 50, height: 14 } }],
    ...(css === undefined ? {} : { css }),
  });

  /** Inline declarations of one element, as property → value, importance included in the value. */
  const declarations = (style: string | undefined): Map<string, string> =>
    new Map((style ?? '').split(';').filter(part => part.trim()).map(part => {
      const at = part.indexOf(':');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }));

  /**
   * Paint, alpha, blending and presence, with the value each one has to keep. Every one of them can
   * turn a cutout into paint or the shown region into a hole, and each is reachable from an accepted
   * `css:` rule or from a restored model whose CSS never passed the parser's locks.
   */
  const pinned: [string, string][] = [['fill-opacity', '1'], ['opacity', '1'], ['stroke', 'none'],
    ['outline', 'none'], ['display', 'inline'], ['visibility', 'visible'], ['mix-blend-mode', 'normal'],
    ['mask', 'none'], ['clip-path', 'none'], ['filter', 'none'], ['mask-border', 'none'],
    ['-webkit-mask-box-image', 'none']];

  it('pins its own paint inline, where no author style sheet can reach it', () => {
    const svg = render(masked(hostileCss));
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    const rects = elements(mask, 'rect');
    // One shown canvas and a cutout for each node, pill and drawn label.
    expect(rects.filter(item => item['class'] === 'pg-mask-show')).toHaveLength(1);
    expect(rects.filter(item => item['class'] === 'pg-mask-hide').length).toBeGreaterThan(1);
    for (const item of rects) {
      const shown = item['class'] === 'pg-mask-show';
      const colour = shown ? '#ffffff' : '#000000';
      // The paint is on the element too, so a renderer that reads no style sheet still draws it.
      expect([item['class'], item['fill']]).toEqual([item['class'], colour]);
      const inline = declarations(item['style']);
      // An important inline declaration outranks every rule of an author style sheet, whatever its
      // specificity, its importance and its source order. That is the whole protection, so each
      // pinned property has to carry both its own value and that importance.
      expect([item['class'], inline.get('fill')]).toEqual([item['class'], `${colour}!important`]);
      for (const [property, value] of pinned) {
        expect([item['class'], property, inline.get(property)])
          .toEqual([item['class'], property, `${value}!important`]);
      }
    }
    // The mask states its own luminance meaning, so no rule can reinterpret black as opaque.
    expect(elements(svg, 'mask')[0]!['style']).toContain('mask-type:luminance!important');
    // The theme no longer states mask paint, where an accepted rule of equal specificity and
    // importance won by source order; nothing in the sheet decides the mask any more.
    expect(svg).not.toContain('.pg-mask-hide{');
    expect(svg).not.toContain('.pg-mask-show{');
    // The author still owns the palette of real diagram elements: no rule is filtered out here.
    expect(svg).toContain('.node-body { fill: none; }');
    expect(svg).toContain('.pg-mask-hide { fill: #ffffff !important; }');
  });

  it('cuts out the same geometry whatever the document styles', () => {
    const plain = render(masked()), styled = render(masked(hostileCss));
    const boxes = (svg: string): Rect[] =>
      elements(svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>')), 'rect').map(rect);
    expect(boxes(styled)).toEqual(boxes(plain));
    const model = masked();
    for (const box of [model.nodes['b']!.bounds!, model.nodes['a']!.ports[0]!.pill!.bounds,
      model.labels[0]!.bounds!]) {
      expect(boxes(styled).some(item => sameRect(item, box))).toBe(true);
    }
  });
});

describe('counted merge runs', () => {
  const merged = (): LayoutModel => {
    const model = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 0, y: 200, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 20, y: 40 } },
        { node: 'a', name: 'q', side: 'bottom', anchor: { x: 40, y: 40 } },
        { node: 'b', name: 'p', side: 'top', anchor: { x: 20, y: 200 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 40, y: 200 } }],
      links: [
        { id: 'm1', from: 'a', to: 'b', bundle: 'bundle-1', technique: 'merge',
          points: [{ x: 20, y: 40 }, { x: 20, y: 80 }, { x: 30, y: 80 }, { x: 30, y: 160 }, { x: 20, y: 160 }, { x: 20, y: 200 }] },
        { id: 'm2', from: 'a', to: 'b', bundle: 'bundle-1', technique: 'merge',
          points: [{ x: 40, y: 40 }, { x: 40, y: 80 }, { x: 30, y: 80 }, { x: 30, y: 160 }, { x: 40, y: 160 }, { x: 40, y: 200 }] }],
    });
    const owner = { kind: 'bundle' as const, id: 'bundle-1' };
    model.bundles.push({ id: 'bundle-1', owner, layer: 'routed', nodes: ['a', 'b'], members: ['m1', 'm2'],
      mergeRuns: [{ id: 'merge:bundle-1:0', members: ['m1', 'm2'], count: 2,
        path: { owner, layer: 'routed', fixed: true,
          segments: [{ from: { x: 30, y: 80 }, to: { x: 30, y: 160 }, owner }] } }] });
    model.labels.push({ id: 'label:multiplicity:merge:bundle-1:0', owner, layer: 'routed', role: 'link',
      text: '2', lines: ['2'], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, fontWeight: 400,
      lineHeight: 11, bounds: { x: 36, y: 115, width: 6, height: 11 },
      support: { kind: 'merge-run', bundle: 'bundle-1', run: 'merge:bundle-1:0' } });
    return model;
  };

  it('paints one shared trunk once and drops its duplicate from every member', () => {
    const svg = render(merged());
    const trunk = elements(block(svg, 'merge:bundle-1:0'), 'path')[0]!;
    expect(trunk['d']).toBe('M30 80 L30 160');
    expect(block(svg, 'merge:bundle-1:0')).toContain('data-owner="bundle-1"');
    for (const id of ['m1', 'm2']) {
      const data = elements(block(svg, id), 'path')[0]!['d']!;
      expect([id, data.includes('L30 160')]).toEqual([id, false]);
      // The member's own approach and departure still draw, as two subpaths.
      expect([id, (data.match(/M/g) ?? []).length]).toEqual([id, 2]);
      expect([id, data]).toEqual([id, data.startsWith('M') ? data : '']);
    }
    expect((svg.match(/M30 80 L30 160/g) ?? []).length).toBe(1);
  });

  it('draws the multiplicity label under its bundle and never invents a count', () => {
    const svg = render(merged());
    const text = elements(svg, 'text').find(item => item['class']!.includes('multiplicity-label'))!;
    expect(text['data-owner']).toBe('bundle-1');
    expect(svg).toContain('>2</tspan>');
    // Hiding every member hides the counted trunk's label with them.
    expect(render(merged(), { layers: ['overlay'] })).not.toContain('multiplicity-label');
  });

  it('protects a drawn multiplicity label in the overlay mask, like any other drawn label', () => {
    const model = merged();
    const owner = { kind: 'link' as const, id: 'flow' };
    model.nodes['a']!.ports.push({ ref: { node: 'a', name: 'f', ordinal: 1 }, side: 'right',
      owner: { kind: 'node', id: 'a' }, layer: 'routed', anchor: { x: 60, y: 20 } });
    model.nodes['b']!.ports.push({ ref: { node: 'b', name: 'f', ordinal: 1 }, side: 'right',
      owner: { kind: 'node', id: 'b' }, layer: 'routed', anchor: { x: 60, y: 220 } });
    model.document.nodes['a']!.ports.push({ name: 'f', ordinal: 1, side: 'right' });
    model.document.nodes['b']!.ports.push({ name: 'f', ordinal: 1, side: 'right' });
    model.document.links.push({ from: { node: 'a', name: 'f', ordinal: 1 }, to: { node: 'b', name: 'f', ordinal: 1 }, class: 'flow' });
    model.links.push({ id: 'flow', sourceIndex: model.document.links.length - 1, owner,
      from: { node: 'a', name: 'f', ordinal: 1 }, to: { node: 'b', name: 'f', ordinal: 1 },
      family: 'overlay', layer: 'overlay', technique: 'overlay',
      attachments: { from: { node: 'a', name: 'f', ordinal: 1 }, to: { node: 'b', name: 'f', ordinal: 1 } },
      path: { owner, layer: 'overlay', fixed: false,
        segments: [{ from: { x: 60, y: 20 }, to: { x: 60, y: 220 }, owner }] } });
    const svg = render(model);
    const label = model.labels.find(item => item.support?.kind === 'merge-run')!;
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    const hidden = elements(mask, 'rect').filter(item => item['class'] === 'pg-mask-hide').map(rect);
    expect(svg).toContain('multiplicity-label');
    expect(hidden.some(box => sameRect(box, label.bounds!))).toBe(true);
    // With every member hidden, the label is not drawn and must not be masked either.
    const hiddenMembers = render(model, { layers: ['overlay'] });
    const other = hiddenMembers.slice(hiddenMembers.indexOf('<mask'), hiddenMembers.indexOf('</mask>'));
    expect(hiddenMembers).not.toContain('multiplicity-label');
    expect(elements(other, 'rect').filter(item => item['class'] === 'pg-mask-hide').map(rect)
      .some(box => sameRect(box, label.bounds!))).toBe(false);
  });
});

describe('declared bar crossings', () => {
  /** The detached-body layer alone, between the overlay and the links. */
  const detachedLayer = (svg: string): string =>
    svg.slice(svg.indexOf('<g class="nodes crossed-bars">'), svg.indexOf('<g class="links">'));

  /** Where one node body is painted, in serialized order; exactly one element paints each. */
  function bodyAt(svg: string, box: Rect): number {
    const found = [...svg.matchAll(/<rect\b[^>]*\/>/g)].filter(match => {
      const values = elements(match[0], 'rect')[0]!;
      return values['class']!.startsWith('node-body') && sameRect(rect(values), box);
    });
    expect(found).toHaveLength(1);
    return found[0]!.index!;
  }

  /**
   * The reported golden pattern, minimised: `drop` reaches the lower bar and crosses the upper bar
   * on the way, as the three Backbone drops cross EBB-01 to reach EBB-02. `feed` ends on the upper
   * bar and crosses nothing; `aside` is an ordinary node; `flow` is an overlay link. The crossing is
   * the model's own annotation, reserved during placement — the renderer reads it and moves nothing.
   */
  const crossing = (): LayoutModel => {
    const model = scene({
      nodes: [{ id: 'top', bounds: { x: 100, y: 0, width: 60, height: 40 }, class: 'router' },
        { id: 'upper', bounds: { x: 0, y: 100, width: 300, height: 40 }, class: 'router', label: 'EBB-01' },
        { id: 'lower', bounds: { x: 0, y: 200, width: 300, height: 40 }, class: 'router', label: 'EBB-02' },
        { id: 'aside', bounds: { x: 360, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'top', name: '100G', side: 'bottom', anchor: { x: 130, y: 40 } },
        { node: 'top', name: '100G', side: 'bottom', anchor: { x: 110, y: 40 } },
        { node: 'lower', name: '100G', side: 'top', anchor: { x: 130, y: 200 } },
        { node: 'upper', name: '100G', side: 'top', anchor: { x: 40, y: 100 } },
        { node: 'upper', name: 'sync', side: 'right', anchor: { x: 300, y: 130 } },
        { node: 'aside', name: 'sync', side: 'left', anchor: { x: 360, y: 130 } }],
      links: [{ id: 'drop', from: 'top', to: 'lower', points: [{ x: 130, y: 40 }, { x: 130, y: 200 }] },
        { id: 'feed', from: 'top', to: 'upper',
          points: [{ x: 110, y: 40 }, { x: 110, y: 70 }, { x: 40, y: 70 }, { x: 40, y: 100 }] },
        { id: 'flow', from: 'upper', to: 'aside', class: 'flow', layer: 'overlay',
          points: [{ x: 300, y: 130 }, { x: 360, y: 130 }] }],
      labels: [{ id: 'label:node:upper', owner: { kind: 'node', id: 'upper' }, layer: 'routed', role: 'node',
        text: 'EBB-01', lines: ['EBB-01'], fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12,
        fontWeight: 700, lineHeight: 14, bounds: { x: 60, y: 113, width: 44, height: 14 } },
      pillLabel('upper', '100G', 1, { x: 35, y: 92, width: 10, height: 16 }, -90)],
    });
    model.links[0]!.path!.segments[0]!.barCross = ['upper'];
    return model;
  };
  const RUN = 'd="M130 40 L130 200"';

  it('paints a crossed bar body beneath the run that declares the crossing', () => {
    const model = crossing();
    const svg = render(model);
    const run = svg.indexOf(RUN);
    expect(run).toBeGreaterThan(-1);
    // The reported symptom: the bar's opaque fill used to be painted over the drop that crosses it.
    expect(bodyAt(svg, model.nodes['upper']!.bounds!)).toBeLessThan(run);

    // The body itself is untouched: the same rectangle, painted once, with the same classes an
    // ordinary body of that class carries and no paint attribute of its own.
    const body = elements(detachedLayer(svg), 'rect')[0]!, ordinary = elements(block(svg, 'lower'), 'rect')[0]!;
    expect(rect(body)).toEqual(model.nodes['upper']!.bounds!);
    expect(Object.keys(body)).toEqual(Object.keys(ordinary));
    expect(body['class']).toBe(ordinary['class']);
    expect(elements(svg, 'rect').filter(values => sameRect(rect(values), model.nodes['upper']!.bounds!)
      && values['class']!.startsWith('node-body'))).toHaveLength(1);
    // One semantic data-id per object: the detached container carries `data-owner`, as every other
    // detached element does, and the bar's identity stays on the group its content is drawn in.
    expect(svg.match(/data-id="upper"/g)).toHaveLength(1);
    expect(block(svg, 'upper')).toContain('data-id="upper.100G#1"');
  });

  it('detaches the body into a node container and a node layer, named as before', () => {
    // A `css:` rule reaches the palette by name: the body, the node class, the container or the
    // layer. Each of those names is kept, so a rule that reaches an ordinary body reaches this one.
    // A rule that depends instead on the element's place in the tree reaches no detached element
    // here — a link label and an endpoint mark leave their link the same way.
    const svg = render(crossing());
    const containers = elements(detachedLayer(svg), 'g').slice(1);
    expect(containers.map(values => values['data-owner'])).toEqual(['upper']);
    expect(containers[0]!['class']).toBe(elements(block(svg, 'lower'), 'g')[0]!['class']);
    expect(containers[0]!['data-id']).toBeUndefined();
    expect(svg).toContain(`<g class="${containers[0]!['class']}" data-owner="upper"><rect class="node-body`);
    expect(detachedLayer(svg).startsWith('<g class="nodes crossed-bars">')).toBe(true);
  });

  it('keeps bar content, and every body no run crosses, above the routed layer', () => {
    const model = crossing();
    const svg = render(model);
    const run = svg.indexOf(RUN);
    // The bar's label and pill stay over the run that crosses the bar, as the target draws them.
    expect(svg.indexOf('>EBB-01</tspan>')).toBeGreaterThan(run);
    expect(svg.indexOf('data-id="upper.100G#1"')).toBeGreaterThan(run);
    // Only a declared crossing moves a body. A link that ends on a node is not one.
    for (const id of ['top', 'lower', 'aside']) expect(bodyAt(svg, model.nodes[id]!.bounds!)).toBeGreaterThan(run);
    expect(elements(detachedLayer(svg), 'g').slice(1).map(values => values['data-owner'])).toEqual(['upper']);
  });

  it('keeps the overlay masked, beneath the crossed body, and cut out of it', () => {
    const svg = render(crossing());
    expect(elements(svg, 'g').find(item => item['class'] === 'overlay-links')!['mask']).toBe('url(#pg-overlay-mask)');
    for (const [above, below] of [['overlay-links', 'nodes crossed-bars'],
      ['nodes crossed-bars', 'links'], ['links', 'nodes']]) {
      expect([above, svg.indexOf(`class="${above}"`) < svg.indexOf(`class="${below}"`)]).toEqual([above, true]);
    }
    const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
    const hidden = elements(mask, 'rect').filter(item => item['class'] === 'pg-mask-hide').map(rect);
    expect(hidden.some(box => sameRect(box, crossing().nodes['upper']!.bounds!))).toBe(true);
  });

  it('moves no body when the painted geometry declares no crossing', () => {
    const model = crossing();
    delete model.links[0]!.path!.segments[0]!.barCross;
    const svg = render(model);
    expect(svg).not.toContain('crossed-bars');
    expect(bodyAt(svg, model.nodes['upper']!.bounds!)).toBeGreaterThan(svg.indexOf(RUN));

    // A crossing that is not drawn is not painted over either, so it moves nothing.
    const overlayOnly = render(crossing(), { layers: ['overlay'] });
    expect(overlayOnly).not.toContain('crossed-bars');
    expect(elements(block(overlayOnly, 'upper'), 'rect')[0]!['class']).toContain('node-body');
  });

  it('reads the crossing from a counted trunk as well, still painted once', () => {
    const model = crossing();
    // Only the shared trunk declares the crossing here, so it alone can move the bar's body.
    delete model.links[0]!.path!.segments[0]!.barCross;
    const owner = { kind: 'bundle' as const, id: 'bundle-1' };
    const trunk = { from: { x: 200, y: 40 }, to: { x: 200, y: 200 }, owner, barCross: ['upper'] };
    for (const link of model.links.slice(0, 2)) link.bundle = 'bundle-1';
    model.bundles.push({ id: 'bundle-1', owner, layer: 'routed', nodes: ['top', 'lower'], members: ['drop', 'feed'],
      mergeRuns: [{ id: 'merge:bundle-1:0', members: ['drop', 'feed'], count: 2,
        path: { owner, layer: 'routed', fixed: true, segments: [trunk] } }] });
    const svg = render(model);
    expect((svg.match(/M200 40 L200 200/g) ?? []).length).toBe(1);
    expect(bodyAt(svg, model.nodes['upper']!.bounds!)).toBeLessThan(svg.indexOf('d="M200 40 L200 200"'));
  });
});
