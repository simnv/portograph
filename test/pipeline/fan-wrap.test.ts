import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { wrapGateVerdict } from '../../src/layout/stagger.js';
import { ownSideWidth } from '../../src/layout/size.js';
import { findPort } from '../../src/layout/row-paths.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

// Fan wrap (decision review 2026-11, D-Q4, ticket 07; ADR-0024, second amendment): a rank cell whose one line is wider than the rest of its
// tier block stands on two lines, the column packer packs its tier again, the feeding chain of the block stands over it again, and the
// acceptance gate keeps the two lines only when the complete placement takes less area and keeps every straight link.
const NAME = 'a-leaf-cell-wider-than-its-block-wraps';
const CHAIN = 'a-feeding-chain-moves-over-its-wrapped-block';
const KEY = 'a-chain-of-tiers-packs-over-its-feeds-final-x';
const DECLINED = 'a-wrap-that-loses-a-straight-link-is-declined';
const CELL = 'west-zone#2';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const oneLine = (yaml: string): string => yaml.replace('\ngroups:', '\nlayout: { autoArrange: false }\ngroups:');
const lines = (model: LayoutModel, group: string): number => new Set(model.groups[group]!.nodes.map(id => model.nodes[id]!.bounds!.y)).size;
const frame = (model: LayoutModel, id: string) => model.frames!.find(item => item.id === id)!.box;
const area = (model: LayoutModel): number => model.canvas!.width * model.canvas!.height;
const failedGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const bends = (model: LayoutModel): number => model.links.reduce((sum, link) => sum + (pathBends(link) ?? 0), 0);
/** The x of the port of `node` that ends its link to `peer`. */
const portX = (model: LayoutModel, node: string, peer: string): number => {
  const link = model.links.find(item => [item.attachments?.from.node, item.attachments?.to.node].sort().join() === [node, peer].sort().join())!;
  return findPort(model, link.attachments!.from.node === node ? link.attachments!.from : link.attachments!.to)!.anchor!.x;
};
/** The nodes whose body is wider than its own content and its widest face at pitch: an alignment grew them. */
const stretched = (model: LayoutModel, ids: readonly string[]): string[] => ids.filter(id => {
  const node = model.nodes[id]!;
  return node.bounds!.width > Math.max(ownSideWidth(node, 'top'), ownSideWidth(node, 'bottom')) + 1;
});

describe('fan wrap: the block trigger (D-Q4)', () => {
  it('stands the eight leaves of a rank cell on two lines, feed order kept, odd members away from the hub, every drop vertical', async () => {
    const model = await run(fixture(NAME));
    expect(model.groupArrangements![CELL]).toEqual({ chosen: 'stagger' });
    expect(lines(model, CELL)).toBe(2);
    const row = model.staggerRows!.find(item => item.group === CELL)!;
    expect(row.order).toEqual(['w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7', 'w-8']);
    // The hub stands above the row (side 'top'): odd members (index 1, 3, ...) stand on the lower line.
    const y = (id: string): number => model.nodes[id]!.bounds!.y;
    expect(y('w-2')).toBeGreaterThan(y('w-1'));
    expect(y('w-3')).toBeCloseTo(y('w-1'), 6);
    for (const link of model.links.filter(item => item.attachments?.from.node === 'w-hub')) {
      expect(pathBends(link), link.id).toBe(0);
      const segment = link.path!.segments[0]!;
      expect(segment.from.x, link.id).toBeCloseTo(segment.to.x, 6);
    }
    expect(failedGates(model)).toEqual([]);
    expect(score(model).snapshot.counters.removedLinks).toBe(0);
    expect(model.diagnostics.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
  }, 60000);

  it('keeps the row of a cell that is no wider than the rest of its block, and records the block reason', async () => {
    // Four gateways in rank 0 make the gateway cell wider than three leaves on one line.
    const yaml = fixture(NAME)
      .replace(/ {2}w-[4-8]: .*\n/g, '').replace(/ {2}- \[w-hub, w-[4-8]\]\n/g, '')
      .replace('  w-hub:', '  w-gw2: { group: west, class: router, label: West gateway two }\n  w-gw3: { group: west, class: router, label: West gateway three }\n  w-gw4: { group: west, class: router, label: West gateway four }\n  w-hub:')
      .replace('  - [w-gw, w-hub]', '  - [w-gw, w-hub]\n  - [core-1, w-gw2]\n  - [core-1, w-gw3]\n  - [core-1, w-gw4]');
    const model = await run(yaml);
    expect(lines(model, CELL)).toBe(1);
    expect(model.staggerRows).toBeUndefined();
    const entry = model.groupArrangements![CELL]!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/^block: one line \([\d.]+ px\) is no wider than the rest of its block \([\d.]+ px\)$/);
  }, 60000);

  it('keeps the row when a hub feeds fewer than three of its members (a fan is three or more)', async () => {
    const yaml = fixture(NAME).replace('  - [w-hub, w-7]\n  - [w-hub, w-8]\n', '  - [e-hub, w-7]\n  - [e-hub, w-8]\n');
    const model = await run(yaml);
    expect(lines(model, CELL)).toBe(1);
    expect(model.staggerRows).toBeUndefined();
  }, 60000);
});

