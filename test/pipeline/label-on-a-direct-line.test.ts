import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutLabel, LayoutModel, PathSegment } from '../../src/index.js';
import { isDirect, lineAngle, produceLinkLabels } from '../../src/layout/link-labels.js';
import { segmentRect } from '../../src/score/geometry.js';
import { flatCells } from '../render/drawio-cells.js';
import { bench } from '../layout/link-label-fixture.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture ticket 16: a label on a direct line lies on it, centred, text at the line's angle. */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-label-on-a-direct-line-runs-along-it.yaml', import.meta.url), 'utf8');
const segment = (fx: number, fy: number, tx: number, ty: number): PathSegment =>
  ({ from: { x: fx, y: fy }, to: { x: tx, y: ty }, owner: { kind: 'link', id: 'x' } });

let model: LayoutModel;
beforeAll(async () => {
  model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
}, 60000);

const labelled = (): { label: LayoutLabel; line: PathSegment }[] => model.labels.filter(label => label.role === 'link').map(label => {
  const link = model.links.find(item => label.owner.kind === 'link' && item.id === label.owner.id)!;
  return { label, line: link.path!.segments[label.support!.kind === 'link-segment' ? label.support!.segment : 0]! };
});

describe('lineAngle', () => {
  it('normalises the heading to (-90, 90] whichever way the line runs', () => {
    expect(lineAngle(segment(0, 0, 10, 10))).toBeCloseTo(45, 9);
    expect(lineAngle(segment(10, 10, 0, 0))).toBeCloseTo(45, 9);
    expect(lineAngle(segment(0, 10, 10, 0))).toBeCloseTo(-45, 9);
    expect(lineAngle(segment(10, 0, 0, 10))).toBeCloseTo(-45, 9);
    expect(lineAngle(segment(0, 0, 1, 100))).toBeGreaterThan(80);
    expect(lineAngle(segment(0, 0, -1, 100))).toBeLessThan(-80);
    for (let degrees = -180; degrees <= 180; degrees += 7) {
      const radians = degrees * Math.PI / 180;
      const angle = lineAngle(segment(0, 0, Math.cos(radians) * 50, Math.sin(radians) * 50));
      expect(angle).toBeGreaterThan(-90);
      expect(angle).toBeLessThanOrEqual(90);
    }
  });
});

describe('a label on a direct line', () => {
  it('is placed for every signal link, at the angle of its line', () => {
    const items = labelled();
    expect(items).toHaveLength(4);
    for (const { label, line } of items) {
      expect(label.omitted).toBeUndefined();
      expect(isDirect(line)).toBe(true);
      expect(label.textRotation).toBeCloseTo(lineAngle(line), 9);
    }
    // Shallow and steep, leaning both ways.
    const angles = items.map(item => item.label.textRotation!);
    expect(angles.some(a => a < -60)).toBe(true);
    expect(angles.some(a => a > 60)).toBe(true);
    expect(angles.some(a => a > 0 && a < 45)).toBe(true);
    expect(angles.some(a => a < 0 && a > -45)).toBe(true);
  });

  it('is centred on its line', () => {
    for (const { label, line } of labelled()) {
      const box = label.bounds!, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
      const distance = Math.abs((cx - line.from.x) * dy - (cy - line.from.y) * dx) / Math.hypot(dx, dy);
      expect(distance).toBeLessThan(1e-6);
      const along = ((cx - line.from.x) * dx + (cy - line.from.y) * dy) / (dx * dx + dy * dy);
      expect(along).toBeGreaterThan(0);
      expect(along).toBeLessThan(1);
    }
  });

  it('reserves the rotated footprint: no label overlaps a node, a pill or another label', () => {
    const overlaps = (a: NonNullable<LayoutLabel['bounds']>, b: NonNullable<LayoutLabel['bounds']>): boolean =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const items = labelled();
    for (const [i, { label }] of items.entries()) {
      for (const node of Object.values(model.nodes)) {
        expect(overlaps(label.bounds!, node.bounds!)).toBe(false);
        for (const port of node.ports) if (port.pill) expect(overlaps(label.bounds!, port.pill.bounds)).toBe(false);
      }
      for (const other of items.slice(i + 1)) expect(overlaps(label.bounds!, other.label.bounds!)).toBe(false);
    }
  });

  it('removes no link and fails no gate', () => {
    expect(model.removedLinks ?? []).toEqual([]);
    const { gates } = score(model).snapshot;
    for (const gate of Object.values(gates)) expect(gate.passed).toBe(true);
  });

  it('is drawn rotated in the SVG with the line cut away under the text', () => {
    const svg = render(model);
    for (const { label } of labelled()) {
      const box = label.bounds!, angle = label.textRotation!;
      expect(svg).toContain(`rotate(${angle} ${box.x + box.width / 2} ${box.y + box.height / 2})`);
    }
    // One rotated cutout per label, turned to the same angle.
    expect([...svg.matchAll(/<rect class="pg-mask-hide"[^>]*transform="rotate\(/g)]).toHaveLength(4);
  });

  it('is a rotated edge-label cell in draw.io, with a backdrop that hides the line', () => {
    const file = drawio(model);
    for (const { label } of labelled()) {
      const cell = flatCells(file).split('<mxCell ').find(chunk => chunk.includes(`value="${label.text}"`) && chunk.includes('edgeLabel'))
        ?.match(/style="([^"]*)"/)?.[1];
      expect(cell, label.text).toBeDefined();
      const rotation = Number(/rotation=([-0-9.e]+)/.exec(cell!)?.[1]);
      expect(rotation).toBeCloseTo(label.textRotation!, 6);
      expect(cell!).toMatch(/labelBackgroundColor=(?!none)/);
    }
  });
});

describe('a direct line too short for its label', () => {
  it('keeps the beside box, which is no on-line label, and never lets the text cross its line', () => {
    // A 21 px stub at 30 degrees under a 40 px label: the text rises across the line, more than the gap.
    const to = { x: 100 + 21 * Math.cos(Math.PI / 6), y: 100 + 21 * Math.sin(Math.PI / 6) };
    const stub = bench(
      [{ id: 'a', bounds: { x: 60, y: 60, width: 40, height: 40 } }, { id: 'b', bounds: { x: to.x, y: to.y, width: 40, height: 40 } }],
      [{ id: 'link-1', from: 'a', to: 'b', points: [{ x: 100, y: 100 }, to], label: 'Heartbeat1', sides: ['right', 'left'] }]);
    produceLinkLabels(stub);
    const label = stub.labels.find(item => item.role === 'link')!;
    expect(label.onLine).toBeUndefined();
    if (!label.omitted) expect(segmentRect(stub.links[0]!.path!.segments[0]!, label.bounds!)).toBe(false);
  });
});
