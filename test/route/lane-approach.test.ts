import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point, Rect } from '../../src/model/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { GROUP_LABEL_GEOMETRY } from '../../src/layout/bands.js';
import { pendingStemObstacles, planRoute } from '../../src/route/plan.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

/**
 * Ticket 18: a lane approach is reserved against the batches routed before it, and a pending stem
 * also reserves the room its checkpoint is reached through.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const throughBands = async (name: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture(name)))))))));
const HELD = 'a-held-lane-stays-on-its-frames-side-of-a-foreign-frame';
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

  it('publishes the held-lane sheet with no link removed and every gate passing', async () => {
    const model = await layout(parse(fixture(HELD)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.removedLinks ?? []).toEqual([]);
    const report = score(model).snapshot;
    expect(Object.entries(report.gates).flatMap(([gate, item]) => item.violations.map(violation => [gate, violation.code]))).toEqual([]);
  }, 120000);
});

describe('a pending stem reserves the room beyond its checkpoint (ticket 18)', () => {
  it('reaches one router stem past the checkpoint where nothing else stands', async () => {
    const model = await throughBands(HELD);
    const plan = planRoute(model);
    const held = linkOf(model, 'wg', 'l1');
    const stem = plan.stems.find(item => item.link === held && item.node === 'l1')!;
    const { from, to } = stem.segment;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const far = { x: to.x + (GROUP_LABEL_GEOMETRY.routerStem - 1) * (to.x - from.x) / span,
      y: to.y + (GROUP_LABEL_GEOMETRY.routerStem - 1) * (to.y - from.y) / span };
    expect(inside(stem.bounds, far)).toBe(true);
  });

  it('stops short of a facing stem, so each checkpoint stays outside the other link’s cover', async () => {
    const model = await throughBands('a-pinned-path-between-two-fans');
    const plan = planRoute(model);
    const facing = plan.stems.filter(item => ['spur', 'mate'].includes(item.node));
    expect(facing.map(item => item.node).sort()).toEqual(['mate', 'spur']);
    const [a, b] = facing as [typeof facing[0], typeof facing[0]];
    expect(inside(a.bounds, b.segment.to)).toBe(false);
    expect(inside(b.bounds, a.segment.to)).toBe(false);
    // Each still reaches past its own checkpoint, beyond the clearance a stem cover keeps there.
    for (const item of facing) {
      const { from, to } = item.segment;
      const horizontal = Math.abs(to.y - from.y) < 1e-9, half = (horizontal ? item.bounds.height : item.bounds.width) / 2;
      const past = { x: to.x + (half + 1) * Math.sign(to.x - from.x), y: to.y + (half + 1) * Math.sign(to.y - from.y) };
      expect(inside(item.bounds, past)).toBe(true);
    }
  });
});