describe('fan wrap: the re-pack after the seat (D-Q4)', () => {
  it('packs the sibling frame against the narrower wrapped frame, one gap as before, and keeps the gateway feed straight', async () => {
    const wrapped = await run(fixture(NAME));
    const plain = await run(oneLine(fixture(NAME)));
    const gap = (model: LayoutModel): number => frame(model, 'east').x - frame(model, 'west').x - frame(model, 'west').width;
    expect(frame(wrapped, 'west').width).toBeLessThan(frame(plain, 'west').width - 100);
    expect(gap(wrapped)).toBeCloseTo(gap(plain), 6);
    expect(area(wrapped)).toBeLessThan(area(plain));
    // The hub spans its drops and its feed from the gateway stays straight (the far face keeps its ports' offsets from the centre).
    const feed = wrapped.links.find(link => link.attachments?.from.node === 'w-gw' && link.attachments.to.node === 'w-hub')!;
    expect(pathBends(feed)).toBe(0);
  }, 60000);

  it('keeps the one-line row and writes no record under layout.autoArrange: false', async () => {
    const off = await run(oneLine(fixture(NAME)));
    expect(off.staggerRows).toBeUndefined();
    expect(off.groupArrangements).toBeUndefined();
    expect(lines(off, CELL)).toBe(1);
  }, 60000);

  it('does not follow the order of the links (R3), and restore keeps the rows (R5)', async () => {
    const base = await run(fixture(NAME));
    const reversedLinks = await run(reversed(fixture(NAME), 'links'));
    expect(reversedLinks.groupArrangements).toEqual(base.groupArrangements);
    expect(reversedLinks.staggerRows).toEqual(base.staggerRows);
    expect(reversedLinks.canvas).toEqual(base.canvas);
    expect(restoreLayoutModel(JSON.stringify(base)).staggerRows).toEqual(base.staggerRows);
  }, 60000);
});

