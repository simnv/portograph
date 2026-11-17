import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { validateFeedOrders } from '../../src/layout/feed-order.js';
import { ofKind } from '../../src/layout/reservations.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

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
    expect(lower.feeds).toEqual([{ row: 'core#0', order: upper.order }]);
    expect(validateFeedOrders(model)).toEqual([]);
  }, 120000);

  it('refuses a model whose lower row no longer stands in the order the upper row read (the premise)', async () => {
    const model = structuredClone(await run(sheet(PLANAR)));
    model.groups['core#1']!.rowOrder = [...order(model, 'core#1')].reverse();
    expect(validateFeedOrders(model).join('\n')).toContain('the feeding row core#1 no longer stands in the order the entry read');
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
    const entries = ofKind(model.reservations ?? [], 'rowOrder');
    expect(entries.some(({ payload }) => payload.feeds.some(feed => feed.row === 'core#1'))).toBe(false);
  }, 120000);

  it('gives the same rows with the links and with the nodes declared the other way round (R3)', async () => {
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
