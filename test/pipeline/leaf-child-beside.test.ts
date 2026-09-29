import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { cellReach } from '../../src/layout/frames.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const apart = (a: Rect, b: Rect): boolean => right(a) <= b.x || right(b) <= a.x || bottom(a) <= b.y || bottom(b) <= a.y;

/** The x distance from the child frame to each parent cell that stands in a sub-tier of the child (the cell as its frame sees it). */
const besideGaps = (model: Awaited<ReturnType<typeof layout>>, parent: string, child: string): number[] => {
  const frames = model.frames!, box = frames.find(frame => frame.id === child)!.box;
  const tiers = new Set(frames.find(frame => frame.id === child)!.cells.map(cell => model.groups[cell]!.tier));
  return frames.find(frame => frame.id === parent)!.cells.filter(cell => tiers.has(model.groups[cell]!.tier)).map(cell => {
    const reach = cellReach(model as never, cell);
    return Math.max(box.x - right(reach), reach.x - right(box));
  });
};

describe('a leaf child stands beside the parent members of its ranks (ranked-groups ticket 28)', () => {
  it('the parent cells share the sub-tiers of the child, outside its frame, and the overlay links are straight', async () => {
    const model = await layout(parse(fixture('a-leaf-child-stands-beside-its-parent-members')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frames = model.frames!;
    const loc = frames.find(frame => frame.id === 'loc')!, zone = frames.find(frame => frame.id === 'zone')!;
    expect(zone.parent).toBe('loc');
    // The child keeps its depth ranks (4 and 5) and the parent's own cells of those ranks stand in the same sub-tiers.
    expect(zone.cells).toEqual(['zone#4', 'zone#5']);
    expect(loc.cells).toEqual(['loc#0', 'loc#1', 'loc#2', 'loc#3', 'loc#4', 'loc#5']);
    for (const rank of [4, 5]) expect(model.groups[`loc#${rank}`]!.tier).toBe(model.groups[`zone#${rank}`]!.tier);
    // The two are disjoint columns: the parent members stand left of the zone frame with at least the column slack
    // between (the child goes on the right on a tie), and no node of the parent lies inside the frame of the child.
    for (const id of ['p4', 'p5']) {
      const body = model.nodes[id]!.bounds!;
      expect(apart(body, zone.box), `${id} stands outside the zone frame`).toBe(true);
      expect(zone.box.x - right(body), `${id} keeps the slack from the zone frame`).toBeGreaterThanOrEqual(COLUMN_SLACK);
    }
    // The two stay one row: the nearest parent cell is the column slack from the child whatever the stages did after the
    // pack (a narrower cell stands as much further as it is narrower, half of it when centred on the axis of the row).
    expect(Math.min(...besideGaps(model, 'loc', 'zone'))).toBeLessThanOrEqual(COLUMN_SLACK + PLACEMENT_EPS);
    for (const id of ['z4', 'z5']) expect(model.nodes[id]!.bounds!.x).toBeGreaterThanOrEqual(zone.box.x);
    // The zone frame stands inside the location frame.
    expect(zone.box.x).toBeGreaterThanOrEqual(loc.box.x);
    expect(right(zone.box)).toBeLessThanOrEqual(right(loc.box));
    expect(score(model).snapshot.gates.G9.violations).toEqual([]);
    // The overlay links from the child up to the parent members of its ranks run face to face in one segment.
    const flows = model.links.filter(link => link.layer === 'overlay');
    expect(flows).toHaveLength(2);
    for (const link of flows) expect(link.path!.segments, link.id).toHaveLength(1);
  }, 60000);

  it('a parent cell fed from the far end of its rank stays beside the child, not under its feed', async () => {
    const model = await layout(parse(fixture('a-leaf-child-and-its-beside-cells-stay-one-row')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const zone = model.frames!.find(frame => frame.id === 'zone')!;
    expect(model.groups['loc#3']!.tier).toBe(model.groups['zone#3']!.tier);
    const gaps = besideGaps(model, 'loc', 'zone');
    expect(gaps).toHaveLength(1);
    // p4 stands beside the frame of the zone, on its left, 20 px from it at most; its feed s0 is the far end of the rank.
    expect(right(model.nodes['p4']!.bounds!)).toBeLessThan(zone.box.x);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(COLUMN_SLACK - PLACEMENT_EPS);
      expect(gap).toBeLessThanOrEqual(COLUMN_SLACK + PLACEMENT_EPS);
    }
    expect(score(model).snapshot.gates.G9.violations).toEqual([]);
  }, 60000);

  it('a child takes the side its partners stand on once the tier is ordered', async () => {
    const model = await layout(parse(fixture('a-leaf-child-takes-the-side-of-its-partners-after-the-tier-is-ordered')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const centre = (id: string): number => model.nodes[id]!.bounds!.x + model.nodes[id]!.bounds!.width / 2;
    const parents = (centre('p1') + centre('p2')) / 2;
    // The overlay order left the sibling locations in the order east, loc, west; each child stands on its partner's side.
    expect(centre('e1')).toBeLessThan(parents);
    expect(centre('w1')).toBeGreaterThan(parents);
    expect(centre('a1') > parents, 'a1 stands on the side of its partner w1').toBe(true);
    expect(centre('b1') < parents, 'b1 stands on the side of its partner e1').toBe(true);
    for (const gap of [besideGaps(model, 'loc', 'za'), besideGaps(model, 'loc', 'zb')]) expect(Math.min(...gap)).toBeLessThanOrEqual(COLUMN_SLACK + PLACEMENT_EPS);
    expect(score(model).snapshot.gates.G9.violations).toEqual([]);
  }, 60000);
});
