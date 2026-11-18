import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { resolve } from '../../src/resolve/index.js';
import { derivedShortfalls } from '../../src/layout/constraints/separation.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withMoveBeforeGrow } from '../layout/move-before-grow.js';

// Dense-16x9 ticket 48: a move reads every separation as part of its window. Three causes put a frame nearer than its gap to a foreign unit:
// - stage 5: a lane a frame holds grows the frame in every sub-tier, and its slot reads only the sub-tiers the link crosses (both modes);
// - stage 4, with seats: a seat set widened its cell into the gap to the child frame beside it;
// - 7f: the pack of the beside rows moved that child back to its gap and closed the gap of the frame to the next column.
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const reversed = (yaml: string): string => {
  const sheet = readYaml(yaml) as { nodes: Record<string, unknown> };
  sheet.nodes = Object.fromEntries(Object.entries(sheet.nodes).reverse());
  return writeYaml(sheet);
};
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
/** The shortfalls on frames derived from the cells, read on a copy: a published stage is a protected model. */
const shortfalls = (model: LayoutModel): string[] => [...derivedShortfalls(JSON.parse(JSON.stringify(model)) as LayoutModel).keys()];
const g9 = (model: LayoutModel): string[] => score(model).snapshot.gates.G9.violations.map(item => item.message);

describe('a move keeps the separation to a foreign frame (dense-16x9 ticket 48)', () => {
  it('a lane a frame holds leaves its frame a beside gap from the unit before it, at stage 5', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(text('a-held-lane-is-reserved-before-a-foreign-lane')))));
    await skeleton(model, { createAttempt });
    const placed = lanes(rows(sidesTwo(model)));
    // Before the fix the held lane of link-6 grew frame `east` 18.8 px into the gap to `midc`; the unit before the grown edge gives way.
    expect(shortfalls(placed)).toEqual([]);
    const named = placed.diagnostics.filter(item => item.code === 'LANE_FRAME_GAP_KEPT').flatMap(item => item.owners ?? []);
    expect(named.some(owner => 'id' in owner && owner.id === 'midc')).toBe(true);
  }, 60000);

  for (const [name, form] of [
    ['a-held-lane-is-reserved-before-a-foreign-lane', 'as written'], ['a-refused-reseat-restores-its-frames', 'as written'],
    ['a-grid-group-stands-fixed-beside-frames', 'as written'], ['a-grid-group-stands-fixed-beside-frames', 'nodes reversed'],
  ] as const) {
    it(`publishes no G9 with layout.moveBeforeGrow: ${name}, ${form}`, async () => {
      const model = await layout(withMoveBeforeGrow(parse(form === 'as written' ? text(name) : reversed(text(name)))), options);
      expect(g9(model)).toEqual([]);
    }, 120000);
  }

  it('a seat set keeps the gap of its cell to the child frame beside it, at stage 4', async () => {
    // Before the fix the seat sets of `d#3` and `c#3` widened the cells 33.2 and 27.0 px into the gap to `d-zone` and `c-zone`.
    const model = sizeNodes(sidesOne(resolve(parse(text('a-seat-set-keeps-the-gap-to-a-child-frame')))));
    await skeleton(model, { createAttempt });
    const placed = rows(sidesTwo(model));
    expect((placed.reservations ?? []).some(entry => entry.kind === 'seatSet')).toBe(true);
    expect(shortfalls(placed).filter(id => id.startsWith('separation-cell-child-frame:'))).toEqual([]);
  }, 60000);

  it('publishes no G9 on the reversed sheet that holds the option (the fixture)', async () => {
    const model = await layout(parse(text('a-seat-set-keeps-the-gap-to-a-child-frame')), options);
    expect(g9(model)).toEqual([]);
  }, 120000);
});
