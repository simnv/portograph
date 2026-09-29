import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, growTierGaps, lanes, linkLabels, planRoute, route, rows, score, tierGapRoom } from '../../src/index.js';
import type { TierGapRoom } from '../../src/index.js';
import type { Rect } from '../../src/model/geometry.js';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { ownedLanes } from '../../src/route/paths.js';
import { MEMBER_GAP } from '../../src/layout/bundle-geometry.js';
import { GROUP_LABEL_GEOMETRY, produceGroupLabelBands, routedStroke, stemReach } from '../../src/layout/bands.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { horizontal, segmentRect, vertical } from '../../src/score/geometry.js';
import { findPort } from '../../src/layout/row-paths.js';
import { stemCache, stemPlan } from '../../src/layout/sides-two.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8');

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

  // Two rows of one gap keep the pitch, and two vertical segments on one x never share length.
  const pitch = MEMBER_GAP + routedStroke(before);
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

it('allocates nothing where every run of a gap keeps one x', async () => {
  // The M1 golden's four transit links descend on the x of their own lanes, so no run needs a row
  // and the allocation is empty: a gap that has nothing to share changes no diagram.
  const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
  const before = await place(golden);
  expect(before.lanes.length).toBe(4);
  expect(allocateGapRuns(before)).toEqual([]);
  expect(planRoute(before).obstacles.some(item => item.id.startsWith('gap:'))).toBe(false);
  // Every gap of the golden already seats the rows it owes, so 7f grows nothing and the approved
  // geometry stands (`.scratch/stress/issues/05`).
  for (const room of tierGapRoom(before)) expect(room.rows).toBe(0);
  expect(growTierGaps(structuredClone(before) as LayoutModel)).toBe(false);
}, 60000);

/** The band gap `stackBands` left between the two bands one tier gap lies between. */
const bandGapOf = (model: LayoutModel, room: TierGapRoom): number => {
  const box = (tier: number): Rect => model.tierBands.find(band => band.tier === tier)!.bounds!;
  return box(room.below).y - (box(room.above).y + box(room.above).height);
};

it('grows a tier gap to the rows it must seat', async () => {
  // Stress ticket 05. Four runs cross one tier gap and not one of them keeps a single x, so the gap
  // owes four rows. The 60 px band gap leaves 49.25 px between the lane extents, which seats two.
  const model = await place(read('a-tier-gap-grows-to-its-rows.yaml'));
  const rooms = tierGapRoom(model);
  const grown = rooms.filter(room => room.rows > 0);
  expect(grown.map(room => room.rows)).toEqual([4]);

  // The rows the gap grew for are the rows it seats. `rows x pitch` would not do it: that is the
  // packing with nothing in the way, and the lane runs standing on both boundaries take 11.5 px of
  // the gap each, so at 70 px this gap seated two of its four.
  const seats = allocateGapRuns(model).flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y));
  for (const room of grown) {
    const inside = seats.filter(y => y > room.low && y < room.high);
    expect(inside.length).toBe(room.rows);
    // The gap holds what the seating landed in and no more: the last row, plus the headroom the
    // high boundary keeps for an approach standing on it.
    expect(Math.max(...inside) - room.low + room.headroom).toBeCloseTo(room.high - room.low, 9);
    expect(room.high - room.low).toBeGreaterThan(room.rows * room.pitch);
    expect(bandGapOf(model, room)).toBeCloseTo(room.high - room.low + room.margins, 9);
  }
  // A gap that owes no row keeps its band gap: growth is a reservation this rule makes, never one
  // it takes back. And the reservation is stable, so a second pass over it grows nothing.
  for (const room of rooms) {
    expect(room.high - room.low).toBeGreaterThanOrEqual(room.required - 1e-9);
    if (!room.rows) expect(bandGapOf(model, room)).toBeCloseTo(60, 9);
  }
  expect(growTierGaps(structuredClone(model) as LayoutModel)).toBe(false);

  const routed = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(routed).snapshot.Q)).toBe(true);
}, 120000);

it('steps a row past a group edge instead of ending the search', async () => {
  // Stress ticket 06. One tier gap owes a single row, and the first position the pitch allows for
  // it runs along the top group's edge. `seat` advanced past a blocker rectangle but not past that
  // refusal, so the gap allocated nothing and the diagram did not publish.
  const model = await place(read('a-row-steps-past-a-group-edge.yaml'));
  const room = tierGapRoom(model).find(entry => entry.rows > 0)!;
  expect([room.rows, room.seated]).toEqual([1, 1]);

  const seats = allocateGapRuns(model)
    .flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y))
    .filter(y => y > room.low && y < room.high);
  expect(seats.length).toBe(1);
  // The rows pack half a pitch inside the low boundary. That position is refused here, so the row
  // stands at the next one the pitch allows.
  const row = seats[0]!;
  expect(row).toBeCloseTo(room.low + room.pitch / 2 + room.pitch, 9);

  // And it stands clear of the link-free margin every group edge keeps (ADR-0013).
  const margin = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
  for (const group of Object.values(model.groups)) {
    if (!group.bounds || !group.nodes.length) continue;
    for (const edge of [group.bounds.y, group.bounds.y + group.bounds.height]) {
      expect(Math.abs(row - edge)).toBeGreaterThanOrEqual(margin - 1e-9);
    }
  }

  const published = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(published).snapshot.Q)).toBe(true);
}, 120000);

