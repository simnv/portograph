import { expect, it } from 'vitest';
import { parse, restoreLayoutModel, resolve, sidesOne, sizeNodes, skeleton, sidesTwo } from '../../src/internal.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

async function reserved() {
  const model = sizeNodes(sidesOne(resolve(parse(`portograph: 2
layout: {nodeContent: card}
groups: {sources: {tier: 0}, sink: {tier: 1, shape: bar}}
nodes:
  a: {group: sources, size: {width: 180, height: 50}}
  b: {group: sources, size: {width: 180, height: 50}}
  c: {group: sources, size: {width: 180, height: 50}}
  hub: {group: sink}
links: [[a, hub], [b, hub], [c, hub]]
`))));
  await skeleton(model, { createAttempt });
  model.staggerRows = [{ group: 'sources', order: [...model.groups.sources!.rowOrder!], side: 'bottom', pitch: 0, step: 0 }];
  return sidesTwo(model);
}

it('restores the reserved two-line placement and refuses a missing or empty reservation', async () => {
  const original = await reserved();
  expect(restoreLayoutModel(JSON.stringify(original)).staggerRows).toEqual(original.staggerRows);
  for (const empty of [undefined, []]) {
    const changed = { ...original, staggerRows: empty };
    expect(() => restoreLayoutModel(JSON.stringify(changed))).toThrow(/stagger/i);
  }
});

it('refuses an anchor-only move into a neighbouring body corridor before routing', async () => {
  const original = await reserved();
  const changed = JSON.parse(JSON.stringify(original)) as typeof original;
  const odd = changed.nodes[changed.staggerRows![0]!.order[1]!]!;
  odd.ports[0]!.anchor!.x -= 1;
  expect(() => restoreLayoutModel(JSON.stringify(changed))).toThrow(/stagger.*corridor/i);
});
