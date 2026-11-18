import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';
import { layout, parse } from '../../src/index.js';
import { centreCheckTrace } from '../../src/layout/centre.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { withMoveBeforeGrow } from '../layout/move-before-grow.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 38, ruling (a) (R1, R2): the centre rule's last centring check reads the geometry the stage publishes. The transaction rebuilds
// the regions, the lane extents and the region geometry after the rule's edit, and withdraws the seats its moves broke (`rebuildAfterEdit`); the
// producer runs the same function before its final check. So the finding set of the producer and the one the publication check reads on that
// draft are one set, on every 7c run of a sheet: compared placements and the kept one. Before ruling (a), a stagger-gate trial of the staged sheet
// ended 7c with no finding and was refused at publication (a row unit off its seat after the lane extents were rebuilt). Review 1: a run whose
// passes spend the budget left 7c with an empty reading of geometry it did not publish; every exit now ends on the one final reading. The last two
// sheets spend it, read as they stand (the option off).
const SHEETS: readonly (readonly [string, 'forced' | 'as is'])[] = [
  ['test/fixtures/staged/a-stagger-gate-compares-placements-that-hold-the-same-seat-sets.yaml', 'forced'],
  ['goldens/synthetic/a-side-lane-label-spans-the-collinear-pieces.yaml', 'forced'],
  ['goldens/synthetic/a-far-end-between-the-anchor-and-a-side-lane.yaml', 'forced'],
  ['goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml', 'as is'],
  ['test/fixtures/sweep/v7-3-2.yaml', 'as is'],
];
const root = new URL('../../', import.meta.url);
afterEach(() => { delete centreCheckTrace.hook; });

for (const [sheet, option] of SHEETS) it(`the producer of 7c and its publication read one finding set: ${sheet.split('/').pop()} (${option})`, async () => {
  const produced = new WeakMap<LayoutModel, readonly string[]>(), pairs: { producer: string[]; publication: string[] }[] = [];
  centreCheckTrace.hook = (model, reader, found) => {
    if (reader === 'producer') produced.set(model, [...found]);
    else if (produced.has(model)) pairs.push({ producer: [...produced.get(model)!].sort(), publication: [...found].sort() });
  };
  const text = readFileSync(new URL(sheet, root), 'utf8');
  await layout(option === 'forced' ? withMoveBeforeGrow(parse(text)) : parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(pairs.length, 'every 7c run of the sheet is read').toBeGreaterThan(0);
  expect(pairs.filter(pair => pair.producer.join('\n') !== pair.publication.join('\n'))).toEqual([]);
}, 600000);