it('leaves out the run a group label covers and seats the rest', async () => {
  // Stress ticket 09. A group label covers the approach one of four runs owes its own port. The
  // sixth amendment answered that wholesale and the gap allocated nothing; the decline is now per
  // run, so the three clear runs are seated and the covered one alone is left to stage 8.
  const model = await place(read('a-gap-leaves-out-the-covered-run.yaml'));
  // Named by its tiers, not found by the answer: the gap between the middle band and the lower one.
  // A `find` on `seated` passes the moment the entry is missing, and any unrelated change to this
  // gap then reads as a crash rather than as the rule failing.
  const room = tierGapRoom(model).find(entry => entry.above === 1 && entry.below === 2);
  expect([room?.rows, room?.seated, room?.refuses]).toEqual([4, 3, false]);

  const runs = allocateGapRuns(model);
  const inside = runs.filter(run => run.segments.some(segment =>
    horizontal(segment) && segment.from.y > room!.low && segment.from.y < room!.high));
  expect(inside.map(run => run.link).sort()).toEqual(['link-2', 'link-3', 'link-4']);

  // The covered run keeps the route it has today, and it crosses every row the gap did seat.
  for (const run of inside) expect(run.crossers).toContain('link-1');

  // The rectangle that covers it is the lower group's own title, and it covers that run's approach
  // and no other's. Each approach runs from the gap's far boundary to the port's own outward
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
    const approach = { from: { x: anchor.x, y: room!.high }, to: { x: anchor.x, y: anchor.y - stemReach(model, node) },
      owner: { kind: 'link' as const, id } };
    return [id, segmentRect(approach, title)] as const;
  });
  expect(covered).toEqual([['link-1', true], ['link-2', false], ['link-3', false], ['link-4', false]]);

  const published = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(published).snapshot.Q)).toBe(true);
}, 120000);

it('claims an approach a row stands exactly on the edge of', async () => {
  // Stress ticket 09. The gap seats a row one cover margin inside its low boundary, so that row's
  // own cover ends exactly on the boundary — and the run standing there is clear of it by the 10 px
  // G6 asks for and no more. The claim's cover scan counted that zero-area touch as a hit, declined
  // the straight piece, and libavoid answered with a route that never reached the reserved end.
  const model = await place(read('a-claim-lies-on-a-cover-edge.yaml'));
  const room = tierGapRoom(model).find(entry => entry.above === 3 && entry.below === 4);
  expect([room?.rows, room?.seated, room?.refuses]).toEqual([3, 3, false]);

  const row = allocateGapRuns(model).find(run => run.link === 'link-17'
    && run.segments.some(segment => horizontal(segment) && segment.from.y > room!.low && segment.from.y < room!.high));
  const seat = row?.segments.find(horizontal);
  expect(seat === undefined).toBe(false);
  // The cover of a run is the run grown by the gate's clearance plus the two half strokes, so a row
  // seated that far inside the boundary puts its cover's edge on the boundary exactly.
  const margin = GROUP_LABEL_GEOMETRY.nodeClearance + routedStroke(model);
  expect(seat!.from.y - margin).toBeCloseTo(room!.low, 9);

  // `link-18` stands on that boundary inside the cover's own x range, and the piece from there to
  // its port is one straight run stage 8 claims rather than asks the router for. Without the rule
  // it is a `gap`, and the route libavoid answers with never reaches the reserved end.
  const pieces = planRoute(model).links.find(item => item.link === 'link-18')!.pieces;
  const last = pieces.at(-1)!;
  expect(last.kind).toBe('straight');
  const claim = (last as { segments: PathSegment[] }).segments[0]!;
  expect(Math.max(claim.from.y, claim.to.y)).toBeCloseTo(room!.low, 9);
  expect(claim.from.x).toBeGreaterThan(Math.min(seat!.from.x, seat!.to.x) - margin);
  expect(claim.from.x).toBeLessThan(Math.max(seat!.from.x, seat!.to.x) + margin);

  const published = linkLabels(await route(model, { createAttempt: createAvoidAttempt }));
  expect(Number.isFinite(score(published).snapshot.Q)).toBe(true);
  // And the published path really arrives at the port the claim was declined short of.
  const path = published.links.find(item => item.id === 'link-18')!.path!.segments;
  const port = findPort(published, published.links.find(item => item.id === 'link-18')!.attachments!.to)!;
  expect([path.at(-1)!.to.x, path.at(-1)!.to.y]).toEqual([port.anchor!.x, port.anchor!.y]);
}, 120000);

