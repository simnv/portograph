import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel, resolve, sidesOne, sizeNodes, skeleton, sidesTwo } from '../../src/internal.js';
import { columnCandidates } from '../../src/layout/column-arrangement.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Architecture-2 ticket 52: a group whose members all link laterally to the group beside it stands as one column, one member on each
// line, decided in stage 5 of the first placement run and recorded in `groupArrangements`.
const FLANK = 'a-flank-whose-members-all-link-to-its-tier-stands-as-one-column';
const TIER = 'a-tier-group-whose-members-all-link-to-its-flank-stands-as-one-column';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const failedGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const picture = (model: LayoutModel) => Object.fromEntries(Object.entries(model.nodes).sort(([a], [b]) => a < b ? -1 : 1)
  .map(([id, node]) => [id, { bounds: node.bounds, ports: node.ports.map(port => port.anchor!).sort((a, b) => a.y - b.y || a.x - b.x) }]));
/** The stage-5 model (final sides, the column seated) on which `columnCandidates` reads its reasons. */
async function stageFive(yaml: string): Promise<LayoutModel> {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
  return sidesTwo(model);
}
const reasonOf = async (yaml: string, group: string): Promise<string | undefined> => columnCandidates(await stageFive(yaml)).reasons.get(group);
const centres = (model: LayoutModel, group: string): { x: number; y: number }[] => model.groups[group]!.rowOrder!
  .map(id => model.nodes[id]!.bounds!).map(box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));

const FLANK_HEAD = `portograph: 2
groups:
  core: { tier: 0 }
  edge: { tier: 1 }
  guard: { align: right, of: edge }
nodes:
  r1: { group: core, class: router }
  e1: { group: edge, class: switch }
  g1: { group: guard, class: tbr }
  g2: { group: guard, class: tbr }
  g3: { group: guard, class: tbr }
links:
  - [r1, e1]
`;

