import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel, resolve, sidesOne, sizeNodes, skeleton, sidesTwo } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Architecture-2 ticket 51: with no width budget, stage 5 of the first placement run stands a wide leaf row on two lines when the
// stagger proves straight drops and a narrower sheet, and records each group's arrangement (`groupArrangements`).
const NAME = 'a-wide-leaf-row-of-two-parents-staggers-without-a-budget';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const picture = (model: LayoutModel) => Object.fromEntries(Object.entries(model.nodes).sort(([a], [b]) => a < b ? -1 : 1).map(([id, node]) =>
  [id, { bounds: node.bounds, xs: node.ports.map(port => port.anchor!.x).sort((a, b) => a - b) }]));
const lines = (model: LayoutModel, group: string): number => new Set(model.groups[group]!.nodes.map(id => model.nodes[id]!.bounds!.y)).size;
const failedGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const refusals = (model: LayoutModel): string[] => model.diagnostics.filter(note => note.code === 'ROW_STAGGER_REFUSED').map(note => note.message);
const withLayout = (yaml: string, layoutLine: string): string => yaml.replace('\ngroups:', `\nlayout: ${layoutLine}\ngroups:`);

describe('a wide leaf row staggers without a width budget (architecture-2 ticket 51)', () => {
  it('stands the nine servers on two lines with 11 straight vertical links and records the choice', async () => {
    const model = await run(fixture(NAME));
    expect(lines(model, 'servers')).toBe(2);
    const routed = model.links.filter(link => link.layer === 'routed');
    expect(routed).toHaveLength(11);
    for (const link of routed) {
      expect(pathBends(link), link.id).toBe(0);
      for (const segment of link.path!.segments) expect(segment.from.x, link.id).toBeCloseTo(segment.to.x, 6);
    }
    const report = score(model).snapshot;
    expect(report.metrics.crossings.count).toBe(0);
    expect(report.counters.removedLinks).toBe(0);
    expect(failedGates(model)).toEqual([]);
    expect(model.canvas!.width).toBeLessThan(500);
    expect(refusals(model)).toEqual([]);
    expect(model.groupArrangements!.servers).toEqual({ chosen: 'stagger' });
    for (const id of ['core', 'access']) {
      const entry = model.groupArrangements![id]!;
      expect(entry.chosen).toBe('row');
      expect(entry.chosen === 'row' && entry.reason.length > 0).toBe(true);
    }
    // The two-parent spacing: the gap between a5 (sw1) and a6 (sw2) is wider than a gap under one parent, and the switches keep a row gap.
    const pitches = model.staggerRows![0]!.pitches;
    expect(pitches).toHaveLength(8);
    expect(pitches[4]!).toBeGreaterThan(pitches[0]!);
    const sw1 = model.nodes.sw1!.bounds!, sw2 = model.nodes.sw2!.bounds!;
    expect(sw2.x).toBeGreaterThan(sw1.x + sw1.width);
  }, 60000);

  it('keeps the one-line row under an authored shape and under layout.autoArrange: false', async () => {
    const authored = await run(fixture(NAME).replace('servers: { tier: 2 }', 'servers: { tier: 2, shape: row }'));
    const off = await run(withLayout(fixture(NAME), '{ autoArrange: false }'));
    for (const model of [authored, off]) {
      expect(model.staggerRows).toBeUndefined();
      expect(lines(model, 'servers')).toBe(1);
    }
    expect(authored.groupArrangements!.servers).toEqual({ chosen: 'row', reason: 'the author set shape row' });
    // `autoArrange: false`: stage 5 chooses nothing, so there is no record (R1: absent, not an all-`row` record).
    expect(off.groupArrangements).toBeUndefined();
    expect(picture(authored)).toEqual(picture(off));
  }, 60000);

  it('publishes the same two lines under a budget they meet, with no WIDTH_BUDGET_UNMET', async () => {
    const base = await run(fixture(NAME));
    const budget = await run(withLayout(fixture(NAME), '{ maxWidth: 600 }'));
    expect(budget.diagnostics.filter(note => note.code === 'WIDTH_BUDGET_UNMET' || note.code === 'ROW_STAGGER_REFUSED')).toEqual([]);
    expect(picture(budget)).toEqual(picture(base));
  }, 60000);

  it('stands a one-parent row on two lines without a budget', async () => {
    const yaml = `portograph: 2
groups:
  feeds: { tier: 0 }
  leaves: { tier: 1 }
nodes:
  p: { group: feeds, class: switch }
${[1, 2, 3, 4, 5, 6].map(i => `  n${i}: { group: leaves, class: server }`).join('\n')}
links:
${[1, 2, 3, 4, 5, 6].map(i => `  - [p, n${i}]`).join('\n')}
`;
    const model = await run(yaml);
    expect(model.staggerRows?.map(row => row.group)).toEqual(['leaves']);
    expect(model.canvas!.width).toBe(298);
    expect(failedGates(model)).toEqual([]);
  }, 60000);

  it('does not follow the order of the links; reversed nodes mirror the row and keep the choice (R3)', async () => {
    const base = await run(fixture(NAME));
    const [top, rest] = fixture(NAME).split('nodes:\n'), [nodes, links] = rest!.split('links:\n');
    const reverse = (block: string): string => `${block.trimEnd().split('\n').reverse().join('\n')}\n`;
    const reversedLinks = await run(`${top}nodes:\n${nodes}links:\n${reverse(links!)}`);
    expect(picture(reversedLinks)).toEqual(picture(base));
    expect(reversedLinks.groupArrangements).toEqual(base.groupArrangements);
    // Node declaration order is the row order (a meaningful order, R3): the row is mirrored, and the decision and the canvas are the same.
    const reversedNodes = await run(`${top}nodes:\n${reverse(nodes!)}links:\n${links}`);
    expect(reversedNodes.groupArrangements).toEqual(base.groupArrangements);
    expect(reversedNodes.canvas).toEqual(base.canvas);
    expect([...reversedNodes.staggerRows![0]!.pitches].reverse()).toEqual(base.staggerRows![0]!.pitches);
  }, 60000);

  it('restore refuses a moved back-line node and a record that contradicts the rows (R5)', async () => {
    const model = await run(fixture(NAME));
    const json = JSON.stringify(model);
    expect(() => restoreLayoutModel(json)).not.toThrow();
    const moved = JSON.parse(json) as LayoutModel;
    const back = moved.nodes[moved.staggerRows![0]!.order[1]!]!;
    back.bounds!.x += 4;
    for (const port of back.ports) if (port.anchor) port.anchor.x += 4;
    expect(() => restoreLayoutModel(JSON.stringify(moved))).toThrow(/stagger/i);
    const forged = JSON.parse(json) as LayoutModel;
    forged.groupArrangements!.servers = { chosen: 'row', reason: 'forged' };
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/arrangement/i);
    const off = JSON.parse(json) as LayoutModel;
    off.document.layout = { autoArrange: false };
    expect(() => restoreLayoutModel(JSON.stringify(off))).toThrow(/autoArrange/);
  }, 60000);

  it('a later placement run keeps what it is given and decides nothing (R1)', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(fixture(NAME)))));
    await skeleton(model, { createAttempt });
    const kept = sidesTwo(JSON.parse(JSON.stringify(model)) as LayoutModel, undefined, { mode: 'keep' });
    expect(kept.groupArrangements).toBeUndefined();
    expect(kept.staggerRows).toBeUndefined();
    const decided = sidesTwo(model);
    expect(decided.groupArrangements!.servers).toEqual({ chosen: 'stagger' });
    // A group a later stage refused in an earlier attempt of the first run stays a row, with the refusal as its reason.
    const again = sizeNodes(sidesOne(resolve(parse(fixture(NAME)))));
    await skeleton(again, { createAttempt });
    const declined = sidesTwo(again, undefined, { mode: 'decide', declined: new Map([['servers', 'Stagger placement lost its reserved pitch or lines']]) });
    expect(declined.staggerRows).toBeUndefined();
    expect(declined.groupArrangements!.servers).toEqual({ chosen: 'row', reason: 'a later stage of the first run refused the two lines: Stagger placement lost its reserved pitch or lines' });
  }, 60000);

  it('writes no record when no group is a candidate row (R1: absent beside an all-row record)', async () => {
    const model = await run(`portograph: 2
groups:
  up: { tier: 0 }
  down: { tier: 1 }
nodes:
  u: { group: up, class: router }
  d1: { group: down, class: server }
  d2: { group: down, class: server }
links: [[u, d1], [u, d2]]
`);
    expect(model.groupArrangements).toBeUndefined();
    expect(model.staggerRows).toBeUndefined();
  }, 60000);
});

