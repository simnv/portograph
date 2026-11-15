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
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { deriveFrames } from '../../src/layout/frames.js';
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
  // When the ticket-17 row step turned `top`, a course trial of link-4 (gate-a to deep-a) left it no lane, and the transit plan of
  // link-5 pushed gate, which holds gate-a. The step now keeps `top` (its turn changes the canton's frame regions, rule
  // `frame-columns`), and the authored turn below places top-b at other x, so this run no longer reaches that trial: it pins only the
  // record and a clean run. The plans and the guard read one predicate, `heldSourceGroups` (R1); the span test below reaches it.
  const source = readFileSync(new URL('../../goldens/synthetic/a-transit-inside-a-canton.yaml', import.meta.url), 'utf8');
  const lines = source.split('\n'), one = lines.findIndex(line => line.startsWith('  top-a:'));
  [lines[one], lines[one + 1]] = [lines[one + 1]!, lines[one]!];
  const model = await layout(parse(lines.join('\n')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.groups.top!.rowOrderDecision).toEqual({ rule: 'frame-columns', before: ['top-b', 'top-a'], after: ['top-b', 'top-a'] });
  expect(model.removedLinks ?? []).toEqual([]);
}, 60000);

it('a span corridor does not push the group of a transit source', async () => {
  // link-8 (b2 to u0) is the chord across middle, which holds m0, the source of the transit link-7.
  const run = throughLanes(read('a-row-turns-to-clear-a-corridor'), ['link-8'], { top: ['t1', 't0'], upper: ['u1', 'u0'] });
  const outcome = await run.then(() => undefined, (error: unknown) => error);
  expect(guardError(outcome)).toBe(false);
}, 60000);

it('a corridor that follows its child derives the frames again', async () => {
  // A corridor that follows its child must leave the frames the cells derive. The premise needs the reseat to be adopted, and a frame to stand in the
  // sheet. It was the held-lane sheet with `l2` declared before `l1` (7f's last step moved a corridor that a frame holds, the frame `east` kept its old edge,
  // and the route stage refused the model: "Frames contradict the cell geometry they derive from"). Since ADR-0027 the seat moves a child under its
  // corridor, or declines it at the cap, and no order or label width of that sheet leaves a corridor free at its child's port (72 orders and
  // two label widths tried): its reseat is none or refused. a-three-port-side-shares-the-room-beyond-its-stems adopts two reseats and keeps three frames.
  // The refused reseat has its own pin: a-refused-reseat-restores-its-frames (refused-reseat-frames.test.ts).
  const yaml = read('a-three-port-side-shares-the-room-beyond-its-stems');
  resetAttemptCounters();
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(attemptCounters.reseat.adopted).toBeGreaterThan(0);
  expect(model.diagnostics.some(item => item.code === 'LANE_FOLLOWS_ITS_CHILD')).toBe(true);
  expect(model.removedLinks ?? []).toEqual([]);
  expect(model.frames?.length).toBeGreaterThan(0);
  expect(model.frames).toEqual(deriveFrames(model));
}, 60000);
