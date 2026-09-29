import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const load = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

async function routed(yaml: string) {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return { plan: planRoute(before), model: linkLabels(await route(before, { createAttempt: createAvoidAttempt })) };
}

/**
 * Ticket 10 of ranked-groups. `n0 -> n4` ends in `g11`, and the title of `g11` stands over the
 * column of `n4`'s port, so the drop cannot go in through the top. It went in sideways from a corridor
 * 5.6 px beside the left edge of `g11`: the group is not an obstacle to a link attached inside it, so
 * nothing kept the router off the edge margin (G6 `segment-group-edge`). The plan now reserves an entry
 * checkpoint one margin beyond the edge, on the row of the stem, and the drop turns there.
 */
it('turns a drop that goes in sideways outside the group-edge link-margin', async () => {
  const { plan, model } = await routed(load('a-drop-turns-outside-the-group-edge-margin'));
  const link = model.links.find(item => item.id === 'link-1')!;
  const box = model.groups['g11']!.bounds!, segments = link.path!.segments;
  const margin = GROUP_EDGE_LINK_CLEARANCE + 1 / 2;
  // Since ticket 66 the title of `g11` is placed clear of the port's leg and the group widens, so the row plan holds the drop and asks for no
  // entry checkpoint: the drop goes in through the top. The entry rule itself is read below on a model whose title stands on the column.
  expect(plan.links.find(item => item.link === 'link-1')?.connectors[0]?.checkpoints.some(checkpoint => checkpoint.x < box.x) ?? false).toBe(false);
  // No vertical run beside the group's side edges closer than the margin; the drop turned outside it.
  for (const segment of segments) {
    if (segment.from.x !== segment.to.x) continue;
    const beside = Math.max(box.y, Math.min(segment.from.y, segment.to.y)) < Math.min(box.y + box.height, Math.max(segment.from.y, segment.to.y));
    if (beside) expect(Math.abs(segment.from.x - box.x)).toBeGreaterThanOrEqual(margin);
  }
  const report = score(model).snapshot;
  expect(Object.entries(report.gates).flatMap(([id, gate]) => gate.violations.map(item => [id, item.code, item.elements]))).toEqual([]);
  }, 60000);

/**
 * The entry rule of ticket 10, read on a forged state: a title on the column of the port, with the source beside the group. Placement no
 * longer publishes it (since ticket 66 the title is placed clear and the group widens; a widening no lane allows leaves the title there, but no
 * fixture of the corpus keeps one with a source beside the group): the title of `g11` is put over the column of `n4`'s port and the plan must
 * reserve an entry checkpoint one margin beyond the side edge that faces the source, on the row of the stem.
 */
it('reserves an entry checkpoint beyond the group-edge link-margin where a title stands on the port column', async () => {
  const before = structuredClone(bands(bundles(bars(centre(flanks(lanes(rows(await placed(load('a-drop-turns-outside-the-group-edge-margin'))))))))));
  const port = before.nodes['n4']!.ports.find(item => item.side === 'top')!.anchor!;
  const title = before.labels.find(label => label.id === 'label:group:g11')!;
  title.bounds = { ...title.bounds!, x: port.x - title.bounds!.width / 2 };
  const box = before.groups['g11']!.bounds!, margin = GROUP_EDGE_LINK_CLEARANCE + 1 / 2;
  const checkpoints = planRoute(before).links.find(item => item.link === 'link-1')!.connectors[0]!.checkpoints;
  const entry = checkpoints.find(checkpoint => checkpoint.x < box.x);
  expect(entry, 'an entry checkpoint beside the left edge').toBeDefined();
  expect(box.x - entry!.x).toBeGreaterThanOrEqual(margin);
}, 60000);
