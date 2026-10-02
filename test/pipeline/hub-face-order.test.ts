import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 153. This fixture is a regression guard only: the engine places these hubs so that no two runs interleave, so it passes
 * without the rule too. The plan tests in test/layout/gap-plan.test.ts carry the rule (nesting by far ends across the hubs of a gap).
 */
const FIXTURE = 'a-hub-face-orders-its-ports-so-its-links-do-not-cross';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');

type Point = { x: number; y: number };
type Segment = { from: Point; to: Point };
const side = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const crosses = (a: Segment, b: Segment): boolean => side(a.from, a.to, b.from) * side(a.from, a.to, b.to) < -1e-9
  && side(b.from, b.to, a.from) * side(b.from, b.to, a.to) < -1e-9;
const isHub = (node: string | undefined): boolean => node?.startsWith('hub-') === true;
const hubLinks = (model: LayoutModel) => model.links.filter(link => isHub(link.from.node) || isHub(link.to.node));
/** The way a link with a run goes from its router: right, left or none. */
const way = (link: LayoutModel['links'][number]): number => Math.sign(link.path!.segments[2]?.from.x === undefined ? 0 : link.path!.segments[1]!.to.x - link.path!.segments[0]!.from.x);
/** Each pair where the drop at the router end of a link that has a run crosses a run of another link that goes the same way (links that go opposite ways cross in either order). */
const dropCrossings = (model: LayoutModel): string[] => {
  const links = hubLinks(model), found: string[] = [];
  for (const link of links) {
    if (link.path!.segments.length < 3) continue;
    const segments = link.path!.segments, drop = isHub(link.from.node) ? segments[segments.length - 1]! : segments[0]!;
    for (const other of links) {
      if (other === link || way(other) !== way(link)) continue;
      if (other.path!.segments.some(run => crosses(drop, run))) found.push(`${link.id} x ${other.id}`);
    }
  }
  return found;
};

describe('the runs of two hubs nest by their far ends', () => {
  it('leaves no drop at a far end crossing a run of the gap, and no crossing among the links of one hub', async () => {
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(hubLinks(model)).toHaveLength(6);
    expect(dropCrossings(model)).toEqual([]);
    for (const hub of ['hub-a', 'hub-b']) {
      const own = hubLinks(model).filter(link => link.from.node === hub || link.to.node === hub);
      for (const [index, a] of own.entries()) for (const b of own.slice(index + 1)) {
        expect(a.path!.segments.some(x => b.path!.segments.some(y => crosses(x, y))), `${a.id} x ${b.id}`).toBe(false);
      }
    }
  }, 60000);
});
