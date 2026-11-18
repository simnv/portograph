import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { orderByFeeds, refreshFeedOrders, validateFeedOrders } from '../../src/layout/feed-order.js';
import { reseatRow } from '../../src/layout/overlay-order.js';
import { ofKind } from '../../src/layout/reservations.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { withTheOldDefault } from '../layout/move-before-grow.js';

// Dense-16x9 ticket 32: a rank cell and the row below it that only it feeds are ordered together, to the fewest crossings of the links
// between them (an exact search, bounded); the members the row above feeds keep their feed keys, the unfed members are free.
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const order = (model: LayoutModel, group: string): readonly string[] => model.groups[group]!.rowOrder ?? model.groups[group]!.nodes;
/** The crossings of the links between two rows, read on their orders. */
function between(model: LayoutModel, upper: string, lower: string): number {
  const at = new Map([...order(model, upper).map((node, i) => [node, i] as const), ...order(model, lower).map((node, i) => [node, i] as const)]);
  const up = new Set(order(model, upper)), down = new Set(order(model, lower));
  const links = model.links.flatMap(link => {
    const a = link.attachments?.from.node, b = link.attachments?.to.node;
    return a === undefined || b === undefined ? [] : up.has(a) && down.has(b) ? [[a, b] as const] : up.has(b) && down.has(a) ? [[b, a] as const] : [];
  });
  let count = 0;
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    if ((at.get(links[i]![0])! - at.get(links[j]![0])!) * (at.get(links[i]![1])! - at.get(links[j]![1])!) < 0) count++;
  }
  return count;
}

