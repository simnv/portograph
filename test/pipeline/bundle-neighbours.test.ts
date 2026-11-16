import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { gatherPairs, keptPairs, type NeighbourPair } from '../../src/layout/bundle-neighbours.js';
import { reseatRow } from '../../src/layout/overlay-order.js';
import { bundleNeighboursOf, ofKind } from '../../src/layout/reservations.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * A free row owes the channel of an enclosed bundle whose end faces look at each other along the row (R3 ticket 18): the two ends stand side
 * by side, whatever order the input gives. Stage 4 records the pairs it keeps (`bundleNeighbours`); `reseatRow`, a restore and the stage-4
 * check read the record (R1, R2, R5).
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const FIXTURE = 'a-row-seats-the-two-ends-of-a-bundle-side-by-side';
const order = (model: LayoutModel, group: string): string[] => model.groups[group]!.rowOrder!;
const pairs = (model: LayoutModel, group: string) => bundleNeighboursOf(model.reservations, group);
const standsBy = (model: LayoutModel, left: string, right: string): boolean => { const o = order(model, 'place'); return o.indexOf(right) === o.indexOf(left) + 1; };
const bounds = (model: LayoutModel) => Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, node.bounds]));

/** A hub with a two-member bundle to the node on each side: `c` leaves right, `hub` takes it on the left, `hub` leaves right to `e`. */
const HUB = (nodes: string[]): string => `portograph: 2
profile: network
groups:
  place: { tier: 0 }
nodes:
${nodes.join('\n')}
links:
  - [c.q, hub.q]
  - [c.r, hub.r]
  - [hub.s, e.s]
  - [hub.t, e.t]
`;
const HUB_NODES = [
  '  e: { group: place, ports: [{ name: s, side: left }, { name: t, side: left }] }',
  '  hub: { group: place, ports: [{ name: q, side: left }, { name: r, side: left }, { name: s, side: right }, { name: t, side: right }] }',
  '  c: { group: place, ports: [{ name: q, side: right }, { name: r, side: right }] }',
];

describe('a free row seats the two ends of an enclosed lateral bundle side by side (R3, ticket 18)', () => {
  it('seats a immediately left of d although the sheet writes b between them, and records the pair', async () => {
    const model = await run(fixture(FIXTURE));
    expect(standsBy(model, 'a', 'd')).toBe(true);
    expect(pairs(model, 'place')).toEqual([['a', 'd']]);
    expect(model.bundles).toHaveLength(1);
    expect(ofKind(model.reservations!, 'bundleNeighbours')).toHaveLength(1);
    // Absent, not empty: a row that holds no such bundle has no entry, and its order is free.
    expect(pairs(model, 'upper')).toEqual([]);
    expect(ofKind(model.reservations!, 'bundleNeighbours').map(entry => entry.payload.group)).toEqual(['place']);
  }, 120000);

  it.each(['links', 'nodes'] as const)('gives the same boxes with %s reversed (R3)', async key => {
    const written = await run(fixture(FIXTURE)), copy = await run(reversed(fixture(FIXTURE), key));
    expect(bounds(copy)).toEqual(bounds(written));
    expect(pairs(copy, 'place')).toEqual(pairs(written, 'place'));
  }, 120000);

  it('holds the record on a restore, and a forged order that splits the pair is refused (R1, R5)', async () => {
    const model = await run(fixture(FIXTURE));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
    // `b` between `a` and `d`: the record names the pair, and the restore refuses.
    forged.groups.place!.rowOrder = ['a', 'b', 'd'];
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/does not stand immediately left of/);
  }, 120000);

  it('reseatRow refuses an order that splits a recorded pair and keeps the row as it stood (R2)', async () => {
    const model = await run(fixture(FIXTURE));
    const before = [...order(model, 'place')], x = bounds(model);
    const split = ['a', 'b', 'd'];
    expect(reseatRow(model, model.groups.place!, split, true)).toBe(false);
    expect(order(model, 'place')).toEqual(before);
    expect(bounds(model)).toEqual(x);
    // An order that keeps the pair is seated.
    const moved = before.includes('b') && before.indexOf('b') < before.indexOf('a') ? ['a', 'd', 'b'] : ['b', 'a', 'd'];
    expect(reseatRow(model, model.groups.place!, moved, true)).toBe(true);
    expect(order(model, 'place')).toEqual(moved);
  }, 120000);

  it('keeps one node between its two peers: c, hub, e stand in one chain whatever the input order', async () => {
    const written = await run(HUB(HUB_NODES));
    const o = order(written, 'place'), at = o.indexOf('c');
    expect(o.slice(at, at + 3)).toEqual(['c', 'hub', 'e']);
    expect(pairs(written, 'place')).toEqual(expect.arrayContaining([['c', 'hub'], ['hub', 'e']]));
    for (const key of ['links', 'nodes'] as const) {
      const copy = await run(reversed(HUB(HUB_NODES), key));
      expect(bounds(copy)).toEqual(bounds(written));
    }
  }, 120000);
});

