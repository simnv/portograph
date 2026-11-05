import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { LayoutGroup, LayoutLink } from '../../src/model/layout.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { ROW_ORDER_BUDGET, ROW_ORDER_PERMUTED_NODES, validateRowOrderDecisions } from '../../src/layout/corridor-order.js';
import {
  groupOrderCandidates, groupRuns, jointAccepted, jointBetter, jointLinks, jointRecord, leftOutRows, orderJointFreeRows, rowCombinations,
  rowFeedCandidates, seatPredicted7c, sideVectors, tierRanks, JOINT_GROUP_RUN, JOINT_ROW_ORDERS, JOINT_TRANSIT_SIDES, type GroupRun,
} from '../../src/layout/joint-order.js';
import { orderTools, readDraft } from '../../src/layout/overlay-order.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { withdrawCorridorSide } from '../../src/layout/lanes.js';
import { refreshFeedOrders } from '../../src/layout/feed-order.js';
import { corridorSideFailure, groupOrderFailure, ofKind, reservation, validateReservations } from '../../src/layout/reservations.js';
import { createColdAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const FACE = sheet('a-free-row-follows-both-tiers'), SINKS = sheet('a-sink-group-order-follows-the-free-row'), SIDES = sheet('a-transit-side-is-decided-in-stage-4');
/** The same sheet with the feed orders off: the joint order does not run (these sheets have no rank cell and no frame). */
const off = (yaml: string): string => yaml.replace('portograph: 2\n', 'portograph: 2\nlayout: { feedOrder: false }\n');
/** The sheet mirrored: every group and every node declared the other way round. */
const mirror = (yaml: string): string => {
  const head: string[] = [], groups: string[] = [], nodes: string[] = [], rest: string[] = [];
  let section: 'head' | 'groups' | 'nodes' | 'rest' = 'head';
  for (const line of yaml.split('\n')) {
    if (line.startsWith('groups:')) { section = 'groups'; continue; }
    if (line.startsWith('nodes:')) { section = 'nodes'; continue; }
    if (line.startsWith('links:')) section = 'rest';
    if (section === 'groups' && line.startsWith('  ')) groups.push(line);
    else if (section === 'nodes' && line.startsWith('  ')) nodes.push(line);
    else (section === 'head' ? head : rest).push(line);
  }
  return [...head, 'groups:', ...groups.reverse(), 'nodes:', ...nodes.reverse(), ...rest].join('\n');
};
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt });
const skeletonOf = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt: createColdAttempt });
  return model;
};
const crossings = (model: LayoutModel): number => { const { count, faint } = score(model).snapshot.metrics.crossings; return count - (faint ?? 0); };
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };
const sides = (model: LayoutModel): string[] => ofKind(model.reservations ?? [], 'corridorSide').map(({ payload }) => `${payload.link} ${payload.side} of ${payload.group}`).sort();
const swap = (text: string): string => text.replace(/\b(left|right)\b/, side => side === 'left' ? 'right' : 'left');

