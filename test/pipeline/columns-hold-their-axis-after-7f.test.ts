import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { holdColumnAxes } from '../../src/layout/columns.js';
import { rows } from '../../src/layout/rows.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { findPort } from '../../src/layout/row-paths.js';
import { resolve } from '../../src/resolve/index.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { blockedChordsAt } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const source = readFileSync(new URL('../../goldens/synthetic/columns-hold-their-axis-after-7f.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** The jog of a routed link between its two ports as the cells stand now: the port x of its end less that of its start. */
const jog = (model: LayoutModel, id: string): number => {
  const { attachments } = model.links.find(link => link.id === id)!;
  return Math.abs(findPort(model, attachments!.to)!.anchor!.x - findPort(model, attachments!.from)!.anchor!.x);
};

describe('columns hold their feed axis after 7f', () => {
  // Stage 7f widens a cell to hold its title and moves the frames after it as wholes; a frame that stood under
  // its feed after rows then stands beside it. Ticket 16's pass runs again after each 7f move (ticket 17).
  it('the feed link of the middle frame jogs no more after the whole layout than after rows', async () => {
    const resolved = resolve(parse(source));
    sidesOne(resolved); sizeNodes(resolved);
    await skeleton(resolved, { createAttempt });
    const atRows = jog(rows(sidesTwo(resolved)), 'link-2');
    expect(atRows, 'the fixture forces a jog at rows, or the test proves nothing').toBeGreaterThan(0);
    expect(jog(await run(), 'link-2')).toBeLessThanOrEqual(atRows + PLACEMENT_EPS);
  }, 60000);

  it('keeps the frames a band gap apart, and a second run of the pass moves nothing', async () => {
    const model = structuredClone(await run());
    const tops = (deriveFrames(model) ?? []).filter(frame => frame.parent === undefined).sort((a, b) => a.box.x - b.box.x);
    for (const [i, frame] of tops.slice(1).entries()) {
      expect(frame.box.x - (tops[i]!.box.x + tops[i]!.box.width)).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    }
    const before = JSON.stringify(Object.values(model.groups).map(group => group.bounds));
    // The slack is spent after centring, so the pass that 7f runs is the one with none.
    expect(holdColumnAxes(model, 0)).toBe(false);
    expect(JSON.stringify(Object.values(model.groups).map(group => group.bounds))).toBe(before);
  }, 60000);

  // Snack-theme ticket 159. With card nodes the side round offers the left face of b-core for the chord link-2. The chord holds at 7e, and then the
  // title room of 7f (the zone titles push Site B right, the feed title band moves tier 1 down) stands the frame of Site A on it: a move 7f cannot
  // refuse, so the chord stayed straight through the frame and G2 failed. The judge reads the frozen chords now and refuses the trial.
  // The premise holds with card nodes only (`layout.nodeContent: card`): the same sheet with stacked nodes offers no such side.
  // Ticket 164 (card default) owns the fix: the judge's use of `chordBlockedNew` broke the stacked canton-order sheet (G9), so it moved to
  // `.scratch/snack-theme/164-chord-blocked-new.patch`. This test fails until 164 lands it; it then passes, and `it.fails` alerts.
  it.fails('ticket 164: refuses a side trial whose held chord 7f stands a foreign frame on, and publishes no blocked chord', async () => {
    const model = await layout(parse(source.replace('portograph: 2\n', 'portograph: 2\nlayout: { nodeContent: card }\n')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(blockedChordsAt(model)).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_BLOCKED')).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED').map(item => item.message))
      .toContainEqual(expect.stringContaining('stage 7f stood a body or a foreign frame on a held chord (link-2)'));
  }, 60000);
});
