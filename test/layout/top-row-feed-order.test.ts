import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { validateFeedOrders } from '../../src/layout/feed-order.js';
import { validateRowOrderDecisions } from '../../src/layout/corridor-order.js';
import { reseatRow } from '../../src/layout/overlay-order.js';
import { ofKind } from '../../src/layout/reservations.js';
import { createColdAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withLayoutEntry } from '../aspect-fixture.js';

// Dense-16x9 ticket 20: a row that no row above feeds takes the order of its feeds into the row below.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-top-leaf-row-takes-the-order-of-its-hubs.yaml', import.meta.url), 'utf8');
const DECLARED = ['leaf-1', 'leaf-2', 'both-1', 'leaf-3', 'both-2', 'leaf-4', 'leaf-5', 'leaf-6', 'leaf-7', 'leaf-8'];
const RUNS = ['leaf-1', 'leaf-2', 'leaf-3', 'leaf-4', 'both-1', 'both-2', 'leaf-5', 'leaf-6', 'leaf-7', 'leaf-8'];
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt });
const skeletonOf = async (text: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(text))));
  await skeleton(model, { createAttempt: createColdAttempt });
  return model;
};
const orderOf = (model: LayoutModel, group: string): string[] => model.groups[group]!.rowOrder ?? model.groups[group]!.nodes;
const xOrder = (model: LayoutModel, nodes: readonly string[]): string[] => [...nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x);
const rowEntries = (model: LayoutModel) => ofKind(model.reservations ?? [], 'rowOrder').flatMap(({ payload }) => 'row' in payload ? [payload] : []);
const errorGates = (model: LayoutModel) => Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id);

describe('a top leaf row takes the order of its hubs (dense-16x9 ticket 20)', () => {
  it('stands the left hub\'s leaves, the shared members, then the right hub\'s leaves, and the crossings fall', async () => {
    const [model, declared] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'feedOrder: false'))]);
    expect(orderOf(model, 'leaves')).toEqual(RUNS);
    expect(xOrder(model, DECLARED)).toEqual(RUNS);
    expect(rowEntries(model)).toEqual([{ row: 'leaves', order: RUNS, feeds: [{ row: 'core#0', order: ['hub-1', 'hub-2'] }] }]);
    expect(model.groups.leaves!.rowOrderDecision).toMatchObject({ rule: 'feed-order', before: DECLARED, after: RUNS });
    expect(orderOf(declared, 'leaves')).toEqual(DECLARED);
    expect(rowEntries(declared)).toEqual([]);
    expect(score(declared).snapshot.metrics.crossings.count).toBe(5);
    expect(score(model).snapshot.metrics.crossings.count).toBe(2);
    expect(errorGates(model)).toEqual([]);
  }, 120000);

  it('stores the row below as the premise: the validator reads it and does not decide again (R5)', async () => {
    const model = await skeletonOf(yaml);
    expect(validateFeedOrders(model)).toEqual([]);
    expect(validateRowOrderDecisions(model)).toEqual([]);
    const turned = JSON.parse(JSON.stringify(model)) as LayoutModel;
    expect(reseatRow(turned, turned.groups['core#0']!, ['hub-2', 'hub-1'], true)).toBe(true);
    expect(validateFeedOrders(turned)).toContain('Reservation rowOrder:group:leaves:row does not hold: the feeding row core#0 no longer stands in the order the entry read');
    const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const entry = forged.reservations!.find(item => item.kind === 'rowOrder' && 'row' in item.payload)!;
    (entry.payload as unknown as { order: string[] }).order = DECLARED;
    expect(validateFeedOrders(forged)).toEqual(['Reservation rowOrder:group:leaves:row does not hold: leaves does not stand in the order its feeds give']);
  }, 60000);

  it.each([['feedOrder: false'], ['corridorRowOrder: false']])('keeps the authored order under %s and writes no entry', async entry => {
    const model = await skeletonOf(withLayoutEntry(yaml, entry));
    expect(orderOf(model, 'leaves')).toEqual(DECLARED);
    expect(rowEntries(model)).toEqual([]);
  }, 60000);

  it('leaves a row fed from both sides as it stands: a feed from above means the row below is not read', async () => {
    const both = yaml.replace('  leaves: { tier: 0 }', '  uplinks: { tier: 0 }\n  leaves: { tier: 1 }').replace('  core: { tier: 1 }', '  core: { tier: 2 }')
      .replace('  rack: { tier: 2 }', '  rack: { tier: 3 }').replace('nodes:\n', 'nodes:\n  uplink: { group: uplinks, class: router }\n')
      .replace('links:\n', 'links:\n  - [uplink, leaf-8]\n');
    const model = await skeletonOf(both);
    expect(orderOf(model, 'leaves')).toEqual(DECLARED);
    expect(rowEntries(model)).toEqual([]);
  }, 60000);

  it('leaves a free top row that the corridor step judged in its measured order (`kept`): the feed order crossed no less there', async () => {
    // The top row `a1`, `a2` feeds `m2`, `m1` below; read from below it would turn, and the corridor-aware draft keeps it (2 crossings, not 4).
    const model = await skeletonOf(readFileSync(new URL('../../goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml', import.meta.url), 'utf8'));
    expect(model.groups.top!.rowOrderDecision?.rule).toBe('kept');
    expect(orderOf(model, 'top')).toEqual(['a1', 'a2']);
    expect(rowEntries(model)).toEqual([]);
  }, 60000);

  it('decides the same order when the links are listed the other way round (R3)', async () => {
    const [head, list] = yaml.split('links:\n');
    const turned = `${head}links:\n${list!.trimEnd().split('\n').reverse().join('\n')}\n`;
    const model = await skeletonOf(turned);
    expect(orderOf(model, 'leaves')).toEqual(RUNS);
  }, 60000);
});
