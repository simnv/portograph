import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { rows } from '../../src/layout/rows.js';
import { lanes } from '../../src/layout/lanes.js';
import { reseatRow } from '../../src/layout/overlay-order.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 17 found two 7a plans that pushed a group holding the authored source of a transit link, which the lane-stage
 * guard then refused with a plain error that ended the command: the transit plans held only the alignment ends of the links that own a
 * lane (a link with a spanning chord or a course owns none), and the span corridors held no group at all. Both now read
 * `heldSourceGroups`, so the push is refused by the plan (a typed refusal at most), never by the guard.
 */
const read = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')
  .replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n');

/** The sheet through 7a, with `spans` as spanning chords and the rows of `order` in the given order (what the stage-4 order may pick). */
async function throughLanes(yaml: string, spans: string[], order: Record<string, string[]>): Promise<LayoutModel> {
  const model = resolve(parse(yaml));
  for (const link of model.links) if (spans.includes(link.id)) link.spanHint = true;
  sizeNodes(sidesOne(model));
  await skeleton(model, { createAttempt });
  for (const [group, next] of Object.entries(order)) expect(reseatRow(model, model.groups[group]!, next, true)).toBe(true);
  return lanes(rows(sidesTwo(model)));
}
const guardError = (error: unknown): boolean => error instanceof Error && !(error instanceof PlacementRefusal) && /transit source anchors/.test(error.message);

it('a transit plan does not push the group of a source whose link has a course', async () => {
  // The default order turns `top` (ticket 17). A course trial of link-4 (gate-a to deep-a) then leaves it no lane, and the transit plan of
  // link-5 pushed gate, which holds gate-a. Only a course trial reaches it, so the whole pipeline runs (no hand-made course).
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-transit-inside-a-canton.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.groups.top!.rowOrderDecision?.rule).toBe('corridor-crossings');
  expect(model.removedLinks ?? []).toEqual([]);
}, 60000);

it('a span corridor does not push the group of a transit source', async () => {
  // link-8 (b2 to u0) is the chord across middle, which holds m0, the source of the transit link-7.
  const run = throughLanes(read('a-row-turns-to-clear-a-corridor'), ['link-8'], { top: ['t1', 't0'], upper: ['u1', 'u0'] });
  const outcome = await run.then(() => undefined, (error: unknown) => error);
  expect(guardError(outcome)).toBe(false);
}, 60000);

it('a corridor that follows its child derives the frames again', async () => {
  // The held-lane sheet with `l2` declared before `l1` (main lays it out the same way): 7f's last step moves a corridor that a frame holds,
  // the frame `east` kept its old edge, and the route stage refused the model ("Frames contradict the cell geometry they derive from").
  const lines = read('a-held-lane-is-reserved-before-a-foreign-lane').split('\n');
  const at = lines.findIndex(line => line.startsWith('  l1:'));
  [lines[at], lines[at + 1]] = [lines[at + 1]!, lines[at]!];
  const model = await layout(parse(lines.join('\n')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.diagnostics.some(item => item.code === 'LANE_FOLLOWS_ITS_CHILD')).toBe(true);
  expect(model.removedLinks ?? []).toEqual([]);
}, 60000);