describe('which pairs a row keeps when a node cannot be next to all its peers (R3, by content)', () => {
  const pair = (left: string, right: string, members = 2): NeighbourPair => ({ left, right, bundle: `${left}-${right}`, members });
  it('keeps the heaviest bundle, then the names of the two nodes, whatever the order of the pairs', () => {
    const all = [pair('hub', 'p3'), pair('hub', 'p1'), pair('hub', 'p2', 3)];
    for (const list of [all, [...all].reverse(), [all[1]!, all[2]!, all[0]!]]) expect(keptPairs(list).map(item => item.bundle)).toEqual(['hub-p2']);
    const equal = [pair('hub', 'p3'), pair('hub', 'p1'), pair('hub', 'p2')];
    for (const list of [equal, [...equal].reverse()]) expect(keptPairs(list).map(item => item.bundle)).toEqual(['hub-p1']);
  });
  it('keeps a chain and drops the pair that would close a ring', () => {
    const ring = [pair('a', 'b'), pair('b', 'c'), pair('c', 'a')];
    for (const list of [ring, [...ring].reverse()]) expect(keptPairs(list).map(item => item.bundle)).toEqual(['a-b', 'b-c']);
  });
  it('gathers a chain at the place of its first member and leaves the other nodes where they stand', () => {
    expect(gatherPairs(['a', 'b', 'd'], [['a', 'd']])).toEqual(['a', 'd', 'b']);
    expect(gatherPairs(['d', 'b', 'a'], [['a', 'd']])).toEqual(['d', 'a', 'b']);
    expect(gatherPairs(['x', 'e', 'y', 'hub', 'c'], [['c', 'hub'], ['hub', 'e']])).toEqual(['x', 'c', 'hub', 'e', 'y']);
    expect(gatherPairs(['x', 'y'], [])).toEqual(['x', 'y']);
  });
  it('a node with three right-facing bundles keeps one neighbour; the others keep the typed refusal', async () => {
    const nodes = ['  hub: { group: place, ports: [' + ['q', 'r', 's', 't', 'u', 'v'].map(n => `{ name: ${n}, side: right }`).join(', ') + '] }',
      ...['p1:q:r', 'p2:s:t', 'p3:u:v'].map(spec => { const [id, a, b] = spec.split(':'); return `  ${id}: { group: place, ports: [{ name: ${a}, side: left }, { name: ${b}, side: left }] }`; })];
    const yaml = `portograph: 2
profile: network
groups:
  place: { tier: 0 }
nodes:
${nodes.join('\n')}
links:
  - [hub.q, p1.q]
  - [hub.r, p1.r]
  - [hub.s, p2.s]
  - [hub.t, p2.t]
  - [hub.u, p3.u]
  - [hub.v, p3.v]
`;
    await expect(run(yaml)).rejects.toThrow(/BUNDLE_CHANNEL_BLOCKED/);
    await expect(run(reversed(yaml, 'nodes'))).rejects.toThrow(/BUNDLE_CHANNEL_BLOCKED/);
  }, 120000);
});
