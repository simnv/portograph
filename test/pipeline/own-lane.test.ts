import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows, score } from '../../src/index.js';
import { ownedLanes } from '../../src/route/paths.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { segmentRect } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/own-lane-is-an-obstacle.yaml', import.meta.url), 'utf8');
const twoRuns = readFileSync(new URL('../../goldens/synthetic/two-runs-share-a-tier-gap.yaml', import.meta.url), 'utf8');
const barEnd = readFileSync(new URL('../../goldens/synthetic/a-bar-end-keeps-its-corridor.yaml', import.meta.url), 'utf8');

/**
 * Stress-test reproducer (`.scratch/stress/issues/02`). Two groups of one tier are fed from nearly
 * the same x, so 7c can seat only one of them; the other keeps its port far from the lane 7a
 * reserved for its link. Stage 8 then had to route that gap sideways into the link's own corridor,
 * and the stitcher refused the geometry. A lane admits only its owner's collinear run, so it is now
 * an obstacle for the owner as well, and the reserved stems of the links a batch has not routed yet
 * are obstacles too.
 *
 * Since ticket 02 the corridor of the unseated child follows it, so `link-3` descends on its own
 * corridor rather than reaching it sideways. The rule this test states is the one that survives
 * either geometry: whatever a link's path does inside one of its own corridors, it does on that
 * corridor's centre. `link-1` and `link-3` each still run the whole length of theirs, and the
 * assertion below is checked against that rather than passing on an empty selection.
 */
it('keeps a routed gap out of the corridor its own link reserved', async () => {
  const before = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  // The precondition: placement really did leave one child off its lane. 7f follows the child with the corridor and says so
  // (ticket 75: the centring settles at a fixed point, so it no longer reports a stall for it).
  expect(before.diagnostics.map(item => item.code)).toContain('LANE_FOLLOWS_ITS_CHILD');
  const plan = planRoute(before);
  // Ticket 50: every part of every gap is a planned part now (the columns of link-1, link-2 and link-3 as drops, link-4 and the
  // link-3 row as stepped parts), so the router is asked for nothing: `link-4`, the one link it still routed, holds a row of its own
  // (327.25) and its stems are claimed. The reproducer's contract, checked below on the published paths, holds by reservation
  // instead of by the router keeping out of the corridor. A residual link in this shape needs ticket 51's fixture.
  expect(plan.batches.map(batch => batch.links)).toEqual([]);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // Every routed segment that meets one of its link's own lanes runs along that lane's centre, and
  // every owned lane really is met, so none of these assertions is checked against nothing.
  for (const link of model.links) {
    for (const lane of ownedLanes(model, link)) {
      const met = link.path!.segments.filter(item => segmentRect(item, lane.bounds));
      expect([link.id, lane.id, met.length > 0]).toEqual([link.id, lane.id, true]);
      for (const segment of met) {
        expect([link.id, lane.id, segment.from.x, segment.to.x]).toEqual([link.id, lane.id, lane.x, lane.x]);
      }
    }
  }
  // Every link reaches both of its ports with the reserved perpendicular stem.
  for (const link of model.links) {
    const segments = link.path!.segments;
    for (const segment of [segments[0]!, segments.at(-1)!]) {
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  }
  // The diagram is poor, but it is a diagram: a failed gate is a judgement, a failed pipeline is not.
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);

/**
 * Ticket 02 of `.scratch/synthetics-review`. The child 7c could not seat is the same one, and the
 * corridor now follows it: 7f moves the lane to the child's port x, because the corridor there is
 * free and the corridors of the tier keep the order of the children they serve. The link then
 * descends straight into its port and turns once, in the tier gap above.
 */
it('moves a corridor to the child 7c could not seat under it', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));
  const link = model.links.find(item => item.id === 'link-3')!;
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-3')!;
  const child = model.nodes['node-ba002']!.ports[0]!;
  expect(model.diagnostics.map(item => item.code)).toContain('LANE_FOLLOWS_ITS_CHILD');
  expect(lane.x).toBe(child.anchor!.x);
  expect(lane.bounds.x).toBe(lane.x - lane.bounds.width / 2);
  expect(lane.side).toBe('right');
  // The reservation and its extents follow the corridor, so the allocation that reads lane x after
  // 7a and 7c reads the new one.
  expect(link.fixedSegments!.map(run => [run.from.x, run.to.x])).toEqual([[lane.x, lane.x]]);
  // The other corridor of the tier keeps its own child, and the two keep the children's order.
  const other = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-1')!;
  expect(other.x).toBe(model.nodes['node-ba001']!.ports[0]!.anchor!.x);
  expect(other.x).toBeLessThan(lane.x);
  // Nothing moved for the corridor: the rule runs after the last centring replay, so the child's
  // node keeps the width and the canvas keeps the extent 7f published.
  expect(model.nodes['node-ba002']!.bounds!.width).toBeCloseTo(145.775146484375, 6);
  // The move turns the run in the gap above the corridor from a column into a row, and 7f measured
  // that gap before the move. No gap may end up owing more room than it has.
  for (const { gap, plan } of tierGapPlans(model)) expect([gap.below, plan.growth]).toEqual([gap.below, 0]);
}, 60000);

