import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { columnShifts, holdColumnAxes, holdMemberWalls, overlayFreeGroups, packBesideRows } from '../../src/layout/columns.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { selectAnchorTier } from '../../src/layout/lanes.js';
import { portKey } from '../../src/layout/sides-one.js';
import { placeOverlayFree } from '../../src/layout/overlay-place.js';
import { rows } from '../../src/layout/rows.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { centreDraft, centreViolations, createCentreBudget } from '../../src/layout/centre.js';
import { memberRoom } from '../../src/layout/read/canton.js';
import { stepOverChords } from '../../src/layout/chord-clear.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { crosses } from '../../src/layout/overlay-paths.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { centringFeeds } from '../../src/layout/read/feeds.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const run2 = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const centreX = (box: Rect): number => box.x + box.width / 2;
const frameOf = (model: LayoutModel, id: string) => model.frames!.find(frame => frame.id === id)!;
const boxOf = (model: LayoutModel, id: string): Rect => deriveFrames(model)!.find(frame => frame.id === id)!.box;
/** The canton frame box less the group margin: where a member frame may stand. */
const inner = (box: Rect): Rect => ({ x: box.x + 20, y: box.y, width: box.width - 40, height: box.height });
const inside = (wall: Rect, box: Rect): boolean => box.x >= wall.x - 1e-6 && right(box) <= right(wall) + 1e-6;
const held = (model: LayoutModel) => model.diagnostics.filter(item => item.code === 'COLUMN_AXIS_HELD');

