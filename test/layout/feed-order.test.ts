import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { validateFeedOrders } from '../../src/layout/feed-order.js';
import { ofKind, rowOrderOf } from '../../src/layout/reservations.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const child = read('a-child-frame-stands-under-its-feeds');
const fan = read('a-fan-follows-the-order-of-its-hubs');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** Stage 4 only: the skeleton with its feed orders. */
const skeletonOf = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
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

  it('keeps the two ends of a peer link next to each other: the pair moves as one block (gate review, six-body collapse)', async () => {
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
    expect(ofKind(one.reservations ?? [], 'rowOrder').map(entry => entry.payload)).toEqual([
      { cell: 'east#0', order: ['x1', 'x2'] }, { cell: 'middle#0', order: ['m1', 'm2'] }, { cell: 'west#0', order: ['w1', 'w2'] },
    ]);
    for (const cell of ['east#0', 'middle#0', 'west#0']) expect(two.groups[cell]!.rowOrder).toEqual(one.groups[cell]!.rowOrder);
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