describe('two rank rows of one frame are ordered together (dense-16x9 ticket 32)', () => {
  const PLANAR = 'two-rank-rows-of-one-frame-are-ordered-together';

  it('stands the edge row and the router row of a frame in a planar order, with no member between the two edges one upstream node feeds', async () => {
    const model = await run(sheet(PLANAR));
    // Main 01415610: [edge-1..4] over [pe-1..4, rr-1, rr-2], 17 routed crossings, 6 bent links. The joint order: no crossing between the rows.
    expect(order(model, 'core#0')).toEqual(['edge-3', 'edge-1', 'edge-2', 'edge-4']);
    expect(order(model, 'core#1')).toEqual(['pe-3', 'pe-1', 'pe-2', 'pe-4', 'rr-1', 'rr-2']);
    expect(between(model, 'core#0', 'core#1')).toBe(0);
    expect(score(model).snapshot.counts.routed.bent).toBe(0);
    // One entry per row, each naming the other row with its order (the joint premise); the validator reads it.
    const entries = ofKind(model.reservations ?? [], 'rowOrder');
    const upper = entries.find(({ payload }) => 'cell' in payload && payload.cell === 'core#0')!.payload;
    const lower = entries.find(({ payload }) => 'cell' in payload && payload.cell === 'core#1')!.payload;
    expect(upper.feeds.map(feed => feed.row)).toEqual(['upstream', 'core#1']);
    // The router row is settled by this pair and is the upper row of the next pair (over the hubs): its entry names both.
    expect(lower.feeds[0]).toEqual({ row: 'core#0', order: upper.order });
    expect(lower.feeds.map(feed => feed.row)).toEqual(['core#0', 'core#2']);
    expect(validateFeedOrders(model)).toEqual([]);
  }, 120000);

  it('refuses a model whose lower row no longer stands in the order the upper row read (the premise)', async () => {
    // Read as main read it before the move-before-grow default (dense-16x9 ticket 45): there the router row has no open member, and the entry of
    // the upper row reads it in the order it stands.
    const model = structuredClone(await layout(withTheOldDefault(parse(sheet(PLANAR))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
    model.groups['core#1']!.rowOrder = [...order(model, 'core#1')].reverse();
    expect(validateFeedOrders(model).join('\n')).toContain('the feeding row core#1 no longer stands in the order the entry read');
    // With the default the router row has proved open members: a feeding row with open members is read in the order stage 4 recorded
    // (dense-16x9 ticket 36, slice 3), so the row's own entry refuses the reversal.
    const seated = structuredClone(await run(sheet(PLANAR)));
    seated.groups['core#1']!.rowOrder = [...order(seated, 'core#1')].reverse();
    expect(validateFeedOrders(seated)).toEqual(['Reservation rowOrder:group:core#1:cell does not hold: core#1 does not stand in the order its feeds give']);
  }, 120000);

  it('reaches 2 crossings on the competition case: the unfed members and the free row below move together', async () => {
    const model = await run(sheet('a-joint-row-order-frees-the-unfed-members-and-the-row-below'));
    // Ticket 30's one-at-a-time allocation reached 9; main 01415610 stands the rows as declared (21 routed crossings).
    expect(order(model, 'core#0')).toEqual(['a1', 'a2', 'b2', 'b1']);
    expect(order(model, 'lower')).toEqual(['c1', 'c5', 'c4', 'c0', 'c3', 'c2']);
    expect(between(model, 'core#0', 'lower')).toBe(2);
    expect(score(model).snapshot.counts.routed.crossings).toBe(2);
    expect(model.groups['lower']!.rowOrderDecision?.rule).toBe('feed-order');
  }, 120000);

  it('keeps a peer pair side by side where splitting it would cross less, and is no worse than the order of each row alone', async () => {
    const model = await run(sheet('a-peer-pair-keeps-its-joint-row-order-when-a-split-would-cross-less'));
    const mids = order(model, 'core#1');
    expect(Math.abs(mids.indexOf('mid-1') - mids.indexOf('mid-2'))).toBe(1);
    // Main 01415610: one crossing, no bent link, the same rows.
    expect(order(model, 'core#0')).toEqual(['top-1', 'top-2', 'top-3']);
    expect(mids).toEqual(['mid-1', 'mid-2', 'mid-3', 'mid-4']);
    const { counts } = score(model).snapshot;
    expect([counts.routed.crossings, counts.routed.bent]).toEqual([1, 0]);
  }, 120000);

  it('names a pair with more joint orders than the bound and keeps today\'s order (2 x 7! = 10080)', async () => {
    const model = await run(sheet('a-row-pair-past-the-search-bound-keeps-todays-order'));
    const named = model.diagnostics.filter(item => item.code === 'FEED_ORDER_PAIR_BOUND');
    expect(named.map(item => item.owners)).toEqual([[{ kind: 'group', id: 'core#0' }, { kind: 'group', id: 'core#1' }]]);
    expect(named[0]!.message).toContain('more than 10000 joint orders (at least 10080)');
    // The order the one-row rules give (main 01415610), with no joint entry.
    expect(order(model, 'core#1')).toEqual(['mid-1', 'mid-2', 'mid-3', 'mid-6', 'mid-7', 'mid-4', 'mid-5']);
    // No joint premise between the two rows of the bounded pair: the edge row's entry does not name the mid row (the mid row reads the edge
    // row as its feed from above, as every fed cell does).
    const entries = ofKind(model.reservations ?? [], 'rowOrder');
    expect(entries.some(({ payload }) => 'cell' in payload && payload.cell === 'core#0' && payload.feeds.some(feed => feed.row === 'core#1'))).toBe(false);
  }, 120000);

  it('gives the same rows with the links reversed, and the mirrored rows with the nodes reversed (R3; a mirror, not the same output)', async () => {
    for (const [name, rows] of [[PLANAR, ['core#0', 'core#1']], ['a-joint-row-order-frees-the-unfed-members-and-the-row-below', ['core#0', 'lower']]] as const) {
      const base = await run(sheet(name));
      for (const block of ['links', 'nodes'] as const) {
        const turned = await run(reversed(sheet(name), block));
        // Reversed nodes reverse the order of the row above (a top row keeps declaration order on a tie, ticket 20), and with it the feed
        // keys: the members linked between the two rows then stand mirrored. A member with no link between them (rr-1, rr-2) keeps the slot
        // today's order gives it (the search keeps today's order where it is a minimum). The search adds no other difference.
        const linked = (model: LayoutModel, row: string): string[] => order(model, row).filter(node => model.links.some(link =>
          [link.attachments?.from.node, link.attachments?.to.node].includes(node) && rows.every(group => model.groups[group]!.nodes.some(other =>
            [link.attachments?.from.node, link.attachments?.to.node].includes(other)))));
        const mirrored = block === 'nodes' && linked(turned, rows[0]).join() === linked(base, rows[0]).reverse().join();
        for (const row of rows) expect(linked(turned, row), `${name} ${block} ${row}`).toEqual(mirrored ? linked(base, row).reverse() : linked(base, row));
        if (block === 'links') for (const row of rows) expect(order(turned, row), `${name} links ${row}`).toEqual(order(base, row));
      }
    }
  }, 300000);

  it('keeps the authored order under feedOrder: false and corridorRowOrder: false', async () => {
    for (const flag of ['feedOrder', 'corridorRowOrder']) {
      const model = await run(sheet(PLANAR).replace('portograph: 2\n', `portograph: 2\nlayout: { ${flag}: false }\n`));
      const entries = ofKind(model.reservations ?? [], 'rowOrder');
      expect(entries.some(({ payload }) => payload.feeds.some(feed => feed.row === 'core#1')), flag).toBe(false);
      expect(order(model, 'core#1'), flag).toEqual(['pe-1', 'pe-2', 'pe-3', 'pe-4', 'rr-1', 'rr-2']);
    }
  }, 240000);
});

describe('stacked pairs, the refresh and a refused try (dense-16x9 ticket 32, review 1)', () => {
  const THREE = 'a-row-a-pair-settled-keeps-its-order-in-the-pair-below';
  const COMPETITION = 'a-joint-row-order-frees-the-unfed-members-and-the-row-below';
  const rowEntries = (model: LayoutModel) => ofKind(model.reservations ?? [], 'rowOrder');

  it('keeps an unchanged joint reservation with a free lower row through a refresh', async () => {
    const model = structuredClone(await placed(sheet(COMPETITION)));
    const before = structuredClone(rowEntries(model));
    expect(before.some(({ payload }) => 'row' in payload && payload.row === 'lower')).toBe(true);
    refreshFeedOrders(model);
    expect(rowEntries(model)).toEqual(before);
    expect(model.diagnostics.filter(item => item.code === 'FEED_ORDER_WITHDRAWN')).toEqual([]);
  }, 120000);

  it('settles the middle row in the first pair: the pair below moves only its lower row, and a refresh agrees', async () => {
    // The first pair (a row over m row) is already a minimum, 4 crossings, as the middle row stands ([m3, m1, m2]). The pair below (m row
    // over b row) took the middle row to [m1, m3, m2] on 10fa07cc, 5 crossings for the first pair, and a refresh turned it back.
    const model = await run(sheet(THREE));
    expect(order(model, 'core#1')).toEqual(['m3', 'm1', 'm2']);
    expect(between(model, 'core#0', 'core#1')).toBe(4);
    const stage = structuredClone(await placed(sheet(THREE)));
    expect(order(stage, 'core#1')).toEqual(['m3', 'm1', 'm2']);
    const ledger = structuredClone(rowEntries(stage));
    const middle = ledger.find(({ payload }) => 'cell' in payload && payload.cell === 'core#1')!.payload;
    expect(middle.feeds.map(feed => feed.row)).toEqual(['core#0', 'core#2']);
    refreshFeedOrders(stage);
    expect(order(stage, 'core#1')).toEqual(['m3', 'm1', 'm2']);
    expect(rowEntries(stage)).toEqual(ledger);
    expect(validateFeedOrders(stage)).toEqual([]);
  }, 120000);

  it('gives back the whole upper row when the lower row of a try does not fit', () => {
    // Main 01415610's stage-4 state of the competition sheet: two thick members, and a wall 110 px right of the lower row. The try seats the
    // upper row (it grows to 401 px), then the lower row does not fit: the upper row's box goes back too, not only its order.
    const model = JSON.parse(readFileSync(new URL('../fixtures/staged/a-joint-row-order-competition-at-stage-4-before-the-feed-order.json', import.meta.url), 'utf8')) as LayoutModel;
    const upper = model.groups['core#0']!, lower = model.groups['lower']!;
    model.nodes['b2']!.strokeWidth = 100; model.nodes['c0']!.strokeWidth = 100;
    reseatRow(model, upper, [...upper.rowOrder!], true); reseatRow(model, lower, [...lower.rowOrder!], true);
    const right = lower.bounds!.x + lower.bounds!.width;
    model.groups['blocker'] = { ...structuredClone(lower), id: 'blocker', nodes: [], rowOrder: [], bounds: { x: right + 110, y: lower.bounds!.y, width: 100, height: lower.bounds!.height } };
    const before = structuredClone({ upper, nodes: upper.nodes.map(node => model.nodes[node]) });
    orderByFeeds(model);
    expect(model.diagnostics.some(item => item.code === 'FEED_ORDER_REFUSED')).toBe(true);
    expect(upper.bounds).toEqual(before.upper.bounds);
    expect(upper.nodes.map(node => model.nodes[node])).toEqual(before.nodes);
  });
});
