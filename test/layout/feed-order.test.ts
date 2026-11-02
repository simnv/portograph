import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { refreshFeedOrders, settlePullsAndFeeds, validateFeedOrders } from '../../src/layout/feed-order.js';
import { validateRowOrderDecisions, withdrawPullsAcrossFlips } from '../../src/layout/corridor-order.js';
import { reseatRow } from '../../src/layout/overlay-order.js';
import { holds } from '../../src/layout/reservation-checks.js';
import { feedingRowsOf, ofKind, rowOrderOf } from '../../src/layout/reservations.js';
import { createColdAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const child = read('a-child-frame-stands-under-its-feeds');
const fan = read('a-fan-follows-the-order-of-its-hubs');
/** A pull chain: Front feeds the cells of Bank, and BL in Back is linked to Spare in the lower cell. */
const pullChain = `portograph: 2
profile: network
groups:
  front: { tier: 0, label: Front }
  bank: { tier: 1, label: Bank }
  back: { tier: 2, label: Back }
nodes:
${['fe1', 'fe2', 'u1', 'u2', 'u3', 'u4', 'lb'].map(id => `  ${id}: { group: front, class: router, label: ${id.toUpperCase()} }`).join('\n')}
  c1: { group: bank, class: switch, label: C1 }
  c2: { group: bank, class: switch, label: C2 }
  spare: { group: bank, class: server, label: Spare }
  outlet: { group: bank, class: server, label: Outlet }
${['b1', 'b2', 'b3', 'b4', 'bl'].map(id => `  ${id}: { group: back, class: router, label: ${id.toUpperCase()} }`).join('\n')}
links:
  - [fe1, c1]
  - [fe2, c1]
  - [lb, c2]
  - [c1, spare]
  - [c2, outlet]
  - [bl, spare]
`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt });
/** Stage 4 only: the skeleton with its feed orders. */
const skeletonOf = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt: createColdAttempt });
  return model;
};
const centre = (model: LayoutModel, node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;
const errorGates = (model: LayoutModel) => Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id);

describe('a child frame stands under its feeds (architecture-2 ticket 25, part A)', () => {
  it('puts the zone left of the parent member its feeds stand right of, and the two feed links do not cross', async () => {
    const model = await run(child);
    expect(rowOrderOf(model.reservations, 'frame', 'loc')).toEqual(['zone', 'loc']);
    expect(centre(model, 's1')).toBeLessThan(centre(model, 's2'));
    expect(centre(model, 'z2')).toBeLessThan(centre(model, 'p2'));
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expect(errorGates(model)).toEqual([]);
  }, 120000);

  it('reads the order of the feeding row, not the declaration order: with s2 declared first the zone stands right', async () => {
    const swapped = child.replace('  s1: { group: loc, class: switch, label: Switch one }\n  s2: { group: loc, class: switch, label: Switch two }\n',
      '  s2: { group: loc, class: switch, label: Switch two }\n  s1: { group: loc, class: switch, label: Switch one }\n');
    expect(swapped).not.toBe(child);
    const model = await skeletonOf(swapped);
    expect(model.groups['loc#1']!.rowOrder).toEqual(['s2', 's1']);
    expect(rowOrderOf(model.reservations, 'frame', 'loc')).toEqual(['loc', 'zone']);
    expect(model.groups['zone#2']!.bounds!.x).toBeGreaterThan(model.groups['loc#2']!.bounds!.x);
  }, 60000);

  it('keeps the declaration order on a tie: one switch feeding both leaves the frame undecided', async () => {
    const tied = child.replace('  - [s2, p2]', '  - [s1, p2]');
    const model = await skeletonOf(tied);
    expect(rowOrderOf(model.reservations, 'frame', 'loc')).toBeUndefined();
    // The frame's own cells first, its children after: the column pack's default.
    expect(model.groups['zone#2']!.bounds!.x).toBeGreaterThan(model.groups['loc#2']!.bounds!.x);
  }, 60000);
});

