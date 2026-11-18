import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { resolve } from '../../src/resolve/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 46: a sheet that draws with `layout.moveBeforeGrow` off draws with it on, in every input order. Two corpus sheets with `nodes`
 * reversed drew without the option and threw with it; each fixture is such a sheet as written, with the option, so it publishes in all three orders.
 *
 * (b) A held lane of the tier pass is reserved before the lanes foreign to its frame where, in the order of the passes, the frame grows around a
 * foreign lane (`allocateLanes`, `heldLanesOverForeign`; review 1: only there): the held lane stands next to its cell, and the foreign lane beyond the
 * room the frame grows to hold it.
 *
 * (a) (design B, ruling of 2026-11-18): the replay of a tier and the producer read one seat (R1). After the chord freeze the recorded seat of a
 * member of a row unit holds only inside the body the member has, and the unit's move that takes it off its feed withdraws it by name.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const orders3 = (yaml: string): Record<string, string> => ({ 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string });
const HELD = 'a-held-lane-is-reserved-before-the-foreign-lane-of-its-tier-pass';
const UNIT = 'a-row-unit-member-keeps-its-body-when-its-recorded-seat-stands-elsewhere';
/** The routed turns of each order of UNIT (`pathBends`), accepted with the ruling of 2026-11-18 (design B of ticket 46, cause a). */
const ROUTED_TURNS: Record<string, number> = { 'as written': 6, 'links reversed': 6, 'nodes reversed': 0 };

describe('a sheet that draws with moveBeforeGrow off draws with it on, in every input order (dense-16x9 ticket 46)', () => {
  for (const sheet of [HELD]) for (const [name, text] of Object.entries(orders3(fixture(sheet)))) {
    it(`${sheet} publishes with every gate passing and no link removed (${name})`, async () => {
      const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      expect(model.document.layout?.moveBeforeGrow).toBe(true);
      expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id)).toEqual([]);
      expect(model.removedLinks ?? []).toEqual([]);
    }, 120000);
  }

  it('(b) the held lane stands next to its cell and the foreign lane beyond it, on one margin', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(fixture(HELD)))));
    await skeleton(model, { createAttempt });
    const placed: LayoutModel = lanes(rows(sidesTwo(model)));
    const cell = placed.groups['zone#2']!.bounds!;
    const between = (a: string, b: string): string[] => placed.links.filter(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join() === [a, b].sort().join()).map(link => link.id);
    const tierLanes = placed.lanes.filter(lane => lane.tier === placed.groups['zone#2']!.tier && lane.owner.kind === 'link');
    // b to e ends in the frame `zone` (held) and passes its left margin; the router-switch links are foreign to it. Reserved after the held lane,
    // no foreign lane stands between it and the cell (before ticket 46 the lane of the switch's first link stood there, 7a refused it): the foreign
    // lanes take the other margin here.
    const held = tierLanes.find(lane => between('b', 'e').includes((lane.owner as { id: string }).id))!;
    const foreign = tierLanes.filter(lane => between('router', 'mid').includes((lane.owner as { id: string }).id));
    expect(held.x).toBeLessThan(cell.x);
    expect(foreign).toHaveLength(2);
    for (const lane of foreign) expect(lane.x > held.x && lane.x < cell.x).toBe(false);
  }, 60000);
});

describe('a sheet that draws with moveBeforeGrow off draws with it on, in every input order (dense-16x9 ticket 46, cause a)', () => {
  for (const [name, text] of Object.entries(orders3(fixture(UNIT)))) {
    it(`${UNIT} publishes with every gate passing and no link removed (${name})`, async () => {
      const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      expect(model.document.layout?.moveBeforeGrow).toBe(true);
      expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id)).toEqual([]);
      expect(model.removedLinks ?? []).toEqual([]);
      // It settles: the passes reach a fixed point.
      expect(model.diagnostics.filter(note => note.code === 'PLACEMENT_NON_CONVERGENCE' || note.code === 'CENTRE_INVARIANT_UNVERIFIED')).toEqual([]);
      expect(score(model).snapshot.counts.routed.turns).toBe(ROUTED_TURNS[name]);
    }, 120000);
  }
});
