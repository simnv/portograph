import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point, Rect } from '../../src/model/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { GROUP_LABEL_GEOMETRY } from '../../src/layout/bands.js';
import { pendingStemObstacles, planRoute } from '../../src/route/plan.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

/** Ticket 18: a lane approach is reserved against the batches routed before it. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const throughBands = async (name: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture(name)))))))));
const HELD = 'a-held-lane-stays-on-its-frames-side-of-a-foreign-frame';
const THREE = 'a-three-port-side-shares-the-room-beyond-its-stems';
const inside = (box: Rect, point: Point): boolean =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;
const linkOf = (model: LayoutModel, from: string, to: string): string =>
  model.links.find(link => link.attachments!.from.node === from && link.attachments!.to.node === to)!.id;

describe('a lane approach is reserved against the batches before its owner (ticket 18)', () => {
  it('covers the approach of a later link for an earlier batch, and not for its own', async () => {
    const model = await throughBands(HELD);
    const plan = planRoute(model);
    const held = linkOf(model, 'wg', 'l1');
    const approach = plan.approaches.findIndex(item => item.link === held);
    expect(approach).toBeGreaterThanOrEqual(0);
    // The approach runs one router stem from the lane terminal, on the lane's own line.
    const { from, to } = plan.approaches[approach]!.segment;
    expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeCloseTo(GROUP_LABEL_GEOMETRY.routerStem, 9);
    expect(inside(plan.approaches[approach]!.bounds, to)).toBe(true);
    // As stage 8 runs them: each batch is given the reservations of the links in the batches after it.
    const id = `approach:${approach}:${held}`;
    const at = plan.batches.findIndex(batch => batch.links.includes(held));
    expect(at).toBeGreaterThan(0);
    for (const [index, batch] of plan.batches.entries()) {
      const later = new Set(plan.batches.slice(index + 1).flatMap(item => item.links));
      expect(pendingStemObstacles(plan, batch, later).some(item => item.id === id)).toBe(index < at);
    }
  });

  // Every link is drawn. On the held-lane sheet the later link still runs along the earlier one's row
  // (G4): stage 8 opens a completed route's cover for a link that must cross it, and libavoid then
  // travels along it. That is open (ticket 18 comments), so only the removal is asserted here.
  it.each([HELD, THREE])('publishes %s with no link removed', async name => {
    const model = await layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.removedLinks ?? []).toEqual([]);
    expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
  }, 120000);
});

describe('an approach cover never covers the lane end of an earlier batch (ticket 18 review)', () => {
  // Nothing exempts an approach cover. That is sound only while no link of an earlier batch has its own
  // lane end, or its approach, inside it: bundle members whose lanes end side by side are the case to check.
  const sheets = ['a-bundle-of-four-ports-agrees-at-both-ends', 'a-bundle-rows-turn-near-when-the-far-end-enters-a-frame',
    'a-flank-link-across-a-neighbour-enters-a-bundle-envelope', 'a-right-flank-beside-a-bundle-into-a-canton', HELD, THREE];
  it.each(sheets)('%s', async name => {
    const plan = planRoute(await throughBands(name));
    const batchOf = new Map(plan.batches.flatMap((batch, index) => batch.links.map(link => [link, index] as const)));
    for (const cover of plan.approaches) for (const other of plan.approaches) {
      if ((batchOf.get(other.link) ?? -1) >= (batchOf.get(cover.link) ?? -1)) continue;
      expect([other.link, inside(cover.bounds, other.segment.from) || inside(cover.bounds, other.segment.to)]).toEqual([other.link, false]);
    }
  });
});
