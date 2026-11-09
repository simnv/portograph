import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { lanes } from '../../src/layout/lanes.js';
import { facingPairs } from '../../src/layout/parallel-sets.js';
import { findPort } from '../../src/layout/row-paths.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { resolve } from '../../src/resolve/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * Decision review ticket 23: 7a nests the transit lanes of a facing pair in the order stage 5 gave both faces (`facingPairs`, `nestFacingPairs`). The
 * router-switch pair of the sheet passes the zone on one margin; each lane 7a reserves stands beside the lanes before it, so on a left margin the source
 * order put the lane of the left port inside the lane of the right port, and the two lanes crossed. Held, in every input order: in each tier the pair's
 * lanes stand in the order of their ports at both ends.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/an-allocated-run-ends-on-the-tip-of-a-lone-port.yaml', import.meta.url), 'utf8');
const inputs = { 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string };

/** The pair's link ids in x order of their ends at `node`, and in x order of their lanes in each tier they cross. */
function orders(model: LayoutModel, node: string): { ports: string[]; lanes: string[][] } {
  const pair = facingPairs(model, ref => findPort(model, ref)?.side).find(item => item.links.some(link => [link.attachments!.from.node, link.attachments!.to.node].includes(node)))!;
  const at = (id: string): number => {
    const ends = pair.links.find(link => link.id === id)!.attachments!;
    return findPort(model, ends.from.node === node ? ends.from : ends.to)!.anchor!.x;
  };
  const ids = pair.links.map(link => link.id);
  const owned = model.lanes.flatMap(lane => lane.owner.kind === 'link' && ids.includes(lane.owner.id) ? [{ id: lane.owner.id, tier: lane.tier, x: lane.x }] : []);
  const tiers = [...new Set(owned.map(lane => lane.tier))].sort((a, b) => a - b);
  return {
    ports: [...ids].sort((a, b) => at(a) - at(b)),
    lanes: tiers.map(tier => owned.filter(lane => lane.tier === tier).sort((a, b) => a.x - b.x).map(lane => lane.id)),
  };
}

describe('7a nests the lanes of a facing pair in the face order', () => {
  for (const [name, text] of Object.entries(inputs)) {
    it(`the router-switch lanes keep the order of both faces (${name})`, async () => {
      const model = sizeNodes(sidesOne(resolve(parse(text))));
      await skeleton(model, { createAttempt });
      const placed = lanes(rows(sidesTwo(model)));
      const mid = orders(placed, 'mid'), router = orders(placed, 'router');
      expect(mid.ports).toHaveLength(2);
      expect(router.ports).toEqual(mid.ports);
      expect(mid.lanes.length).toBeGreaterThan(0);
      for (const tier of mid.lanes) expect(tier).toEqual(mid.ports);
    }, 60000);
  }
});