describe('a group whose members all link laterally stands as one column (architecture-2 ticket 52)', () => {
  for (const [name, group, members] of [[FLANK, 'guard', 3], [TIER, 'cells', 4]] as const) {
    it(`${group}: one member on each line, every link kept, straight and uncrossed, G1-G9 pass`, async () => {
      const model = await run(fixture(name));
      expect(model.groupArrangements![group]).toEqual({ chosen: 'column' });
      const points = centres(model, group);
      expect(points).toHaveLength(members);
      for (const point of points.slice(1)) {
        expect(point.x).toBeCloseTo(points[0]!.x, 6);
        expect(point.y - points[0]!.y).toBeGreaterThan(0);
      }
      const report = score(model).snapshot;
      expect(report.counters.removedLinks).toBe(0);
      expect(report.metrics.crossings.count).toBe(0);
      expect(failedGates(model)).toEqual([]);
      const routed = model.links.filter(link => link.layer === 'routed');
      expect(routed).toHaveLength(4);
      for (const link of routed) expect(pathBends(link), link.id).toBe(0);
      expect(model.diagnostics.filter(note => note.code === 'ROUTE_GAP_REJECTED' || note.code === 'FLANK_CAPACITY')).toEqual([]);
      // Every other group has an entry: a row with a reason (R1, the record exists because a group took the column).
      for (const [id, entry] of Object.entries(model.groupArrangements!)) {
        if (id === group) continue;
        expect(entry.chosen, id).toBe('row');
        expect(entry.chosen === 'row' && entry.reason.length > 0, id).toBe(true);
      }
    }, 60000);
  }

  it('records one entry per group, never two, and no record when no group takes an arrangement (R1)', async () => {
    const model = await run(fixture(FLANK));
    expect(Object.keys(model.groupArrangements!).sort()).toEqual(Object.keys(model.groups).sort());
    expect(model.groupArrangements!.edge).toEqual({ chosen: 'row', reason: 'one member only' });
    const none = await run(`${FLANK_HEAD}  - [e1, g1]\n  - [e1, g2]\n`);
    expect(none.groupArrangements).toBeUndefined();
  }, 60000);

  it('keeps the row of main under an authored shape and under layout.autoArrange: false', async () => {
    for (const [name, from, to] of [[FLANK, 'guard: { align: right, of: edge }', 'guard: { align: right, of: edge, shape: SHAPE }'],
      [TIER, 'cells: { tier: 0 }', 'cells: { tier: 0, shape: SHAPE }']] as const) {
      const off = await run(fixture(name).replace('\ngroups:', '\nlayout: { autoArrange: false }\ngroups:'));
      expect(off.groupArrangements).toBeUndefined();
      const row = await run(fixture(name).replace(from, to.replace('SHAPE', 'row')));
      expect(row.groupArrangements).toBeUndefined();
      expect(picture(row)).toEqual(picture(off));
      for (const shape of ['row', 'grid', 'ranked']) {
        const group = from.split(':')[0]!;
        expect(await reasonOf(fixture(name).replace(from, to.replace('SHAPE', shape)), group), shape).toBe('the author set the shape');
      }
    }
  }, 120000);

  it('does not follow the order of the links; reversed nodes keep the choice (R3)', async () => {
    const base = await run(fixture(FLANK));
    const [top, rest] = fixture(FLANK).split('nodes:\n'), [nodes, links] = rest!.split('links:\n');
    const reverse = (block: string): string => `${block.trimEnd().split('\n').reverse().join('\n')}\n`;
    const reversedLinks = await run(`${top}nodes:\n${nodes}links:\n${reverse(links!)}`);
    expect(picture(reversedLinks)).toEqual(picture(base));
    expect(reversedLinks.groupArrangements).toEqual(base.groupArrangements);
    // Node declaration order is the stage-4 row order, which the column keeps top to bottom (a meaningful order, R3).
    const reversedNodes = await run(`${top}nodes:\n${reverse(nodes!)}links:\n${links}`);
    expect(reversedNodes.groupArrangements).toEqual(base.groupArrangements);
    expect(reversedNodes.canvas).toEqual(base.canvas);
    expect(reversedNodes.groups.guard!.rowOrder).toEqual([...base.groups.guard!.rowOrder!].reverse());
  }, 60000);

  it('restore refuses a member moved off its line or pitch (R5)', async () => {
    const model = await run(fixture(FLANK));
    const json = JSON.stringify(model);
    expect(() => restoreLayoutModel(json)).not.toThrow();
    for (const axis of ['x', 'y'] as const) {
      const moved = JSON.parse(json) as LayoutModel;
      const member = moved.nodes[moved.groups.guard!.rowOrder![1]!]!;
      member.bounds![axis] += 4;
      for (const port of member.ports) if (port.anchor) port.anchor[axis] += 4;
      expect(() => restoreLayoutModel(JSON.stringify(moved)), axis).toThrow(/column guard/i);
    }
  }, 60000);

  it('a later placement run seats the recorded column and decides nothing (R1)', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(fixture(FLANK)))));
    await skeleton(model, { createAttempt });
    const kept = sidesTwo(JSON.parse(JSON.stringify(model)) as LayoutModel, undefined, { mode: 'keep' });
    expect(kept.groupArrangements).toBeUndefined();
    expect(new Set(kept.groups.guard!.nodes.map(id => kept.nodes[id]!.bounds!.y)).size).toBe(1);
    const decided = sidesTwo(JSON.parse(JSON.stringify(model)) as LayoutModel);
    const recorded = JSON.parse(JSON.stringify(model)) as LayoutModel;
    recorded.groupArrangements = decided.groupArrangements!;
    const replayed = sidesTwo(recorded, undefined, { mode: 'keep' });
    expect(picture(replayed)).toEqual(picture(decided));
  }, 60000);

  it('under a width budget the trial records the column it seats beside the rows the search gives (R1)', async () => {
    const yaml = `portograph: 2
layout: { maxWidth: 400 }
groups:
  edge: { tier: 0 }
  guard: { align: right, of: edge }
  mid: { tier: 1 }
  leaves: { tier: 2 }
nodes:
  e1: { group: edge, class: switch }
  g1: { group: guard, class: tbr }
  g2: { group: guard, class: tbr }
  g3: { group: guard, class: tbr }
  e2: { group: mid, class: switch }
${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `  l${i}: { group: leaves, class: server }`).join('\n')}
links:
  - [e1, e2]
  - [e1, g1]
  - [e1, g2]
  - [e1, g3]
${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `  - [e2, l${i}]`).join('\n')}
`;
    const model = await run(yaml);
    expect(model.groupArrangements!.guard).toEqual({ chosen: 'column' });
    expect(model.groupArrangements!.leaves).toEqual({ chosen: 'stagger' });
    expect(model.diagnostics.filter(note => note.code === 'ROW_STAGGER_REFUSED' || note.code === 'WIDTH_BUDGET_UNMET')).toEqual([]);
    expect(model.canvas!.width).toBeLessThanOrEqual(400);
    expect(score(model).snapshot.counters.removedLinks).toBe(0);
  }, 120000);

  describe('each refusal keeps the row and names its reason', () => {
    const cases: [string, string, string, string][] = [
      ['a member with a vertical link (side entry)', FLANK_HEAD + '  - [e1, g1]\n  - [e1, g2]\n  - [e1, g3]\n  - [r1, g2]\n', 'guard', 'member g2 has 2 links, not one'],
      ['a member whose one link is vertical', FLANK_HEAD + '  - [e1, g1]\n  - [r1, g2]\n  - [e1, g3]\n', 'guard', 'member g2 links to core, not laterally to edge'],
      ['a member with two links', FLANK_HEAD + '  - [e1, g1]\n  - [e1, g2]\n  - [e1, g3]\n  - [g1, g3]\n', 'guard', 'member g1 has 2 links, not one'],
      ['a link inside the group', FLANK_HEAD + '  - [e1, g1]\n  - [g2, g3]\n', 'guard', 'member g2 links inside the group'],
      ['a member with a bundle', FLANK_HEAD + '  - [e1, g1]\n  - [e1, g1]\n  - [e1, g2]\n  - [e1, g3]\n', 'guard', 'member g1 has 2 links, not one'],
      ['a member with no link to the tier', FLANK_HEAD + '  - [e1, g1]\n  - [e1, g2]\n', 'guard', 'member g3 has no link to edge'],
      ['one member only', FLANK_HEAD + '  - [e1, g1]\n', 'edge', 'one member only'],
    ];
    for (const [title, yaml, group, reason] of cases) {
      it(title, async () => {
        expect(await reasonOf(yaml, group)).toBe(reason);
        const model = await run(yaml);
        expect(model.groupArrangements?.[group]?.chosen ?? 'row').toBe('row');
        expect(new Set(model.groups[group]!.nodes.map(id => model.nodes[id]!.bounds!.y)).size).toBe(1);
      }, 60000);
    }
    it('a member with another port on its facing face', async () => {
      const yaml = FLANK_HEAD.replace('  g2: { group: guard, class: tbr }', '  g2: { group: guard, class: tbr, ports: [{ name: p }, { name: x, side: left }] }')
        + '  - [e1, g1]\n  - [e1, { node: g2, port: p }]\n  - [e1, g3]\n';
      expect(await reasonOf(yaml, 'guard')).toBe('member g2 has other ports on its left face');
    }, 60000);
    it('a peer that is not the node of its row nearest the column', async () => {
      const yaml = `portograph: 2
groups:
  cells: { tier: 0 }
  spine: { align: left, of: cells }
  low: { tier: 1 }
nodes:
  s: { group: spine, class: switch }
  t: { group: spine, class: switch }
  c1: { group: cells, class: server }
  c2: { group: cells, class: server }
  c3: { group: cells, class: server }
  b1: { group: low, class: server }
links:
  - [s, c1]
  - [s, c2]
  - [s, c3]
  - [t, b1]
`;
      expect(await reasonOf(yaml, 'cells')).toMatch(/^s is not the node of spine nearest the column$/);
    }, 60000);
    it('a group with a flank on each side', async () => {
      const yaml = fixture(TIER).replace('  spine: { align: left, of: cells }', '  spine: { align: left, of: cells }\n  rack: { align: right, of: cells }')
        .replace('  s: { group: spine, class: switch }', '  s: { group: spine, class: switch }\n  t: { group: rack, class: switch }');
      expect(await reasonOf(yaml, 'cells')).toBe('a flank stands on each side (rack, spine)');
    }, 60000);
  });
});
