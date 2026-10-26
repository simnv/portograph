import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point, Rect } from '../../src/index.js';
import { overlayEndpoint, OVERLAY_PILL_CLEARANCE } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 34 (user, 2026-10-25, on `drawio-constructs`: "purple line looks wrong, no margins"): an overlay line touches
 * a pill or a node body only at its own endpoint, and runs along no face. Two ports level on one side take a U whose run stands one
 * overlay port clearance beyond the pill tips; the segment that leaves its own pill is exempt from the clearance to that pill.
 */
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const pointsOf = (segments: readonly { from: Point; to: Point }[]): Point[] => [segments[0]!.from, ...segments.map(segment => segment.to)];
const TOLERANCE = 1e-6;

/** Every body and every drawn pill of the model, named: the shapes an overlay line may touch only at its own endpoint. */
function shapes(model: LayoutModel): { name: string; box: Rect }[] {
  return Object.entries(model.nodes).flatMap(([id, node]) => [
    ...(node.bounds ? [{ name: id, box: node.bounds }] : []),
    ...node.ports.filter(port => port.pill && port.ref.anonymous !== true).map(port => ({ name: `${id}.${port.ref.name}`, box: port.pill!.bounds })),
  ]);
}

/**
 * The test's own reading of "runs along a face": an axis-aligned segment that overlaps a shape's span along its own axis by more than
 * a hair and stands nearer than the overlay port clearance to it across that axis. The segment that leaves its own pill meets that
 * pill and its body only at its end point, so it overlaps neither span and needs no exemption here.
 */
function facesRidden(model: LayoutModel, points: readonly Point[]): string[] {
  const found: string[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1]!, to = points[index]!;
    const horizontal = Math.abs(from.y - to.y) < TOLERANCE, vertical = Math.abs(from.x - to.x) < TOLERANCE;
    if (horizontal === vertical) continue;
    for (const { name, box } of shapes(model)) {
      const [low, high, at] = horizontal ? [Math.min(from.x, to.x), Math.max(from.x, to.x), from.y] : [Math.min(from.y, to.y), Math.max(from.y, to.y), from.x];
      const [start, end, near, far] = horizontal ? [box.x, box.x + box.width, box.y, box.y + box.height] : [box.y, box.y + box.height, box.x, box.x + box.width];
      if (Math.min(high, end) - Math.max(low, start) <= TOLERANCE) continue;
      if (Math.max(near - at, at - far, 0) < OVERLAY_PILL_CLEARANCE - TOLERANCE) found.push(`segment ${index} along ${name}`);
    }
  }
  return found;
}

describe('an overlay line keeps the overlay port clearance from every face it runs along (architecture-2 ticket 34)', () => {
  for (const name of ['drawio-constructs', 'an-overlay-line-keeps-its-clearance-from-the-faces-it-runs-along']) {
    it(`two level ports on one top side take a U one clearance above the pill tips: ${name}`, async () => {
      const model = await run(fixture(name));
      const overlay = model.links.filter(link => link.layer === 'overlay' && link.path !== undefined);
      expect(overlay).toHaveLength(1);
      const link = overlay[0]!;
      const points = pointsOf(link.path!.segments);
      const ends = [link.attachments!.from, link.attachments!.to].map(ref => {
        const node = model.nodes[ref.node]!, port = node.ports.find(item => item.ref.name === ref.name)!;
        expect(port.side).toBe('top');
        return { face: overlayEndpoint(node, port)!, pill: port.pill!.bounds };
      });
      const [one, two] = ends as [typeof ends[0], typeof ends[0]];
      // The two faces are level: the old straight segment would run along both pill tips.
      expect(one.face.y).toBeCloseTo(two.face.y, 9);
      const above = one.face.y - OVERLAY_PILL_CLEARANCE;
      expect(points).toHaveLength(4);
      expect(points[0]).toEqual(one.face);
      expect(points[1]!.x).toBeCloseTo(one.face.x, 9);
      expect(points[1]!.y).toBeCloseTo(above, 9);
      expect(points[2]!.x).toBeCloseTo(two.face.x, 9);
      expect(points[2]!.y).toBeCloseTo(above, 9);
      expect(points[3]).toEqual(two.face);
      // No segment of any overlay path runs along a face, the own pills' included.
      for (const item of overlay) expect(facesRidden(model, pointsOf(item.path!.segments))).toEqual([]);
      const report = score(model).snapshot;
      expect(Object.entries(report.gates).filter(([, gate]) => !gate.passed).map(([id]) => id)).toEqual([]);
      expect(report.counts.overlay.bent).toBe(1);
      expect(report.counts.overlay.turns).toBe(2);
    });
  }

  it('the old straight segment ran along a foreign pill: the fixture still holds the case it tests', async () => {
    // `east.up` is a pill of a routed link between the two overlay ends, its tip level with theirs: the case the user called out.
    const model = await run(fixture('an-overlay-line-keeps-its-clearance-from-the-faces-it-runs-along'));
    const peer = (id: string) => model.nodes[id]!.ports.find(port => port.ref.name === 'peer')!.pill!.bounds;
    const foreign = model.nodes['east']!.ports.find(port => port.ref.name === 'up')!.pill!.bounds;
    const [west, east] = [peer('west'), peer('east')];
    expect(foreign.y).toBeCloseTo(west.y, 9);
    expect(foreign.x).toBeGreaterThan(west.x + west.width);
    expect(foreign.x + foreign.width).toBeLessThan(east.x);
  });
});
