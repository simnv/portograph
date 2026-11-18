import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../../src/theme/geometry.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 52: a tier-gap row keeps the group-edge margin from every frame box, as G6 reads it (`groupBoxes`). The frame `east`
 * holds the child frame `eastc` in its last sub-tier, so its box reaches the group padding below that band, into the gap above `low`. The
 * gap plan read the frame box of a canton only, and seated the turn row of `eastg` > `l1` 5.75 px below the edge of `east` (G6
 * segment-group-edge). The far-end decision of l0 is ticket 49's, and the G9 of its `nodes` order is ticket 48's: neither is asserted here.
 */
const yaml = readFileSync(new URL('../fixtures/staged/a-tier-gap-row-keeps-the-margin-of-a-frame-edge.yaml', import.meta.url), 'utf8');
const orders = { 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string };
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a tier-gap row keeps the margin of a frame edge (dense-16x9 ticket 52)', () => {
  for (const [name, text] of Object.entries(orders)) {
    it(`no routed segment runs along a group edge (${name})`, async () => {
      const model = await run(text);
      expect(model.document.layout?.moveBeforeGrow).toBe(true);
      expect(score(model).snapshot.gates.G6.violations).toEqual([]);
      expect(model.removedLinks ?? []).toEqual([]);
    }, 120000);
  }

  it('seats the turn row of eastg > l1 the margin below the frame east, past its child frame', async () => {
    const model = await run(yaml);
    const frame = model.frames!.find(item => item.id === 'east')!, child = model.frames!.find(item => item.id === 'eastc')!;
    const edge = frame.box.y + frame.box.height;
    // The frame reaches below its child frame: the box the gate reads is not a cell box.
    expect(edge).toBeGreaterThan(child.box.y + child.box.height);
    const link = model.links.find(item => item.attachments!.from.node === 'eastg' && item.attachments!.to.node === 'l1')!;
    const rows = link.path!.segments.filter(segment => Math.abs(segment.from.y - segment.to.y) < 1e-6 && segment.from.y > edge);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from.y - edge).toBeGreaterThanOrEqual(GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2 - 1e-6);
  }, 120000);
});
