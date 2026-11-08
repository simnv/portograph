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

// Two groups side by side in one tier; the bundle between them leaves right and enters left with every member inverted (the authored order is
// reversed), so 7e takes crossover room by moving the right group in x (W09 of the post-7a writer table).
const inverted = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 0}}
nodes:
  a: {group: ga, ports: [{name: p, side: right, order: 0}, {name: q, side: right, order: 1}, {name: r, side: right, order: 2}]}
  b: {group: gb, ports: [{name: p, side: left, order: 2}, {name: q, side: left, order: 1}, {name: r, side: left, order: 0}]}
links: [[a.p, b.p], [b.q, a.q], [a.r, b.r]]`;
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

describe('W09: the crossover room of an inverted bundle asks the guard (DR-11)', () => {
  it('moves the right group when every reservation holds, and takes no room, named, when one would break', async () => {
    const base = await bars(centre(flanks(lanes(rows(await placed(inverted))))));
    const was = base.groups['gb']!.bounds!;
    const free = copy(base);
    prepareBundleGeometry(free);
    const dx = free.groups['gb']!.bounds!.x - was.x;
    expect(dx).toBeGreaterThan(1);
    expect(free.diagnostics.some(item => item.code === 'BUNDLE_ROOM_HELD')).toBe(false);
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
});
