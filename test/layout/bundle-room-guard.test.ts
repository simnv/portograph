import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/index.js';
import { rows } from '../../src/layout/rows.js';
import { lanes } from '../../src/layout/lanes.js';
import { flanks } from '../../src/layout/flanks.js';
import { centre } from '../../src/layout/centre.js';
import { bars } from '../../src/layout/bars.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { routedStroke } from '../../src/layout/bands.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { placed } from './phase-two-fixture.js';
import { bundles } from '../../src/layout/bundles.js';
import { straightMembers } from '../../src/layout/bundle-paths.js';
import { edgeMargin, members, pitch } from '../../src/layout/bundle-geometry.js';
import { facingBundleNeed } from '../../src/layout/bundle-need.js';
import { score } from '../../src/score/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';

// Two groups side by side in one tier; the bundle between them leaves right and enters left with every member inverted (the authored order is
// reversed), so 7e takes crossover room by moving the right group in x (W09 of the post-7a writer table). Two members share `a.p` and `b.p`,
// so the bundle is fanned: placement keeps the staircase room for it, and the paths decide its shape on the fan leaves (ticket DR-16; an
// unfanned one is decided straight at placement and needs no room here).
const inverted = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 0}}
nodes:
  a: {group: ga, ports: [{name: p, side: right, order: 0}, {name: q, side: right, order: 1}, {name: r, side: right, order: 2}]}
  b: {group: gb, ports: [{name: p, side: left, order: 2}, {name: q, side: left, order: 1}, {name: r, side: left, order: 0}]}
links: [[a.p, b.p], [a.p, b.p], [b.q, a.q], [a.r, b.r]]`;
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

const diagonals = (model: LayoutModel): number => model.links.flatMap(link => link.path?.segments ?? []).filter(segment => segment.straight === true).length;
const staged = async (yaml: string): Promise<LayoutModel> => bars(centre(flanks(lanes(rows(await placed(yaml))))));

describe('DR-16: a fanned inverted bundle decides its shape on the fan leaves', () => {
  // The W09 fixture and its twin across a tier gap: the channel between the fan leaves holds the member pitch, so both draw straight.
  const twin = inverted.replace('gb: {tier: 0}', 'gb: {tier: 1}').replaceAll('side: right', 'side: bottom').replaceAll('side: left', 'side: top');
  for (const [name, yaml] of [['side-facing', inverted], ['across a tier gap', twin]] as const) {
    it(`draws straight members, ${name}`, async () => {
      const model = bundles(await staged(yaml));
      expect(model.bundles[0]!.straight).toBe(true);
      expect(diagonals(model)).toBe(4);
      for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
      expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    }, 60000);
  }
});

describe('DR-16: the side-facing room of an unfanned inverted bundle', () => {
  it('is decided straight where the gap already holds the member pitch, and takes no room', async () => {
    const unfanned = inverted.replace('[[a.p, b.p], [a.p, b.p], ', '[[a.p, b.p], ');
    const base = await bars(centre(flanks(lanes(rows(await placed(unfanned))))));
    const free = copy(base);
    prepareBundleGeometry(free);
    expect(free.bundles[0]!.straight).toBe(true);
    expect(free.groups['gb']!.bounds!.x).toBe(base.groups['gb']!.bounds!.x);
  }, 60000);

  // Six reversed members: the straight need is deeper than the gap between the two groups, so the room is taken, through the guard,
  // and it is the straight depth only.
  const six = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 0}}
nodes:
  a: {group: ga, ports: [${[0, 1, 2, 3, 4, 5].map(i => `{name: p${i}, side: right, order: ${i}}`).join(', ')}]}
  b: {group: gb, ports: [${[0, 1, 2, 3, 4, 5].map(i => `{name: p${i}, side: left, order: ${5 - i}}`).join(', ')}]}
links: [${[0, 1, 2, 3, 4, 5].map(i => `[a.p${i}, b.p${i}]`).join(', ')}]`;
  it('takes only the straight depth as room, through the guard', async () => {
    const base = await staged(six);
    const free = copy(base);
    prepareBundleGeometry(free);
    const bundle = free.bundles[0]!, [left, right] = ['a', 'b'].map(id => free.nodes[id]!.bounds!);
    const q = pitch(free, bundle), margin = edgeMargin(routedStroke(free));
    expect(bundle.straight).toBe(true);
    expect(free.groups['gb']!.bounds!.x - base.groups['gb']!.bounds!.x).toBeGreaterThan(1);
    expect(free.diagnostics.some(item => item.code === 'BUNDLE_ROOM_HELD')).toBe(false);
    // The channel is the straight need, not the staircase need of 15 inversions.
    expect(right!.x - (left!.x + left!.width)).toBeCloseTo(facingBundleNeed(0, 6, q, 0, 0, margin), 6);
    const model = bundles(await staged(six));
    expect(diagonals(model)).toBe(6);
    for (const gate of ['G2', 'G4', 'G5', 'G6', 'G7'] as const) expect(score(model).snapshot.gates[gate], gate).toMatchObject({ passed: true });
  }, 60000);

  it('decides the shape again on the channel as it stands when the guard refuses the room', async () => {
    const base = await staged(six);
    const free = copy(base);
    prepareBundleGeometry(free);
    const was = base.groups['gb']!.bounds!, landed = free.groups['gb']!.bounds!;
    const link = base.links.find(item => item.attachments?.from.node === 'a')!;
    // A reserved exit right of gb where it stands, inside gb moved by the straight-depth room.
    const margin = routedStroke(base) / 2 + GROUP_EDGE_LINK_CLEARANCE, x = was.x + was.width + margin + 5, y = landed.y + landed.height / 2;
    expect(landed.x + landed.width - x).toBeGreaterThan(margin);
    const held = copy(base);
    held.groupExits = [{ link: link.id, end: 'from', exited: ['ga'], from: { x, y }, to: { x: x + 1, y }, clearance: margin }];
    prepareBundleGeometry(held);
    expect(held.groups['gb']!.bounds!.x).toBe(was.x);
    expect(held.diagnostics.some(item => item.code === 'BUNDLE_ROOM_HELD')).toBe(true);
    const bundle = held.bundles[0]!;
    // Refused, the shape is decided on the channel that stands (144 px, short of the 174 px straight need): it still holds the pitch.
    expect(bundle.straight).toBe(true);
    expect(straightMembers(held, bundle, members(held, bundle))).toBe(true);
    expect(base.nodes['b']!.bounds!.x - (base.nodes['a']!.bounds!.x + base.nodes['a']!.bounds!.width)).toBeLessThan(facingBundleNeed(0, 6, pitch(held, bundle), 0, 0, edgeMargin(routedStroke(held))));
  }, 60000);
});

