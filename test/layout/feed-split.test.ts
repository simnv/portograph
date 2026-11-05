import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { alignLinkedGroupGridAndPack, gridPairsApart } from '../../src/layout/bands.js';
import { feedPairRoom } from '../../src/layout/feed-split.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 73, the feed split: two sibling groups whose feeds stand apart, but closer than the two reaches and the band gap, get
 * the room in stage 5. The feeding side right of the split line moves right; the child tier stays, and 7c stands each group under its feeds.
 */
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const SPLIT = sheet('a-feed-split-stands-each-group-under-its-feeds');
const TITLES = sheet('two-titles-over-skewed-legs-each-widen-their-group');
const STRETCH = sheet('overlay-links-reorder-an-indifferent-tier');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const stageFive = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
  return sidesTwo(model);
};
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };
const crossings = (model: LayoutModel): number => { const { count, faint } = score(model).snapshot.metrics.crossings; return count - (faint ?? 0); };
/** A link that stands vertical: every segment at one x (a transit runs through its lane in collinear pieces). */
const vertical = (model: LayoutModel, id: string): boolean => {
  const segments = model.links.find(link => link.id === id)!.path!.segments, x = segments[0]!.from.x;
  return segments.every(segment => Math.abs(segment.from.x - x) < 1e-6 && Math.abs(segment.to.x - x) < 1e-6);
};
const linksOf = (model: LayoutModel, node: string): string[] =>
  model.links.filter(link => link.attachments?.from.node === node || link.attachments?.to.node === node).map(link => link.id);
/**
 * The geometry a layout publishes, taken from the canvas origin and rounded to 1e-6: group boxes by id, and the node boxes and link paths as
 * sorted lists (sw2 and sw4 have the same links, so the two are interchangeable), and the record without its line (`at` is a stage-5 x, and
 * stage 4 places the sheet at another x for another link order).
 */
const geometry = (model: LayoutModel) => {
  const dx = model.canvas!.x, r = (value: number): number => Math.round(value * 1e6) / 1e6;
  const box = (rect: { x: number; y: number; width: number; height: number }): number[] => [r(rect.x - dx), r(rect.y), r(rect.width), r(rect.height)];
  const sorted = (rows: number[][]): string[] => rows.map(row => row.join(' ')).sort();
  return {
    canvas: [r(model.canvas!.width), r(model.canvas!.height)],
    groups: Object.fromEntries(Object.keys(model.groups).sort().map(id => [id, box(model.groups[id]!.bounds!)])),
    nodes: sorted(Object.values(model.nodes).map(node => box(node.bounds!))),
    links: sorted(model.links.map(link => link.path!.segments.flatMap(segment => [r(segment.from.x - dx), r(segment.from.y), r(segment.to.x - dx), r(segment.to.y)]))),
    feedSplits: model.feedSplits!.map(({ tier, authority, pair, width }) => ({ tier, authority, pair, width })),
  };
};
/** The sheet with its links the other way round. */
const reversedLinks = (yaml: string): string => {
  const [head, links] = yaml.split('\nlinks:\n') as [string, string];
  return `${head}\nlinks:\n${links.trimEnd().split('\n').reverse().join('\n')}\n`;
};
/** The sheet mirrored: every group and every node declared the other way round (the declaration order is the row order, R3). */
const mirror = (yaml: string): string => {
  const head: string[] = [], groups: string[] = [], nodes: string[] = [], rest: string[] = [];
  let section: 'head' | 'groups' | 'nodes' | 'rest' = 'head';
  for (const line of yaml.split('\n')) {
    if (line.startsWith('groups:')) { section = 'groups'; continue; }
    if (line.startsWith('nodes:')) { section = 'nodes'; continue; }
    if (line.startsWith('links:')) section = 'rest';
    if (section === 'groups' && line.startsWith('  ')) groups.push(line);
    else if (section === 'nodes' && line.startsWith('  ')) nodes.push(line);
    else (section === 'head' ? head : rest).push(line);
  }
  return [...head, 'groups:', ...groups.reverse(), 'nodes:', ...nodes.reverse(), ...rest].join('\n');
};

