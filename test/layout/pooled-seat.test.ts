import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 47: a member of a pooled row unit (`rowSeats`) seats inside the body it has, with `layout.moveBeforeGrow` as without it
// (one limit for `alignSide` and `seatNode`, R1). A seat that grew the body past it was carried off its feed by the clamp of the step, and the
// step was declined whole, main move included, on every pass: the group stood at its stage-6 x with no seat or target of its own.
const NAME = 'a-pooled-row-member-seats-inside-its-body';
const yaml = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');
const lay = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const without = (text: string): string => text.replace('layout: { moveBeforeGrow: true }', 'layout: { moveBeforeGrow: false }');
const read = (model: LayoutModel) => {
  const { overlay } = score(model).snapshot.counts;
  return { group: model.groups['row-b']!.bounds, node: model.nodes['node-b']!.bounds, canvas: model.canvas, overlayBent: overlay.bent };
};

it('a pooled member keeps its body, and its group stands where its main move puts it, with the option as without it', async () => {
  expect(without(yaml)).not.toBe(yaml);
  const on = await lay(yaml), off = await lay(without(yaml));
  expect(on.document.layout?.moveBeforeGrow).toBe(true);
  expect(read(on)).toEqual(read(off));
  expect(Math.round(on.groups['row-b']!.bounds!.x)).toBe(202);
  expect(read(on).overlayBent).toBe(0);
  // No seat of the pooled member: it neither slides nor grows.
  expect(Object.hasOwn(on.alignmentSeats ?? {}, 'node-b')).toBe(false);
}, 120000);

// With the nodes block reversed the unit stands in the other order (`node-b` first, as without the option); the rule holds there too.
it('holds with the nodes block reversed (R3): the option changes nothing there either', async () => {
  const back = reversed(yaml, 'nodes'), on = await lay(back), off = await lay(without(back));
  expect(read(on)).toEqual(read(off));
  expect(read(on).overlayBent).toBe(0);
}, 120000);
