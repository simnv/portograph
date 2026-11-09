import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score, serializeLayoutModel } from '../../src/index.js';
import { createLayoutModel } from '../../src/model/index.js';
import type { LayoutModel } from '../../src/index.js';
import { firstDifference, reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gateFailures } from './open-min-separation.js';

// Ticket DR-04 (decision review D-Q1): link order is never input. The parser lists the links in one canonical order
// (`src/parse/link-order.ts`), so ports, ordinals, ids and the drawing do not depend on the order of `links`.
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** The layout as `npm run r3` compares it: no timings, no echoed input. */
function comparable(model: LayoutModel): unknown {
  const { runtime, document, ...rest } = JSON.parse(serializeLayoutModel(model)) as Record<string, unknown>;
  void runtime; void document;
  return rest;
}

describe('the canonical link order', () => {
  it('lists the links by the declared ranks of their ends, smaller first, whatever the order and direction they are written in', () => {
    const head = 'portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a: { group: g }\n  b: { group: g }\n  c: { group: g }\nlinks:\n';
    const one = parse(`${head}  - [c, a]\n  - [b, c]\n  - [a, b]\n`);
    const two = parse(`${head}  - [a, b]\n  - [c, a]\n  - [b, c]\n`);
    const ends = (doc: ReturnType<typeof parse>): string[] => doc.links.map(link => `${link.from.node}-${link.to.node}`);
    expect(ends(one)).toEqual(['a-b', 'c-a', 'b-c']);
    expect(one).toEqual(two);
  });

  it('gives a wildcard and an unnumbered port name the same port in every link order', () => {
    const head = 'portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  x: { group: g, ports: [p, p, q] }\n  y: { group: g }\n  z: { group: g }\nlinks:\n';
    const one = parse(`${head}  - [x.*, y]\n  - [x.p, z]\n  - [x.*, z, { class: dashed }]\n`);
    const two = parse(`${head}  - [x.*, z, { class: dashed }]\n  - [x.p, z]\n  - [x.*, y]\n`);
    expect(one).toEqual(two);
  });

  it('names a link by its place in the canonical order, so its id does not follow the order of `links`', () => {
    const head = 'portograph: 2\ngroups:\n  g: { tier: 0 }\nnodes:\n  a: { group: g, ports: [p] }\n  b: { group: g, ports: [q] }\nlinks:\n';
    const links = ['  - [a.p#1, b.q#1]\n', '  - [b, a]\n', '  - [a.p#1, b.q#1, { class: dashed }]\n'];
    const named = (text: string): string[] => {
      const doc = parse(text);
      return createLayoutModel(doc).links.map(link => `${link.id} ${JSON.stringify(link.from)} ${doc.links[link.sourceIndex]!.class ?? ''}`);
    };
    // Bare ends rank before numbered ports; the two parallel links differ in content only, and `"dashed"` sorts before `null`.
    expect(named(head + links.join(''))).toEqual([
      'link-1 {"node":"b","anonymous":true,"ordinal":1} ',
      'link-2 {"node":"a","name":"p","ordinal":1} dashed',
      'link-3 {"node":"a","name":"p","ordinal":1} ',
    ]);
    expect(named(head + [...links].reverse().join(''))).toEqual(named(head + links.join('')));
  });

  it('bar-fan with its links reversed draws the same as bar-fan, and passes every gate', async () => {
    const reversedSheet = fixture('synthetic/bar-fan-with-its-links-reversed');
    expect(reversedSheet).toContain(reversed(fixture('synthetic/bar-fan'), 'links').split('links:\n')[1]!);
    const [base, model] = await Promise.all([run(fixture('synthetic/bar-fan')), run(reversedSheet)]);
    expect(firstDifference(comparable(base), comparable(model))).toBeUndefined();
    expect(gateFailures(score(model).snapshot)).toEqual([]);
  });

  it('bar-fan with its nodes reversed stands the bar under its drop and passes every gate', async () => {
    // Reversed, the link to c2 comes first in the canonical order; the parent port still seats over the bar, so 7d shapes the bar
    // under the drop and not over the leaves (the seat rivals of `groupFeeds` are read bar first, then by x, never in link order).
    const model = await run(reversed(fixture('synthetic/bar-fan'), 'nodes'));
    expect(gateFailures(score(model).snapshot)).toEqual([]);
  });

  it('a perimeter lane stands one ring beyond the outermost earlier lane it meets, so no two lanes of one side share an x', async () => {
    // With its nodes reversed this sheet met earlier lanes of rings 0 and 2 only; the old ring was their count, 2, and two lanes stood on one x.
    const model = await run(reversed(fixture('synthetic/three-canton-groups-whose-grid-yields-to-the-pack'), 'nodes'));
    const perimeter = model.lanes.filter(lane => lane.kind === 'perimeter');
    for (const lane of perimeter) for (const other of perimeter) {
      if (other === lane || other.side !== lane.side || other.bounds.y >= lane.bounds.y + lane.bounds.height || lane.bounds.y >= other.bounds.y + other.bounds.height) continue;
      expect(other.ring).not.toBe(lane.ring);
    }
  }, 120000);

  it('m1-sip-edge lays out the same with its links reversed', async () => {
    const source = fixture('m1-sip-edge');
    const [base, model] = await Promise.all([run(source), run(reversed(source, 'links'))]);
    expect(firstDifference(comparable(base), comparable(model))).toBeUndefined();
  }, 120000);
});