describe('the joint stage-4 order (architecture-2 ticket 72)', () => {
  it('turns the anchor row with the sink order and the corridor sides, where no sweep judges it (a-free-row-follows-both-tiers)', async () => {
    const [joint, alone] = await Promise.all([run(FACE), run(off(FACE))]);
    expect(joint.groups.aggr!.rowOrderDecision).toEqual({ rule: 'feed-order', before: ['ag0', 'ag1', 'ag2', 'ag3', 'ag4'], after: ['ag2', 'ag4', 'ag0', 'ag1', 'ag3'] });
    expect(alone.groups.aggr!.rowOrderDecision!.rule).toBe('kept');
    expect(sides(joint)).toEqual(['link-10 left of aggr', 'link-11 right of aggr']);
    expect(sides(alone)).toEqual([]);
    expect([crossings(joint), bends(joint)]).toEqual([1, 6]);
    expect([crossings(alone), bends(alone)]).toEqual([7, 8]);
    expect(validateRowOrderDecisions(joint)).toEqual([]);
  }, 120000);

  it('records the group order of the outward tier with its premise, the free row (a-sink-group-order-follows-the-free-row)', async () => {
    const [joint, alone] = await Promise.all([run(SINKS), run(off(SINKS))]);
    const entries = ofKind(joint.reservations ?? [], 'groupOrder');
    expect(entries.map(({ payload }) => payload)).toEqual([{ tier: joint.groups['leaf-near']!.tier, order: ['leaf-near', 'leaf-far'], feeds: [{ row: 'aggr', order: ['ag2', 'ag4', 'ag0', 'ag1', 'ag3'] }] }]);
    expect(joint.groups['leaf-near']!.bounds!.x).toBeLessThan(joint.groups['leaf-far']!.bounds!.x);
    expect(alone.groups['leaf-far']!.bounds!.x).toBeLessThan(alone.groups['leaf-near']!.bounds!.x);
    expect(groupOrderFailure(entries[0]!, joint)).toBeUndefined();
    expect([crossings(joint), crossings(alone)]).toEqual([1, 5]);
    expect(bends(joint)).toBeLessThan(bends(alone));
  }, 120000);

  it('reserves the corridor sides that 7a allocates and every later stage keeps (a-transit-side-is-decided-in-stage-4)', async () => {
    const [joint, alone] = await Promise.all([run(SIDES), run(off(SIDES))]);
    expect(sides(joint)).toEqual(['link-12 left of aggr', 'link-13 right of aggr']);
    const aggr = joint.groups.aggr!.bounds!;
    for (const { payload } of ofKind(joint.reservations ?? [], 'corridorSide')) {
      const lane = joint.lanes.find(item => item.owner.kind === 'link' && item.owner.id === payload.link && item.tier === payload.tier)!;
      expect(payload.side === 'left' ? lane.x < aggr.x : lane.x > aggr.x + aggr.width).toBe(true);
    }
    for (const entry of ofKind(joint.reservations ?? [], 'corridorSide')) expect(corridorSideFailure(entry, joint)).toBeUndefined();
    // Bends 2 before architecture-2 ticket 73: the feed split stands both sink groups under their feeds.
    expect([crossings(joint), bends(joint)]).toEqual([1, 0]);
    expect([crossings(alone), bends(alone)]).toEqual([6, 5]);
  }, 120000);

  it('decides the mirror image on mirrored input, and the published crossings stay (R3)', async () => {
    for (const yaml of [FACE, SINKS, SIDES]) {
      const [one, two] = await Promise.all([skeletonOf(yaml), skeletonOf(mirror(yaml))]);
      expect(two.groups.aggr!.rowOrderDecision!.after).toEqual([...one.groups.aggr!.rowOrderDecision!.after].reverse());
      expect(sides(two)).toEqual(sides(one).map(swap).sort());
      expect(ofKind(two.reservations ?? [], 'groupOrder').map(({ payload }) => [...payload.order].reverse()))
        .toEqual(ofKind(one.reservations ?? [], 'groupOrder').map(({ payload }) => [...payload.order]));
    }
    const published = await Promise.all([FACE, mirror(FACE), SINKS, mirror(SINKS), SIDES, mirror(SIDES)].map(run));
    expect(published.map(crossings)).toEqual([1, 1, 1, 1, 1, 1]);
    // Bends follow the stages after 4 on the first two shapes (main's own mirror of the a-face shape goes from 7 to 15 crossings); the sheet
    // whose later stages are symmetric publishes the same bends (2 and 2 before the feed split of architecture-2 ticket 73).
    expect(published.map(bends)).toEqual([6, 8, 4, 6, 0, 0]);
  }, 300000);

  it('the 7c predictor raises no published crossing; where the draft counts a crossing the published sheet never had, it gains none (the oracle)', async () => {
    // The ticket's oracle experiment over the corpus: 38 sheets with an accepted candidate, 27 with fewer published crossings, 11 with as many,
    // none with more. The bound this test holds: no rise on these sheets, and no fall on two of the eleven.
    const gains = ['a-free-row-follows-both-tiers', 'a-sink-group-order-follows-the-free-row', 'a-transit-side-is-decided-in-stage-4'];
    const level = ['a-declined-feed-grows-no-body', 'a-row-stretches-a-body-past-its-sibling'];
    for (const name of [...gains, ...level]) {
      const [joint, alone] = await Promise.all([run(sheet(name)), run(off(sheet(name)))]);
      if (gains.includes(name)) expect(crossings(joint)).toBeLessThan(crossings(alone));
      else expect(crossings(joint)).toBe(crossings(alone));
    }
  }, 300000);
});

