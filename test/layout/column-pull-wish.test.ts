import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { COLUMN_SLACK, besideGap, fitRun, holdColumnAxes } from '../../src/layout/columns.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { score } from '../../src/score/index.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
// The group lift (ticket 08) is off in these tests: with it, `g3` (it links to no lower tier) rises one band, so the unit with no feed
// range no longer stands where the pull and the seat meet. `lift.test.ts` tests the lift.

/**
 * Architecture-2 ticket 74: the column pull (`holdColumnAxes`) pooled a frame that pulls toward a fixed feed with a unit whose feeds are the
 * far end of a bundle block it leads (`Bundle.lead`), and gave that unit a wish to stay where it stood. The run moved half of the frame's
 * deficit, the next seat moved the feeds after the unit, so every replay moved the tier in x, and the y-only rebuild of the tier-gap solve
 * threw. Such a unit now has no feed range and no wish: the seat has decided where its feeds stand. Ticket 75: no unit with no feed range
 * has a wish (slots 0 and 2: the block records no lead and g1, a row group, has no feed), so the pass is idempotent in every slot. The
 * centring window reads the gap G9 reads beside a frame (`besideGap`).
 */
const SOURCE = readFileSync(new URL('../../goldens/synthetic/a-unit-with-no-feed-range-stands-until-pushed.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true };

/** The sheet with n5 in slot `slot` of the g0 row (the node order of the document is the row order). */
function inSlot(source: string, slot: number): string {
  const lines = source.split('\n'), row = lines.filter(line => /^ {2}n[0-5]: /.test(line)), moved = row.find(line => line.startsWith('  n5:'))!;
  const order = row.filter(line => line !== moved);
  order.splice(slot, 0, moved);
  let at = 0;
  return lines.map(line => (/^ {2}n[0-5]: /.test(line) ? order[at++]! : line)).join('\n');
}

/** The sheet with g1 a frame (a child group under it): the column that leads the bundle block is then pulled toward its feeds. */
const framed = (source: string): string => source
  .replace('  g3: { parent: g2 }\n', '  g3: { parent: g2 }\n  g4: { parent: g1 }\n')
  .replace('  n11: { group: g3, label: n11 }\n', '  n11: { group: g3, label: n11 }\n  n12: { group: g4, label: n12 }\n');

/** Lays the sheet out with a tap on the drafts before the end trim (after the tier-gap solve), one per placement attempt. */
async function run(yaml: string): Promise<{ model: LayoutModel; drafts: LayoutModel[] }> {
  const drafts: LayoutModel[] = [], sink = targetTap.sink;
  targetTap.sink = (tap, value) => { if (tap === 'beforeEndTrim') drafts.push(JSON.parse(value) as LayoutModel); };
  try {
    return { model: await layout(parse(yaml), options), drafts };
  } finally { if (sink === undefined) delete targetTap.sink; else targetTap.sink = sink; }
}

/** The x geometry a bundle seat and the repack write: node boxes along x and the x of every port. */
const xs = (model: LayoutModel): string => JSON.stringify(Object.values(model.nodes).map(node =>
  [node.id, node.bounds!.x, node.bounds!.width, node.ports.map(port => [port.side, port.anchor?.x])]));

describe('a unit with no feed range stands until it is pushed', () => {
  it('publishes, the bundle links stand vertical, and the seat records n6 as the lead', async () => {
    const { model } = await run(SOURCE);
    const bundled = model.links.filter(item => item.bundle !== undefined);
    expect(bundled.map(link => [link.attachments!.from.node, link.attachments!.to.node].sort())).toEqual([['n5', 'n6'], ['n5', 'n6'], ['n5', 'n6']]);
    for (const link of bundled) {
      const xsOf = link.path!.segments.flatMap(segment => [segment.from.x, segment.to.x]);
      expect(Math.max(...xsOf) - Math.min(...xsOf), link.id).toBeLessThan(1e-6);
    }
    expect(model.bundles.map(bundle => bundle.lead)).toEqual(['n6']);
  }, 120000);

  it('the seat and the pull are at their fixed point on the draft the solve leaves: a further seat and repack move no x', async () => {
    for (const yaml of [SOURCE, framed(SOURCE)]) {
      const { drafts } = await run(yaml);
      expect(drafts.length).toBeGreaterThan(0);
      for (const draft of drafts) {
        const again = JSON.parse(JSON.stringify(draft)) as LayoutModel;
        prepareBundleGeometry(again);
        expect(xs(again)).toBe(xs(draft));
        // The pull of 7f (slack 0) on its own moves nothing either, and the lead stays.
        expect(holdColumnAxes(again, 0)).toBe(false);
        expect(xs(again)).toBe(xs(draft));
        expect(again.bundles.map(bundle => bundle.lead)).toEqual(['n6']);
      }
    }
  }, 120000);

  it('a block that is not lined up from one end records no lead (slot 1)', async () => {
    const model = await layout(parse(inSlot(SOURCE, 1)), options);
    expect(model.bundles.map(bundle => bundle.lead)).toEqual([undefined]);
  }, 120000);

  it.each([0, 1, 2, 3, 4, 5])('publishes with n5 in slot %i of its row', async slot => {
    const yaml = inSlot(SOURCE, slot);
    expect(yaml.split('\n').filter(line => /^ {2}n[0-5]: /.test(line)).findIndex(line => line.startsWith('  n5:'))).toBe(slot);
    const model = await layout(parse(yaml), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
  }, 120000);

  // Ticket 75: in slots 0 and 2 the block records no lead and g1 has no feed range. With a wish to stay, the pull halved g2's deficit at each
  // call and the tier-gap solve threw. With no wish, a replay of the pull on the draft the solve leaves moves nothing, in every slot.
  it.each([0, 1, 2, 3, 4, 5])('the pull is idempotent on the draft the solve leaves with n5 in slot %i: a second call moves nothing', async slot => {
    const { drafts } = await run(inSlot(SOURCE, slot));
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      const again = JSON.parse(JSON.stringify(draft)) as LayoutModel;
      expect(holdColumnAxes(again, 0)).toBe(false);
      expect(holdColumnAxes(again)).toBe(false);
      expect(xs(again)).toBe(xs(draft));
    }
  }, 120000);

  it.each([0, 1, 2, 3, 4, 5])('publishes with g1 a frame and n5 in slot %i of its row', async slot => {
    const yaml = inSlot(framed(SOURCE), slot);
    expect(yaml).toContain('g4: { parent: g1 }');
    const model = await layout(parse(yaml), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
    if (slot === 5) expect(model.bundles.map(bundle => bundle.lead)).toEqual(['n6']);
  }, 120000);
});

const MARGIN = readFileSync(new URL('../../goldens/synthetic/a-frame-keeps-its-margin-beside-a-plain-group.yaml', import.meta.url), 'utf8');

describe('a frame keeps its margin beside a plain group (ticket 75)', () => {
  it('the frame box and the plain group stand besideGap apart, and every gate passes', async () => {
    const model = await layout(parse(MARGIN), options);
    const frame = model.frames!.find(item => item.id === 'g1')!.box, group = model.groups.g2!.bounds!;
    expect(group.x - (frame.x + frame.width)).toBeGreaterThanOrEqual(besideGap(model, true, false) - 1e-6);
    const failed = Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length > 0);
    expect(failed.map(([id]) => id)).toEqual([]);
  }, 120000);

  it('besideGap is a band gap, and COLUMN_SLACK more when exactly one unit is a frame', async () => {
    const model = await layout(parse(MARGIN), options);
    expect(besideGap(model, true, true)).toBe(bandGap(model));
    expect(besideGap(model, false, false)).toBe(bandGap(model));
    expect(besideGap(model, true, false)).toBe(bandGap(model) + COLUMN_SLACK);
    expect(besideGap(model, false, true)).toBe(bandGap(model) + COLUMN_SLACK);
  }, 120000);
});

describe('fitRun, the fit of the column pull', () => {
  // Three units of widths folded into `offsets` (each 100 apart when packed), one segment, no pin.
  const offsets = [0, 100, 200], segment = [0, 0, 0], free = [-Infinity, -Infinity, -Infinity], none = [Infinity, Infinity, Infinity];
  it('a unit with a wish pushes the units with no wish after it the whole way, in one call', () => {
    // Unit 0 wants 150; units 1 and 2 stand at 120 and 260 and have no wish.
    expect(fitRun([150, 120, 260], offsets, segment, free, none, [false, true, true])).toEqual([150, 250, 350]);
  });
  it('a unit with a wish pushes the units with no wish before it to the left', () => {
    expect(fitRun([0, 100, 120], offsets, segment, free, none, [true, true, false])).toEqual([-80, 20, 120]);
  });
  it('a unit with no wish that nothing pushes stands where it stands', () => {
    expect(fitRun([0, 140, 300], offsets, segment, free, none, [false, true, false])).toEqual([0, 140, 300]);
  });
  it('a unit with no wish between two pins is pushed by its segment and held between the pins', () => {
    // Units 0 and 3 are pins at z = left - offset = 0 and 50 (segments 1 and 3). Units 1 and 2 share segment 2: unit 1 wants z 30, unit 2
    // has no wish and stands at z 10, so unit 1 pushes it to z 30 (pooled with a wish to stay, both would stand at z 20). A wish past the
    // pin at z 50 is held there.
    const four = [0, 100, 200, 300], segment = [1, 2, 2, 3], below = [0, 0, 0, 50], above = [0, 50, 50, 50], noWish = [false, false, true, false];
    expect(fitRun([0, 130, 210, 350], four, segment, below, above, noWish)).toEqual([0, 130, 230, 350]);
    expect(fitRun([0, 130, 210, 350], four, segment, below, above, [false, false, false, false])).toEqual([0, 120, 220, 350]);
    expect(fitRun([0, 180, 210, 350], four, segment, below, above, noWish)).toEqual([0, 150, 250, 350]);
  });
  it('is a fixed point: on its own result as the wanted lefts it returns the same lefts', () => {
    const noWish = [false, true, true, false], four = [0, 100, 200, 300], one = [0, 0, 0, 0];
    const first = fitRun([150, 120, 260, 290], four, one, four.map(() => -Infinity), four.map(() => Infinity), noWish);
    expect(fitRun(first, four, one, four.map(() => -Infinity), four.map(() => Infinity), noWish)).toEqual(first);
  });
});
