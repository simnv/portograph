import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 11 (architecture-2): the 7f freeze is a decision even when no chord is held. The fixture has a cross-frame candidate that the facing-edge
// check refuses at the freeze. 7f then reserves space, a replay saw the boxes with that space, took the chord, and the grid widened the group
// afterwards: the row path no longer matched the region rule and the run stopped with `Row path on link-3 contradicts the region rule`.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-chord-refused-at-the-freeze-is-not-taken-after-the-grid-widens.yaml', import.meta.url), 'utf8');

// Dense-16x9 ticket 06 (slice B): the link between the two sites is a level cross-frame chord and is held. The test pins it orthogonal in the text, so the freeze holds
// no chord here; the second test reads the golden as written.
const noTunnelChord = fixture.replace('id: tunnel', 'id: tunnel\n    route: orthogonal');

it('lays out with no error, and the chord the freeze refused stays orthogonal', async () => {
  expect(noTunnelChord).not.toBe(fixture);
  const model = await layout(parse(noTunnelChord), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.frozenChords).toEqual([]);
  const link = model.links.find(item => item.id === 'link-3')!;
  expect(link.technique).toBe('orthogonal');
  expect(link.path?.segments.length ?? 2).toBeGreaterThan(1);
}, 120000);

it('holds the level chord between the two sites and still refuses the chord that the facing edge refuses', async () => {
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const tunnel = model.links.find(item => item.id === 'link-7')!;
  expect(model.frozenChords).toEqual(['link-7']);
  expect(tunnel.technique).toBe('straight');
  expect(tunnel.path!.segments).toHaveLength(1);
  expect(model.links.find(item => item.id === 'link-3')!.technique).toBe('orthogonal');
}, 120000);
