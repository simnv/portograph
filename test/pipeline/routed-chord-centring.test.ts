import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 100 review 3: 7f centring packs the ports of a face against the one alignment it keeps. A held chord's port that is not a target
 * used to slide along the face, the chord slanted across the lane of another link, and `validateLanes` threw `Fixed path crosses a foreign lane`.
 * The side is declined instead, so the chord keeps the x it was decided at. The same hole stood in the whole-group shift of the centring (`toMean`):
 * a group that moved left of its chord's other end slanted the chord across a lane; the shift is now 0 for such a move.
 */
describe('a face that aligns one port leaves the port of a held chord in place', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-face-aligns-one-port-and-leaves-a-chord-port-in-place.yaml', import.meta.url), 'utf8');
  it('lays out, and the chord stays straight', async () => {
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    // The chord of src1 to acc3 stays a chord, vertical at the x it was decided at.
    const chord = model.links.find(link => link.attachments!.from.node === 'src1' && link.attachments!.to.node === 'acc3')!;
    expect(chord.path?.fixed).toBe(true);
    expect(chord.path!.segments).toHaveLength(1);
  });
});

describe('a group shift leaves a held chord clear of a lane', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-shift-leaves-a-chord-clear-of-a-lane.yaml', import.meta.url), 'utf8');
  it('lays out, and the chord of src0 to acc0 stays straight', async () => {
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const chord = model.links.find(link => link.attachments!.from.node === 'src0' && link.attachments!.to.node === 'acc0')!;
    expect(chord.path?.fixed).toBe(true);
    expect(chord.path!.segments).toHaveLength(1);
  });
});
