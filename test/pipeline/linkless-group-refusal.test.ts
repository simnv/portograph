import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
// The judges' module is loaded before the layout entry (architecture-2 ticket 57): the solve's imports (centre, bands) changed the order in which
// the import cycle overlay-paths -> row-paths -> frame-paths -> bands -> objective -> overlay-paths is entered, and entered from the entry the
// objective module bound the real path reader, not the mock below.
import '../../src/layout/objective.js';
import { layout, parse } from '../../src/index.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { stepOutOfChords } from '../../src/layout/overlay-place.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
// The group lift (ticket 08) is off in these tests: with it, `key` (no link) rises one band beside the sources, out of the chords the
// refused move reads. `lift.test.ts` tests the lift.

// The step refuses a move that leaves the picture worse (architecture ticket 13, phase 4: by the order of the user, a net gain may bend a link, so the
// refusal needs a loss). The geometry cannot force that (a chord that is straight with the group in place is straight without it, so it bans its own
// interval), so once the layout is done the test makes the overlay decision report one link as bent, with seven more turns than it has, whenever the group
// stands left of x = 0, which is where the step wants to put it.
const state = vi.hoisted(() => ({ armed: false }));
vi.mock('../../src/layout/overlay-paths.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/overlay-paths.js')>();
  // The judges of placement read the per-link path (`overlayBasePath`, ticket 23); both readers are made to report it.
  type Read = typeof actual.overlayPath;
  const worse = (read: Read): Read => (model, link, blockers) => {
    const path = read(model, link, blockers);
    // Eight copies, every other one reversed: seven reversals, which the turn predicate (`pieceTurns`) counts as seven turns.
    const back = [...path.segments].reverse().map(segment => ({ ...segment, from: segment.to, to: segment.from }));
    return state.armed && link.id === 'link-6' && (model.groups['key']?.bounds?.x ?? 1) < 0 ? { ...path, segments: Array.from({ length: 8 }, (_, index) => index % 2 === 0 ? path.segments : back).flat() } : path;
  };
  return { ...actual, overlayPath: worse(actual.overlayPath), overlayBasePath: worse(actual.overlayBasePath) };
});

it('undoes a move that would leave the overlay links worse, and warns', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-with-no-links-stands-in-a-straight-chord.yaml', import.meta.url), 'utf8');
  const model = structuredClone(await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true }));
  const key = model.groups['key']!;
  // Stand the group across the chord again, then let the step try.
  moveGroup(model, key, 12 - key.bounds!.x, 0);
  rebuildNodeGeometry(model, key.nodes, 'current');
  state.armed = true;
  stepOutOfChords(model, [1], new Set(['key']), []);
  expect(model.diagnostics.some(d => d.code === 'LINKLESS_GROUP_MOVE_REFUSED')).toBe(true);
  expect(key.bounds!.x).toBeCloseTo(12, 3);
}, 60000);
