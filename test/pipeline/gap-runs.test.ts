import { goldenWithRemainders } from '../golden-remainders.js';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { score } from '../../src/index.js';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, lanes, linkLabels, planRoute, route, rows } from '../../src/internal.js';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { ownedLanes } from '../../src/route/paths.js';
import { produceGroupLabelBands, nudgingDistance, routedStroke, stemReach } from '../../src/layout/bands.js';
import { solveTierGaps } from '../../src/layout/gap-room.js';
import { replayGridAndBands } from '../../src/layout/placement-attempt.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { horizontal, segmentRect, vertical } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';
import { withoutJointOrder } from '../layout/joint-off.js';

const read = (name: string): string =>
  withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8'));

const place = async (fixture: string): Promise<LayoutModel> =>
  bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture))))))));

/** The model 7f receives: every placement rule before it, and no group label yet. */
const beforeBands = async (fixture: string): Promise<LayoutModel> =>
  bundles(bars(centre(flanks(lanes(rows(await placed(fixture)))))));

/**
 * Stress-test reproducers (`.scratch/stress/issues/04`). ADR-0015 rule 1 allocates the runs that
 * cross a tier gap before the first ownership batch runs, so no batch can take the corridor a
 * later link's own lane opens into.
 */
it('allocates every run of a tier gap two transit links share', async () => {
  const before = await place(read('two-runs-share-a-tier-gap.yaml'));
  const runs = allocateGapRuns(before);
  expect(runs.length).toBeGreaterThanOrEqual(2);

  // Two rows of one gap keep the pitch, and two vertical segments on one x never share length. Ticket 50: the pitch is the run
  // clearance k = 11.5 (spec open question 1), not the bundle pitch 17.5 the old allocation inherited.
  const pitch = nudgingDistance(before);
  const rowsOf = runs.flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y));
  for (const [index, y] of rowsOf.entries()) {
    for (const other of rowsOf.slice(index + 1)) expect(Math.abs(other - y)).toBeGreaterThanOrEqual(pitch - 1e-9);
  }
  const verticals = runs.flatMap(run => run.segments.filter(vertical)
    .map(segment => ({ x: segment.from.x, low: Math.min(segment.from.y, segment.to.y), high: Math.max(segment.from.y, segment.to.y) })));
  for (const [index, one] of verticals.entries()) {
    for (const other of verticals.slice(index + 1)) {
      if (Math.abs(other.x - one.x) > 1e-9) continue;
      expect(Math.min(one.high, other.high) - Math.max(one.low, other.low)).toBeLessThanOrEqual(1e-9);
    }
  }

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // The published path runs through every allocated run. A piece of one may be joined to the gap
  // beyond it where the two are one straight run, so each is covered rather than repeated.
  const covers = (item: PathSegment, run: PathSegment): boolean => {
    const on = Math.abs(item.from.x - item.to.x) <= 1e-9 ? Math.abs(item.from.x - run.from.x) <= 1e-9
      && Math.abs(run.from.x - run.to.x) <= 1e-9 : Math.abs(item.from.y - run.from.y) <= 1e-9
      && Math.abs(run.from.y - run.to.y) <= 1e-9;
    if (!on) return false;
    const along = (point: { x: number; y: number }): boolean =>
      point.x >= Math.min(item.from.x, item.to.x) - 1e-9 && point.x <= Math.max(item.from.x, item.to.x) + 1e-9
      && point.y >= Math.min(item.from.y, item.to.y) - 1e-9 && point.y <= Math.max(item.from.y, item.to.y) + 1e-9;
    return along(run.from) && along(run.to);
  };
  for (const run of runs) {
    const path = model.links.find(item => item.id === run.link)!.path!.segments;
    for (const segment of run.segments) expect(path.some(item => covers(item, segment))).toBe(true);
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 60000);

