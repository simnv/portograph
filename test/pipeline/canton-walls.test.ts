import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { columnShifts, holdColumnAxes, holdMemberWalls, overlayFreeGroups, packBesideRows } from '../../src/layout/columns.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { selectAnchorTier } from '../../src/layout/lanes.js';
import { placeOverlayFree } from '../../src/layout/overlay-place.js';
import { rows } from '../../src/layout/rows.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
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
    expect(Math.abs(centreX(model.nodes['k1']!.bounds!) - mean)).toBeLessThan(4);
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
    // Ticket 67: the finished layout is a fixed point of the column pull (a packed run with a pin; the lone column stays open, see the ticket).
    'a-canton-group-swap-is-refused-for-routed-crossings',
    'three-canton-groups-close-up-to-a-band-gap',
  ])('%s: a second layout is the same model and the column rules move nothing on it', async name => {
    const first = await run(name), second = await run(name);
    // The stage timings are the only thing that differs between two runs.
    const same = (model: LayoutModel): string => JSON.stringify({ ...model, runtime: undefined });
    expect(same(second)).toBe(same(first));
    const clone = structuredClone(first) as LayoutModel;
    const before = JSON.stringify(Object.values(clone.groups).map(group => [group.id, group.bounds]));
    // `separateFrameColumns` keeps the rows-time gap (a band gap and two slacks) and is not asked of a finished layout; `columnShifts` with the
    // slack of 7f is. The inner pass is the one of this ticket.
    expect([columnShifts(clone, 0).size, packBesideRows(clone), holdMemberWalls(clone), holdColumnAxes(clone, 0)]).toEqual([0, false, false, false]);
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
});
