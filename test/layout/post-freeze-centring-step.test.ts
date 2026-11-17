import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { blockMoveRefusal, blockReservationFaults } from '../../src/layout/block-checks.js';
import { centreDraft, createCentreBudget } from '../../src/layout/centre.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';

// Dense-16x9 ticket 33: a 7c group step after the chord freeze moved the ends of one row of a block, unjudged, while the other row stood, and
// took a member past its reservation. The step is judged now (`blockMoveRefusal` in `centreGroupStepChecked`): a step that leaves a member
// past BLOCK_TOLERANCE of its reservation where it held, or further past it, is given back.
//
// test/fixtures/staged/a-flat-block-over-centred-site-rows.draft.json is the 7f draft (tap beforeEndTrim) of
// goldens/synthetic/a-flat-block-member-pushed-past-its-box-falls-back.yaml as main b259aed5 built it: the chords are frozen, the flat block
// between the hub row (core#2) and six site rows stands, and link-8 already stands past its side-edge box.
const draft = (): LayoutModel => JSON.parse(readFileSync(new URL('../fixtures/staged/a-flat-block-over-centred-site-rows.draft.json', import.meta.url), 'utf8')) as LayoutModel;

describe('a 7c group step after the chord freeze keeps the blocks (dense-16x9 ticket 33)', () => {
  for (const site of ['site-3', 'site-4', 'site-5', 'site-6', 'site-9']) {
    it(`gives back the steps that would take a member further past its reservation after ${site} moves`, () => {
      const model = draft();
      expect(model.frozenChords).toBeDefined();
      // Move one site row a little: its step and the steps of its neighbours then want the row back under its feeds, which moves the block
      // ends of one row only.
      moveGroup(model, model.groups[site]!, 30, 0);
      const before = blockReservationFaults(model);
      centreDraft(model, createCentreBudget());
      expect(blockMoveRefusal(before, model)).toBeUndefined();
    });
  }
});