it('reserves the row a transit approach needs and the lane jogs it crosses', async () => {
  const before = await place(read('a-row-crosses-two-lane-jogs.yaml'));
  const runs = allocateGapRuns(before);
  // The two lane-to-lane jogs of one gap are columns; the third link's approach takes the row and
  // crosses one of them. A crossing between two allocated runs is reserved, not discovered.
  const columns = runs.filter(run => run.segments.every(vertical));
  const rowUsers = runs.filter(run => run.segments.some(horizontal));
  expect(columns.length).toBeGreaterThanOrEqual(2);
  expect(rowUsers.length).toBeGreaterThanOrEqual(1);
  const row = rowUsers[0]!.segments.find(horizontal)!;
  expect(columns.some(column => column.segments.some(segment =>
    Math.min(row.from.x, row.to.x) < segment.from.x && segment.from.x < Math.max(row.from.x, row.to.x)))).toBe(true);

  const model = linkLabels(await route(before, { createAttempt: createAvoidAttempt }));
  // The contract the reproducer broke: a routed segment that meets one of its link's own lanes
  // runs along that lane's centre, and every port keeps its reserved stem.
  for (const link of model.links) {
    for (const lane of ownedLanes(model, link)) {
      for (const segment of link.path!.segments.filter(item => segmentRect(item, lane.bounds))) {
        expect([link.id, lane.id, segment.from.x, segment.to.x]).toEqual([link.id, lane.id, lane.x, lane.x]);
      }
    }
    const segments = link.path!.segments;
    for (const segment of [segments[0]!, segments.at(-1)!]) {
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  }
  expect(Number.isFinite(score(model).snapshot.Q)).toBe(true);
}, 120000);

it('reserves the columns of a gap whose runs keep one x and leaves the golden where it stood', async () => {
  // The M1 golden's four transit links descend on the x of their own lanes, so no run needs a row. Ticket 50: the plan
  // reserves each such run as a drop (one vertical, tip to tip), where the old allocation reserved nothing; the two runs of its one
  // populated gap are verticals and no row, and the gap asks for nothing (H is the 60 px band gap).
  // The two provider links are read on the variant that keeps them orthogonal: on the golden they hold their chord (ticket 100).
  const golden = goldenWithRemainders();
  const before = await place(golden);
  expect(before.lanes.length).toBe(4);
  const runs = allocateGapRuns(before);
  expect(runs.map(run => run.link)).toEqual(['link-2', 'link-3']);
  for (const run of runs) {
    expect(run.segments).toHaveLength(1);
    expect(run.segments.every(vertical)).toBe(true);
  }
  expect(planRoute(before).obstacles.some(item => item.id.startsWith('gap:'))).toBe(false);
  // The plan seats no row, so 7f grows nothing and the approved geometry stands.
  for (const { plan } of tierGapPlans(before)) expect(plan.growth).toBe(0);
  expect(tierGapPlans(before).every(({ plan }) => plan.growth <= 1e-6)).toBe(true);
}, 60000);

it('grows a tier gap to the rows it must seat', async () => {
  // Stress ticket 05. Four runs cross one tier gap and not one of them keeps a single x. Ticket 50: the plan seats them on five rows
  // (link-4 is a Z part: two rows and a middle drop) at the pitch k = 11.5, from 332.25 to 378.25, and the gap grew to H = 83.25:
  // 34 px above the 49.25 the lane extents leave. Old numbers: four rows at the pitch 17.5.
  const model = await place(read('a-tier-gap-grows-to-its-rows.yaml'));
  const pitch = nudgingDistance(model);
  const busy = tierGapPlans(model).filter(({ plan }) => plan.parts.some(part => part.shape !== 'drop'));
  expect(busy).toHaveLength(1);
  const { gap, plan } = busy[0]!;
  expect(plan.parts.map(part => part.rows.length)).toEqual([1, 1, 1, 2]);

  // The rows the gap grew for are the rows it holds, and the gap stands exactly at the height the plan asks for.
  const seats = allocateGapRuns(model).flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y))
    .filter(y => y > gap.low && y < gap.high).sort((a, b) => a - b);
  expect(seats).toHaveLength(5);
  for (const [index, y] of seats.entries()) if (index) expect(y - seats[index - 1]!).toBeGreaterThanOrEqual(pitch - 1e-9);
  expect(plan.height).toBeCloseTo(83.25, 9);
  expect(plan.bandTop - gap.low).toBeCloseTo(plan.height, 9);
  expect(plan.growth).toBe(0);
  expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN').map(item => item.message))
    .toEqual([expect.stringMatching(/grew 34\.00 px to hold the rows of its parts \(set by link-4#1b\)/)]);
  // A gap whose parts are all drops keeps its band gap: growth is a reservation this rule makes, never one it takes back.
  for (const other of tierGapPlans(model)) {
    if (other.plan.parts.every(part => part.shape === 'drop')) expect(other.plan.growth).toBe(0);
  }
  // The reservation is stable, so a second pass over it grows nothing.
  expect(tierGapPlans(model).every(({ plan }) => plan.growth <= 1e-6)).toBe(true);

  const routed = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(routed).snapshot.Q)).toBe(true);
}, 120000);

it('steps a row past a group edge instead of ending the search', async () => {
  // Stress ticket 06. The first position for a row runs along the top group's edge. Ticket 50: the plan starts a part whose tip
  // stands in the group padding at `low + e`, e = 10 + stroke / 2 = 10.75 px (spec 2.2 O5), so the first row of the gap stands at
  // 131.75 and the rows after it at the pitch k (143.25, 154.75, then link-1 at 166.25). Old numbers: half a pitch inside the boundary
  // plus one pitch, 26.25 px, and one row where the plan reserves three.
  const model = await place(read('a-row-steps-past-a-group-edge.yaml'));
  const { gap, plan } = tierGapPlans(model).find(entry => entry.gap.above === 0 && entry.gap.below === 1)!;
  const seats = allocateGapRuns(model)
    .flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y))
    .filter(y => y > gap.low && y < gap.high)
    .sort((a, b) => a - b);
  const margin = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
  expect(seats).toHaveLength(4);
  expect(seats[0]!).toBeCloseTo(gap.low + margin, 9);
  expect(seats.map(y => y - gap.low)).toEqual([margin, margin + 11.5, margin + 23, margin + 34.5].map(value => expect.closeTo(value, 9)));
  expect(plan.growth).toBe(0);
  expect(plan.height).toBeCloseTo(82.5, 9);

  // And every row stands clear of the link-free margin every group edge keeps (ADR-0013).
  for (const row of seats) {
    for (const group of Object.values(model.groups)) {
      if (!group.bounds || !group.nodes.length) continue;
      for (const edge of [group.bounds.y, group.bounds.y + group.bounds.height]) {
        expect(Math.abs(row - edge)).toBeGreaterThanOrEqual(margin - 1e-9);
      }
    }
  }

  const published = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(published).snapshot.Q)).toBe(true);
}, 120000);