describe('the parts of the joint order', () => {
  it('reads normalized ranks, one slot per node of a one-row group', async () => {
    const model = await skeletonOf(off(FACE));
    const ranks = tierRanks(model, model.groups.aggr!.tier);
    expect([...ranks.values()].sort()).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(tierRanks(model, undefined).size).toBe(0);
  }, 60000);

  it('builds the row candidates with the current order first and no repeat; a row with no key keeps its order (R3)', async () => {
    const model = await skeletonOf(off(FACE)), links = jointLinks(model), aggr = model.groups.aggr!;
    const tier = aggr.tier!, candidates = rowFeedCandidates(model, links, aggr, tierRanks(model, tier - 1), tierRanks(model, tier + 1));
    expect(candidates[0]).toEqual(['ag0', 'ag1', 'ag2', 'ag3', 'ag4']);
    expect(new Set(candidates.map(order => order.join())).size).toBe(candidates.length);
    expect(candidates.length).toBeLessThanOrEqual(6);
    expect(candidates).toContainEqual(['ag2', 'ag4', 'ag0', 'ag1', 'ag3']);
    expect(rowFeedCandidates(model, links, aggr, new Map(), new Map())).toEqual([['ag0', 'ag1', 'ag2', 'ag3', 'ag4']]);
  }, 60000);

  it('enumerates the group orders and names a cap', () => {
    const groups = (ids: string[]): LayoutGroup[] => ids.map(id => ({ id }) as LayoutGroup);
    const runOf = (ids: string[], permute = true): GroupRun => ({ groups: groups(ids), wallLeft: -Infinity, wallRight: Infinity, permute });
    const caps = new Set<string>();
    expect(groupOrderCandidates([runOf(['a', 'b', 'c'])], caps, 2)).toEqual([[['a', 'b', 'c']], [['a', 'c', 'b']], [['b', 'a', 'c']], [['b', 'c', 'a']], [['c', 'a', 'b']], [['c', 'b', 'a']]]);
    expect(groupOrderCandidates([runOf(['a', 'b'], false)], caps, 2)).toEqual([[['a', 'b']]]);
    expect(caps.size).toBe(0);
    const long = Array.from({ length: JOINT_GROUP_RUN + 1 }, (_, i) => `g${i}`);
    expect(groupOrderCandidates([runOf(long)], caps, 2)).toEqual([[long], [[...long].reverse()]]);
    expect([...caps]).toEqual([`a group run of sub-tier 2 has ${long.length} groups, so only its reverse was judged`]);
    caps.clear();
    const combos = groupOrderCandidates([runOf(['a', 'b', 'c', 'd']), runOf(['e', 'f'])], caps, 3);
    expect(combos.length).toBe(25);
    expect(combos[0]).toEqual([['a', 'b', 'c', 'd'], ['e', 'f']]);
    expect([...caps]).toEqual(['the group runs of sub-tier 3 have 48 orders together, so a further run was judged once turned']);
  });

  it('enumerates the side vectors with the current sides first, and names a cap', () => {
    const links = (n: number): LayoutLink[] => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, attachments: { from: { node: `a${i}` }, to: { node: `b${i}` } } }) as LayoutLink);
    const caps = new Set<string>();
    expect(sideVectors({} as LayoutModel, [], [], undefined, undefined, caps, 1)).toEqual([undefined]);
    expect(sideVectors({} as LayoutModel, links(2), ['left', 'right'], undefined, undefined, caps, 1)).toEqual([['left', 'right'], ['left', 'left'], ['right', 'right'], ['right', 'left']]);
    expect(caps.size).toBe(0);
    const base = Array.from({ length: JOINT_TRANSIT_SIDES + 1 }, () => 'left' as const);
    expect(sideVectors({} as LayoutModel, links(base.length), base, undefined, undefined, caps, 1)).toEqual([base]);
    expect([...caps]).toEqual([`sub-tier 1 has ${base.length} transit corridors, so only the sides their ends ask for were judged`]);
  });

  it('combines the row candidates, and judges each row alone past the cap', () => {
    const caps = new Set<string>();
    const two = [[['a', 'b'], ['b', 'a']], [['c', 'd'], ['d', 'c']]];
    expect(rowCombinations(two, caps, 1)).toEqual([[['a', 'b'], ['c', 'd']], [['a', 'b'], ['d', 'c']], [['b', 'a'], ['c', 'd']], [['b', 'a'], ['d', 'c']]]);
    const wide = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (__, n) => [`r${r}`, `n${n}`]));
    expect(3 ** 3).toBeGreaterThan(JOINT_ROW_ORDERS);
    const combos = rowCombinations(wide, caps, 1);
    expect(combos[0]).toEqual(wide.map(list => list[0]));
    expect(combos.length).toBe(1 + 2 + 3 * 2);
    expect([...caps]).toEqual(['the free rows of sub-tier 1 have 27 candidate orders together, so each row was judged alone']);
  });

  it('accepts a candidate only on strictly fewer crossings with no straight link lost, and ranks by straight, blocked, crossings, stretch', () => {
    const base = { crossings: 4, straight: 2, blocked: 1, freeBlocked: 0, stretch: 100 };
    expect(jointAccepted({ ...base, crossings: 3 }, base)).toBe(true);
    expect(jointAccepted(base, base)).toBe(false);
    expect(jointAccepted({ ...base, crossings: 3, straight: 1 }, base)).toBe(false);
    expect(jointAccepted({ ...base, crossings: 3, blocked: 2 }, base)).toBe(false);
    expect(jointAccepted({ ...base, crossings: 3, freeBlocked: 1 }, base)).toBe(false);
    expect(jointBetter({ ...base, straight: 3, crossings: 9 }, base)).toBe(true);
    expect(jointBetter({ ...base, blocked: 0, crossings: 9 }, base)).toBe(true);
    expect(jointBetter({ ...base, crossings: 3 }, base)).toBe(true);
    expect(jointBetter({ ...base, stretch: 50 }, base)).toBe(true);
    expect(jointBetter(base, base)).toBe(false);
  });

  it('seats a run at its predicted 7c centres in the order asked, a band gap apart and inside its walls', async () => {
    const model = await skeletonOf(off(SINKS)), links = jointLinks(model), aggr = model.groups.aggr!, tier = aggr.tier!;
    const { movable } = orderTools(model);
    const runs = groupRuns(model, links, tier + 1, [aggr], [], movable, new Set());
    expect(runs.map(item => [item.groups.map(group => group.id), item.permute])).toEqual([[['leaf-far', 'leaf-near'], true]]);
    seatPredicted7c(model, links, [aggr], runs, [['leaf-near', 'leaf-far']], [], tier);
    const near = model.groups['leaf-near']!.bounds!, far = model.groups['leaf-far']!.bounds!;
    expect(near.x + near.width + bandGap(model)).toBeLessThanOrEqual(far.x + 1e-6);
    // lf0 (leaf-near) is fed by ag1, ag2 and ag4 and wants their mean centre; lf1 by ag0 and ag3. The pack keeps both wants in order.
    const centre = (id: string): number => model.nodes[id]!.bounds!.x + model.nodes[id]!.bounds!.width / 2;
    expect(near.x + near.width / 2).toBeLessThan(far.x + far.width / 2);
    expect(Math.abs(near.x + near.width / 2 - (centre('ag1') + centre('ag2') + centre('ag4')) / 3)).toBeLessThan(far.width + near.width);
  }, 60000);

  it('leaves out a row whose links the draft does not model, with the reason (R6)', async () => {
    const lateral = await skeletonOf(sheet('widened-child-packs-tier')), uTurn = await skeletonOf(sheet('label-no-gap'));
    expect([...leftOutRows(lateral, jointLinks(lateral))].map(([group, why]) => [group.id, why])).toContainEqual(['middle', 'lateral-port']);
    expect([...leftOutRows(uTurn, jointLinks(uTurn))].map(([group, why]) => [group.id, why])).toContainEqual(['row-group', 'same-row-u-turn']);
    expect(uTurn.diagnostics.filter(item => item.code === 'JOINT_ORDER_LEFT_OUT').map(item => item.severity)).toEqual(['info']);
  }, 60000);

  it('spends the budget of the sweeps, and names the cap when it runs out (R4)', async () => {
    const fresh = await skeletonOf(off(FACE)), spent = await skeletonOf(off(FACE));
    const call = (model: LayoutModel, used: number) => {
      const { movable, freeRow } = orderTools(model), draft = readDraft(model)!;
      const rows = (k: number): LayoutGroup[] => Object.values(model.groups).filter(group => group.tier === draft.tiers[k] && group.nodes.length > 1 && freeRow(group));
      const before = new Map(Object.values(model.groups).filter(group => group.nodes.length > 1 && freeRow(group)).map(group => [group, [...(group.rowOrder ?? group.nodes)]]));
      const budget = { spent: used, limit: ROW_ORDER_BUDGET, caps: new Set<string>() };
      return { result: orderJointFreeRows(model, draft, rows, movable, new Set(), before, new Set(), ROW_ORDER_PERMUTED_NODES, budget), budget };
    };
    const one = call(fresh, 0), two = call(spent, ROW_ORDER_BUDGET - 1);
    expect(one.result.jointMoved.has(fresh.groups.aggr!)).toBe(true);
    expect(one.budget.spent).toBeGreaterThan(1);
    expect(one.budget.caps.size).toBe(0);
    expect(two.result.moved).toBe(false);
    expect(two.budget.spent).toBe(ROW_ORDER_BUDGET);
    expect([...two.budget.caps]).toEqual([`the sheet spent its budget of ${ROW_ORDER_BUDGET} candidates`]);
  }, 60000);
});