// The five width-budget trials that stage 5 admitted and routing refused (kill experiment, class b1: drops not vertical). Each is now a
// stage-5 refusal with a named reason, so no trial reaches routing.
describe('stage 5 refuses the stagger trials whose drops would bend (architecture-2 ticket 51)', () => {
  it.each([
    // (1) A wide parent's ports stood 100 px off the members: the centre rule moves the parent from the tier above, not over the row.
    ['a-foreign-lane-stands-outside-the-frame', 'mid#1', /the centre rule \(7c\) aligns the row under its parents/],
    // (2) The far end of `lb` is a lateral face of `outlet`.
    ['a-link-drops-beside-a-frame-into-a-lateral-side', 'front', /link \S+ ends on the right face of outlet/],
    // (3) Two parents interleave: `edge-sw`, a body of the parent tier, stands in a drop corridor of `core-sw`.
    ['a-single-feed-port-follows-its-child-over-a-pushed-row', 'leaves', /the feeds of core-sw interleave/],
    // (3) The drops from `core-sw` run through the tiers between, past a foreign body.
    ['a-single-feed-port-follows-its-child-over-a-pushed-row', 'rack', /the drop of link \S+ to cam-1 meets a foreign body/],
    // (3) A transit: `sw-1`'s drop to `host-2` crosses the tier of `sw-2` inside the box 7a keeps its lane out of.
    ['a-stem-tip-stands-beyond-its-pill-text', 'hosts', /link \S+ crosses the box of access#1 between sw-1 and host-2/],
  ])('%s: %s', async (sheet, group, reason) => {
    const model = await run(withLayout(fixture(sheet), '{ maxWidth: 1 }'));
    const mine = model.diagnostics.filter(note => note.code === 'ROW_STAGGER_REFUSED' && note.owners?.some(owner => owner.kind === 'group' && owner.id === group)).map(note => note.message);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(new RegExp(`Error: Stagger row ${group}: ${reason.source}`));
    expect(mine[0]).not.toMatch(/vertical drops/);
    // Without a budget, stage 5 keeps the row too, and the record names why.
    const unbudgeted = await run(fixture(sheet));
    expect(unbudgeted.staggerRows?.some(row => row.group === group) ?? false).toBe(false);
    // Each of these groups is a rank cell, has fewer than four members, or leaves through a lateral far face: a record names it, or there is
    // no candidate row and no record.
    const entry = unbudgeted.groupArrangements?.[group];
    expect(entry === undefined ? unbudgeted.groupArrangements : entry.chosen).toBe(entry === undefined ? undefined : 'row');
  }, 120000);

});
