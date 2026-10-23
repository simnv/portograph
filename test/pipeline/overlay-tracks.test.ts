import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point } from '../../src/index.js';
import { overlayBasePath, overlayPath, OVERLAY_PILL_CLEARANCE } from '../../src/layout/overlay-paths.js';
import { sharedTrackPairs } from '../../src/layout/overlay-tracks.js';
import { nestOverlayPorts } from '../../src/layout/overlay-nest.js';
import { pathBends } from '../../src/layout/objective.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import { anonymousDotRadius, DEFAULT_STROKE_WIDTHS, overlayPortClearance, overlayTrackPitch } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 23: two overlay detours never share a track, and every turn steps out of its port face by the overlay port
 * clearance (the bare-end dot plus a visible gap). The user's report: on
 * `a-label-beside-a-detour-in-a-group-padding-keeps-clear-of-the-border` the detours out of A ran on one riser and one run over the row
 * and read as one line from A to D, 4 px from the faces they passed.
 */
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const pointsOf = (segments: readonly { from: Point; to: Point }[]): Point[] => [segments[0]!.from, ...segments.map(segment => segment.to)];
const overlays = (model: LayoutModel) => model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.path !== undefined);

/** The test's own reading of "one track": two axis-aligned runs of two links on one line (within 1 px) whose spans overlap or meet. */
function collinear(model: LayoutModel): string[] {
  const runs = overlays(model).flatMap(link => link.path!.segments.map(segment => ({ link: link.id, ...segment })))
    .filter(run => Math.abs(run.from.x - run.to.x) < 1e-9 !== (Math.abs(run.from.y - run.to.y) < 1e-9));
  const found: string[] = [];
  for (const [i, one] of runs.entries()) for (const two of runs.slice(i + 1)) {
    if (one.link === two.link) continue;
    const vertical = Math.abs(one.from.x - one.to.x) < 1e-9;
    if (vertical !== Math.abs(two.from.x - two.to.x) < 1e-9) continue;
    const at = (run: typeof one) => vertical ? run.from.x : run.from.y;
    const span = (run: typeof one) => vertical ? [Math.min(run.from.y, run.to.y), Math.max(run.from.y, run.to.y)] : [Math.min(run.from.x, run.to.x), Math.max(run.from.x, run.to.x)];
    const [a0, a1] = span(one), [b0, b1] = span(two);
    if (Math.abs(at(one) - at(two)) < 1 && Math.max(a0!, b0!) <= Math.min(a1!, b1!) + 1) found.push(`${one.link}/${two.link}`);
  }
  return found;
}