/**
 * The refusal. `two-runs-share-a-tier-gap` has an unseated child and a free corridor at its port x
 * as well, but following it opens an alignment 7c could not reach, and the centring invariant would
 * then read the published placement as unfinished work. The corridor stays where 7a put it.
 */
it('keeps a corridor that would leave the centring invariant unverified', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(twoRuns))))))));
  const lane = model.lanes.find(item => item.id === 'lane:"link-3":2')!;
  const child = model.nodes.d!.ports[0]!;
  expect(child.anchor!.x).not.toBe(lane.x);
  expect(lane.x).toBe(59);
  expect(model.diagnostics.map(item => item.code)).not.toContain('LANE_FOLLOWS_ITS_CHILD');
  expect(model.diagnostics.map(item => item.code)).not.toContain('CENTRE_INVARIANT_UNVERIFIED');
}, 60000);

/**
 * A bar takes its port x from the corridor the drop's link owns (7d), so a corridor that followed
 * its child would move the bar port derived from it, and the bar rebuild every publication replays
 * would contradict the declaration-order geometry it re-derives. Without the exclusion this input
 * raises `Bar group core contradicts declaration-order geometry` at the bands stage.
 */
it('leaves a corridor whose link has a bar end where 7a put it', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(barEnd))))))));
  // The precondition: a child really is off its corridor here as well.
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-1')!;
  expect(model.nodes.c1!.ports[0]!.anchor!.x).not.toBe(lane.x);
  expect(model.diagnostics.map(item => item.code)).not.toContain('LANE_FOLLOWS_ITS_CHILD');
  expect(model.lanes.map(item => item.x)).toEqual([229, 263]);
}, 60000);

/**
 * `transitTiers` runs from the authored source to the authored target, so its last tier is the one
 * next to the child only when the child is the authored target. Reading it from the child instead
 * keeps the answer out of the authoring: both directions move the corridor next to the child and
 * leave the corridor next to the alignment end where 7a put it.
 */
const twoTierTransit = (reversed: boolean): string => {
  const pair = (a: string, b: string) => reversed ? `[${b}, ${a}]` : `[${a}, ${b}]`;
  return `portograph: 2
groups:
  up-a: {tier: 7}
  up-b: {tier: 7}
  mid: {tier: 8}
  mid2: {tier: 9}
  low-a: {tier: 10}
  low-b: {tier: 10}
  tail: {tier: 12}
nodes:
  node-ca002: {group: up-b, class: provider, label: node-ca002}
  node-aa001: {group: up-a, class: router, label: node-aa001}
  node-aa002: {group: mid, class: tbr, label: node-aa002}
  filler: {group: mid2, class: rr, label: filler}
  node-ba001: {group: low-b, class: rr, label: node-ba001}
  node-ba002: {group: low-a, class: provider, label: node-ba002}
  edge-outlet1: {group: tail, class: tbr, label: Edge outlet1}
links:
  - ${pair('node-ba001', 'node-aa001')}
  - ${pair('node-ba001', 'node-aa002')}
  - ${pair('node-ba002', 'node-aa001')}
  - ${pair('node-ba002', 'node-aa002')}
  - ${pair('filler', 'node-aa002')}`;
};

it('moves the corridor next to the child whichever way the link is authored', async () => {
  for (const reversed of [false, true]) {
    const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(twoTierTransit(reversed)))))))));
    const owned = model.lanes.filter(item => item.owner.kind === 'link' && item.owner.id === 'link-1')
      .sort((a, b) => a.tier - b.tier);
    expect([reversed, owned.length]).toEqual([reversed, 2]);
    expect([reversed, model.diagnostics.map(item => item.code)].flat()).toContain('LANE_FOLLOWS_ITS_CHILD');
    // The child is the low-tier end, whichever way the link was authored. Its corridor is the one
    // in the tier next to it, and that corridor alone took the child port's x.
    const link = model.links.find(item => item.id === 'link-1')!;
    const ends = [link.attachments!.from, link.attachments!.to];
    const childRef = ends.find(end => end.node === 'node-ba001')!;
    const child = model.nodes[childRef.node]!.ports.find(port => port.ref.ordinal === childRef.ordinal)!.anchor!.x;
    expect([reversed, owned.map(item => item.tier)]).toEqual([reversed, [1, 2]]);
    expect([reversed, owned.at(-1)!.x]).toEqual([reversed, child]);
    expect([reversed, owned[0]!.x === child]).toEqual([reversed, false]);
  }
}, 120000);