it('carries a group label with the band the gap room moves', async () => {
  // Stress ticket 06. 7f places its group labels, measures the gaps, and places them again: a group
  // label is an obstacle in the tier gap beside it, so a gap measured before them grows for rows
  // they then refuse. The measurement therefore moves each group's label band and label with it.
  // A published model is frozen; 7f's own producers run on the transaction's draft.
  const model = structuredClone(await beforeBands(read('a-tier-gap-grows-to-its-rows.yaml'))) as LayoutModel;
  produceGroupLabelBands(model);
  expect(model.labels.filter(label => label.role === 'group').length).toBeGreaterThan(0);
  expect(model.labelBands.length).toBeGreaterThan(0);

  const groupY = new Map(Object.entries(model.groups).map(([id, group]) => [id, group.bounds!.y]));
  const labelY = new Map(model.labels.filter(item => item.role === 'group').map(item => [item.id, item.bounds!.y]));
  const bandY = new Map(model.labelBands.map(band => [band.group, band.bounds.y]));

  expect(growTierGaps(model)).toBe(true);
  const shift = (id: string): number => model.groups[id]!.bounds!.y - groupY.get(id)!;
  expect(Object.keys(model.groups).filter(id => shift(id) > 1e-9).length).toBeGreaterThan(0);
  // Each label and each band moved by exactly the shift of the group it belongs to.
  for (const label of model.labels.filter(item => item.role === 'group')) {
    const id = label.id.slice('label:group:'.length);
    expect(label.bounds!.y - labelY.get(label.id)!).toBeCloseTo(shift(id), 9);
  }
  for (const band of model.labelBands) {
    expect(band.bounds.y - bandY.get(band.group)!).toBeCloseTo(shift(band.group), 9);
  }
}, 120000);

it('grows a tier gap so that the two tip rows of a link that nests a stem stand two run clearances apart (ranked-groups ticket 25)', async () => {
  // A pending stem's obstacle reaches one obstacle expansion (11.5 px) past its tip, and a run keeps one
  // run clearance (11.5 px) off an obstacle. The other tip row of the link must stand beyond both, so it
  // clears the near stem's obstacle rows; this is all the rule claims (see `stemShortfall`).
  const OBSTACLE = 11.5, CLEARANCE = 11.5;
  const before = await beforeBands(read('a-stem-tip-clears-the-tip-that-faces-it.yaml'));
  const owed = tierGapRoom(before).map(room => room.stems);
  expect(owed).toHaveLength(1);
  expect(owed[0]).toBeCloseTo(5.5, 9);

  const after = bands(before);
  expect(tierGapRoom(after).map(room => room.stems)).toEqual([0]);
  const grown = after.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN');
  expect(grown.map(item => item.message)).toEqual([expect.stringMatching(/grew 5\.50 px to keep the two stem tips of a link clear of each other's stem obstacle/)]);
  const gapBefore = bandGapOf(before, tierGapRoom(before)[0]!), gapAfter = bandGapOf(after, tierGapRoom(after)[0]!);
  expect(gapAfter - gapBefore).toBeCloseTo(5.5, 9);

  // Every link: the lower tip row lies beyond the upper stem's obstacle rows (upper tip + 11.5) by a run clearance.
  const cache = stemCache();
  let deepest = 0;
  for (const link of after.links) {
    const [a, b] = [findPort(after, link.attachments!.from)!, findPort(after, link.attachments!.to)!];
    const [upper, lower] = a.anchor!.y < b.anchor!.y ? [a, b] : [b, a];
    const upperTip = upper.anchor!.y + stemPlan(after, upper, cache).depth;
    const lowerTip = lower.anchor!.y - stemPlan(after, lower, cache).depth;
    deepest = Math.max(deepest, stemPlan(after, lower, cache).depth);
    expect(lowerTip - (upperTip + OBSTACLE), link.id).toBeGreaterThanOrEqual(CLEARANCE - 1e-9);
  }
  expect(deepest).toBeGreaterThan(15);

  // A second call asks for nothing more. This fixture routes without the rule as well (no removed link at
  // any growth from 0 to 34.5 px), so it pins the arithmetic, not the need; the need is the fixture below.
  expect(growTierGaps(after)).toBe(false);
  const routed = await route(after, { createAttempt: createAvoidAttempt });
  expect(routed.removedLinks ?? []).toEqual([]);
}, 120000);

it('grows the gap under the far stem of link-35 by 23 px, the near stem obstacle plus a run clearance (ranked-groups ticket 25)', async () => {
  // Measured on this fixture: 23 px keeps `removedLinks` empty through the real router, 22.9 px removes
  // link-37 (`test/route/stem-pocket.test.ts` routes the grown sheet). The near side is flat, every tip at
  // 15 px, and the far stems of link-35 and link-37 reach 85 px of a 100 px gap: the far tip row lay on the
  // near tip row, inside the near stems' obstacle rows.
  const before = await beforeBands(read('a-band-holds-the-group-that-set-its-edge.yaml'));
  const room = tierGapRoom(before).filter(item => item.stems > 0);
  expect(room).toHaveLength(1);
  expect(room[0]!.stems).toBeCloseTo(23, 9);
  const after = bands(before);
  const grown = after.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN');
  expect(grown.map(item => item.message)).toEqual([expect.stringMatching(/grew 23\.00 px to keep the two stem tips of a link clear of each other's stem obstacle/)]);
  expect(tierGapRoom(after).map(item => item.stems).every(item => item === 0)).toBe(true);
}, 120000);