describe('two overlay detours never share a track (architecture-2 ticket 23)', () => {
  it('the overlay port clearance clears the bare-end dot by the visible gap: 7.75 px at the default stroke', () => {
    expect(OVERLAY_PILL_CLEARANCE).toBe(7.75);
    expect(overlayPortClearance(DEFAULT_STROKE_WIDTHS.path)).toBe(anonymousDotRadius(DEFAULT_STROKE_WIDTHS.path) + 4);
    expect(overlayPortClearance(3)).toBe(8.5);
    expect(overlayTrackPitch(1.5, 1.5)).toBe(5.5);
    expect(overlayTrackPitch(1.5, 3)).toBe(6.25);
  });

  for (const name of ['two-overlay-detours-never-share-a-track', 'a-label-beside-a-detour-in-a-group-padding-keeps-clear-of-the-border']) {
    it(`no two overlay runs share a track, and every middle run keeps the clearance from every body: ${name}`, async () => {
      const model = await run(fixture(name));
      const bent = overlays(model).filter(link => link.path!.segments.length > 1);
      expect(bent.length).toBeGreaterThanOrEqual(3);
      expect(collinear(model)).toEqual([]);
      expect(score(model).snapshot.counters.overlayTrackShares).toBeUndefined();
      for (const link of bent) {
        const segments = link.path!.segments;
        // The turn out of each face is one clearance or more beyond it (a separated track stands further out).
        for (const end of [segments[0]!, segments.at(-1)!]) {
          expect(Math.hypot(end.to.x - end.from.x, end.to.y - end.from.y)).toBeGreaterThanOrEqual(OVERLAY_PILL_CLEARANCE - 1e-9);
        }
        // A middle run passes no node body nearer than the clearance: not its own ends, not a column of foreign ports.
        for (const segment of segments.slice(1, -1)) {
          for (const node of Object.values(model.nodes)) {
            const box = node.bounds!;
            const dx = Math.max(box.x - Math.max(segment.from.x, segment.to.x), Math.min(segment.from.x, segment.to.x) - (box.x + box.width), 0);
            const dy = Math.max(box.y - Math.max(segment.from.y, segment.to.y), Math.min(segment.from.y, segment.to.y) - (box.y + box.height), 0);
            expect(Math.hypot(dx, dy), `${link.id} by ${node.id}`).toBeGreaterThanOrEqual(OVERLAY_PILL_CLEARANCE - 1e-9);
          }
        }
        // Bends first: a separated path has the bends of the per-link rule.
        expect(pathBends(link)).toBe(pathBends({ ...link, path: overlayBasePath(model, link) }));
      }
    }, 120000);
  }

  it('the user report: the detours out of A no longer read as one line from A to D', async () => {
    const model = await run(fixture('a-label-beside-a-detour-in-a-group-padding-keeps-clear-of-the-border'));
    const byEnds = (from: string, to: string) => overlays(model).find(link => link.attachments!.from.node === from && link.attachments!.to.node === to)!;
    const toC = pointsOf(byEnds('a', 'c').path!.segments), toD = pointsOf(byEnds('a', 'd').path!.segments);
    // Before ticket 23 both left A, rose on one riser 4 px from A's face and ran over the row on one line. Now each keeps its bends
    // (out of A, along the row, into the far end) and no run of one lies on a run of the other.
    expect(toC).toHaveLength(6);
    expect(toD).toHaveLength(6);
    const pitch = overlayTrackPitch(DEFAULT_STROKE_WIDTHS.path, DEFAULT_STROKE_WIDTHS.path);
    expect(sharedTrackPairs([{ points: toC, strokeWidth: 1.5 }, { points: toD, strokeWidth: 1.5 }])).toEqual([]);
    // The two along-row runs stand at least a track pitch apart, and the risers out of A as well.
    expect(Math.abs(toC[2]!.y - toD[2]!.y)).toBeGreaterThanOrEqual(pitch - 1e-9);
    expect(Math.abs(toC[1]!.x - toD[1]!.x) >= pitch - 1e-9 || Math.sign(toC[2]!.y - toC[1]!.y) !== Math.sign(toD[2]!.y - toD[1]!.y)).toBe(true);
  }, 120000);

  it('does not depend on the order of links (R3)', async () => {
    const source = fixture('two-overlay-detours-never-share-a-track');
    const [head, body] = source.split('links:\n');
    const reversed = `${head}links:\n${body!.trimEnd().split('\n').reverse().join('\n')}\n`;
    const drawn = (model: LayoutModel) => overlays(model).map(link => `${link.attachments!.from.node}-${link.attachments!.to.node} ${JSON.stringify(pointsOf(link.path!.segments))}`).sort();
    const one = await run(source), two = await run(reversed);
    expect(drawn(two)).toEqual(drawn(one));
  }, 120000);

  it('does not depend on the order of the nodes and groups of the model (R3)', async () => {
    for (const name of ['two-overlay-detours-never-share-a-track', 'a-label-beside-a-detour-in-a-group-padding-keeps-clear-of-the-border']) {
      const model = await run(fixture(name));
      const reversed = structuredClone(model);
      reversed.nodes = Object.fromEntries(Object.entries(reversed.nodes).reverse());
      reversed.groups = Object.fromEntries(Object.entries(reversed.groups).reverse());
      for (const link of overlays(model)) {
        expect(overlayPath(reversed, reversed.links.find(item => item.id === link.id)!).segments).toEqual(link.path!.segments);
      }
      // The nesting rule gives one answer in either order.
      expect(nestOverlayPorts(reversed)).toEqual(nestOverlayPorts(structuredClone(model)));
    }
  }, 120000);

  it('nests the overlay ports of a face, and never moves an authored port (R3)', async () => {
    const model = await run(fixture('a-label-beside-a-detour-in-a-group-padding-keeps-clear-of-the-border'));
    const portOf = (copy: LayoutModel, id: string) => {
      const end = copy.links.find(link => link.id === id)!.attachments!.to;
      return copy.nodes.d!.ports.find(port => port.ref.ordinal === end.ordinal && port.ref.name === end.name)!;
    };
    const unnest = (copy: LayoutModel): void => {
      const one = portOf(copy, 'link-3'), two = portOf(copy, 'link-5');
      [one.anchor, two.anchor, one.engineOrder, two.engineOrder] = [two.anchor!, one.anchor!, two.engineOrder!, one.engineOrder!];
    };
    // a-d (link-3) and b-d (link-5) put back in each other's slot on `d`: the rule trades them again, and the bottom detours nest.
    const loose = structuredClone(model);
    unnest(loose);
    expect(nestOverlayPorts(loose).length).toBe(2);
    expect(portOf(loose, 'link-3').anchor).toEqual(portOf(model, 'link-3').anchor);
    // An authored order is the author's: the rule does not move that port.
    const authored = structuredClone(model);
    unnest(authored);
    portOf(authored, 'link-3').authorOrder = 1;
    expect(nestOverlayPorts(authored)).toEqual([]);
  }, 120000);

  it('the validator and the scorer read the separation: a detour put back on the shared track is refused and counted (R5)', async () => {
    const model = await run(fixture('two-overlay-detours-never-share-a-track'));
    expect(() => validateRoutedPaths(model)).not.toThrow();
    const moved = overlays(model).find(link => JSON.stringify(link.path!.segments) !== JSON.stringify(overlayBasePath(model, link).segments));
    expect(moved).toBeDefined();
    expect(overlayPath(model, moved!).segments).toEqual(moved!.path!.segments);
    const forged = structuredClone(model);
    const link = forged.links.find(item => item.id === moved!.id)!;
    link.path = overlayBasePath(forged, link);
    expect(() => validateRoutedPaths(forged)).toThrow(/Overlay path on/);
    expect(score(forged).snapshot.counters.overlayTrackShares).toBeGreaterThan(0);
  }, 120000);
});