describe('the cells of a fan follow the order of the far ends (architecture-2 ticket 25, part B)', () => {
  it('orders e1 before e2 in every location, against the declaration, and no two fan links of a location cross', async () => {
    const model = await run(fan);
    for (const [cell, one, two] of [['west#0', 'w1', 'w2'], ['middle#0', 'm1', 'm2'], ['east#0', 'x1', 'x2']] as const) {
      expect(rowOrderOf(model.reservations, 'cell', cell)).toEqual([one, two]);
      expect(model.groups[cell]!.rowOrder).toEqual([one, two]);
      expect(centre(model, one)).toBeLessThan(centre(model, two));
    }
    expect(centre(model, 'hub1')).toBeLessThan(centre(model, 'hub2'));
    // Only the three crossings between locations stay (hub2's link to a location against hub1's link to each location right of it).
    const { metrics, counts } = score(model).snapshot;
    expect(metrics.crossings.count).toBe(3);
    expect(counts.routed.bent).toBeLessThanOrEqual(2);
    expect(errorGates(model)).toEqual([]);
  }, 120000);

  it('writes no entry under layout.feedOrder: false, and ELK\'s order stands (an absent entry: the feeds decide nothing)', async () => {
    const model = await skeletonOf(fan.replace('portograph: 2\n', 'portograph: 2\nlayout: { feedOrder: false }\n'));
    expect(ofKind(model.reservations ?? [], 'rowOrder')).toEqual([]);
    expect(model.groups['west#0']!.rowOrder).toEqual(['w2', 'w1']);
    expect(validateFeedOrders(model)).toEqual([]);
  }, 60000);

  it('keeps a peer pair that stands side by side together: the pair moves as one block (gate review, six-body collapse)', async () => {
    // crt3 feeds srt1 and rrt1, crt4 feeds srt2 and rrt2; srt1-srt2 and rrt1-rrt2 are peer links. Node by node the feeds would interleave
    // the pairs (srt1, rrt1, srt2, rrt2) and bend both peer links round a neighbour; as blocks the two pairs tie and stand as they were.
    const model = await skeletonOf(read('a-peer-link-joins-members-of-equal-depth-six-bodies'));
    expect(model.groups['loc#2']!.rowOrder).toEqual(['srt1', 'srt2', 'rrt1', 'rrt2']);
    expect(model.groups['loc#3']!.rowOrder).toEqual(['ssw1', 'ssw2', 'rsw1', 'rsw2']);
  }, 60000);

  it('decides nothing where the far ends tie, and keeps the order the row stands in', async () => {
    const tied = fan.replace('  - [w2, hub2]', '  - [w2, hub1]');
    const model = await skeletonOf(tied);
    expect(rowOrderOf(model.reservations, 'cell', 'west#0')).toBeUndefined();
    expect(rowOrderOf(model.reservations, 'cell', 'middle#0')).toEqual(['m1', 'm2']);
  }, 60000);

  it('decides the same orders when the links are listed the other way round (R3)', async () => {
    // ELK's own placement reads the link order, so the boxes may differ; the feed order is a mean over the links and does not.
    const lines = fan.split('\n'), at = lines.indexOf('links:');
    const reversed = [...lines.slice(0, at + 1), ...lines.slice(at + 1).filter(line => line.trim()).reverse(), ''].join('\n');
    const [one, two] = await Promise.all([skeletonOf(fan), skeletonOf(reversed)]);
    expect(ofKind(two.reservations ?? [], 'rowOrder')).toEqual(ofKind(one.reservations ?? [], 'rowOrder'));
    expect(ofKind(one.reservations ?? [], 'rowOrder').map(entry => entry.payload)).toEqual(['east#0', 'middle#0', 'west#0'].map((cell, i) => ({
      cell, order: [['x1', 'x2'], ['m1', 'm2'], ['w1', 'w2']][i], feeds: [{ row: 'core', order: ['hub1', 'hub2'] }],
    })));
    for (const cell of ['east#0', 'middle#0', 'west#0']) expect(two.groups[cell]!.rowOrder).toEqual(one.groups[cell]!.rowOrder);
  }, 60000);
});