describe('the feed split (architecture-2 ticket 73)', () => {
  let model: LayoutModel;
  beforeAll(async () => { model = await run(SPLIT); }, 120000);

  it('records one split of sub-tier 2 and stands every link of srv0 and srv1 vertical (a-feed-split-stands-each-group-under-its-feeds)', () => {
    expect(model.feedSplits).toEqual([{ tier: 2, authority: 1, pair: ['edge-far', 'edge-near'], at: 164.25, width: 60.5 }]);
    expect(model.freeze!.feedSplits).toEqual(model.feedSplits);
    for (const id of [...linksOf(model, 'srv0'), ...linksOf(model, 'srv1')]) expect(vertical(model, id), id).toBe(true);
    expect([bends(model), Math.round(model.canvas!.width)]).toEqual([0, 590]);
    expect(Math.round(model.nodes.isp0!.bounds!.width)).toBe(184);
  });

  it('publishes the same layout with the links reversed, and the mirror decision on mirrored input (R3)', async () => {
    const [reversed, mirrored] = await Promise.all([run(reversedLinks(SPLIT)), run(mirror(SPLIT))]);
    // With the links reversed, stage 4 puts isp0 (tier 0, a tier beyond the authority) across the split line at another x: the split is not
    // declined for it (before variant V it was), and the sheet publishes the same layout.
    expect(reversed.feedSplits!.map(split => split.pair)).toEqual([['edge-far', 'edge-near']]);
    expect(reversed.feedSplits![0]!.at).not.toBe(model.feedSplits![0]!.at);
    expect(reversed.diagnostics.filter(item => item.code === 'FEED_SPLIT_DECLINED')).toEqual([]);
    expect(geometry(reversed)).toEqual(geometry(model));
    // Mirrored, the joint stage-4 order (ticket 72) stands the groups as before: the same decision and the same layout.
    expect(geometry(mirrored)).toEqual(geometry(model));
    expect([bends(mirrored), crossings(mirrored)]).toEqual([bends(model), crossings(model)]);
  }, 240000);

  it('checks the room of each recorded pair on the stage-5 model, and the freeze keeps the record (R1, R5)', async () => {
    const five = await stageFive(SPLIT);
    expect(five.feedSplits).toEqual(model.feedSplits);
    expect(feedPairRoom(five, 2, 1, 'edge-far', 'edge-near')).toBeLessThanOrEqual(PLACEMENT_EPS);
    expect(restoreLayoutModel(JSON.stringify(five)).feedSplits).toEqual(five.feedSplits);
    const forge = (edit: (copy: LayoutModel) => void): string => {
      const copy = JSON.parse(JSON.stringify(five)) as LayoutModel;
      edit(copy);
      return JSON.stringify(copy);
    };
    // The record and the freeze differ: refused, whichever side changed.
    expect(() => restoreLayoutModel(forge(copy => { copy.feedSplits = []; }))).toThrow(/Frozen feed splits changed/);
    expect(() => restoreLayoutModel(forge(copy => { delete copy.feedSplits; }))).toThrow(/Frozen feed splits changed/);
    // The box of edge-near reaches farther left than its nodes need: the record and its copy agree, but the pair has no room on the geometry.
    expect(() => restoreLayoutModel(forge(copy => { const box = copy.groups['edge-near']!.bounds!; box.x -= 20; box.width += 20; })))
      .toThrow(/Feed split edge-far\|edge-near lacks 20\.00 px of its room/);
    // A record that names no pair of the sub-tier is refused on any stage.
    const forged = (edit: (split: NonNullable<LayoutModel['feedSplits']>[number]) => void): string => forge(copy => {
      edit(copy.feedSplits![0]!);
      copy.freeze!.feedSplits = JSON.parse(JSON.stringify(copy.feedSplits)) as NonNullable<LayoutModel["feedSplits"]>;
    });
    expect(() => restoreLayoutModel(forged(split => { split.pair = ['edge-far', 'access']; }))).toThrow(/two plain groups of sub-tier 2/);
    expect(() => restoreLayoutModel(forged(split => { split.authority = 0; }))).toThrow(/not adjacent sub-tiers/);
    expect(() => restoreLayoutModel(forged(split => { split.width = 0; }))).toThrow(/has no width/);
    // The same shape check on the published model (stage `final`), where the room is no longer read.
    const late = JSON.parse(JSON.stringify({ ...model, runtime: { stages: [] } })) as LayoutModel;
    late.feedSplits![0]!.pair = ['edge-far', 'access'];
    late.freeze!.feedSplits = JSON.parse(JSON.stringify(late.feedSplits)) as NonNullable<LayoutModel['feedSplits']>;
    expect(() => restoreLayoutModel(JSON.stringify(late))).toThrow(/two plain groups of sub-tier 2/);
    expect(() => restoreLayoutModel(JSON.stringify({ ...model, runtime: { stages: [] }, feedSplits: [] }))).toThrow(/Frozen feed splits changed/);
  }, 120000);

  it('reads absent as not decided and [] as decided with no split; both restore', async () => {
    const five = await stageFive(STRETCH);
    expect(five.feedSplits).toEqual([]);
    expect(five.freeze!.feedSplits).toEqual([]);
    // Step 0's P2 split through k0, a node of the authority tier that feeds both groups, by 147 px (q1, a tier beyond, would move whole). The
    // split never stretches a body, and the decline is named (R6).
    expect(five.diagnostics.filter(item => item.code === 'FEED_SPLIT_DECLINED').map(item => item.message))
      .toEqual(['The feed split B|A at x 155.5 (147.0 px) is declined: the split would stretch k0.']);
    expect(restoreLayoutModel(JSON.stringify(five)).feedSplits).toEqual([]);
    const absent = JSON.parse(JSON.stringify(five)) as LayoutModel;
    delete absent.feedSplits;
    delete absent.freeze!.feedSplits;
    expect(restoreLayoutModel(JSON.stringify(absent)).feedSplits).toBeUndefined();
  }, 120000);

  it('moves a box the line crosses whole when all its nodes stand right of the line (the mirrored split, two-titles)', async () => {
    const five = await stageFive(TITLES);
    expect(five.feedSplits!.map(split => [split.tier, split.authority, split.pair])).toEqual([[1, 2, ['mid', 'mid2']]]);
    const at = five.feedSplits![0]!.at, box = five.groups.low2!.bounds!;
    const bodies = five.groups.low2!.nodes.map(id => five.nodes[id]!.bounds!);
    // The line ran through the padding of low2, left of its nodes: the box keeps its width and holds its nodes as low does.
    expect(bodies.every(body => body.x >= at)).toBe(true);
    expect(box.width).toBeCloseTo(five.groups.low!.bounds!.width, 6);
    expect(box.x).toBeGreaterThan(at);
    // The box started left of the line (the line crossed it), and moved by the split's width.
    expect(box.x - five.feedSplits![0]!.width).toBeLessThan(at);
  }, 120000);

  it('refuses a later split that would take the room of a split made before it (two steps)', async () => {
    // Step (2, 1) splits L | R. Step (0, 1) then asks for G1 | G2, whose line crosses the box of L between n2 and n3: L would grow, and so its
    // reach, and the room of L | R would no longer hold. The later split is declined by name; the stage-5 publication holds (R2).
    const yaml = `portograph: 2
groups:
  G1: { tier: 0 }
  G2: { tier: 0 }
  core: { tier: 1 }
  L: { tier: 2 }
  R: { tier: 2 }
nodes:
  g1: { group: G1, label: "x one" }
  g2: { group: G2, label: "x two" }
  p1: { group: core }
  q: { group: core }
  s: { group: core }
  p2: { group: core }
  t: { group: core }
  n1: { group: L }
  n2: { group: L }
  n3: { group: L }
  r: { group: R }
links:
  - [g1, q]
  - [g2, s]
  - [p1, n1]
  - [p2, n1]
  - [t, r]
`;
    const five = await stageFive(yaml);
    expect(five.feedSplits!.map(split => split.pair)).toEqual([['L', 'R']]);
    expect(five.diagnostics.filter(item => item.code === 'FEED_SPLIT_DECLINED').map(item => item.message))
      .toEqual([expect.stringMatching(/^The feed split G1\|G2 at .* is declined: L\|R would lack [\d.]+ px of its room\.$/)]);
    const published = await run(yaml);
    expect(published.feedSplits).toEqual(five.feedSplits);
  }, 120000);

  it('publishes the sheet whose span round grows a tier gap beside a linked pair the grid holds apart in x (sweep v6-2-1)', async () => {
    // Before the fix the tier-gap solve of the span round's last run threw: its rebuild in y widened edge-near to the extent of access.
    const model = await run(sheet('a-tier-gap-growth-widens-no-grid-pair-in-x'));
    expect(model.feedSplits!.map(split => split.pair)).toEqual([['edge-near', 'edge-far']]);
    expect(bends(model)).toBe(4);
  }, 240000);

  it('a grid pair the tier-gap solve holds stays as it stands and is recorded as refused (R1)', async () => {
    const model = await run(sheet('a-tier-gap-growth-widens-no-grid-pair-in-x'));
    const apart = gridPairsApart(model, 'x');
    expect(apart.length).toBeGreaterThan(0);
    const held = JSON.parse(JSON.stringify(model)) as LayoutModel;
    alignLinkedGroupGridAndPack(held, undefined, new Set(apart));
    for (const id of Object.keys(model.groups)) expect(held.groups[id]!.bounds, id).toEqual(model.groups[id]!.bounds);
    for (const key of apart) expect(held.gridRefusals ?? []).toContain(key);
  }, 240000);
});
