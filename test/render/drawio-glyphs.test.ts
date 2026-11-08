import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
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
import { flatCells } from './drawio-cells.js';

/**
 * Drawio-export ticket 10 (audit A1-03): every shape the exporter writes for a glyph has to paint a
 * visible area. `mxgraph.cisco19.cloud` is two contours 0.04 px apart and paints a hairline, so the
 * `cloud` glyph is draw.io's built-in `cloud` shape. The shape table is pinned from the file, and the
 * render-back check runs the draw.io CLI when `PORTOGRAPH_DRAWIO_CLI` names it (outside the gate).
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/drawio-every-glyph.yaml', import.meta.url), 'utf8');

async function pipeline(yaml: string): Promise<LayoutModel> {
  const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return linkLabels(await route(placedModel, { createAttempt: createAvoidAttempt }));
}

/** The style of every glyph cell (a node icon or a legend swatch that is not a plain rounded tile). */
function glyphStyles(xml: string): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  for (const match of flatCells(xml).matchAll(/<mxCell\b([^>]*?)(?:\/>|>)/g)) {
    const id = /\bid="([^"]*)"/.exec(match[1]!)?.[1] ?? '';
    if (!/^pg-(icon|legendSwatch)~/.test(id) || id.startsWith('pg-legendSwatch~line:')) continue;
    const style: Record<string, string> = {};
    for (const part of (/\bstyle="([^"]*)"/.exec(match[1]!)?.[1] ?? '').split(';')) {
      const at = part.indexOf('=');
      if (at > 0) style[part.slice(0, at)] = part.slice(at + 1);
    }
    if (style['shape'] !== undefined && style['shape'] !== 'image') found.set(id, style);
  }
  return found;
}

/** The shape name a glyph is drawn with: the badge frame plus its icon, or the silhouette itself. */
const shapeOf = (style: Record<string, string>): string =>
  style['prIcon'] === undefined ? style['shape']! : `${style['shape']}:${style['prIcon']}`;

/** The fraction of non-white pixels of an 8-bit RGB or RGBA PNG, in each box (pixels). */
function painted(png: Buffer, boxes: readonly { x: number; y: number; width: number; height: number }[]): number[] {
  const width = png.readUInt32BE(16), channels = png[25] === 6 ? 4 : 3;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels, rows: Buffer[] = [];
  for (let y = 0, at = 0; at < raw.length; y++, at += stride + 1) {
    const row = Buffer.from(raw.subarray(at + 1, at + 1 + stride)), filter = raw[at]!, above = rows[y - 1];
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0, up = above?.[i] ?? 0, corner = i >= channels ? above?.[i - channels] ?? 0 : 0;
      const guess = [0, left, up, (left + up) >> 1, (() => {
        const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
        return a <= b && a <= c ? left : b <= c ? up : corner;
      })()][filter]!;
      row[i] = (row[i]! + guess) & 255;
    }
    rows.push(row);
  }
  return boxes.map(box => {
    let ink = 0;
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const at = x * channels, row = rows[y]!;
        if (channels === 4 && row[at + 3]! < 128) continue;
        if (row[at]! < 200 || row[at + 1]! < 200 || row[at + 2]! < 200) ink++;
      }
    }
    return ink / (box.width * box.height);
  });
}

describe('draw.io glyph shapes', () => {
  it('writes the same bundled or built-in shape for a node icon and its legend swatch, and never the hairline cloud', async () => {
    const styles = glyphStyles(drawio(await pipeline(fixture)));
    const shapes = new Set([...styles.values()].map(shapeOf));
    // The shape table, pinned: three badges and one built-in silhouette.
    expect([...shapes].sort()).toEqual([
      'cloud',
      'mxgraph.cisco19.rect:l2_switch',
      'mxgraph.cisco19.rect:router',
      'mxgraph.cisco19.rect:server',
    ]);
    // A silhouette is filled with the glyph colour and has no frame; a badge strokes its glyph.
    for (const style of styles.values()) {
      if (style['prIcon'] === undefined) expect(style['strokeColor']).toBe('none');
    }
    for (const kind of ['icon', 'legendSwatch']) {
      const mine = [...styles].filter(([id]) => id.startsWith(`pg-${kind}~`)).map(([, style]) => shapeOf(style));
      expect(mine).toContain('cloud');
    }
  }, 60000);

  const cli = process.env['PORTOGRAPH_DRAWIO_CLI'];
  it.skipIf(!cli || !existsSync(cli))('paints a visible area for every glyph shape (render-back with the draw.io CLI)', async () => {
    const styles = glyphStyles(drawio(await pipeline(fixture)));
    const shapes = new Map([...styles.values()].map(style => [shapeOf(style), style] as const));
    const size = { width: 60, height: 36 }, scale = 4, step = 80;
    const body = [...shapes.values()].map((style, i) => {
      const badge = style['prIcon'] !== undefined;
      const probe = [`shape=${style['shape']}`, ...(badge ? [`prIcon=${style['prIcon']}`] : []), 'aspect=fixed',
        `fillColor=${badge ? '#ffffff' : '#000000'}`, `strokeColor=${badge ? '#000000' : 'none'}`].join(';');
      return `<mxCell id="g${i}" style="${probe}" vertex="1" parent="1"><mxGeometry x="${20 + i * step}" y="20" width="${size.width}" height="${size.height}" as="geometry"/></mxCell>`;
    }).join('');
    const dir = mkdtempSync(join(tmpdir(), 'pg-glyphs-'));
    try {
      writeFileSync(join(dir, 'probe.drawio'), `<mxfile><diagram id="d"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${body}</root></mxGraphModel></diagram></mxfile>`);
      execFileSync(cli!, ['-x', '-f', 'png', '-s', String(scale), '-b', '0', '-o', join(dir, 'probe.png'), join(dir, 'probe.drawio')], { stdio: 'ignore' });
      const png = readFileSync(join(dir, 'probe.png'));
      // draw.io crops the page to the content, so cell i starts at i * step px (times the scale) from the left.
      const boxes = [...shapes.keys()].map((_, i) => ({
        x: i * step * scale, y: 0, width: size.width * scale, height: png.readUInt32BE(20),
      }));
      const areas = painted(png, boxes);
      for (const [i, name] of [...shapes.keys()].entries()) {
        // Measured: the hairline stencil paints 0.029 of its box, the badges 0.16 to 0.27, the built-in cloud 0.57.
        expect(areas[i], `${name} paints ${areas[i]}`).toBeGreaterThan(0.1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