describe('the feed order across later moves (ticket 25 review)', () => {
  it('reads every unit\'s feeds from one row: feeds from two groups decide nothing', async () => {
    const split = fan.replace('  east: { tier: 2, label: East }\n', '  east: { tier: 2, label: East }\n  alt: { tier: 1, label: Alt }\n')
      .replace('  hub2: { group: core, class: provider, label: Hub two }\n', '  hub2: { group: core, class: provider, label: Hub two }\n  hub3: { group: alt, class: provider, label: Hub three }\n')
      .replace('  - [w2, hub2]', '  - [w2, hub3]\n  - [up, hub3]');
    expect(split).toContain('hub3: { group: alt');
    const model = await skeletonOf(split);
    expect(rowOrderOf(model.reservations, 'cell', 'west#0')).toBeUndefined();
    expect(rowOrderOf(model.reservations, 'cell', 'middle#0')).toEqual(['m1', 'm2']);
  }, 60000);

  it('stores the feeding row as the premise: a turned feeding row fails the entry, and the refresh reads the cells again', async () => {
    const model = await skeletonOf(fan);
    expect([...feedingRowsOf(model.reservations)]).toEqual(['core']);
    expect(validateFeedOrders(model)).toEqual([]);
    // A later move turns the feeding row (as a withdrawn pull re-seats a free row): every fed cell's entry now reads a premise that is gone.
    expect(reseatRow(model, model.groups.core!, ['hub2', 'hub1'], true)).toBe(true);
    expect(validateFeedOrders(model)).toHaveLength(3);
    expect(validateFeedOrders(model)[0]).toContain('the feeding row core no longer stands in the order the entry read');
    expect(refreshFeedOrders(model)).toBe(true);
    expect(validateFeedOrders(model)).toEqual([]);
    for (const [cell, one, two] of [['west#0', 'w1', 'w2'], ['middle#0', 'm1', 'm2'], ['east#0', 'x1', 'x2']] as const) {
      expect(model.groups[cell]!.rowOrder).toEqual([two, one]);
      expect(rowOrderOf(model.reservations, 'cell', cell)).toEqual([two, one]);
    }
  }, 60000);

  it('withdraws again a pull whose far node the refresh moved, until no pull is withdrawn (re-check, R2)', async () => {
    // Front feeds C1 and C2 (bank#0), which feed Spare and Outlet (bank#1); BL in Back is linked to Spare.
    const model = await skeletonOf(pullChain);
    expect(model.groups['bank#1']!.rowOrder ?? model.groups['bank#1']!.nodes).toEqual(['spare', 'outlet']);
    const shift = (node: string, dx: number): void => {
      const body = model.nodes[node]!;
      body.bounds!.x += dx;
      for (const port of body.ports) if (port.anchor) port.anchor.x += dx;
    };
    // Forged: C2 stands left of C1, so the pull of LB in Front (toward C2) stands across and is withdrawn. The withdrawn order puts LB
    // first, so the feeds of bank#1 (read in bank#0) turn it, and Spare moves right.
    expect(reseatRow(model, model.groups['bank#0']!, ['c2', 'c1'], true)).toBe(true);
    const front = model.groups.front!;
    front.rowOrderDecision = { rule: 'frame-columns', before: ['lb', 'fe1', 'fe2', 'u1', 'u2', 'u3', 'u4'], after: [...(front.rowOrder ?? front.nodes)], pulledFrom: ['lb', 'fe1', 'fe2', 'u1', 'u2', 'u3', 'u4'], pulled: ['lb'] };
    // Forged: Back stands left so that Spare is inside its span; BL's pull holds until Spare moves right.
    const back = model.groups.back!;
    expect(reseatRow(model, back, ['bl', 'b1', 'b2', 'b3', 'b4'], true)).toBe(true);
    const dx = centre(model, 'spare') - 63 - centre(model, 'bl');
    back.bounds!.x += dx;
    for (const node of back.nodes) shift(node, dx);
    back.rowOrderDecision = { rule: 'frame-columns', before: ['b1', 'b2', 'bl', 'b3', 'b4'], after: ['bl', 'b1', 'b2', 'b3', 'b4'], pulledFrom: ['b1', 'b2', 'bl', 'b3', 'b4'], pulled: ['bl'] };
    // As after the frame order: Front's pull stands across, Back's holds.
    expect(validateRowOrderDecisions(model)).toEqual(['The far-end pull of front is recorded on orders it cannot give']);
    // One withdrawal and one refresh leave Back's pull across: the validator would throw.
    const once = copy(model);
    expect(withdrawPullsAcrossFlips(once)).toBe(true);
    expect(refreshFeedOrders(once)).toBe(true);
    expect(once.groups['bank#1']!.rowOrder).toEqual(['outlet', 'spare']);
    expect(validateRowOrderDecisions(once)).toEqual(['The far-end pull of back is recorded on orders it cannot give']);
    // The guard repeats: the second round withdraws Back's pull, the third withdraws nothing.
    expect(settlePullsAndFeeds(model)).toBe(2);
    expect(model.groups.front!.rowOrderDecision!.pullWithdrawn).toEqual(['lb']);
    expect(model.groups.back!.rowOrderDecision!.pullWithdrawn).toEqual(['bl']);
    expect(model.groups['bank#1']!.rowOrder).toEqual(['outlet', 'spare']);
    expect(validateRowOrderDecisions(model)).toEqual([]);
    expect(validateFeedOrders(model)).toEqual([]);
  }, 60000);

  it('names a cell the refresh cannot seat (FEED_ORDER_REFUSED) and drops its entry', async () => {
    const model = await skeletonOf(fan);
    reseatRow(model, model.groups.core!, ['hub2', 'hub1'], true);
    // A forged wall: west#0 keeps a 1 px box and middle#0 stands right after it, so the turned row has no room.
    const west = model.groups['west#0']!.bounds!;
    west.width = 1;
    model.groups['middle#0']!.bounds!.x = west.x + 2;
    refreshFeedOrders(model);
    expect(model.diagnostics.filter(item => item.code === 'FEED_ORDER_REFUSED').map(item => item.owners)).toEqual([[{ kind: 'group', id: 'west#0' }]]);
    expect(rowOrderOf(model.reservations, 'cell', 'west#0')).toBeUndefined();
    expect(model.groups['west#0']!.rowOrder).toEqual(['w1', 'w2']);
  }, 60000);

  it('refuses through holds a later move that would turn a frame order', async () => {
    const model = await run(child);
    expect(holds(model.reservations ?? [], model)).toEqual([]);
    const forged = copy(model);
    forged.groups['zone#2']!.bounds!.x = forged.groups['loc#2']!.bounds!.x + 400;
    expect(holds(forged.reservations ?? [], forged).map(item => [item.kind, item.why])).toEqual([['rowOrder', 'zone#2 does not stand left of loc#2, the order the feeds of loc give']]);
  }, 120000);

  it('orders a row of child frames with no cell of the parent beside them (the pure row of standOf)', async () => {
    const model = await skeletonOf(`portograph: 2
groups:
  upstream: { tier: 0, label: Upstream }
  loc: { tier: 1, label: Location }
  za: { parent: loc, label: Zone A }
  zb: { parent: loc, label: Zone B }
nodes:
  feed: { group: upstream, class: router, label: Feed }
  c0: { group: loc, class: router, label: Core }
  s1: { group: loc, class: switch, label: Switch one }
  s2: { group: loc, class: switch, label: Switch two }
  a1: { group: za, class: server, label: Zone A server }
  b1: { group: zb, class: server, label: Zone B server }
links:
  - [feed, c0]
  - [c0, s1]
  - [c0, s2]
  - [s1, b1]
  - [s2, a1]
`);
    expect(model.groups['loc#1']!.rowOrder).toEqual(['s1', 's2']);
    expect(rowOrderOf(model.reservations, 'frame', 'loc')).toEqual(['zb', 'za']);
    expect(model.groups['zb#2']!.bounds!.x).toBeLessThan(model.groups['za#2']!.bounds!.x);
    expect(validateFeedOrders(model)).toEqual([]);
  }, 60000);

  it('follows the hubs when the nodes are declared the other way round (R3)', async () => {
    const lines = fan.split('\n'), from = lines.indexOf('nodes:'), to = lines.indexOf('links:');
    const reversed = [...lines.slice(0, from + 1), ...lines.slice(from + 1, to).reverse(), ...lines.slice(to)].join('\n');
    const model = await skeletonOf(reversed);
    const [left, right] = centre(model, 'hub1') < centre(model, 'hub2') ? ['1', '2'] : ['2', '1'];
    for (const prefix of ['w', 'm', 'x']) {
      const cell = { w: 'west#0', m: 'middle#0', x: 'east#0' }[prefix]!;
      expect(model.groups[cell]!.rowOrder).toEqual([prefix + left, prefix + right]);
    }
  }, 60000);
});

