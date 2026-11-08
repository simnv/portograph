import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point } from '../../src/index.js';
import { EPS as PLANAR_EPS } from '../../src/geometry/planar.js';
import { chordBuilt, pathEnd, visibleEnd } from '../../src/layout/path-end.js';
import { findPort } from '../../src/layout/row-paths.js';
import { linkIds } from '../../src/model/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { flatCells, inFile } from './drawio-cells.js';

/**
 * The path-end rule by producer (D-Q7, audit T-05): a stem-built path ends on the anchor, a
 * chord-built path on the outward face, and every renderer pins and marks an end at `visibleEnd`.
 */

const source = (name: string): string => readFileSync(new URL(`../../goldens/${name.includes('/') ? name : `synthetic/${name}`}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> =>
  layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** The fixture with an approach: link-1 meets the trunk pill from above (ticket 15, phase 6). */
const APPROACH = 'a-port-with-two-peers-in-two-directions-takes-a-side-per-link';
/**
 * One sheet per producer family: approach and orthogonal, bundle, routed chords on named ports (the golden's provider links) and on
 * anonymous ports (fan and direct families), overlay.
 */
const SHEETS = [
  APPROACH,
  './m1-sip-edge',
  'a-bundle-of-named-ports-agrees-at-both-ends',
  'a-hub-tiers-fan-draws-straight-and-crosses-itself',
  'a-label-on-a-direct-line-runs-along-it',
  'a-fan-spreads-its-ports-so-its-chords-hold-clearance',
  'drawio-constructs',
];

interface Cell { id: string; parent?: string; source?: string; target?: string; style: Record<string, string>; box: Record<string, number>; points: Point[]; ends: Record<string, Point> }

function cells(xml: string): Map<string, Cell> {
  const found = new Map<string, Cell>();
  for (const match of flatCells(xml).matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    const attributes: Record<string, string> = {};
    for (const pair of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[pair[1]!] = pair[2]!;
    const body = match[3] ?? '';
    const box: Record<string, number> = {};
    for (const pair of (/<mxGeometry\b([^>]*)/.exec(body)?.[1] ?? '').matchAll(/(x|y|width|height)="([^"]*)"/g)) box[pair[1]!] = Number(pair[2]);
    const style: Record<string, string> = {};
    for (const part of (attributes['style'] ?? '').split(';')) if (part.includes('=')) style[part.slice(0, part.indexOf('='))] = part.slice(part.indexOf('=') + 1);
    const points = [...(/<Array as="points">([\s\S]*?)<\/Array>/.exec(body)?.[1] ?? '').matchAll(/<mxPoint x="([^"]*)" y="([^"]*)"\/>/g)]
      .map(point => ({ x: Number(point[1]), y: Number(point[2]) }));
    const ends: Record<string, Point> = {};
    for (const point of body.matchAll(/<mxPoint x="([^"]*)" y="([^"]*)" as="(sourcePoint|targetPoint)"\/>/g)) ends[point[3]!] = { x: Number(point[1]), y: Number(point[2]) };
    const id = attributes['id']!;
    found.set(id, { id, style, box, points, ends,
      ...(attributes['parent'] === undefined ? {} : { parent: attributes['parent'] }),
      ...(attributes['source'] === undefined ? {} : { source: attributes['source'] }),
      ...(attributes['target'] === undefined ? {} : { target: attributes['target'] }) });
  }
  return found;
}

/** A cell's box on the page: its geometry plus the corner of every container above it. */
function absolute(all: Map<string, Cell>, id: string): { x: number; y: number; width: number; height: number } {
  const cell = all.get(id)!;
  let x = cell.box['x'] ?? 0, y = cell.box['y'] ?? 0;
  for (let at = cell.parent === undefined ? undefined : all.get(cell.parent); at?.box['width'] !== undefined; at = at.parent === undefined ? undefined : all.get(at.parent)) {
    x += at.box['x'] ?? 0; y += at.box['y'] ?? 0;
  }
  return { x, y, width: cell.box['width'] ?? 0, height: cell.box['height'] ?? 0 };
}

/** The connectors of one link, in run order. */
function connectors(model: LayoutModel, all: Map<string, Cell>, link: LayoutLink): Cell[] {
  const base = `pg-link~${inFile(linkIds(model.document)[link.sourceIndex] ?? link.id).replace(/[%~]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`;
  const single = all.get(base);
  if (single) return [single];
  const runs: Cell[] = [];
  for (let index = 0; all.has(`${base}~${index}`); index++) runs.push(all.get(`${base}~${index}`)!);
  return runs;
}

/** Where draw.io puts a pinned end: the constraint fraction resolved against the terminal cell's page box. */
function drawnEnd(all: Map<string, Cell>, cell: Cell, end: 'from' | 'to'): Point | undefined {
  const terminal = end === 'from' ? cell.source : cell.target, key = end === 'from' ? 'exit' : 'entry';
  if (terminal === undefined) return undefined;
  const box = absolute(all, terminal);
  return { x: box.x + Number(cell.style[`${key}X`]) * box.width, y: box.y + Number(cell.style[`${key}Y`]) * box.height };
}

const shifted = (model: LayoutModel, point: Point): Point => ({ x: point.x - model.canvas!.x, y: point.y - model.canvas!.y });
const gap = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const ends = (link: LayoutLink): Record<'from' | 'to', { at: Point; next: Point }> => {
  const segments = link.path!.segments;
  return { from: { at: segments[0]!.from, next: segments[0]!.to }, to: { at: segments.at(-1)!.to, next: segments.at(-1)!.from } };
};

describe('the path-end rule by producer (D-Q7)', () => {
  it.each(SHEETS)('%s: each path ends at pathEnd, and each drawn end at visibleEnd on the same stem', async name => {
    const model = await run(name);
    const all = cells(drawio(model));
    const svg = render(model);
    let ends_ = 0;
    for (const link of model.links) {
      if (!link.path?.segments.length || link.meshBus !== undefined || link.technique === 'stub') continue;
      const runs = connectors(model, all, link);
      expect(runs.length, link.id).toBeGreaterThan(0);
      for (const end of ['from', 'to'] as const) {
        const { at, next } = ends(link)[end];
        // The producer rule: the published path end is the one point `pathEnd` names.
        expect(gap(at, pathEnd(model, link, end)!), `${link.id}:${end}`).toBeLessThanOrEqual(PLANAR_EPS);
        const seen = visibleEnd(model, link, end)!;
        // The visible end is the path end, or a point on the path's own stem: across-stem offset at most PLANAR_EPS.
        const along = { x: next.x - at.x, y: next.y - at.y }, length = Math.hypot(along.x, along.y);
        const across = Math.abs((seen.x - at.x) * along.y - (seen.y - at.y) * along.x) / length;
        expect(across, `${link.id}:${end} across the stem`).toBeLessThanOrEqual(PLANAR_EPS);
        ends_ += 1;
        // draw.io pins the end at the visible end.
        const cell = end === 'from' ? runs[0]! : runs.at(-1)!;
        const drawn = drawnEnd(all, cell, end);
        if (drawn !== undefined) expect(gap(drawn, shifted(model, seen)), `${link.id}:${end} in draw.io`).toBeLessThanOrEqual(PLANAR_EPS);
      }
      // The SVG puts an overlay endpoint mark at the visible end.
      for (const mark of svg.matchAll(new RegExp(`<circle class="overlay-endpoint[^"]*" data-owner="${link.id}" data-end="(from|to)" cx="([^"]*)" cy="([^"]*)"`, 'g'))) {
        const seen = visibleEnd(model, link, mark[1] as 'from' | 'to')!;
        expect(gap({ x: Number(mark[2]), y: Number(mark[3]) }, seen), `${link.id} mark`).toBeLessThanOrEqual(PLANAR_EPS);
      }
    }
    expect(ends_).toBeGreaterThan(0);
  }, 120000);

  it('covers both producer families and the approach over the sheets', async () => {
    const kinds = new Set<string>();
    for (const name of SHEETS) {
      const model = await run(name);
      for (const link of model.links) {
        if (!link.path?.segments.length || link.meshBus !== undefined) continue;
        for (const end of ['from', 'to'] as const) {
          const port = findPort(model, link.attachments![end]);
          if (port?.pill === undefined || port.ref.anonymous === true) continue;
          kinds.add(link.approach?.[end] !== undefined ? 'approach' : !chordBuilt(model, link) ? 'stem-built'
            : link.layer === 'overlay' ? 'overlay' : 'routed chord');
        }
      }
    }
    expect([...kinds].sort()).toEqual(['approach', 'overlay', 'routed chord', 'stem-built']);
  }, 240000);

  it('pins an approach end on the approach point, so draw.io draws the model path (M-5)', async () => {
    const model = await run(APPROACH);
    const link = model.links.find(item => item.approach !== undefined && item.path !== undefined)!;
    expect(link).toBeDefined();
    const all = cells(drawio(model));
    const runs = connectors(model, all, link);
    expect(runs).toHaveLength(1);
    const cell = runs[0]!;
    const drawn = [drawnEnd(all, cell, 'from') ?? cell.ends['sourcePoint']!, ...cell.points, drawnEnd(all, cell, 'to') ?? cell.ends['targetPoint']!];
    const segments = link.path!.segments;
    const model_ = [visibleEnd(model, link, 'from')!, ...segments.slice(0, -1).map(segment => segment.to), visibleEnd(model, link, 'to')!].map(point => shifted(model, point));
    expect(drawn).toHaveLength(model_.length);
    // Within the format grain (0.01 px) of the model; a real draw.io drawing adds only the crisp half pixel.
    for (const [index, point] of drawn.entries()) expect(gap(point, model_[index]!), `vertex ${index}`).toBeLessThanOrEqual(0.01);
    // The approach end is the model end itself, on the pill's tangential edge.
    const approached = link.approach!.to !== undefined ? 'to' : 'from';
    expect(gap(visibleEnd(model, link, approached)!, ends(link)[approached].at)).toBeLessThanOrEqual(PLANAR_EPS);
    // The route is square to the end, so the connector is square: no wrong-end fallback to `none`.
    expect(cell.style['edgeStyle']).toBe('orthogonalEdgeStyle');
  }, 60000);
});
