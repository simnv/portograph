import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { blockReservationFaults } from '../../src/layout/block-checks.js';
import { farEndHoldTrace, farEndRangeOutside, farEndSnapshot, holdFarEnds, type GroupStep } from '../../src/layout/centre.js';
import { refuseChords } from '../../src/layout/fan-admission.js';
import { freezeChords } from '../../src/layout/frame-paths.js';
import { rebuildFrames } from '../../src/layout/frames.js';
import { seatSetFault } from '../../src/layout/reservations.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';

/**
 * Review 1 of dense-16x9 ticket 57: after the chord freeze the step of a far-end row (`holdFarEnds`, W40) translates the row only where the judge
 * of a move after the freeze (`blockMoveRefusal`) accepts it, read on a copy with the frames rebuilt (W41, `farEndShifted`). Before, the copy kept
 * the frame boxes of before the move, and the judge read the old frame edge.
 *
 * The reviewer's reproduction on the staged two-cores sheet, with the option on: the model the first centring replay after the freeze gives back
 * (stage `bars`), its freeze emptied (an empty freeze is a recorded decision too, so the move guard asks no chord), the far-end rank cell widened
 * so that the two frames start 75 px apart, and a translation 1 px past the seat window. The judge refuses it on the rebuilt frames (a frozen
 * link loses its reserved box clearance): the row stays, one clamp names the block, and the reading of the publication agrees.
 */
const SHEET = readFileSync(new URL('../fixtures/staged/two-cores-reach-seven-pairs-through-hubs-on-the-last-rank.yaml', import.meta.url), 'utf8');
const ID = 'core-b#0';
const clamps = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'SEAT_FAR_END_CLAMPED').map(item => item.message);

async function givenBack(text: string): Promise<LayoutModel> {
  let found: LayoutModel | undefined;
  farEndHoldTrace.given = (model, id) => { if (found === undefined && id === ID && model.frozenChords !== undefined && model.stage === 'bars') found = structuredClone(model); };
  try {
    await layout(withMoveBeforeGrow(parse(text)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { delete farEndHoldTrace.given; }
  expect(found, 'a centring replay after the freeze gives the far-end row back').toBeDefined();
  return found!;
}

describe('a far-end row moves after the chord freeze only where the block judge accepts the rebuilt frames (dense-16x9 ticket 57, review 1)', () => {
  for (const [order, text] of [['as written', SHEET], ['nodes reversed', reversed(SHEET, 'nodes') as string]] as const) {
    it(`refuses a translation that a frozen link loses its frame clearance to, and names the block (${order})`, async () => {
      const model = await givenBack(text);
      const reasons = new Map(model.frozenChords!.map(link => [link, 'title' as const]));
      delete model.frozenChords; delete model.frozenBlockFollowers; delete model.frozenLevelChords; delete model.fanAdmissions;
      freezeChords(model, refuseChords(model, reasons));
      expect(model.frozenChords).toEqual([]);
      const other = model.frames!.find(frame => frame.id === 'core-a')!.box, box = model.groups[ID]!.bounds!, x = other.x + other.width + 75;
      box.width += box.x - x; box.x = x;
      rebuildFrames(model);
      // The premise: the row starts with no block fault and with both seat sets holding.
      expect([...blockReservationFaults(model).keys()]).toEqual([]);
      const seats = (m: LayoutModel): (string | undefined)[] => (m.reservations ?? []).filter(item => item.kind === 'seatSet').map(item => seatSetFault(item, m));
      expect(seats(model).length).toBeGreaterThan(0);
      expect(seats(model).every(fault => fault === undefined)).toBe(true);
      const range = farEndRangeOutside(model, [ID])!, before = clamps(model).length;
      const saved = farEndSnapshot(model, ID);
      moveGroup(model, model.groups[ID]!, range.low - 1, 0);
      holdFarEnds(model, ID, range, saved, { unresolved: new Set(), group: model.groups[ID]!, notes: { wanted: new Map() } } as unknown as GroupStep);
      // The row stays where the step began, one clamp names the block, and the publication reads no fault on the rebuilt frames.
      expect(model.groups[ID]!.bounds!.x).toBeCloseTo(x, 6);
      const named = clamps(model).slice(before);
      expect(named).toHaveLength(1);
      expect(named[0]).toMatch(/moves core-b#0 0\.0 px of the -\d+\.\d px it asked: the move would leave the reservation of a solid block \(link-\d+ lost its reserved box clearance \(frame\)\)/);
      rebuildFrames(model);
      expect([...blockReservationFaults(model).keys()]).toEqual([]);
      expect(seats(model).every(fault => fault === undefined)).toBe(true);
    }, 180000);
  }
});