describe('fan wrap: the feeding chain stands over its wrapped block (D-Q4)', () => {
  it('moves the chain (dist and core) as one block so Dist one stands over West gateway, and grows no body of it', async () => {
    const model = await run(fixture(CHAIN));
    expect(model.groupArrangements![CELL]).toEqual({ chosen: 'stagger' });
    expect(model.staggerRows!.find(item => item.group === CELL)!.chain).toEqual(['core', 'dist']);
    expect(portX(model, 'dist-1', 'w-gw')).toBeCloseTo(portX(model, 'w-gw', 'dist-1'), 6);
    expect(portX(model, 'core-1', 'dist-1')).toBeCloseTo(portX(model, 'dist-1', 'core-1'), 6);
    expect(stretched(model, ['core-1', 'core-2', 'dist-1', 'dist-2'])).toEqual([]);
    expect(model.diagnostics.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
    const plain = await run(oneLine(fixture(CHAIN)));
    expect(area(model)).toBeLessThan(area(plain));
    // The one-line layout stretches Dist one toward West gateway; the chain move makes that growth unnecessary.
    expect(stretched(plain, ['dist-1'])).toEqual(['dist-1']);
    expect(failedGates(model)).toEqual([]);
    expect(score(model).snapshot.counters.removedLinks).toBe(0);
  }, 60000);

  it('keeps the wrap of the 29-leaf key sheet: the chain stands over West gateway, no chain body grows, a third less area', async () => {
    const model = await run(fixture(KEY));
    const plain = await run(oneLine(fixture(KEY)));
    expect(lines(model, CELL)).toBe(2);
    expect(model.staggerRows![0]!.chain).toEqual(['core', 'dist', 'top-a', 'top-b']);
    expect(portX(model, 'dist-1', 'west-gw')).toBeCloseTo(portX(model, 'west-gw', 'dist-1'), 6);
    expect(stretched(model, ['a-core', 'a-edge', 'b-core', 'b-edge', 'core-1', 'core-2', 'dist-1', 'dist-2'])).toEqual([]);
    expect(area(model)).toBeLessThan(0.7 * area(plain));
    expect(bends(model)).toBeLessThanOrEqual(bends(plain));
    expect(failedGates(model)).toEqual([]);
  }, 60000);

  it('refuses, at stage 5 and by name, a chain whose near units need different moves (each near unit must stand over its own feeds)', async () => {
    const model = await run(fixture('locations-stack-as-columns-over-columns'));
    expect(model.staggerRows).toBeUndefined();
    const entry = model.groupArrangements!['x-zone#2']!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/its feeding chain \(a, b\) cannot stand over its block with one move: a needs [-\d.]+ px, b [-\d.]+ px$/);
  }, 60000);

  it('keeps a shared parent out of the chain: Core one feeds both gateways, so the chain is decided empty and the wrap stands', async () => {
    const model = await run(fixture(NAME));
    expect(lines(model, CELL)).toBe(2);
    expect(model.staggerRows![0]!.chain).toEqual([]);
  }, 60000);

  it('does not follow the order of the links (R3), and restore keeps the chain (R5)', async () => {
    const base = await run(fixture(CHAIN));
    const reversedLinks = await run(reversed(fixture(CHAIN), 'links'));
    expect(reversedLinks.staggerRows).toEqual(base.staggerRows);
    expect(reversedLinks.canvas).toEqual(base.canvas);
    expect(restoreLayoutModel(JSON.stringify(base)).staggerRows).toEqual(base.staggerRows);
  }, 60000);

  it('publication refuses a chain moved off its block, a rank cell without a chain record and a plain row with one, whatever the diagnostics say (R2, R5)', async () => {
    const base = await run(fixture(CHAIN));
    const copy = (): LayoutModel => JSON.parse(JSON.stringify(base)) as LayoutModel;
    // A later write moves Dist one's ports off West gateway: the chain no longer stands over its block. A forged diagnostic excuses nothing.
    const moved = copy();
    for (const port of moved.nodes['dist-1']!.ports) if (port.anchor) port.anchor.x += 30;
    moved.diagnostics.push({ stage: 'placement', severity: 'info', code: 'FAN_WRAP_DECLINED', message: 'forged', owners: [{ kind: 'group', id: CELL }] });
    expect(() => restoreLayoutModel(JSON.stringify(moved))).toThrow(/feeding chain \(core, dist\) no longer stands over its block \(dist -30\.00 px off\)/);
    // Absent and empty differ: a rank cell always carries its decided chain (`[]` = no chain); a plain row carries none.
    const absent = copy();
    delete absent.staggerRows![0]!.chain;
    expect(() => restoreLayoutModel(JSON.stringify(absent))).toThrow(/Invalid stagger reservation/);
    const unsorted = copy();
    unsorted.staggerRows![0]!.chain = ['dist', 'core'];
    expect(() => restoreLayoutModel(JSON.stringify(unsorted))).toThrow(/invalid feeding chain/);
    const plainRow = await run(fixture('a-wide-leaf-row-of-two-parents-staggers-without-a-budget'));
    expect(plainRow.staggerRows![0]!.chain).toBeUndefined();
    const forged = JSON.parse(JSON.stringify(plainRow)) as LayoutModel;
    forged.staggerRows![0]!.chain = [];
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/Invalid stagger reservation/);
  }, 60000);
});

