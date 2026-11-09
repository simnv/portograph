import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { score } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows } from '../../src/internal.js';
import { findPort } from '../../src/layout/row-paths.js';
import { segmentDistance } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';
import { withoutJointOrder } from '../layout/joint-off.js';

const fixture = withoutJointOrder(readFileSync(new URL('../../goldens/synthetic/a-straight-gap-needs-no-router.yaml', import.meta.url), 'utf8'));

/**
 * Stress-test reproducer. `m2 → l1` is one straight run between two
 * port anchors on one x, and the two links out of `h1` cross it at the 15 px depth every stem turns
 * at. One of those crossings is routed first and covers the reserved approach of `m2 → l1`;
 * libavoid cannot reach the checkpoint, drops it and answers with the two node centres. Nothing in
 * that gap is the router's to choose, so stage 8 claims it.
 */
it('stitches a straight gap between two reserved endpoints without asking the router', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  const plan = planRoute(before);
  const claimed = plan.links.find(item => item.link === 'link-3')!;
  // Ticket 50: the run is a planned drop, reserved tip to tip between the two claimed stems, where it was one claimed straight piece.
  expect(claimed.pieces.map(piece => piece.kind)).toEqual(['straight', 'allocated', 'straight']);
  expect(claimed.connectors).toEqual([]);
  // The two crossing links are planned rows now (312.25 and 300.75), so the router is asked for nothing: it was asked for both.
  expect(plan.batches.flatMap(batch => batch.links)).toEqual([]);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  const link = model.links.find(item => item.id === 'link-3')!;
  const from = findPort(model, link.attachments!.from)!.anchor!;
  const to = findPort(model, link.attachments!.to)!.anchor!;
  // One segment, from the reserved endpoint it was asked to start at to the one it was asked to
  // end at, on one x — the geometry libavoid replaced with a diagonal between the two node centres.
  expect(link.path!.segments).toEqual([{ from: { ...from }, to: { ...to }, owner: { kind: 'link', id: 'link-3' } }]);
  expect(from.x).toBe(to.x);
  expect(link.path!.fixed).toBe(false);

  // The crossing really happens, and it is the one the router chose for the other link.
  const crossing = model.links.find(item => item.id === 'link-1')!.path!.segments
    .filter(segment => segment.from.y === segment.to.y
      && Math.min(segment.from.x, segment.to.x) < from.x && Math.max(segment.from.x, segment.to.x) > from.x);
  expect(crossing).toHaveLength(1);

  // The diagram is produced and every gate passes. (Main left `link-1` following the `hub` group edge, G6 `segment-group-edge`, which
  // no reservation on that side answered; the plan reserves link-1's row 312.25 clear of it, spec O5.) The crossing pair of links that
  // shared one corridor no longer runs along itself either: rule 1 nests those two stems (stress ticket 08).
  const report = score(model).snapshot;
  expect(Number.isFinite(report.Q)).toBe(true);
  expect(Object.entries(report.gates).flatMap(([id, gate]) => gate.violations.map(item => [id, item.code, item.elements]))).toEqual([]);
}, 60000);

/**
 * The same claim, refused. Three links meet at `b.p`, so each one's remaining gap starts at the
 * terminal of the shared run 7e reserved below `b`. `a → b.p` is then a piece from a port anchor
 * above `b` to a terminal below it, on one x, with `b` in between. `b` is the link's own end node
 * and it is not an end of this piece: a claim owns only the pins the piece really attaches to.
 */
it('claims no run through a node the piece does not attach to', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-claimed-run-owns-only-its-pins.yaml', import.meta.url), 'utf8');
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  const plan = planRoute(before);
  const item = plan.links.find(entry => entry.link === 'link-1')!;
  expect(item.pieces.map(piece => piece.kind)).toEqual(['gap', 'reserved']);
  expect(item.connectors).toHaveLength(1);

  const model = await route(before, { createAttempt: createAvoidAttempt });
  const box = model.nodes.b!.bounds!;
  const path = model.links.find(entry => entry.id === 'link-1')!.path!;
  // Every segment of the published path clears the node the straight line went through.
  for (const segment of path.segments) {
    const acrossX = Math.min(segment.from.x, segment.to.x) < box.x + box.width && Math.max(segment.from.x, segment.to.x) > box.x;
    const acrossY = Math.min(segment.from.y, segment.to.y) < box.y + box.height && Math.max(segment.from.y, segment.to.y) > box.y;
    expect([segment.from, segment.to, acrossX && acrossY]).toEqual([segment.from, segment.to, false]);
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);

/**
 * The same claim, refused for the other reason. Both links out of `h1` leave one port, so 7e
 * reserves a junction tree there and one branch takes a bar across the tier gap. `m2.b → l1` is
 * still one straight run between two anchors on one x, and the bar crosses it. A shared run is a
 * wall like every other reservation, and neither G4 nor G6 measures a perpendicular crossing, so
 * the claim has to read the covers `routeObstacles` puts in front of the router.
 */
it('claims no run across a reserved run the corridor predicate cannot see', async () => {
  const yaml = withoutJointOrder(readFileSync(new URL('../../goldens/synthetic/a-claimed-run-clears-a-shared-run.yaml', import.meta.url), 'utf8'));
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(orthogonalLinks(yaml)))))))));
  const bar = before.links.find(item => item.id === 'link-2')!.sharedRuns!.from!;
  const plan = planRoute(before);
  expect(plan.links.find(item => item.link === 'link-3')!.pieces.map(piece => piece.kind)).toEqual(['gap']);

  const model = await route(before, { createAttempt: createAvoidAttempt });
  const link = model.links.find(item => item.id === 'link-3')!;
  const from = findPort(model, link.attachments!.from)!.anchor!;
  const to = findPort(model, link.attachments!.to)!.anchor!;
  // The run the claim would have taken really crosses the reserved bar; the published one does not.
  const straight = { from: { ...from }, to: { ...to }, owner: { kind: 'link' as const, id: 'link-3' } };
  expect(bar.some(run => segmentDistance(straight, run) < 10)).toBe(true);
  for (const segment of link.path!.segments) {
    for (const run of bar) expect([segment.from, run.from, segmentDistance(segment, run) >= 10]).toEqual([segment.from, run.from, true]);
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);