describe('W09: the crossover room of an inverted bundle asks the guard (DR-11)', () => {
  it('moves the right group when every reservation holds, and takes no room, named, when one would break', async () => {
    const base = await bars(centre(flanks(lanes(rows(await placed(inverted))))));
    const was = base.groups['gb']!.bounds!;
    const free = copy(base);
    prepareBundleGeometry(free);
    const dx = free.groups['gb']!.bounds!.x - was.x;
    expect(dx).toBeGreaterThan(1);
    expect(free.diagnostics.some(item => item.code === 'BUNDLE_ROOM_HELD')).toBe(false);
    // Fanned: placement leaves the shape to the paths, which place the fan leaves.
    expect(free.bundles[0]!.straight).toBeUndefined();
    // A reserved exit of a link from `a` where gb lands after the move: far right of gb where it stands, met by gb moved by dx.
    const link = base.links.find(item => item.attachments?.from.node === 'a')!, landed = free.groups['gb']!.bounds!;
    const margin = routedStroke(base) / 2 + GROUP_EDGE_LINK_CLEARANCE, x = landed.x + landed.width / 2, y = landed.y + landed.height / 2;
    expect(x - (was.x + was.width + margin)).toBeGreaterThan(margin);
    const held = copy(base);
    held.groupExits = [{ link: link.id, end: 'from', exited: ['ga'], from: { x, y }, to: { x: x + 1, y }, clearance: margin }];
    prepareBundleGeometry(held);
    expect(held.groups['gb']!.bounds!.x).toBe(was.x);
    expect(held.nodes['b']!.bounds!.x).toBe(base.nodes['b']!.bounds!.x);
    expect(held.diagnostics.filter(item => item.code === 'BUNDLE_ROOM_HELD').map(item => item.owners)).toEqual([[{ kind: 'bundle', id: base.bundles[0]!.id }]]);
  }, 60000);

  // DR-11 review F3: a group that straddles the threshold (here gb, whose node c stands left of b) moves only b and is refitted, so its box grows
  // right. The guard reads that widened box: an exit right of gb where it stands, met by the grown box, holds the room.
  it('asks the guard for a group that straddles the threshold, by its widened box', async () => {
    const straddle = inverted.replace('nodes:\n', 'nodes:\n  c: {group: gb}\n');
    const base = await bars(centre(flanks(lanes(rows(await placed(straddle))))));
    const was = base.groups['gb']!.bounds!;
    expect(base.nodes['c']!.bounds!.x).toBeLessThan(base.nodes['b']!.bounds!.x);
    const free = copy(base);
    prepareBundleGeometry(free);
    const grown = free.groups['gb']!.bounds!;
    expect(grown.x).toBe(was.x);
    expect(free.nodes['c']!.bounds!.x).toBe(base.nodes['c']!.bounds!.x);
    const dx = grown.x + grown.width - (was.x + was.width);
    expect(dx).toBeGreaterThan(1);
    expect(free.diagnostics.some(item => item.code === 'BUNDLE_ROOM_HELD')).toBe(false);
    const link = base.links.find(item => item.attachments?.from.node === 'a')!;
    const margin = routedStroke(base) / 2 + GROUP_EDGE_LINK_CLEARANCE, x = was.x + was.width + margin + dx / 2, y = was.y + was.height / 2;
    expect(dx / 2).toBeGreaterThan(margin);
    const held = copy(base);
    held.groupExits = [{ link: link.id, end: 'from', exited: ['ga'], from: { x, y }, to: { x: x + 1, y }, clearance: margin }];
    prepareBundleGeometry(held);
    // The room in x is not taken (a y growth of the bundle fit, W06, may still stand).
    expect([held.groups['gb']!.bounds!.x, held.groups['gb']!.bounds!.width]).toEqual([was.x, was.width]);
    expect(held.nodes['b']!.bounds!.x).toBe(base.nodes['b']!.bounds!.x);
    expect(held.diagnostics.filter(item => item.code === 'BUNDLE_ROOM_HELD').map(item => item.owners)).toEqual([[{ kind: 'bundle', id: base.bundles[0]!.id }]]);
  }, 60000);
});
