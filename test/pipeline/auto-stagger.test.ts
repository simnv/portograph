import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel, resolve, sidesOne, sizeNodes, skeleton, sidesTwo } from '../../src/internal.js';
import { arrangeGroups } from '../../src/layout/stagger.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

// Architecture-2 ticket 51: with no width budget, stage 5 of the first placement run stands a wide leaf row on two lines when the
// stagger proves straight drops and a narrower sheet, and records each group's arrangement (`groupArrangements`).
const NAME = 'a-wide-leaf-row-of-two-parents-staggers-without-a-budget';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// The group lift (ticket 08) is off: on the inline sheets a lift changes the canvas the stagger rules read, so a pinned refusal is admitted.
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
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
    // Every group keeps its row before a draft (`servers` by the authored shape), and under `autoArrange: false` stage 5 chooses nothing:
    // in both there is no record (R1: absent, not an all-`row` record).
    expect(authored.groupArrangements).toBeUndefined();
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
    const reversedLinks = await run(reversed(fixture(NAME), 'links'));
    expect(picture(reversedLinks)).toEqual(picture(base));
    expect(reversedLinks.groupArrangements).toEqual(base.groupArrangements);
    // Node declaration order is the row order (a meaningful order, R3): the row is mirrored, and the decision and the canvas are the same.
    const reversedNodes = await run(reversed(fixture(NAME), 'nodes'));
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

  it('writes no record when no group passes the rules before a draft (R1: absent beside an all-row record)', async () => {
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

// Follow-up of 2026-11-02 (user decisions): any authored shape wins, the aspect rule, and the two open review findings 3b and 4.
const oneParent = (leaves: number): string => `portograph: 2
groups:
  top: { tier: 0 }
  feeds: { tier: 1 }
  leaves: { tier: 2 }
nodes:
  t: { group: top, class: router }
  p: { group: feeds, class: switch }
${Array.from({ length: leaves }, (_, i) => `  n${i + 1}: { group: leaves, class: server }`).join('\n')}
links:
  - [t, p]
${Array.from({ length: leaves }, (_, i) => `  - [p, n${i + 1}]`).join('\n')}
`;
const skeletonOf = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
  return model;
};

describe('stage 5 admits a stagger only toward a square sheet (ticket 51, aspect rule)', () => {
  it.each(['a-linked-node-steps-out-of-a-straight-chord', 'a-group-with-routed-links-steps-off-a-straight-chord'])(
    '%s: two hubs that feed two hosts each are no fan (D-Q4): the row stays and no group is tried', async sheet => {
      const model = await run(fixture(sheet));
      expect(model.staggerRows).toBeUndefined();
      expect(lines(model, 'hosts')).toBe(1);
      expect(model.groupArrangements).toBeUndefined();
    }, 60000);

  it('a plain row on a sheet taller than wide keeps its row, and the record names the aspect', async () => {
    const model = await run(oneParent(3));
    expect(model.staggerRows).toBeUndefined();
    expect(lines(model, 'leaves')).toBe(1);
    const entry = model.groupArrangements!.leaves!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/^aspect: the sheet is [\d.]+ x [\d.]+ px, not wider than tall$/);
  }, 60000);

  it('refuses two lines that leave a wide sheet further from square than one line', async () => {
    const model = await run(oneParent(5));
    expect(model.staggerRows).toBeUndefined();
    expect(lines(model, 'leaves')).toBe(1);
    const entry = model.groupArrangements!.leaves!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/^aspect: two lines give [\d.]+ x [\d.]+ px, not nearer square than [\d.]+ x [\d.]+ px$/);
  }, 60000);
});

describe('any authored shape wins (ticket 51, user decision 2026-11-02)', () => {
  it.each(['ranked', 'row', 'grid'])('shape: %s on the servers keeps the one-line row and writes no record', async shape => {
    const yaml = fixture(NAME).replace('servers: { tier: 2 }', `servers: { tier: 2, shape: ${shape} }`);
    expect(parse(yaml).groups.servers!.shapeAuthored).toBe(true);
    const model = await run(yaml);
    expect(model.staggerRows).toBeUndefined();
    expect(model.groupArrangements).toBeUndefined();
  }, 60000);

  it('marks no shape the author did not write', () => {
    expect(parse(fixture(NAME)).groups.servers!.shapeAuthored).toBeUndefined();
  });
});

