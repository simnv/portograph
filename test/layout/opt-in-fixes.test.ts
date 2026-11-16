import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';

// Review 1 of dense-16x9 ticket 02: two fixes of the branch read `layout.moveBeforeGrow` (ADR-0027). No input shows that the default needs
// them, and with the option on each of these sheets fails without its fix. The other fixes that read the option have their tests beside the
// rule they hold: reseat-lane-sides.test.ts (the lane side and the record comparison) and seat-owns-body.test.ts (the close-up lane port).
const sheet = (path: string): string => withMoveBeforeGrow(readFileSync(new URL(`../../goldens/${path}.yaml`, import.meta.url), 'utf8'));
const publish = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the fixes that read layout.moveBeforeGrow (ADR-0027)', () => {
  it('the end trim keeps the room 7f reserved for a link label: an-overlay-row-label-keeps-clear-of-both-group-borders publishes', async () => {
    // Without the label-room guard of the end trim the publication refuses it: "A labelled link is shorter than the run its label reserved".
    const model = await publish(sheet('synthetic/an-overlay-row-label-keeps-clear-of-both-group-borders'));
    expect(model.document.layout?.moveBeforeGrow).toBe(true);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);

  it('the centre rule\'s rebuild names its open alignments: the NTP sheet publishes', async () => {
    // Without the naming in the rebuild the publication refuses it: "Centring invariant violated" at a port of loc5crt003.
    const model = await publish(sheet('real/ntp'));
    expect(model.document.layout?.moveBeforeGrow).toBe(true);
    expect(model.diagnostics.some(item => item.code === 'CENTRE_ALIGNMENT_OPEN')).toBe(true);
  }, 300000);
});