describe('sharedTrackPairs, the one reading of a shared track', () => {
  const path = (points: Point[], strokeWidth = 1.5) => ({ points, strokeWidth });
  it('counts runs on one line that overlap or meet within the pitch, and not runs a pitch apart', () => {
    const over = path([{ x: 0, y: 50 }, { x: 0, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 50 }]);
    // On the same line, overlapping.
    expect(sharedTrackPairs([over, path([{ x: 50, y: 60 }, { x: 50, y: 10 }, { x: 150, y: 10 }, { x: 150, y: 60 }])])).toEqual([[[0, 1], [1, 1]]]);
    // End to end: one run ends at x 100 and the other starts 5 px on (within 5.5 px), and the two risers there stand 5 px apart.
    expect(sharedTrackPairs([over, path([{ x: 105, y: 60 }, { x: 105, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 60 }])])).toEqual([[[0, 1], [1, 1]], [[0, 2], [1, 0]]]);
    // 6 px on: two lines.
    expect(sharedTrackPairs([over, path([{ x: 106, y: 60 }, { x: 106, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 60 }])])).toEqual([]);
    // One track pitch above: two tracks.
    expect(sharedTrackPairs([over, path([{ x: 50, y: 60 }, { x: 50, y: 4.5 }, { x: 150, y: 4.5 }, { x: 150, y: 60 }])])).toEqual([]);
    // Nearer than the pitch: one track. A wider stroke widens the pitch.
    expect(sharedTrackPairs([over, path([{ x: 50, y: 60 }, { x: 50, y: 5 }, { x: 150, y: 5 }, { x: 150, y: 60 }])])).toHaveLength(1);
    expect(sharedTrackPairs([over, path([{ x: 50, y: 60 }, { x: 50, y: 4.5 }, { x: 150, y: 4.5 }, { x: 150, y: 60 }], 3)])).toHaveLength(1);
  });

  it('leaves out a fork out of one port, and counts two paths that leave the fork the same way', () => {
    // One stub, then the two turn the opposite ways: a branch.
    const one = path([{ x: 0, y: 0 }, { x: 0, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 0 }]);
    const two = path([{ x: 0, y: 0 }, { x: 0, y: -20 }, { x: -40, y: -20 }, { x: -40, y: 0 }]);
    expect(sharedTrackPairs([one, two])).toEqual([]);
    // Stubs of two lengths out of one port: drawn once.
    expect(sharedTrackPairs([path([{ x: 0, y: 0 }, { x: 0, y: -20 }, { x: 40, y: -20 }]), path([{ x: 0, y: 0 }, { x: 0, y: -26 }, { x: -40, y: -26 }])])).toEqual([]);
    // The same way after the fork: one line.
    expect(sharedTrackPairs([one, path([{ x: 0, y: 0 }, { x: 0, y: -20 }, { x: 80, y: -20 }, { x: 80, y: 0 }])])).toEqual([[[0, 1], [1, 1]]]);
    // A diagonal is no run.
    expect(sharedTrackPairs([path([{ x: 0, y: 0 }, { x: 10, y: 10 }]), path([{ x: 0, y: 0 }, { x: 10, y: 10 }])])).toEqual([]);
  });
});