describe('a feeding parent seated over its other links (review finding 3b)', () => {
  // `p` feeds n1 to n6 and also links to `x`; `q`, its row neighbour, links to `z`. Seated over the drops and `x`, `p` reaches `q`.
  const crowded = `portograph: 2
groups:
  feeds: { tier: 0 }
  leaves: { tier: 1 }
  side: { tier: 1 }
nodes:
  p: { group: feeds, class: switch }
  q: { group: feeds, class: switch }
${[1, 2, 3, 4, 5, 6].map(i => `  n${i}: { group: leaves, class: server }`).join('\n')}
  x: { group: side, class: server }
  z: { group: side, class: server }
links:
${[1, 2, 3, 4, 5, 6].map(i => `  - [p, n${i}]`).join('\n')}
  - [p, x]
  - [q, z]
`;
  it('refuses by name when the widened parent comes within clearance of its row neighbour', async () => {
    const model = await run(crowded);
    expect(model.staggerRows).toBeUndefined();
    const entry = model.groupArrangements!.leaves!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/Stagger row leaves: the feeding face of p, seated over its drops and its other links \(link-7\), comes within clearance of q$/);
  }, 60000);

  it('refuses by name when the widened parent pushes its group into a neighbour group of its band', async () => {
    // `q` in a group of its own, and `z` before `x`: `feeds`, grown round `p`, reaches `feeds2` (the freeze's band test).
    const apart = crowded.replace('  feeds: { tier: 0 }\n', '  feeds: { tier: 0 }\n  feeds2: { tier: 0 }\n').replace('  q: { group: feeds,', '  q: { group: feeds2,')
      .replace('  x: { group: side, class: server }\n  z: { group: side, class: server }\n', '  z: { group: side, class: server }\n  x: { group: side, class: server }\n');
    const model = await run(apart);
    expect(model.staggerRows).toBeUndefined();
    const entry = model.groupArrangements!.leaves!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/the feeding face of p, seated over its drops and its other links \(link-7\), leaves its band invalid: Groups feeds and feeds2 overlap$/);
  }, 60000);

  it('refuses by name when a port the seat does not move breaks the pitch of the feeding face', async () => {
    // The overlay link to `x` keeps its port where it stood; the seated drops spread past it.
    const overlay = crowded.replace('  q: { group: feeds, class: switch }\n', '').replace('  z: { group: side, class: server }\n', '').replace('  - [q, z]\n', '')
      .replace('  - [p, x]\n', '  - [p, x, { class: sync }]\n');
    const model = await run(overlay);
    expect(model.staggerRows).toBeUndefined();
    const entry = model.groupArrangements!.leaves!;
    expect(entry.chosen === 'row' && entry.reason).toMatch(/the feeding face of p, seated over its drops, cannot keep its pitch between the port of link-7 and the port of link-\d+$/);
  }, 60000);

  it('admits a parent whose other link fits beside the drops', async () => {
    const fits = crowded.replace('  q: { group: feeds, class: switch }\n', '').replace('  z: { group: side, class: server }\n', '').replace('  - [q, z]\n', '');
    const model = await run(fits);
    expect(model.groupArrangements!.leaves).toEqual({ chosen: 'stagger' });
    expect(failedGates(model)).toEqual([]);
  }, 60000);
});

describe('arrangeGroups records only a stagger refusal (review finding 4)', () => {
  it('records a stagger refusal as the reason and rethrows every other error', async () => {
    const model = await skeletonOf(fixture(NAME));
    const refused = JSON.parse(JSON.stringify(model)) as LayoutModel;
    arrangeGroups(refused, new Map(), () => { throw new PlacementRefusal('stagger', 'Stagger row servers: a named refusal'); });
    expect(refused.groupArrangements!.servers).toEqual({ chosen: 'row', reason: 'stage 5 refused the two lines: Stagger row servers: a named refusal' });
    expect(refused.staggerRows).toBeUndefined();
    const bug = new Error('Nodes sw1 and sw2 violate clearance');
    expect(() => arrangeGroups(JSON.parse(JSON.stringify(model)) as LayoutModel, new Map(), () => { throw bug; })).toThrow(bug);
    const ledger = new PlacementRefusal('ledger', 'a ledger refusal');
    expect(() => arrangeGroups(JSON.parse(JSON.stringify(model)) as LayoutModel, new Map(), () => { throw ledger; })).toThrow(ledger);
    expect(() => arrangeGroups(JSON.parse(JSON.stringify(model)) as LayoutModel, new Map(), () => { throw new TypeError('x is undefined'); })).toThrow(TypeError);
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
    // Each of these groups is no fan (a hub feeds fewer than three members), leaves through a lateral far face, or fails the seat's proof: a
    // record names it, or no group passes the rules before a draft and there is no record.
    const entry = unbudgeted.groupArrangements?.[group];
    expect(entry === undefined ? unbudgeted.groupArrangements : entry.chosen).toBe(entry === undefined ? undefined : 'row');
  }, 120000);

});
