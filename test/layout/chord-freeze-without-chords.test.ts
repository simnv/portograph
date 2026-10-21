import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 11 (architecture-2): the 7f freeze is a decision even when no chord is held. The fixture has a cross-frame candidate that the facing-edge
// check refuses at the freeze. 7f then reserves space, a replay saw the boxes with that space, took the chord, and the grid widened the group
// afterwards: the row path no longer matched the region rule and the run stopped with `Row path on link-3 contradicts the region rule`.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-chord-refused-at-the-freeze-is-not-taken-after-the-grid-widens.yaml', import.meta.url), 'utf8');

it('lays out with no error, and the chord the freeze refused stays orthogonal', async () => {
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.frozenChords).toEqual([]);
  const link = model.links.find(item => item.id === 'link-3')!;
  expect(link.technique).toBe('orthogonal');
  expect(link.path?.segments.length ?? 2).toBeGreaterThan(1);
}, 120000);
