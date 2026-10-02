import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ranked-groups ticket 153: the links of one hub face do not cross each other, so no stub of the face crosses a run of the same face. */
const FIXTURE = 'a-hub-face-orders-its-ports-so-its-links-do-not-cross';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');

type Point = { x: number; y: number };
type Segment = { from: Point; to: Point };
const side = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const crosses = (a: Segment, b: Segment): boolean => side(a.from, a.to, b.from) * side(a.from, a.to, b.to) < -1e-9
  && side(b.from, b.to, a.from) * side(b.from, b.to, a.to) < -1e-9;
const hubLinks = (model: LayoutModel, hub: string) => model.links.filter(link => link.from.node === hub || link.to.node === hub);
const crossings = (model: LayoutModel, hub: string): string[] => {
  const links = hubLinks(model, hub), found: string[] = [];
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    if (links[i]!.path!.segments.some(a => links[j]!.path!.segments.some(b => crosses(a, b)))) found.push(`${links[i]!.id} x ${links[j]!.id}`);
  }
  return found;
};

describe('a hub face orders its ports so that its links do not cross', () => {
  it('leaves no crossing among the links of either hub', async () => {
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    for (const hub of ['hub-a', 'hub-b']) {
      expect(hubLinks(model, hub), hub).toHaveLength(4);
      expect(crossings(model, hub), hub).toEqual([]);
    }
  }, 60000);
});