describe('the validator reads the rowOrder reservation (R2, R5)', () => {
  it('refuses a stage-4 model whose cell or frame order differs from the ledger entry', async () => {
    const [cells, frames] = await Promise.all([skeletonOf(fan), skeletonOf(child)]);
    expect(validateFeedOrders(cells)).toEqual([]);
    expect(validateFeedOrders(frames)).toEqual([]);
    const forged = copy(cells);
    const entry = forged.reservations!.find(item => item.kind === 'rowOrder' && 'cell' in item.payload && item.payload.cell === 'west#0')!;
    (entry.payload as unknown as { order: string[] }).order = ['w2', 'w1'];
    expect(validateFeedOrders(forged)).toEqual(['Reservation rowOrder:group:west#0:cell does not hold: west#0 does not stand in the order its feeds give']);
    const flipped = copy(frames);
    const side = flipped.reservations!.find(item => item.kind === 'rowOrder' && 'frame' in item.payload)!;
    (side.payload as unknown as { order: string[] }).order = ['loc', 'zone'];
    expect(validateFeedOrders(flipped)).toEqual(['Reservation rowOrder:group:loc:frame does not hold: loc#2 does not stand left of zone#2, the order the feeds of loc give']);
  }, 60000);

  it('refuses a restored layout whose ledger names another order', async () => {
    const model = await run(fan);
    expect(() => restoreFinalLayout(serializeLayoutModel(model))).not.toThrow();
    const json = JSON.parse(serializeLayoutModel(model)) as LayoutModel;
    const entry = json.reservations!.find(item => item.kind === 'rowOrder' && 'cell' in item.payload && item.payload.cell === 'east#0')!;
    (entry.payload as unknown as { order: string[] }).order = ['x2', 'x1'];
    expect(() => restoreFinalLayout(JSON.stringify(json))).toThrow(/east#0 does not stand in the order its feeds give/);
  }, 120000);
});