it('seats all four runs once the group label is nudged off the run it covered', async () => {
  // Stress ticket 09. A group label covers the approach one of four runs owes its own port. Ticket 50 declined that run as residual
  // (`leg-blocked`, spec 2.2) and reserved the other three; since ticket 62 placement nudges the label along its edge off the four legs
  // (there is room beside them), so the gap seats all four and none is covered. The per-run decline itself is held by the plan's own
  // unit test (`gap-plan.test.ts`, 'makes a part residual (leg-blocked)').
  const model = await place(read('a-gap-leaves-out-the-covered-run.yaml'));
  // Named by its tiers, not found by the answer: the gap between the middle band and the lower one.
  const gap = tierGaps(model).find(entry => entry.above === 1 && entry.below === 2)!;
  const plan = tierGapPlans(model).find(entry => entry.gap.above === 1 && entry.gap.below === 2)!.plan;
  expect(plan.parts.map(part => part.link).sort()).toEqual(['link-1', 'link-2', 'link-3', 'link-4']);
  expect(plan.residual).toEqual([]);

  const runs = allocateGapRuns(model);
  const inside = runs.filter(run => run.segments.some(segment => Math.max(segment.from.y, segment.to.y) > gap.low && Math.min(segment.from.y, segment.to.y) < gap.high));
  expect(inside.map(run => run.link).sort()).toEqual(['link-1', 'link-2', 'link-3', 'link-4']);

  // The lower group's own title covers no run's approach. Each approach runs from the gap's far boundary to the port's own outward
  // checkpoint, which is the line the allocation measures.
  const label = model.labels.find(item => item.id === 'label:group:g2')!;
  const title = { x: label.bounds!.x - GROUP_LABEL_LINK_CLEARANCE - routedStroke(model) / 2,
    y: label.bounds!.y - GROUP_LABEL_LINK_CLEARANCE - routedStroke(model) / 2,
    width: label.bounds!.width + 2 * (GROUP_LABEL_LINK_CLEARANCE + routedStroke(model) / 2),
    height: label.bounds!.height + 2 * (GROUP_LABEL_LINK_CLEARANCE + routedStroke(model) / 2) };
  const covered = ['link-1', 'link-2', 'link-3', 'link-4'].map(id => {
    const link = model.links.find(item => item.id === id)!;
    const node = model.nodes[link.attachments!.to.node]!;
    const anchor = node.ports.find(port => port.side === 'top')!.anchor!;
    const approach = { from: { x: anchor.x, y: gap.high }, to: { x: anchor.x, y: anchor.y - stemReach(model, node) },
      owner: { kind: 'link' as const, id } };
    return [id, segmentRect(approach, title)] as const;
  });
  expect(covered).toEqual([['link-1', false], ['link-2', false], ['link-3', false], ['link-4', false]]);

  const published = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(published).snapshot.Q)).toBe(true);
}, 120000);

// Ticket 50: a planned row never stands half a pitch inside a boundary, so the claim on a cover edge (stress ticket 09) is tested on a gap the plan
// does not fit, where the old allocation seats the rows: `test/pipeline/unfit-gap.test.ts` (ticket 51).