describe('fan wrap: the acceptance gate (D-Q4)', () => {
  it('keeps a wrap with less area and every straight link, and names the area when the alternative is smaller', async () => {
    const wrapped = await run(fixture(NAME));
    const plain = await run(oneLine(fixture(NAME)));
    expect(wrapGateVerdict(wrapped, plain)).toBeUndefined();
    expect(wrapGateVerdict(plain, wrapped)).toMatch(/^the complete placement is [\d.]+ x [\d.]+ px with two lines, not less area than [\d.]+ x [\d.]+ px without$/);
  }, 60000);

  it('declines, end to end and by name, a wrap that loses a straight link, also when the placement budget is one re-run', async () => {
    for (const testMaxReruns of [undefined, 1]) {
      const model = await layout(parse(fixture(DECLINED)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(testMaxReruns ? { testMaxReruns } : {}) });
      expect(model.staggerRows, `testMaxReruns ${testMaxReruns}`).toBeUndefined();
      expect(lines(model, CELL)).toBe(1);
      expect(model.groupArrangements![CELL]).toEqual({ chosen: 'row', reason: 'the acceptance gate declined the two lines (FAN_WRAP_DECLINED names why)' });
      expect(model.diagnostics.filter(note => note.code === 'FAN_WRAP_DECLINED').map(note => note.message))
        .toEqual([`The two lines of ${CELL} are declined: the link link-34 is straight without the two lines and not with them.`]);
    }
  }, 120000);

  it('compares against a run with no stagger at all: the comparison cannot choose another row (R1)', async () => {
    // Two six-leaf rows under two switches: stage 5 wraps `ra`; `rb` keeps its row by the aspect rule. A comparison run in decide mode would
    // wrap `rb` once `ra` is declined, and publish it unjudged.
    const six = [1, 2, 3, 4, 5, 6];
    const nodes = (row: string): string => six.map(i => `  ${row}${i}: { group: ${row}, class: server }\n`).join('');
    const links = (row: string, hub: string): string => six.map(i => `  - [${hub}, ${row}${i}]\n`).join('');
    const yaml = `portograph: 2
groups:
  u0: { tier: 0 }
  u1: { tier: 1 }
  core: { tier: 2 }
  acca: { tier: 3 }
  accb: { tier: 3 }
  a: { tier: 4 }
  b: { tier: 4 }
nodes:
  n0: { group: u0, class: router }
  n1: { group: u1, class: router }
  r1: { group: core, class: router }
  sw1: { group: acca, class: switch }
  sw2: { group: accb, class: switch }
${nodes('a')}${nodes('b')}links:
  - [n0, n1]
  - [n1, r1]
  - [r1, sw1]
  - [r1, sw2]
${links('a', 'sw1')}${links('b', 'sw2')}`;
    const model = await run(yaml);
    expect(model.staggerRows?.map(row => row.group)).toEqual(['a']);
    const entry = model.groupArrangements!.b!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/^aspect: /);
    expect(model.diagnostics.filter(note => note.code === 'FAN_WRAP_DECLINED')).toEqual([]);
  }, 120000);

  it('names a straight link the wrap would lose', async () => {
    const wrapped = await run(fixture(NAME));
    const plain = await run(oneLine(fixture(NAME)));
    // The same wrapped placement with the gateway's feed moved off its hub port: the feed is straight in `plain` and not here.
    const moved = JSON.parse(JSON.stringify(wrapped)) as LayoutModel;
    const feed = moved.links.find(link => link.attachments?.from.node === 'w-gw' && link.attachments.to.node === 'w-hub')!;
    moved.nodes['w-gw']!.ports.find(item => item.side === 'bottom')!.anchor!.x += 30;
    delete feed.path;
    expect(wrapGateVerdict(moved, plain)).toMatch(new RegExp(`^the link ${feed.id} is straight without the two lines and not with them$`));
  }, 60000);
});
