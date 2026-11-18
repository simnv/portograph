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
// ended 7c with no finding and was refused at publication (a row unit off its seat after the lane extents were rebuilt).
const SHEETS = [
  'test/fixtures/staged/a-stagger-gate-compares-placements-that-hold-the-same-seat-sets.yaml',
  'goldens/synthetic/a-side-lane-label-spans-the-collinear-pieces.yaml',
  'goldens/synthetic/a-far-end-between-the-anchor-and-a-side-lane.yaml',
];
const root = new URL('../../', import.meta.url);
afterEach(() => { delete centreCheckTrace.hook; });

for (const sheet of SHEETS) it(`the producer of 7c and its publication read one finding set: ${sheet.split('/').pop()}`, async () => {
  const produced = new WeakMap<LayoutModel, readonly string[]>(), pairs: { producer: string[]; publication: string[] }[] = [];
  centreCheckTrace.hook = (model, reader, found) => {
    if (reader === 'producer') produced.set(model, [...found]);
    else if (produced.has(model)) pairs.push({ producer: [...produced.get(model)!].sort(), publication: [...found].sort() });
  };
  await layout(parse(withMoveBeforeGrow(readFileSync(new URL(sheet, root), 'utf8'))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(pairs.length, 'every 7c run of the sheet is read').toBeGreaterThan(0);
  expect(pairs.filter(pair => pair.producer.join('\n') !== pair.publication.join('\n'))).toEqual([]);
}, 600000);
