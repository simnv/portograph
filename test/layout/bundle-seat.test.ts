import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { prepareBundleGeometry } from '../../src/layout/bundle-geometry.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 74: the repack after a bundle seat moved one end of the block, so the block stood off the ports it aligned, and the
 * y-only rebuild of the tier-gap solve seated it again (an x move; the solve threw). The blocks are now seated again until the repack moves
 * no block's ends apart, so a later replay finds each block where it would seat it.
 */
const SOURCE = readFileSync(new URL('../../goldens/synthetic/a-bundle-block-is-seated-again-after-the-repack.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

/** The sheet with n5 in slot `slot` of the g0 row (the node order of the document is the row order). */
function inSlot(slot: number): string {
  const lines = SOURCE.split('\n'), row = lines.filter(line => /^ {2}n[0-5]: /.test(line)), moved = row.find(line => line.startsWith('  n5:'))!;
  const order = row.filter(line => line !== moved);
  order.splice(slot, 0, moved);
  let at = 0;
  return lines.map(line => (/^ {2}n[0-5]: /.test(line) ? order[at++]! : line)).join('\n');
}

/** Lays the sheet out with a tap on the drafts before the end trim (after the tier-gap solve), one per placement attempt. */
async function run(yaml: string): Promise<{ model: LayoutModel; drafts: LayoutModel[] }> {
  const drafts: LayoutModel[] = [], sink = targetTap.sink;
  targetTap.sink = (tap, value) => { if (tap === 'beforeEndTrim') drafts.push(JSON.parse(value) as LayoutModel); };
  try {
    return { model: await layout(parse(yaml), options), drafts };
  } finally { if (sink === undefined) delete targetTap.sink; else targetTap.sink = sink; }
}

/** The x geometry a bundle seat writes: node boxes along x and the x of every port. */
const xs = (model: LayoutModel): string => JSON.stringify(Object.values(model.nodes).map(node =>
  [node.id, node.bounds!.x, node.bounds!.width, node.ports.map(port => [port.side, port.anchor?.x])]));

describe('a bundle block is seated again after the repack', () => {
  it('publishes, and the bundle links stand vertical', async () => {
    const { model } = await run(SOURCE);
    const bundled = model.links.filter(item => item.bundle !== undefined);
    expect(bundled.map(link => [link.attachments!.from.node, link.attachments!.to.node].sort())).toEqual([['n5', 'n6'], ['n5', 'n6'], ['n5', 'n6']]);
    for (const link of bundled) {
      const xsOf = link.path!.segments.flatMap(segment => [segment.from.x, segment.to.x]);
      expect(Math.max(...xsOf) - Math.min(...xsOf), link.id).toBeLessThan(1e-6);
    }
    expect(model.diagnostics.map(item => item.code)).not.toContain('BUNDLE_BLOCK_UNSETTLED');
  }, 120000);

  it('the seat is at its fixed point on the draft the solve leaves: a further seat moves no x', async () => {
    const { drafts } = await run(SOURCE);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      const again = JSON.parse(JSON.stringify(draft)) as LayoutModel;
      prepareBundleGeometry(again);
      expect(xs(again)).toBe(xs(draft));
    }
  }, 120000);

  it.each([0, 1, 2, 3, 4, 5])('publishes with n5 in slot %i of its row', async slot => {
    const yaml = inSlot(slot);
    expect(yaml.split('\n').filter(line => /^ {2}n[0-5]: /.test(line)).findIndex(line => line.startsWith('  n5:'))).toBe(slot);
    const model = await layout(parse(yaml), options);
    expect(model.links.every(link => link.path !== undefined)).toBe(true);
  }, 120000);
});
