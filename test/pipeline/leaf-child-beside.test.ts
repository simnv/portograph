import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const apart = (a: Rect, b: Rect): boolean => right(a) <= b.x || right(b) <= a.x || bottom(a) <= b.y || bottom(b) <= a.y;

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
});
