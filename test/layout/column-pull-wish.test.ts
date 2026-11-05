import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { holdColumnAxes } from '../../src/layout/columns.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 74: the column pull (`holdColumnAxes`) pooled a frame that pulls toward a fixed feed with a unit whose feeds are the
 * far end of a bundle block it leads (`Bundle.lead`), and gave that unit a wish to stay where it stood. The run moved half of the frame's
 * deficit, the next seat moved the feeds after the unit, so every replay moved the tier in x, and the y-only rebuild of the tier-gap solve
 * threw. Such a unit now has no feed range and no wish: the seat has decided where its feeds stand. A unit with no feed range for another
 * reason still wishes to stay (slots 0 and 2, the block bent): ticket 75.
 */
const SOURCE = readFileSync(new URL('../../goldens/synthetic/a-unit-with-no-feed-range-stands-until-pushed.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

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

  it.each([1, 3, 4, 5])('publishes with n5 in slot %i of its row', async slot => {
    const yaml = inSlot(SOURCE, slot);
    expect(yaml.split('\n').filter(line => /^ {2}n[0-5]: /.test(line)).findIndex(line => line.startsWith('  n5:'))).toBe(slot);
    const model = await layout(parse(yaml), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
  }, 120000);

  // Ticket 75: the block stands bent, g1 has no feed range and still wishes to stay, so the pull halves g2's deficit at each call and
  // the tier-gap solve throws, as on main. The fix of ticket 75 makes these pass.
  it.fails.each([0, 2])('publishes with n5 in slot %i of its row (ticket 75)', async slot => {
    const model = await layout(parse(inSlot(SOURCE, slot)), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
  }, 120000);

  it.each([0, 1, 2, 3, 4, 5])('publishes with g1 a frame and n5 in slot %i of its row', async slot => {
    const yaml = inSlot(framed(SOURCE), slot);
    expect(yaml).toContain('g4: { parent: g1 }');
    const model = await layout(parse(yaml), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
    if (slot === 5) expect(model.bundles.map(bundle => bundle.lead)).toEqual(['n6']);
  }, 120000);
});