describe('the records of the joint order (R1, R2, R6)', () => {
  it('writes a group order with its premise and the corridor sides', () => {
    const row = { id: 'row', nodes: ['b', 'a'], rowOrder: ['a', 'b'] } as LayoutGroup;
    const side = reservation('corridorSide', { kind: 'link', id: 'l' }, '1', 'skeleton', 0, { link: 'l', tier: 1, group: 'row', side: 'left' });
    const entries = jointRecord({ moved: true, jointMoved: new Set([row]), groupOrders: [{ tier: 2, order: ['g2', 'g1'], rows: [row] }], corridorSides: [side] });
    expect(entries.map(entry => [entry.kind, entry.id, entry.activeFrom, entry.payload])).toEqual([
      ['groupOrder', 'groupOrder:command:feed-order:tier:2:g2', 'skeleton', { tier: 2, order: ['g2', 'g1'], feeds: [{ row: 'row', order: ['a', 'b'] }] }],
      ['corridorSide', side.id, 'skeleton', { link: 'l', tier: 1, group: 'row', side: 'left' }],
    ]);
  });

  it('fails a group order whose premise turned or whose groups stand the other way, and drops it by name in the refresh', async () => {
    const model = await run(SINKS), [entry] = ofKind(model.reservations ?? [], 'groupOrder');
    expect(groupOrderFailure(entry!, model)).toBeUndefined();
    const turned = structuredClone(model);
    turned.groups.aggr!.rowOrder = [...turned.groups.aggr!.rowOrder!].reverse();
    expect(groupOrderFailure(entry!, turned)).toMatch(/the free row aggr no longer stands in the order the group order read/);
    const swapped = structuredClone(model), near = swapped.groups['leaf-near']!.bounds!, far = swapped.groups['leaf-far']!.bounds!;
    [near.x, far.x] = [far.x, near.x];
    expect(groupOrderFailure(entry!, swapped)).toMatch(/leaf-near does not stand left of leaf-far/);
    expect(refreshFeedOrders(turned)).toBe(true);
    expect(ofKind(turned.reservations ?? [], 'groupOrder')).toEqual([]);
    expect(turned.diagnostics.filter(item => item.code === 'FEED_ORDER_WITHDRAWN').map(item => item.message)).toEqual([
      `The group order leaf-near, leaf-far of sub-tier ${entry!.payload.tier} is withdrawn: the free row aggr no longer stands in the order the group order read. The groups stand as they stand, with no reservation.`,
    ]);
  }, 120000);

  it('checks a corridor side against its lane from 7a on, and its host alone before', async () => {
    const model = await run(SIDES), [entry] = ofKind(model.reservations ?? [], 'corridorSide');
    const flipped = { ...entry!, payload: { ...entry!.payload, side: entry!.payload.side === 'left' ? 'right' as const : 'left' as const } };
    expect(corridorSideFailure(entry!, model)).toBeUndefined();
    expect(corridorSideFailure(flipped, model)).toMatch(/does not stand/);
    for (const stage of ['lanes', 'centre', 'bands'] as const) expect(corridorSideFailure(flipped, { ...model, stage })).toMatch(/does not stand/);
    expect(corridorSideFailure(flipped, { ...model, stage: 'skeleton' })).toBeUndefined();
    const gone = { ...entry!, payload: { ...entry!.payload, group: 'nowhere' } };
    expect(corridorSideFailure(gone, { ...model, stage: 'skeleton' })).toMatch(/nowhere does not stand on sub-tier/);
  }, 120000);

  it('withdraws by name a corridor side that a 7f move puts the lane across', () => {
    const entry = reservation('corridorSide', { kind: 'link', id: 'l' }, '1', 'skeleton', 0, { link: 'l', tier: 1, group: 'host', side: 'left' });
    const model = (): LayoutModel => ({ reservations: [entry], diagnostics: [], groups: { host: { id: 'host', nodes: [], bounds: { x: 100, y: 0, width: 50, height: 20 } } } }) as unknown as LayoutModel;
    const link = { id: 'l' } as LayoutLink, lane = (x: number) => ({ tier: 1, x }) as never;
    const kept = model();
    withdrawCorridorSide(kept, link, lane(90));
    expect(kept.reservations).toEqual([entry]);
    expect(kept.diagnostics).toEqual([]);
    const moved = model();
    withdrawCorridorSide(moved, link, lane(170));
    expect(moved.reservations).toEqual([]);
    expect(moved.diagnostics.map(item => [item.code, item.severity])).toEqual([['CORRIDOR_SIDE_WITHDRAWN', 'warning']]);
  });

  it('refuses a malformed group order or corridor side on restore', () => {
    const restore = (payload: object, kind: string): void => validateReservations({ reservations: [{ id: 'x', kind, owner: { kind: 'command', id: 'feed-order' }, key: 'k', producer: 'skeleton', revision: 0, activeFrom: 'skeleton', payload }], links: [], nodes: {} } as never);
    expect(() => restore({ tier: 1, order: ['a', 'b'], feeds: [] }, 'groupOrder')).toThrow(/malformed/);
    expect(() => restore({ tier: 1.5, order: ['a', 'b'], feeds: [{ row: 'r', order: ['x'] }] }, 'groupOrder')).toThrow(/malformed/);
    expect(() => restore({ link: 'l', tier: 1, group: 'g', side: 'up' }, 'corridorSide')).toThrow(/malformed/);
  });
});
