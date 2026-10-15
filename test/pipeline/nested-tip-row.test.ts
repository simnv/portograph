import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { stemReach } from '../../src/layout/bands.js';
import { stemCache, stemPlan } from '../../src/layout/sides-two.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** One run clearance, the reach of a run's cover: how far a row may still touch the x-span of a tip's leg. */
const CLEARANCE = 11.5;
/**
 * The band the plan keeps free of a row either side of a foreign nested tip row whose column the row spans (spec O4, ticket 50):
 * k = 11.5 px. Ticket 31 kept 2k = 23 px, because a ROUTED link needs a pocket at its tip (the tip obstacle reaches 11.5 px past it
 * and a run keeps 11.5 px off an obstacle). A planned part's stem is claimed and its leg reserved, so no pocket is needed; and a row that
 * does not span the tip column keeps nothing, because the tip's leg is a reserved vertical and no longer a leg along the tip row.
 */
const BAND = CLEARANCE;
const spans = (row: { x0: number; x1: number }, tip: { x: number }): boolean => row.x0 < tip.x - 1e-6 && row.x1 > tip.x + 1e-6;
const FIXTURE = 'a-nested-tip-row-holds-no-allocated-row';

interface Row { link: string; y: number; x0: number; x1: number }
interface Tip { node: string; x: number; x0: number; x1: number; y: number; links: Set<string> }

/** Every allocated row (a horizontal run segment) of every gap, with the link that owns it. */
function allocatedRows(model: LayoutModel): Row[] {
  const found: Row[] = [];
  for (const run of allocateGapRuns(model)) {
    for (const { from, to } of run.segments) {
      if (Math.abs(from.y - to.y) < 1e-9 && Math.abs(from.x - to.x) > 1e-9) {
        found.push({ link: run.link, y: from.y, x0: Math.min(from.x, to.x), x1: Math.max(from.x, to.x) });
      }
    }
  }
  return found;
}

/** Every stem tip that lies deeper than the flat stem, with the links that leave its port. */
function nestedTips(model: LayoutModel): Tip[] {
  const cache = stemCache(), found: Tip[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    for (const port of node.ports) {
      if (!port.anchor || (port.side !== 'top' && port.side !== 'bottom')) continue;
      const depth = stemPlan(model, port, cache).depth;
      if (depth <= stemReach(model, node) + 1e-9) continue;
      const key = portId(port.ref);
      const links = new Set(model.links
        .filter(link => link.attachments && [link.attachments.from, link.attachments.to].some(ref => ref.node === id && portId(ref) === key))
        .map(link => link.id));
      // The leg along the tip row travels from the tip column to the far port of each link, past its lanes.
      const xs = [port.anchor.x, ...model.links.filter(link => links.has(link.id)).flatMap(link => {
        const far = [link.attachments!.from, link.attachments!.to].filter(ref => !(ref.node === id && portId(ref) === key));
        return [...far.map(ref => model.nodes[ref.node]!.ports.find(item => portId(item.ref) === portId(ref))?.anchor?.x ?? port.anchor!.x),
          ...model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id).map(lane => lane.x)];
      })];
      found.push({ node: id, x: port.anchor.x, x0: Math.min(...xs), x1: Math.max(...xs),
        y: port.anchor.y + (port.side === 'top' ? -depth : depth), links });
    }
  }
  return found;
}

it('keeps every allocated row one run clearance off every nested stem tip, and routes every link (ranked-groups ticket 31)', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(read(FIXTURE)))))))));
  const tips = nestedTips(model);
  expect(tips.length).toBeGreaterThanOrEqual(2);
  const found = allocatedRows(model);
  expect(found.length).toBeGreaterThan(0);
  for (const tip of tips) {
    for (const row of found) {
      if (tip.links.has(row.link) || !spans(row, tip)) continue;
      expect(Math.abs(row.y - tip.y), `${row.link} row at ${row.y} against the tip of ${tip.node} at ${tip.y}`).toBeGreaterThanOrEqual(BAND - 1e-6);
    }
  }
});

it('grows the gap for the row a nested tip band denies, allocates that row and keeps every path on the canvas (ranked-groups ticket 31)', async () => {
  // Through the published model. The near server nests three stems, and the tip band of the deepest one
  // spans the leg that runs along it. The one transit row of the last gap must seat above that band, so
  // the gap grows by the seat: a row left unseated routes free, next to the tip, or the router drops a link.
  // Read with every link authored orthogonal: Q108 (ticket 100) gives link-2 its chord once the fan spread has run, and a chord seats no row.
  const pipeline = bands(bundles(bars(centre(flanks(lanes(rows(await placed(orthogonalLinks(read(FIXTURE))))))))));
  const seated = allocatedRows(pipeline);
  expect(seated.length, 'the gap seats its row').toBeGreaterThan(0);
  const routed = await layout(parse(orthogonalLinks(read(FIXTURE))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(routed.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN').map(item => item.message))
    .toEqual([expect.stringMatching(/The tier gap above tier 2 grew [\d.]+ px to hold the rows of its parts/)]);
  expect(routed.removedLinks ?? []).toEqual([]);
  // Each published path runs along its allocated row, not along a row the router found.
  for (const row of seated) {
    const path = routed.links.find(link => link.id === row.link)!.path!.segments;
    expect(path.some(segment => Math.abs(segment.from.y - row.y) < 1e-6 && Math.abs(segment.to.y - row.y) < 1e-6
      && Math.min(segment.from.x, segment.to.x) <= row.x0 + 1e-6 && Math.max(segment.from.x, segment.to.x) >= row.x1 - 1e-6), `${row.link} runs along its row`).toBe(true);
  }
  // In the published model each allocated row stands a tip band off every foreign nested tip row where it
  // passes the tip column. (A row the router finds for itself is not the rule's to place.)
  const cover = nestedTips(routed);
  expect(cover.length).toBeGreaterThanOrEqual(2);
  for (const row of seated) {
    for (const tip of cover) {
      if (tip.links.has(row.link) || !spans(row, tip)) continue;
      expect(Math.abs(row.y - tip.y), `${row.link} row at ${row.y} against the tip of ${tip.node} at ${tip.y}`).toBeGreaterThanOrEqual(BAND - 1e-6);
    }
  }
  // No path leaves the canvas.
  const canvas = routed.canvas!;
  for (const link of routed.links) {
    for (const segment of link.path?.segments ?? []) {
      for (const point of [segment.from, segment.to]) {
        expect(point.x, `${link.id} x`).toBeGreaterThanOrEqual(canvas.x);
        expect(point.x, `${link.id} x`).toBeLessThanOrEqual(canvas.x + canvas.width);
        expect(point.y, `${link.id} y`).toBeGreaterThanOrEqual(canvas.y);
        expect(point.y, `${link.id} y`).toBeLessThanOrEqual(canvas.y + canvas.height);
      }
    }
  }
}, 120000);
