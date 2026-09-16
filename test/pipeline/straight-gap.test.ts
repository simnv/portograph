import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-straight-gap-needs-no-router.yaml', import.meta.url), 'utf8');

/**
 * Stress-test reproducer (`.scratch/stress/issues/07`). `m2 → l1` is one straight run between two
 * port anchors on one x, and the two links out of `h1` cross it at the 15 px depth every stem turns
 * at. One of those crossings is routed first and covers the reserved approach of `m2 → l1`;
 * libavoid cannot reach the checkpoint, drops it and answers with the two node centres. Nothing in
 * that gap is the router's to choose, so stage 8 claims it.
 */
it('stitches a straight gap between two reserved endpoints without asking the router', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  const plan = planRoute(before);
  const claimed = plan.links.find(item => item.link === 'link-3')!;
  expect(claimed.pieces.map(piece => piece.kind)).toEqual(['straight']);
  expect(claimed.connectors).toEqual([]);
  // The two crossing links still reach the router; only the forced run is kept out of the batches.
  expect(plan.batches.flatMap(batch => batch.links)).toEqual(['link-1', 'link-2']);

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

  // The diagram is produced. What it still fails is the pair of links that share the one corridor
  // this tier gap offers, and none of it touches the claimed run: `link-1` and `link-2` run along
  // each other, and `link-1` follows the `hub` group edge. That is a separate defect.
  const report = score(model).snapshot;
  expect(Number.isFinite(report.Q)).toBe(true);
  expect(Object.entries(report.gates).flatMap(([id, gate]) => gate.violations.map(item => [id, item.code, item.elements])))
    .toEqual([['G4', 'collinear-overlap', ['link-1', 'link-2']], ['G4', 'collinear-overlap', ['link-1', 'link-2']],
      ['G6', 'segment-group-edge', ['link-1', 'hub']], ['G6', 'parallel-clearance', ['link-1', 'link-2']],
      ['G6', 'parallel-clearance', ['link-1', 'link-2']], ['G6', 'parallel-clearance', ['link-1', 'link-2']]]);
}, 60000);
