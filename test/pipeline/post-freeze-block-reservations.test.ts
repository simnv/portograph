import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

// Dense-16x9 ticket 31: a sheet whose node declaration order made a centring step after the chord freeze of 7f take a solid-block member
// off its reserved angle. On main 92b16e7f it threw at publication: "The fan admission record is forged: link-11 lost its reserved angle".
const yaml = readFileSync(new URL('../../goldens/synthetic/a-centring-step-after-the-freeze-keeps-a-solid-block-on-its-angle.yaml', import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const solidMembers = (model: LayoutModel): string[] => (model.fanFamilies ?? []).filter(family => family.kind === 'solid').flatMap(family => family.members.map(member => member.link));

describe('a move after the chord freeze keeps the solid block on its reservation (dense-16x9 ticket 31)', () => {
  it('publishes the sheet as declared, with every block reservation holding', async () => {
    const model = await run(yaml);
    expect(solidMembers(model)).toContain('link-11');
    expect(model.blockReservations?.length).toBeGreaterThan(0);
    expect(blockReservationsFault(model)).toBeUndefined();
  }, 180000);

  it('publishes the sheet with its nodes declared the other way round as well (R3)', async () => {
    const model = await run(reversed(yaml, 'nodes'));
    expect(blockReservationsFault(model)).toBeUndefined();
  }, 180000);
});
