import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve, restoreLayoutModel, sidesOne, sidesTwo, sizeNodes, skeleton } from '../../src/internal.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { siblingRowsFault, siblingSeatOrder, SIBLING_SEAT_REFUSED, SIBLING_UTURN_DECLINED } from '../../src/layout/sibling-frames.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 06, slice C (owner ruling "mirror one pair", 2026-11-15): stage 4 seats the ends of each sibling-frame link at the ends of their rows that
 * face each other; when two pairs join two cells, one cell mirrors its pair, so the inner pair is a level chord (slice B) and the outer pair a u-turn course that
 * stage 5 plans and 7a reserves as a U part of the tier gap (slice A). `siblingRows` records the decision.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const MIRROR = read('../../goldens/synthetic/two-sibling-frames-mirror-a-linked-pair.yaml');
const BUNDLE = read('../../goldens/synthetic/a-sibling-seat-keeps-an-authored-bundle-of-its-row.yaml');
const APART = read('../../goldens/synthetic/a-sibling-seat-keeps-a-bundle-whose-ends-stand-apart.yaml');
const TWO_BUNDLES = read('../../goldens/synthetic/a-sibling-seat-keeps-two-bundles-of-its-row.yaml');
const WHOLE = read('../../goldens/synthetic/a-sibling-seat-moves-a-bundle-whole.yaml');
const TWIN = read('../fixtures/staged/two-cores-reach-seven-pairs-through-hubs-on-the-last-rank.yaml');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const lay = (source: string): Promise<LayoutModel> => layout(parse(source), options);
const between = (model: LayoutModel, a: string, b: string): LayoutLink =>
  model.links.find(link => link.attachments !== undefined && [link.attachments.from.node, link.attachments.to.node].sort().join() === [a, b].sort().join())!;
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}`));
const sides = (model: LayoutModel, link: LayoutLink): (string | undefined)[] => [findPort(model, link.attachments!.from)!.side, findPort(model, link.attachments!.to)!.side];
const ends = (model: LayoutModel, id: string): string => { const link = model.links.find(item => item.id === id)!.attachments!; return [link.from.node, link.to.node].sort().join(); };
const xy = (link: LayoutLink): number[][] => link.path!.segments.map(item => [item.from.x, item.from.y, item.to.x, item.to.y]);

/** The level chord: one straight segment between the facing lateral faces, held by the freeze, with both ends at one height. */
function expectLevelChord(model: LayoutModel, link: LayoutLink): void {
  const segments = link.path!.segments;
  expect(segments).toHaveLength(1);
  expect(segments[0]!.straight).toBe(true);
  expect(segments[0]!.to.y).toBe(segments[0]!.from.y);
  expect(model.frozenChords).toContain(link.id);
}
/** The planned U: a `u-turn` course on one face, both ports on that face, and the published path is the plan's part (two legs and one row). */
function expectPlannedU(model: LayoutModel, link: LayoutLink, face: 'top' | 'bottom'): void {
  expect(model.courses).toContainEqual({ link: link.id, kind: 'u-turn', from: { face }, to: { face }, runs: ['u'] });
  expect(sides(model, link)).toEqual([face, face]);
  const segments = link.path!.segments;
  expect(segments).toHaveLength(3);
  const row = segments[1]!;
  expect(row.from.y).toBe(row.to.y);
  // The row stands beyond both stems, on the side the face looks at.
  const ends = [findPort(model, link.attachments!.from)!.anchor!.y, findPort(model, link.attachments!.to)!.anchor!.y];
  if (face === 'top') expect(row.from.y).toBeLessThan(Math.min(...ends)); else expect(row.from.y).toBeGreaterThan(Math.max(...ends));
  // 7a planned it: the gap plan holds the part and no part of the gap is residual.
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  for (const item of copy.links) { delete item.path; }
  const planned = tierGapPlans(copy).find(({ plan }) => plan.parts.some(part => part.link === link.id));
  expect(planned).toBeDefined();
  expect(model.diagnostics.filter(item => item.code.startsWith('TIER_GAP_PART') && item.owners?.some(owner => 'id' in owner && owner.id === link.id))).toEqual([]);
}

describe('a sibling row: the facing ends of two frames of one tier (dense-16x9 ticket 06, slice C)', () => {
  it('mirrors one pair: the inner pair is one level chord, the outer one a planned U, and every gate holds', async () => {
    const model = await lay(MIRROR);
    // On the declared order (w1, w2 and e1, e2) the facing ends are w2 and e1, which no link joins; the east row mirrors its pair.
    expect(model.groups['west#1']!.rowOrder).toEqual(['w1', 'w2']);
    expect(model.groups['east#1']!.rowOrder).toEqual(['e2', 'e1']);
    const inner = between(model, 'w2', 'e2'), outer = between(model, 'w1', 'e1');
    expect(model.siblingRows).toEqual([{ subTier: model.groups['west#1']!.tier, leftCell: 'west#1', rightCell: 'east#1', mirrored: 'right', levelLink: inner.id, outerLinks: [outer.id] }]);
    expect(model.freeze!.siblingRows).toEqual(model.siblingRows);
    expect(sides(model, inner)).toEqual(['right', 'left']);
    expectLevelChord(model, inner);
    // The top face holds the feeds of w2 and e2, which the row would cross; the bottom face holds none between the two ends.
    expectPlannedU(model, outer, 'bottom');
    expect(gates(model)).toEqual([]);
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('draws the twin with one level chord and one U between the cores, and G6 holds', async () => {
    const model = await lay(TWIN);
    const a = model.groups['core-a#2']!.rowOrder!, b = model.groups['core-b#2']!.rowOrder!;
    // One core mirrors its hubs: the inner pair stands on the facing row ends.
    expect([a, b]).toEqual([['hub-a1', 'hub-a2'], ['hub-b2', 'hub-b1']]);
    const inner = between(model, 'hub-a2', 'hub-b2'), outer = between(model, 'hub-a1', 'hub-b1');
    expect(model.siblingRows).toEqual([{ subTier: model.groups['core-a#2']!.tier, leftCell: 'core-a#2', rightCell: 'core-b#2', mirrored: 'right', levelLink: inner.id, outerLinks: [outer.id] }]);
    expectLevelChord(model, inner);
    expectPlannedU(model, outer, 'top');
    expect(score(model).snapshot.gates.G6.violations).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 180000);

  it('is the same layout with the links reversed (R3); with the nodes reversed the declared order may pick the other inner pair, and the rule still holds', async () => {
    const one = await lay(MIRROR);
    // Link ids are the places of the links in the canonical order, so the record is compared by the nodes it joins.
    const named = (model: LayoutModel) => model.siblingRows!.map(row => ({ ...row, levelLink: ends(model, row.levelLink!), outerLinks: row.outerLinks.map(id => ends(model, id)) }));
    const links = await lay(reversed(MIRROR, 'links'));
    expect(named(links)).toEqual(named(one));
    for (const [a, b] of [['w1', 'e1'], ['w2', 'e2']]) expect(xy(between(links, a!, b!))).toEqual(xy(between(one, a!, b!)));
    // The order of `nodes` is author input (D-Q1): ELK then stands w2 before w1, and the pair of w1 is the inner one. One level chord and one U still nest.
    const nodes = await lay(reversed(MIRROR, 'nodes'));
    const [row] = nodes.siblingRows!;
    expect(row!.levelLink).toBeDefined();
    expect(row!.outerLinks).toHaveLength(1);
    expectLevelChord(nodes, nodes.links.find(link => link.id === row!.levelLink)!);
    expect(nodes.courses?.map(course => course.link)).toEqual(row!.outerLinks);
    expect(gates(nodes)).toEqual([]);
  }, 120000);

  it('refuses a forged record at restore: a removed copy, a cell order the record does not give, and a link that joins no sibling frames (R1, R5)', async () => {
    const model = await lay(MIRROR);
    expect(siblingRowsFault(model)).toBeUndefined();
    expect(restoreLayoutModel(JSON.stringify(model)).siblingRows).toEqual(model.siblingRows);
    const forge = (change: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; change(copy); return JSON.stringify(copy); };
    // 1. The record differs from the frozen copy.
    expect(() => restoreLayoutModel(forge(copy => { delete copy.siblingRows; }))).toThrow(/Frozen sibling rows changed/);
    // 2. The record and its copy say the east row is mirrored, and the record names the other pair as the inner one: the rows do not stand so.
    const swapped = (copy: LayoutModel): void => {
      for (const rows of [copy.siblingRows!, copy.freeze!.siblingRows!]) { const row = rows[0]!; [row.levelLink, row.outerLinks] = [row.outerLinks[0]!, [row.levelLink!]]; }
    };
    expect(() => restoreLayoutModel(forge(swapped))).toThrow(/sibling rows do not hold/);
    // 3. A record that names the feed of a row, which is no sibling-frame link.
    const feed = between(model, 'wt', 'w1').id;
    expect(() => restoreLayoutModel(forge(copy => { for (const rows of [copy.siblingRows!, copy.freeze!.siblingRows!]) rows[0]!.outerLinks = [feed]; }))).toThrow(/is no sibling-frame link/);
    // 4. The cells swapped: the left cell does not stand left.
    expect(() => restoreLayoutModel(forge(copy => { for (const rows of [copy.siblingRows!, copy.freeze!.siblingRows!]) [rows[0]!.leftCell, rows[0]!.rightCell] = [rows[0]!.rightCell, rows[0]!.leftCell]; }))).toThrow(/does not stand left of/);
  }, 60000);

  it('declines the U of an outer pair by name when an end is authored, and stage 8 routes it as before', async () => {
    const authored = MIRROR.replace('  - [w1, e1]', '  - [w1.p, e1]').replace('  w1: { group: west, class: switch, label: W1 }', '  w1: { group: west, class: switch, label: W1, ports: [{ name: p, side: right }] }');
    const model = await lay(authored);
    const outer = between(model, 'w1', 'e1');
    expect(model.siblingRows?.[0]?.outerLinks).toEqual([outer.id]);
    expect(model.diagnostics.filter(item => item.code === SIBLING_UTURN_DECLINED).map(item => item.owners)).toEqual([[{ kind: 'link', id: outer.id }]]);
    expect((model.courses ?? []).some(course => course.link === outer.id)).toBe(false);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);
  it('keeps an authored lateral bundle of a row: the sibling seat of that row is declined by name, and every gate passes (review 1, finding 2)', async () => {
    const model = await lay(BUNDLE);
    // w1 leaves the bundle to w2 on its right face: the seat would stand w2 left of w1 and turn the bundle; the row keeps w1, w2.
    expect(model.groups['west#1']!.rowOrder).toEqual(['w1', 'w2']);
    const declined = model.diagnostics.filter(item => item.code === SIBLING_SEAT_REFUSED);
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toMatch(/lateral bundle/);
    expect(declined[0]!.owners).toEqual([{ kind: 'link', id: between(model, 'w1', 'e1').id }]);
    expect(model.siblingRows).toEqual([]);
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('keeps a lateral bundle whose ends stand apart: the order of the two ends is what the row owes it (review 2)', async () => {
    const model = await lay(APART);
    // wx stands between w1 and w2; the seat would stand the row wx, w2, w1 and turn the bundle. The row keeps w1 left of w2.
    expect(model.groups['west#1']!.rowOrder).toEqual(['w1', 'wx', 'w2']);
    const declined = model.diagnostics.filter(item => item.code === SIBLING_SEAT_REFUSED);
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toMatch(/turn the lateral bundle \S+: w1 would no longer stand left of w2/);
    expect(declined[0]!.owners).toEqual([{ kind: 'link', id: between(model, 'w1', 'e1').id }]);
    expect(model.siblingRows).toEqual([]);
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('reads every bundle of the row: two bundles that the seat would turn decline the seat of both links by name (review 2)', async () => {
    const model = await lay(TWO_BUNDLES);
    expect(model.groups['west#1']!.rowOrder).toEqual(['w1', 'w2', 'w3', 'w4']);
    const declined = model.diagnostics.filter(item => item.code === SIBLING_SEAT_REFUSED);
    expect(declined).toHaveLength(1);
    expect(declined[0]!.owners).toEqual(expect.arrayContaining([{ kind: 'link', id: between(model, 'w1', 'e1').id }, { kind: 'link', id: between(model, 'w3', 'e2').id }]));
    expect(declined[0]!.owners).toHaveLength(2);
    expect(model.siblingRows).toEqual([]);
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('takes a seat that moves a bundle whole and keeps both orders; the feed refresh reads the same predicate (review 2)', async () => {
    const model = await lay(WHOLE);
    // The sheet writes w3, w4, w1, w2; the seat moves the block w3, w4 to the east end, w4 on the end and w3 next to it.
    expect(model.groups['west#1']!.rowOrder).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(model.diagnostics.filter(item => item.code.startsWith('SIBLING'))).toEqual([]);
    expect(model.siblingRows).toEqual([expect.objectContaining({ leftCell: 'west#1', rightCell: 'east#1', levelLink: between(model, 'w4', 'e1').id, outerLinks: [] })]);
    expect(gates(model)).toEqual([]);
    // A feed order that turns a bundle leaves the row as it stands; one that keeps both orders with a member between the ends of a bundle is taken.
    expect(siblingSeatOrder(model, 'west#1', ['w2', 'w1', 'w3', 'w4'])).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(siblingSeatOrder(model, 'west#1', ['w1', 'w3', 'w2', 'w4'])).toEqual(['w1', 'w3', 'w2', 'w4']);
  }, 60000);

  it('refuses a forged record at the stage-4 restore, before stage 5 reads it (review 1, finding 3)', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(MIRROR))));
    await skeleton(model, { createAttempt });
    expect(model.stage).toBe('skeleton');
    expect(siblingRowsFault(model)).toBeUndefined();
    expect(restoreLayoutModel(JSON.stringify(model)).siblingRows).toEqual(model.siblingRows);
    const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
    forged.siblingRows![0]!.outerLinks = ['missing-link'];
    // The typed fault of the record, never a TypeError of a reader.
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/The sibling rows do not hold: missing-link is no sibling-frame link/);
    // The record of an unforged stage-4 model reaches stage 5 and plans the U.
    expect(sidesTwo(restoreLayoutModel(JSON.stringify(model))).courses?.map(course => course.kind)).toEqual(['u-turn']);
  }, 60000);
});