it('carries each group label band with the gap room move, and places no title in 7f', async () => {
  // Stress ticket 06, as architecture-2 ticket 54 changed it: 7f reserves its label bands, measures the gaps and moves each group's band with
  // it. No title stands while placement moves: titles are placed once at the end of 7f.
  // A published model is frozen; 7f's own producers run on the transaction's draft.
  const model = structuredClone(await beforeBands(read('a-tier-gap-grows-to-its-rows.yaml'))) as LayoutModel;
  produceGroupLabelBands(model);
  expect(model.labels.filter(label => label.role === 'group')).toEqual([]);
  expect(model.labelBands.length).toBeGreaterThan(0);

  const groupY = new Map(Object.entries(model.groups).map(([id, group]) => [id, group.bounds!.y]));
  const bandY = new Map(model.labelBands.map(band => [band.group, band.bounds.y]));

  expect(solveTierGaps(model, replayGridAndBands)).toBe(true);
  const shift = (id: string): number => model.groups[id]!.bounds!.y - groupY.get(id)!;
  expect(Object.keys(model.groups).filter(id => shift(id) > 1e-9).length).toBeGreaterThan(0);
  // Each band moved by exactly the shift of the group it belongs to.
  for (const band of model.labelBands) {
    expect(band.bounds.y - bandY.get(band.group)!).toBeCloseTo(shift(band.group), 9);
  }
}, 120000);

it('plans a tier gap whose nested stems stand close without the 2k pocket a routed link needs (ranked-groups tickets 25 and 50)', async () => {
  // Ticket 25 grew this gap 5.5 px so the two tip rows of a link that nests a stem stood 23 px apart, the room a ROUTED link
  // needs at its far checkpoint. Every link of the fixture is a planned part now (tier-gap-rows.md Section 5: the drop and residual
  // terms replace `stemShortfall`): its stems are claimed and its rows and legs reserved, so no pocket is needed and the plan asks
  // for 58.25 px, under the 60 px band gap. Nothing grows.
  const before = await beforeBands(read('a-stem-tip-clears-the-tip-that-faces-it.yaml'));
  const after = bands(before);
  expect(after.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN')).toEqual([]);
  const busy = tierGapPlans(after).filter(item => item.plan.parts.length);
  expect(busy).toHaveLength(1);
  const plan = busy[0]!.plan;
  expect(plan.residual).toEqual([]);
  expect(plan.demand).toBeCloseTo(58.25, 9);
  expect(plan.height).toBe(60);
  // A second call asks for nothing more, and the router is asked for nothing at all: every gap of every link is reserved.
  expect(tierGapPlans(after).every(({ plan }) => plan.growth <= 1e-6)).toBe(true);
  expect(planRoute(after).batches).toEqual([]);
  const routed = await route(after, { createAttempt: createAvoidAttempt });
  expect(routed.removedLinks ?? []).toEqual([]);
  expect(Object.entries(score(routed).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id)).toEqual([]);
}, 120000);

it('grows the gap of the band that sets the group edge to the rows of its 25 parts (ranked-groups tickets 25 and 50)', async () => {
  // Ticket 25 grew this gap 23 px for the two far stems of link-36 and link-38. The plan seats every part of the gap on a row of
  // its own at the pitch k = 11.5 (spans of 21 stepped parts overlap, so 18 distinct rows from 10.75 to 206.25 px below the low
  // boundary, three of them shared by parts whose spans do not touch), and the last row keeps k + 30 px (a lower leg of depth 30)
  // above the band below: H = 206.25 + 41.5 - 11.5 = 236.25 px against a room of 49.25. The router discovered those rows before
  // (G4 18, G6 47 on main); they are reserved now, and the gap grows 187 px, the height the published plan asks: 7f replaces the growth of
  // each round by `H - room` and does not accumulate it (ticket 51; the rounds added 198.5 px while they accumulated). Since ticket 57 the one solve
  // reads it once, after the last move in x, and asks the same 187 px.
  const before = await beforeBands(orthogonalLinks(read('a-band-holds-the-group-that-set-its-edge.yaml')));
  const after = bands(before);
  const grown = after.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN');
  // The plan is read once (ticket 57): link-17 and link-37 ask the same height, and the first part in the plan's order names it (link-37 since
  // ticket 65, where the kept verticals change the x of the parts; link-17 before).
  expect(grown.map(item => item.message)).toEqual([expect.stringMatching(/grew 187\.00 px to hold the rows of its parts \(set by link-37#0\)/)]);
  const busy = tierGapPlans(after).filter(item => item.plan.parts.length > 20);
  expect(busy).toHaveLength(1);
  expect(busy[0]!.plan.height).toBeCloseTo(236.25, 9);
  expect(busy[0]!.plan.growth).toBe(0);
  expect(busy[0]!.plan.residual).toEqual([]);
  // The second measure is identical: no gap asks for more. (A replay of the published model is not the test here: it replays the
  // published model first, and that replay is not idempotent on this fixture: it moves the x of the wide lower nodes by 42 px.)
  for (const { plan } of tierGapPlans(after)) expect(plan.growth).toBe(0);
}, 120000);
