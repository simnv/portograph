import { expect, it } from 'vitest';
import { parse, restoreLayoutModel, resolve, sidesOne, sizeNodes, skeleton, sidesTwo } from '../../src/internal.js';
import { packRowsOf } from '../../src/layout/grid.js';
import { lineOf } from '../../src/layout/read/stagger.js';
import { rowGap } from '../../src/layout/sides-two.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

async function reserved(members: readonly string[] = ['a', 'b', 'c'], far: string[] = []) {
  const model = sizeNodes(sidesOne(resolve(parse(`portograph: 2
layout: {nodeContent: card}
groups: {sources: {tier: 0}, sink: {tier: 1, shape: bar}}
nodes:
${members.map(id => `  ${id}: {group: sources, size: {width: 180, height: 50}}`).join('\n')}
  hub: {group: sink}
links: [${members.map(id => `[${id}, hub]`).join(', ')}]
`))));
  await skeleton(model, { createAttempt });
  model.staggerRows = [{ group: 'sources', order: [...model.groups.sources!.rowOrder!], far, side: 'bottom', pitches: [], step: 0 }];
  return sidesTwo(model);
}

it('restores the reserved two-line placement and refuses a missing or empty reservation', async () => {
  const original = await reserved();
  expect(original.staggerRows![0]!.far).toEqual(['b']);
  expect(lineOf(original.staggerRows![0]!, 'a')).toBe('near');
  expect(lineOf(original.staggerRows![0]!, 'b')).toBe('far');
  expect(packRowsOf(original, original.groups.sources!)).toEqual([['a', 'c'], ['b']]);
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

it('reads far as data in the validator, refusing missing, empty, duplicate, unknown, all-far or swapped far', async () => {
  const original = await reserved(['a', 'b', 'c', 'd']);
  expect(original.staggerRows![0]!.far).toEqual(['b', 'd']);
  const clone = () => JSON.parse(JSON.stringify(original)) as typeof original;

  const missing = clone();
  delete (missing.staggerRows![0]! as { far?: string[] }).far;
  expect(() => restoreLayoutModel(JSON.stringify(missing))).toThrow(/Invalid stagger reservation/);

  for (const bad of [[], ['b', 'b'], ['b', 'nope'], ['a', 'b', 'c', 'd']]) {
    const invalid = clone();
    invalid.staggerRows![0]!.far = bad;
    expect(() => restoreLayoutModel(JSON.stringify(invalid))).toThrow(/Invalid stagger reservation/);
  }

  // Swapping `far` without moving node y fails the line check: the validator reads `far`, not index parity.
  const swapped = clone();
  swapped.staggerRows![0]!.far = ['a', 'c'];
  expect(() => restoreLayoutModel(JSON.stringify(swapped))).toThrow(/Stagger placement lost its reserved pitch or lines/);
});

it('seats, measures, validates and packs a non-alternating far record without overwriting it', async () => {
  const model = await reserved(['a', 'b', 'c', 'd'], ['b']);
  const plan = model.staggerRows![0]!;
  expect(plan.far).toEqual(['b']);
  expect(packRowsOf(model, model.groups.sources!)).toEqual([['a', 'c', 'd'], ['b']]);
  expect(restoreLayoutModel(JSON.stringify(model)).staggerRows).toEqual(model.staggerRows);
  const y = (id: string) => model.nodes[id]!.bounds!.y;
  expect(y('b')).toBeLessThan(y('a'));
  expect(y('c')).toBe(y('a'));
  expect(y('d')).toBe(y('a'));
  // Adjacent same-line neighbours `c` and `d` clear each other by at least rowGap.
  const c = model.nodes.c!.bounds!, d = model.nodes.d!.bounds!;
  expect(d.x - (c.x + c.width)).toBeGreaterThanOrEqual(rowGap(model, 'c', 'd') - 1e-6);

  // Also when order[0] itself stands on the far line.
  const endsFar = await reserved(['a', 'b', 'c', 'd'], ['a', 'd']);
  expect(endsFar.staggerRows![0]!.far).toEqual(['a', 'd']);
  expect(packRowsOf(endsFar, endsFar.groups.sources!)).toEqual([['b', 'c'], ['a', 'd']]);
  expect(restoreLayoutModel(JSON.stringify(endsFar)).staggerRows).toEqual(endsFar.staggerRows);
  expect(endsFar.nodes.a!.bounds!.y).toBe(endsFar.nodes.d!.bounds!.y);
  expect(endsFar.nodes.b!.bounds!.y).toBe(endsFar.nodes.c!.bounds!.y);
  expect(endsFar.nodes.a!.bounds!.y).toBeLessThan(endsFar.nodes.b!.bounds!.y);
});