// Canton-groups ticket 56, Section 2b: the member-level walls. Each assertion reads the model after the whole layout.
describe('canton member walls (canton-groups ticket 56)', () => {
  // Fixture 3. The measured numbers are in the ticket: hall 32.0 to 512.6, lab 340.6 wide, 102.0 to 442.6 at pack.
  it('a narrow tier is centred at pack and pulled to its feed only inside its canton column, and the canton is named when it holds it', async () => {
    const name = 'a-narrow-tier-is-centred-in-its-canton-column';
    const packed = await placed(fixture(name));
    expect(Math.abs(centreX(boxOf(packed, 'lab')) - centreX(boxOf(packed, 'west')))).toBeLessThan(1);
    const model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), hall = frameOf(model, 'hall'), lab = frameOf(model, 'lab');
    expect(model.anchorTier).toBe(0);
    // The wall holds: no growth of the canton, the member frame inside the canton frame with the group margin.
    expect(west.box.x).toBeCloseTo(boxOf(packed, 'west').x, 3);
    expect(west.box.width).toBeCloseTo(boxOf(packed, 'west').width, 3);
    expect(inside(inner(west.box), lab.box)).toBe(true);
    expect(inside(inner(west.box), hall.box)).toBe(true);
    // Pulled to its feed, by no more than the room the column leaves it: it stands flush with the wall.
    const room = inner(west.box).width - lab.box.width, moved = centreX(lab.box) - centreX(boxOf(packed, 'lab'));
    expect(moved).toBeGreaterThan(20);
    expect(moved).toBeLessThanOrEqual(room / 2 + 1e-6);
    expect(right(lab.box)).toBeCloseTo(right(inner(west.box)), 3);
    // The warning names the member, and the canton that holds it.
    const warning = held(model).find(item => item.owners?.[0] !== undefined && 'id' in item.owners[0] && item.owners[0].id === 'lab')!;
    expect(warning).toBeDefined();
    expect(warning.owners).toEqual([{ kind: 'group', id: 'lab' }, { kind: 'group', id: 'west' }]);
    expect(warning.message).toContain('canton west');
    expect(warning.message).toContain('the canton column holds it');
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Ticket 54 measured `w-lab` of fixture 2 47 px off the canton axis after `centre`. It stays inside its wall.
  it('a member that centring moved off the axis stays inside its column window (ticket 54, fixture 2)', async () => {
    const model = await run('two-canton-groups-are-disjoint-columns');
    for (const [member, canton] of [['w-site', 'west'], ['w-lab', 'west'], ['e-site', 'east'], ['e-lab', 'east']] as const) {
      const wall = inner(frameOf(model, canton).box), box = frameOf(model, member).box;
      expect(inside(wall, box), `${member} inside the canton ${canton}`).toBe(true);
      // The window is the room the wall leaves: the member is off the axis by at most half of it.
      expect(Math.abs(centreX(box) - centreX(frameOf(model, canton).box))).toBeLessThanOrEqual((wall.width - box.width) / 2 + 1e-6);
    }
    const lab = frameOf(model, 'w-lab'), west = frameOf(model, 'west');
    expect(Math.abs(centreX(lab.box) - centreX(west.box))).toBeGreaterThan(20);
  }, 60000);

  // Table fixture 6: a member widened after the pack.
  it('a member widened after the pack widens its canton, and the sibling canton moves as a whole', async () => {
    const name = 'a-member-widened-after-pack';
    const packed = await placed(fixture(name)), model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), east = frameOf(model, 'east');
    // Stage 7f widened the zone cell for its title: the canton box follows the member.
    expect(west.box.width).toBeGreaterThan(boxOf(packed, 'west').width + 10);
    expect(east.box.width).toBeGreaterThan(boxOf(packed, 'east').width + 10);
    // The rule that moves the sibling: on the packed model with the zone cell widened by 60 px (as 7f does for a title), `columnShifts`
    // moves every cell of every member of `east`, on both tiers, by one dx, and no cell of `west`.
    const clone = structuredClone(await rows(await placed(fixture(name)))) as LayoutModel;
    const body = clone.nodes['a-sync']!;
    body.bounds = { ...body.bounds!, width: body.bounds!.width + 60 };
    const shifts = columnShifts(clone, 0);
    const eastCells = ['c#0', 'c-zone#1', 'c-lab#0'], westCells = ['a#0', 'a-zone#1', 'a-lab#0'];
    expect(new Set(eastCells.map(cell => shifts.get(clone.groups[cell]!))).size).toBe(1);
    expect(shifts.get(clone.groups['c#0']!)).toBeGreaterThan(10);
    for (const cell of westCells) expect(shifts.has(clone.groups[cell]!)).toBe(false);
    // The cantons stand a band gap apart, and every member stands inside its canton.
    const [left, next] = west.box.x <= east.box.x ? [west, east] : [east, west];
    expect(next.box.x - right(left.box)).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    for (const [member, canton] of [['a', west], ['a-zone', west], ['a-lab', west], ['c', east], ['c-zone', east], ['c-lab', east]] as const) {
      expect(inside(inner(canton.box), frameOf(model, member).box), `${member} inside ${canton.id}`).toBe(true);
    }
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Section 2b rule 3: a one-node client group is a one-cell member; ticket 05's barycentre survives, inside the column.
  it('a one-cell member keeps its barycentre, clamped to the canton', async () => {
    const name = 'a-one-cell-member-keeps-its-barycentre-inside-the-column';
    const packed = await placed(fixture(name)), model = await run(name);
    const anchor = selectAnchorTier(packed)!;
    const free = overlayFreeGroups(packed, anchor);
    expect(free.has('clients#0')).toBe(true);
    expect(free.has('hall#0')).toBe(false);
    const west = frameOf(model, 'west'), clients = frameOf(model, 'clients');
    // At the mean x of its two overlay partners, to the left of the canton axis, inside the canton, which did not grow.
    const partners = ['h1', 'h2'].map(id => centreX(model.nodes[id]!.bounds!)), mean = (partners[0]! + partners[1]!) / 2;
    // The cell box stands at the mean; label growth (7f) widens the box on one side, so the node stands off it. Snack-theme ticket 157:
    // measured 6.0 px off with Verdana (3 px with Arial, bound 4): the wider Verdana title widens the cell box more on that side. The bound is 7 px.
    const cell = model.groups['clients#0']!.bounds!, k1 = model.nodes['k1']!.bounds!;
    expect(Math.abs(centreX(cell) - mean)).toBeLessThan(0.5);
    expect(Math.abs(centreX(k1) - mean)).toBeLessThan(7);
    expect(centreX(clients.box)).toBeLessThan(centreX(west.box) - 100);
    expect(inside(inner(west.box), clients.box)).toBe(true);
    expect(west.box.width).toBeCloseTo(boxOf(packed, 'west').width, 3);
    // The pack put it on the axis: the barycentre moved it.
    expect(Math.abs(centreX(boxOf(packed, 'clients')) - centreX(boxOf(packed, 'west')))).toBeLessThan(1);
  }, 60000);

  it('a clamped barycentre stops at the wall: the partner is beyond the column', async () => {
    // Move the two partners of the client to the right end of the hall, so the mean is right of the canton axis; the wall holds it.
    const source = fixture('a-one-cell-member-keeps-its-barycentre-inside-the-column').replace('{ from: h1,', '{ from: h6,').replace('{ from: h2,', '{ from: h5,');
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const west = frameOf(model, 'west'), clients = frameOf(model, 'clients');
    expect(inside(inner(west.box), clients.box)).toBe(true);
    expect(centreX(clients.box)).toBeGreaterThan(centreX(west.box) + 100);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Table fixture 5: held-lane parity with tickets 04, 14 and 23.
  it('a held lane inside the column grows the canton box, and the foreign lane stands outside it at one x', async () => {
    const name = 'a-transit-inside-a-canton';
    const packed = await placed(fixture(name)), model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west');
    const own = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-4');
    const foreign = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-5');
    expect(own).toHaveLength(1);
    // The lane of gate-a to deep-a stands inside the canton frame, which grew to hold it.
    expect(own[0]!.bounds.x).toBeGreaterThanOrEqual(west.box.x - 1e-6);
    expect(right(own[0]!.bounds)).toBeLessThanOrEqual(right(west.box) + 1e-6);
    const growth = boxOf(packed, 'west').x - west.box.x;
    expect(growth).toBeGreaterThan(10);
    // The foreign lane: one x for the three tiers, outside the canton frame.
    expect(foreign).toHaveLength(3);
    expect(new Set(foreign.map(lane => lane.bounds.x)).size).toBe(1);
    expect(right(foreign[0]!.bounds)).toBeLessThanOrEqual(west.box.x + 1e-6);
    for (const member of ['gate', 'mid', 'deep']) expect(inside(inner(west.box), frameOf(model, member).box), member).toBe(true);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Review B1: `sweepMembers` walls the lanes held in the tier as `sweep` does, so a free member never stands on a lane.
  it('a free member stands beside a held lane inside its canton, and the layout does not throw', async () => {
    const name = 'a-free-member-beside-a-held-lane-inside-its-canton';
    const model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), mid = frameOf(model, 'mid');
    const lane = model.lanes.find(item => item.tier === 2 && item.owner.kind === 'link' && model.links.find(link => link.id === (item.owner as { id: string }).id)?.attachments?.from.node === 'g1')!;
    expect(lane).toBeDefined();
    // The lane and the member share the tier and do not overlap; both stand inside the canton frame.
    expect(right(lane.bounds) <= mid.box.x + 1e-6 || lane.bounds.x >= right(mid.box) - 1e-6).toBe(true);
    expect(inside(inner(west.box), mid.box)).toBe(true);
    expect(lane.bounds.x).toBeGreaterThanOrEqual(west.box.x - 1e-6);
    expect(right(lane.bounds)).toBeLessThanOrEqual(right(west.box) + 1e-6);
    const gates = score(model).snapshot.gates as Record<string, { passed: boolean }>;
    const failing = Object.entries(gates).filter(([, gate]) => !gate.passed).map(([name]) => name);
    expect(failing).toEqual([]);
    expect(gates['G9']?.passed).toBe(true);
  }, 60000);

  // Table fixture 8: canton, member, leaf child beside its parent's cells.
  it('a leaf zone stands inside its member inside its canton, and no route of the member is left to the router', async () => {
    const model = await run('a-leaf-child-beside-its-parent-inside-a-canton');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), loc = frameOf(model, 'loc'), zone = frameOf(model, 'zone');
    expect(zone.parent).toBe('loc');
    expect(loc.parent).toBe('west');
    // Two frames deep: 20 px to the member, 20 px more to the canton.
    expect(zone.box.x - west.box.x).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(right(west.box) - right(zone.box)).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(inside(loc.box, zone.box)).toBe(true);
    // The row stands packed after the whole layout: `packBesideRows` moves none of the cells. `wing` stands 40 px from `loc` (ticket 61: 7f
    // widened the cell of `loc` for its title, and the beside row is packed again after 7f; it was 41).
    const clone = structuredClone(model) as LayoutModel;
    expect(packBesideRows(clone)).toBe(false);
    expect(frameOf(model, 'wing').box.x - right(loc.box)).toBeCloseTo(40, 3);
    // The internal link is planned: no part of the model is left to the router.
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL')).toEqual([]);
    const internal = model.links.find(link => link.attachments?.from.node === 'gw' && link.attachments?.to.node === 'sw')!;
    expect(internal.path?.segments.length).toBeGreaterThan(0);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Ticket 54 measured 40 and 44 px for three beside members.
  it('three members of one tier: 40 px at rows time and after 7f (ticket 61)', async () => {
    const name = 'a-canton-holds-three-members-on-one-tier';
    const atRows = await rows(await placed(fixture(name)));
    const gaps = (model: LayoutModel): number[] => {
      const [a, b, c] = ['alpha', 'beta', 'gamma'].map(id => boxOf(model, id));
      return [b!.x - right(a!), c!.x - right(b!)];
    };
    for (const gap of gaps(atRows)) expect(gap).toBeCloseTo(40, 3);
    const model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const [first, second] = gaps(model);
    // 7f widens the cell of `beta` by 4 px for its title and `pushFollowingGroups` moves `gamma` by the growth of the cell; the frame of `beta`
    // does not grow (it is derived from the bodies), so the beside row is packed again after 7f (ticket 61) and the gap stays 40.
    expect(first).toBeCloseTo(40, 3);
    expect(second).toBeCloseTo(40, 3);
    // The inner pass never moves members that share a sub-tier: a second pass on the finished layout moves nothing.
    expect(holdMemberWalls(structuredClone(model))).toBe(false);
  }, 60000);

  // Fixture 9: idempotence. A second layout is the same model, and every rule that moves a column finds nothing to do on the finished layout.
  it.each([
    'two-canton-groups-are-disjoint-columns',
    'a-narrow-tier-is-centred-in-its-canton-column',
    'a-member-widened-after-pack',
    'a-one-cell-member-keeps-its-barycentre-inside-the-column',
    'a-transit-inside-a-canton',
    'a-free-member-beside-a-held-lane-inside-its-canton',
    // Ticket 64: the pull reads the owned lane of a transit feed, as centring does, so the last rule to run cannot flip the member.
    'a-one-rank-member-beside-a-two-rank-member',
    // Ticket 67: the finished layout is a fixed point of the column pull (a packed run with a pin; the lone column stays open, see the ticket).
    'a-canton-group-swap-is-refused-for-routed-crossings',
    'three-canton-groups-close-up-to-a-band-gap',
    // Tickets 69 and 70: the pull reads a transit from beyond the authority tier, and a declined member stands at the in-wall x nearest its feed, where the pull puts it.
    'a-transit-from-beyond-the-authority-tier-into-a-member',
  ])('%s: a second layout is the same model and the column rules move nothing on it', async name => {
    const first = await run(name), second = await run(name);
    // The stage timings are the only thing that differs between two runs.
    const same = (model: LayoutModel): string => JSON.stringify({ ...model, runtime: undefined });
    expect(same(second)).toBe(same(first));
    const clone = structuredClone(first) as LayoutModel;
    const before = JSON.stringify(Object.values(clone.groups).map(group => [group.id, group.bounds]));
    // `separateFrameColumns` keeps the rows-time gap (a band gap and two slacks) and is not asked of a finished layout; `columnShifts` with the
    // slack of 7f is. The inner pass is the one of this ticket.
    // Every sheet is at rest. (Before ticket 17 three-canton-groups still had 4 shifts to make: the chord step had left a gap under the band gap, and closing it would have bent a straight link.)
    expect([columnShifts(clone, 0).size, packBesideRows(clone), holdMemberWalls(clone), holdColumnAxes(clone, 0)])
      .toEqual([0, false, false, false]);
    // A second pull moves no unit, so none goes farther from its feed range either (ticket 67).
    const moved = Object.values(clone.groups).map(group => Math.abs(group.bounds!.x - (JSON.parse(before) as [string, Rect][]).find(([id]) => id === group.id)![1].x));
    expect(Math.max(0, ...moved)).toBe(0);
    placeOverlayFree(clone);
    expect(JSON.stringify(Object.values(clone.groups).map(group => [group.id, group.bounds]))).toBe(before);
  }, 60000);

  // Ticket 67: the mixed run of a foreign unit between two cantons converges by a third each round of 7f (1.551, 0.517, 0.172 px), and the rounds end
  // under the creep of half a pixel. What is left is that creep, not a pull that goes the wrong way: a second pull moves the run as one block by less
  // than it. The bound of 0.1 is measured (0.057); the guaranteed bound is CANTON_CREEP x the ratio of the rounds, about 0.167.
  it('a-foreign-unit-with-routed-links-to-two-canton-groups: a second pull moves the run by less than the creep of the rounds', async () => {
    const clone = structuredClone(await run('a-foreign-unit-with-routed-links-to-two-canton-groups')) as LayoutModel;
    const before = Object.values(clone.groups).map(group => group.bounds!.x);
    holdColumnAxes(clone, 0);
    const moved = Object.values(clone.groups).map((group, i) => Math.abs(group.bounds!.x - before[i]!));
    expect(Math.max(...moved)).toBeLessThan(0.1);
  }, 60000);
  // Ticket 70, review: a declined member is stood at the nearest in-wall x to its feeds, clamped at the straight overlay chord as the main move is.
  // The fixture declines the provider at its canton wall. The clamp is inert on it (measured: the target already lies on the near side of the chord), so this holds the
  // outcome, not the clamp alone; no fixture of the corpus makes a declined body grown with a chord in the way (ticket 70 review).
  it('a-declined-grown-member-stops-at-an-overlay-chord: the declined member stays off the chord and inside its canton', async () => {
    const model = await run('a-declined-grown-member-stops-at-an-overlay-chord');
    const clock = model.nodes['clock']!.bounds!, lab = model.nodes['lab']!.bounds!, provider = model.nodes['provider']!.bounds!;
    const chord = centreX(clock);
    expect(Math.abs(chord - centreX(lab))).toBeLessThan(1e-6);
    expect(chord <= provider.x || chord >= right(provider), 'the chord does not run through the provider').toBe(true);
    expect(inside(inner(boxOf(model, 'west')), frameOf(model, 'providers').box)).toBe(true);
  }, 60000);

  // Ticket 136: every published layout stands at the fixed point of the three column rules, hinted or not. The pack is the rule that a widening of a
  // box after the last pack (the linked-group grid) used to leave behind.
  const settled = (model: LayoutModel): boolean[] => {
    const clone = structuredClone(model) as LayoutModel;
    return [packBesideRows(clone), holdMemberWalls(clone), holdColumnAxes(clone, 0)];
  };
  it('three-canton-groups-close-up-to-a-band-gap with a side hint on m1 and the feed order on: the finished layout is the fixed point of the pack (ticket 25)', async () => {
    const hinted = await layout(parse(fixture('three-canton-groups-close-up-to-a-band-gap')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false,
      testSideHints: new Map([[portKey({ node: 'm1', anonymous: true, name: null, ordinal: 2 } as never), 'left' as const]]) });
    expect(settled(hinted)).toEqual([false, false, false]);
    expect(hinted.diagnostics.filter(item => item.code === 'GROUP_GRID_NON_CONVERGENCE')).toEqual([]);
    // Verdana metrics (snack-theme ticket 157): 1996 px wide, 1905 with Arial.
    expect(hinted.canvas!.width).toBeCloseTo(1996, -1);
  }, 60000);
  it('three-canton-groups-close-up-to-a-band-gap with a side hint on m1: the finished layout is the fixed point of the pack (ticket 136)', async () => {
    // The hint frees link-4 to the left face of m1 (the port the side round offers); the wider node changes the grid of a linked pair after 7f packed the row.
    // The feed order is off here (ticket 25): with it on, the zones of canton a stand under their feeds and the grid no longer meets the pack,
    // so the subject is gone; the rule-on run is checked in the test below.
    const hinted = await layout(parse(fixture('three-canton-groups-close-up-to-a-band-gap').replace('portograph: 2\n', 'portograph: 2\nlayout: { feedOrder: false }\n')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false,
      testSideHints: new Map([[portKey({ node: 'm1', anonymous: true, name: null, ordinal: 2 } as never), 'left' as const]]) });
    // The hint took: the port is a hinted lateral port (the fixture is not the plain layout by another name).
    const port = hinted.nodes['m1']!.ports.find(item => portKey(item.ref) === portKey({ node: 'm1', anonymous: true, name: null, ordinal: 2 } as never))!;
    expect([port.sideHint, port.side]).toEqual([true, 'left']);
    expect(settled(hinted)).toEqual([false, false, false]);
    // The grid and the pack settle inside their round bound (they did not step against each other, 22 to 45 grid passes in 4 rounds, before ticket 136's rework).
    expect(hinted.diagnostics.filter(item => item.code === 'GROUP_GRID_NON_CONVERGENCE')).toEqual([]);
    // Pinned: the grid gives way to the pack. With the widening allowed, the pair takes one extent of 534.1 px at x 1070.3 and the canvas is 2182 px wide.
    const loc = hinted.groups['loc-a2#0']!.bounds!;
    // Ticket 143: the window rule stands cl-a3 at x 765.3 (gaining two straight overlay chords) and the pack that follows reads that place: loc-a2 stands at x 1084.9, 224.6 wide (main: 982.1, 372.4 wide) and the canvas is 118 px narrower. The price: the overlay bent count of this hinted run goes from 9 to 10: link-45 (`loc-a2-sw` to `cl-a3-2`) bends, because the pack that follows the window moves `loc-a2` and the 7f step does not repair it (ticket 143 review, finding 1).
    // Snack-theme ticket 157, Verdana metrics: loc-a2 stands at x 1050.3, 345.7 wide (1084.9 and 224.6 with Arial), and the canvas is 2094 px
    // wide (1921 with Arial). Measured again with the widening allowed (the ticket 136 refusal off): loc-a2 at x 1131.2, 235.5 wide, and the
    // canvas 2019.7 px wide, also a fixed point of the pack. With Arial the canvas told the two apart (1921 against 2182, a bound of 2100);
    // with Verdana the widening is the narrower one, so the extent of loc-a2 and the yield below are the witnesses, not a canvas bound.
    expect([loc.x, loc.width]).toEqual([expect.closeTo(1050.3, 1), expect.closeTo(345.7, 1)]);
    expect(hinted.canvas!.width).toBeCloseTo(2094, -1);
    const yields = hinted.diagnostics.filter(item => item.code === 'GROUP_GRID_YIELDS_TO_PACK');
    expect(yields.length).toBeGreaterThan(0);
    expect(yields.every(item => item.severity === 'info' && item.owners!.length >= 2)).toBe(true);
  }, 60000);
  it.each([
    'two-canton-groups-are-disjoint-columns', 'three-canton-groups-close-up-to-a-band-gap', 'a-canton-group-frames-two-tiers', 'a-canton-holds-three-members-on-one-tier',
    'a-canton-holds-two-members-on-one-tier', 'a-child-frame-stands-inside-its-parent', 'a-frame-shares-the-grid-with-its-linked-group', 'a-leaf-child-and-its-beside-cells-stay-one-row',
    'a-leaf-child-beside-its-parent-inside-a-canton', 'a-leaf-child-stands-beside-its-parent-members', 'a-member-title-widens-a-beside-row', 'a-member-widened-after-pack',
    'a-one-rank-member-beside-a-two-rank-member', 'a-foreign-unit-between-two-canton-groups', 'a-canton-with-a-tier-below', 'a-group-with-no-links-stands-beside-a-canton',
  ])('%s: with no hint the finished layout is the fixed point of the pack, the member walls and the column axes (ticket 136)', async name => {
    expect(settled(await run(name))).toEqual([false, false, false]);
  }, 60000);
});

/** Every link from a bottom port to a top port, with how far its two ends stand apart in x. */
const drops = (model: LayoutModel): { link: string; dx: number }[] => model.links.flatMap(link => {
  if (!link.attachments || link.removed) return [];
  const from = findPort(model, link.attachments.from)!, to = findPort(model, link.attachments.to)!;
  return new Set([from.side, to.side]).size === 2 && [from.side, to.side].every(side => side === 'top' || side === 'bottom') ? [{ link: link.id, dx: to.anchor!.x - from.anchor!.x }] : [];
});

// Architecture-2 ticket 31: a canton member above the anchor tier reserves its aligned extent (the anchor-tier feed x, the end-port insets and the side-face
// pills) once, in placement (`alignedExtents`); the 7c member window and the canton wall of the inner column pass read that one record.
describe('a drop from a wide parent stands vertical (architecture-2 ticket 31)', () => {
  it.each(['a-drop-from-a-wide-parent-stands-vertical', 'a-drop-from-a-wide-parent-stands-vertical-over-a-narrow-row'])('%s: every drop stands at one x', async name => {
    const model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const all = drops(model);
    expect(all.map(item => item.link).sort()).toEqual(['link-1', 'link-2', 'link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8']);
    expect(all.filter(item => Math.abs(item.dx) > 0.5)).toEqual([]);
    // One answer: the offset step does not hold the parent ports, and the canton does not hold the member.
    expect(model.diagnostics.filter(item => ['CENTRE_PARENT_MOVE_SHIFTS_GROUP', 'COLUMN_AXIS_HELD', 'CENTRE_WINDOW_DECLINED'].includes(item.code))).toEqual([]);
    // The record: the member above the anchor tier reserves room, and the anchor member reserves none.
    expect(Object.keys(model.alignedExtents ?? {})).toEqual(['core#0']);
    // The layout is the fixed point of the publication check and of the member walls.
    expect(centreViolations(model)).toEqual([]);
    expect(holdMemberWalls(structuredClone(model) as LayoutModel)).toBe(false);
  }, 60000);

  it('a-drop-from-a-wide-parent-stands-vertical: the bundle seats, the ports beside the bundle and the wall-move replay stay as on main', async () => {
    const model = await run('a-drop-from-a-wide-parent-stands-vertical');
    const x = (node: string, port: string): number => model.nodes[node]!.ports.find(item => item.ref.name === port)!.anchor!.x;
    // The bundle ends agree (tickets 08 and 09) at the x main gives them (measured on main 33c62c16), with its member gap.
    expect([x('sw', 'p5'), x('sw', 'p4'), x('srv', 'n1'), x('srv', 'n0')]).toEqual([355.25, 372.75, 355.25, 372.75]);
    expect(model.bundles.map(bundle => [bundle.id, bundle.memberGap, bundle.memberPitch])).toEqual([['bundle-1', 16, 17.5]]);
    // The ports beside the bundle keep their side of it.
    expect([x('sw', 'p3') < x('sw', 'p5'), x('sw', 'p4') < x('sw', 'p6')]).toEqual([true, true]);
    // No parent-port move is taken at a frame-column wall, so the wall-move replay has nothing to give back (as on main).
    expect(model.parentWallMoves).toBeUndefined();
  }, 60000);

  it('without the record the canton wall holds the member again: absent reserves nothing, and a later replay that finds it absent says so', async () => {
    const model = structuredClone(await run('a-drop-from-a-wide-parent-stands-vertical')) as LayoutModel;
    const bare = structuredClone(model) as LayoutModel;
    delete bare.alignedExtents;
    // The wall the anchor row alone makes (its member frame and the group margin): the member's room holds its frame on the record, and not without it.
    const edge = frameOf(model, 'edge').box, core = frameOf(model, 'core').box, wall = { x: edge.x - 20, width: edge.width + 40 };
    const holds = (room: { low: number; high: number }): boolean => room.low <= core.x + 1e-6 && core.x + core.width <= room.high + 1e-6;
    expect(holds(memberRoom(model, wall, core, ['core#0'], 20))).toBe(true);
    expect(holds(memberRoom(bare, wall, core, ['core#0'], 20))).toBe(false);
    // Centring outside the centre rule does not decide: it reserves nothing and names the missing record (R6).
    centreDraft(bare, createCentreBudget());
    expect(bare.alignedExtents).toBeUndefined();
    expect(bare.diagnostics.filter(item => item.code === 'ALIGNED_EXTENTS_UNDECIDED').length).toBe(1);
  }, 60000);

  it('a sheet with a canton and no member above its anchor tier records an empty decision, and a sheet with no canton records none', async () => {
    const model = await run('a-narrow-tier-is-centred-in-its-canton-column');
    const cantonCells = Object.values(model.groups).filter(group => group.frame !== undefined);
    expect(cantonCells.length).toBeGreaterThan(0);
    expect(cantonCells.every(group => group.tier! >= model.anchorTier!)).toBe(true);
    expect(model.alignedExtents).toEqual({});
    expect((await run('parent-two-children')).alignedExtents).toBeUndefined();
  }, 60000);

  it('a member above the anchor tier whose feeds stand outside its canton reserves nothing (a-canton-member-frame-slides-off-a-straight-chord)', async () => {
    const model = await run('a-canton-member-frame-slides-off-a-straight-chord');
    const tier = model.groups['loc-zone#1']!.tier!;
    expect(tier).toBeLessThan(model.anchorTier!);
    const feeds = centringFeeds(model, tier, model.anchorTier!).filter(feed => model.document.nodes[feed.child.ref.node]!.group === 'loc-zone#1');
    expect(feeds.length).toBeGreaterThan(0);
    expect(feeds.every(feed => model.groups[model.document.nodes[feed.parent.ref.node]!.group]!.frame === undefined)).toBe(true);
    expect(model.alignedExtents).toEqual({});
  }, 60000);

  it('a member above the anchor tier with a transit feed reserves nothing (a-transit-inside-a-canton)', async () => {
    const model = await run('a-transit-inside-a-canton');
    const tier = model.groups['gate#0']!.tier!;
    expect(tier).toBeLessThan(model.anchorTier!);
    const feeds = centringFeeds(model, tier, model.anchorTier!).filter(feed => model.document.nodes[feed.child.ref.node]!.group === 'gate#0');
    expect(feeds.some(feed => feed.transit)).toBe(true);
    expect(model.alignedExtents).toEqual({});
  }, 60000);

  it('a member on its aligned extent that an overlay chord crosses keeps its x in the whole-group chord step (memberRoom, review re-check)', async () => {
    // The fixture moved one tier down, between two free groups whose overlay link crosses the member's tier.
    const yaml = fixture('a-drop-from-a-wide-parent-stands-vertical')
      .replace('core: { tier: 0, canton: site', 'core: { tier: 1, canton: site').replace('edge: { tier: 1, canton: site', 'edge: { tier: 2, canton: site')
      .replace('groups:\n', 'groups:\n  top: { tier: 0, label: Top }\n  bottom: { tier: 3, label: Bottom }\n')
      .replace('nodes:\n', 'nodes:\n  t: { group: top, label: t }\n  u: { group: bottom, label: u }\n')
      .trimEnd() + '\n  - [t, u, { class: sync }]\n';
    const model = structuredClone(await run2(yaml)) as LayoutModel;
    expect(Object.keys(model.alignedExtents ?? {})).toEqual(['core#0']);
    // Stand the chord on the switch: both free ends over the middle of its body. They are then kept in place (history), so the step can only
    // move the member, and a move would take its drops off their feeds.
    const sw = model.nodes['sw']!.bounds!, middle = sw.x + sw.width / 2;
    for (const id of ['top', 'bottom']) {
      const group = model.groups[id]!;
      moveGroup(model, group, middle - (group.bounds!.x + group.bounds!.width / 2), 0);
      rebuildNodeGeometry(model, group.nodes, 'current');
    }
    const t = model.nodes['t']!.bounds!, u = model.nodes['u']!.bounds!;
    expect(crosses({ x: t.x + t.width / 2, y: t.y + t.height }, { x: u.x + u.width / 2, y: u.y }, sw)).toBe(true);
    const at = model.groups['core#0']!.bounds!.x;
    stepOverChords(model, undefined, new Set(['top', 'bottom']));
    expect(model.groups['core#0']!.bounds!.x).toBeCloseTo(at, 6);
    expect(drops(model).filter(item => item.link !== 'link-9' && Math.abs(item.dx) > 0.5)).toEqual([]);
  }, 60000);

  it('a-declined-grown-member-stops-at-an-overlay-chord: a feed outside the canton reserves no room, and the declined step names its group and links', async () => {
    const model = await run('a-declined-grown-member-stops-at-an-overlay-chord');
    expect(model.alignedExtents).toEqual({});
    const declined = model.diagnostics.filter(item => item.code === 'CENTRE_WINDOW_DECLINED');
    expect(declined.length).toBe(1);
    expect(declined[0]!.owners).toEqual([{ kind: 'group', id: 'providers#0' }, ...['link-1', 'link-2', 'link-3', 'link-4'].map(id => ({ kind: 'link', id }))]);
    expect(declined[0]!.message).toMatch(/^providers#0 declines its alignment: .*, so link-1, link-2, link-3, link-4 keep a jog; routing completes them\.$/);
  }, 60000);
});
