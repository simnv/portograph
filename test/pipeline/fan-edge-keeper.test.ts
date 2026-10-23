import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { crossBundleFans } from '../../src/layout/bundle-junctions.js';
import { MEMBER_GAP, edgeMargin } from '../../src/layout/bundle-geometry.js';
import { routedStrokeWidth } from '../../src/theme/geometry.js';
import type { LayoutModel, PathSegment } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 18: the edge keeper of a fan, read on forged states of the published fixture. `s1.p` fans to `c1` (link-2)
 * and `c2.a` (link-3); the frame `home` holds `s1`. Each case moves far port anchors and rebuilds the fans with `crossBundleFans`.
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-fan-track-keeps-the-group-edge-margin.yaml', import.meta.url), 'utf8');
const published = layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

async function forged(edit: (model: LayoutModel, box: { x: number; y: number; width: number; height: number }, here: number) => void, frozen = false) {
  const model = structuredClone(await published);
  if (!frozen) delete model.fanKeepers;
  const box = model.frames!.find(frame => frame.id === 'home')!.box, here = model.nodes['s1']!.ports[0]!.anchor!.x;
  edit(model, box, here);
  model.junctions = [];
  model.diagnostics = [];
  for (const link of model.links) if (link.path?.fixed !== true) delete link.path;
  crossBundleFans(model);
  return { model, box, here, runs: (id: string): PathSegment[] => model.links.find(link => link.id === id)!.sharedRuns!.from! };
}
const farPort = (model: LayoutModel, node: string) => model.nodes[node]!.ports.find(port => port.side === 'bottom')!;
const vertical = (segment: PathSegment): boolean => Math.abs(segment.from.x - segment.to.x) < 1e-9 && Math.abs(segment.from.y - segment.to.y) > 1e-9;

it('ticket 18: a partner close to the port column turns at the keeper junction and never rises beside the stem', async () => {
  // The far port of link-3 stands 11 px right of the column: on a stem extended past the partner's own row it would rise 11 px from it.
  const { model, runs, here } = await forged((m, _box, x) => { farPort(m, 'c2').anchor!.x = x + 11; });
  const keeperJunction = model.junctions.find(junction => junction.keeper !== undefined);
  expect(keeperJunction?.keeper?.link).toBe('link-2');
  const stem = runs('link-2')[0]!;
  const gap = MEMBER_GAP + routedStrokeWidth(model);
  for (const segment of runs('link-3').filter(vertical)) {
    if (Math.abs(segment.from.x - here) < 1e-9) continue;
    const overlap = Math.min(Math.max(segment.from.y, segment.to.y), Math.max(stem.from.y, stem.to.y)) - Math.max(Math.min(segment.from.y, segment.to.y), Math.min(stem.from.y, stem.to.y));
    if (overlap > 1e-9) expect(Math.abs(segment.from.x - here)).toBeGreaterThanOrEqual(gap);
  }
  // The partner leaves the junction on the keeper's row, the other way.
  expect(runs('link-3')[1]).toMatchObject({ from: keeperJunction!.point, to: { y: keeperJunction!.point!.y } });
}, 60000);

it('ticket 18: a second member on the keeper side refuses the keeper; the wall steps the track out of the band and names it', async () => {
  // Both far ports stand left of the column: neither member is alone on its side, so there is no keeper. The far port of link-3 stands
  // nearer the column, so link-2 is still peeled first, on the row inside the frame, where the edge wall applies.
  const { model, box, runs } = await forged((m, _box, x) => { farPort(m, 'c2').anchor!.x = x - 20; });
  expect(model.junctions.some(junction => junction.keeper !== undefined)).toBe(false);
  const margin = edgeMargin(routedStrokeWidth(model));
  for (const id of ['link-2', 'link-3']) {
    const track = runs(id).at(-1)!;
    if (!vertical(track)) continue;
    const x = track.from.x;
    expect(x > box.x || box.x - x >= margin - 1e-6).toBe(true);
  }
  expect(model.diagnostics.some(item => item.code === 'FAN_TRACK_STEPPED_AT_GROUP_EDGE' && (item.owners ?? []).some(owner => 'id' in owner && owner.id === 'link-2'))).toBe(true);
}, 60000);

it('ticket 18: the keeper holds on the right edge as on the left', async () => {
  // Mirror: the far port of link-2 stands 7.4 px right of the frame's right edge, the far port of link-3 left of the column.
  const { model, box, runs, here } = await forged((m, b) => {
    farPort(m, 'c1').anchor!.x = b.x + b.width + 7.4;
    farPort(m, 'c2').anchor!.x = 2 * m.nodes['s1']!.ports[0]!.anchor!.x - farPort(m, 'c2').anchor!.x;
  });
  const junction = model.junctions.find(item => item.keeper !== undefined);
  expect(junction?.keeper?.link).toBe('link-2');
  const [stem, along, rise] = runs('link-2');
  expect(stem!.to.x).toBe(here);
  expect(box.y - along!.from.y).toBeGreaterThanOrEqual(edgeMargin(routedStrokeWidth(model)));
  expect(rise!.from.x).toBeCloseTo(box.x + box.width + 7.4, 9);
  expect(model.diagnostics.some(item => item.code === 'FAN_TRACK_STEPPED_AT_GROUP_EDGE')).toBe(false);
}, 60000);

it('ticket 18: once frozen, the keeper and its depth are read from the record, not from a box that stretched (R1)', async () => {
  const before = await published;
  expect(before.fanKeepers).toEqual([expect.objectContaining({ link: 'link-2' })]);
  const depth = before.fanKeepers![0]!.depth;
  // The frame grows 30 px up after the freeze: a fresh choice would turn deeper, the record keeps the published turn.
  const { model, here } = await forged((_m, box) => { box.y -= 30; box.height += 30; }, true);
  const anchor = model.nodes['s1']!.ports[0]!.anchor!;
  const junction = model.junctions.find(item => item.keeper !== undefined)!;
  expect(junction.keeper).toEqual({ link: 'link-2', depth });
  expect(junction.point).toEqual({ x: here, y: anchor.y - depth });
  // Absent = not frozen: the same stretch is chosen again; the turn past the grown frame lies beyond the rows the fan holds, so no keeper.
  const fresh = await forged((_m, box) => { box.y -= 30; box.height += 30; });
  expect(fresh.model.junctions.some(item => item.keeper !== undefined)).toBe(false);
}, 60000);
