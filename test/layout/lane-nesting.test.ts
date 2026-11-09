import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { lanes, nestFacingPairs } from '../../src/layout/lanes.js';
import { facingPairs } from '../../src/layout/parallel-sets.js';
import { findPort } from '../../src/layout/row-paths.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { resolve } from '../../src/resolve/index.js';
import { score } from '../../src/score/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * Decision review ticket 23: 7a nests the transit lanes of a facing pair in the order stage 5 gave both faces (`facingPairs`, `nestFacingPairs`). The
 * router-switch pair of the sheet passes the zone on one margin; each lane 7a reserves stands beside the lanes before it, so on a left margin the source
 * order put the lane of the left port inside the lane of the right port, and the two lanes crossed. Held, in every input order: in each tier the pair's
 * lanes stand in the order of their ports at both ends. The same on a dedicated sheet whose held node is decided on a tie of tiers. A pair whose lanes
 * would take two sides keeps the source order.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const orders3 = (yaml: string): Record<string, string> => ({ 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string });
const inputs = orders3(fixture('an-allocated-run-ends-on-the-tip-of-a-lone-port'));
/** The dedicated sheet: `u` in tier 0, `v` in tier 2, the anchor tier between, the two links written both ways (`v` is held on a tie). */
const pairInputs = orders3(fixture('a-facing-pair-nests-its-lanes-in-the-face-order'));

/** The model 7a receives. */
async function beforeLanes(text: string): Promise<LayoutModel> {
  const model = sizeNodes(sidesOne(resolve(parse(text))));
  await skeleton(model, { createAttempt });
  return rows(sidesTwo(model));
}

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
      const placed = lanes(await beforeLanes(text));
      const mid = orders(placed, 'mid'), router = orders(placed, 'router');
      expect(mid.ports).toHaveLength(2);
      expect(router.ports).toEqual(mid.ports);
      expect(mid.lanes.length).toBeGreaterThan(0);
      for (const tier of mid.lanes) expect(tier).toEqual(mid.ports);
    }, 60000);
  }

  for (const [name, text] of Object.entries(pairInputs)) {
    it(`a pair held on a tier tie nests its lanes and passes every gate (${name})`, async () => {
      const placed = lanes(await beforeLanes(text));
      const v = orders(placed, 'v'), u = orders(placed, 'u');
      expect(v.ports).toHaveLength(2);
      expect(u.ports).toEqual(v.ports);
      expect(v.lanes.length).toBeGreaterThan(0);
      for (const tier of v.lanes) expect(tier).toEqual(v.ports);
      const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.violations.length).map(([id]) => id)).toEqual([]);
      expect(model.removedLinks ?? []).toEqual([]);
    }, 120000);
  }

  it('fills the slots of a pair inner lane first on one side, and keeps the source order where its lanes take two sides', async () => {
    const model = await beforeLanes(pairInputs['as written']!);
    const pair = facingPairs(model, ref => findPort(model, ref)?.side)[0]!;
    const heldX = (id: string): number => {
      const ends = pair.links.find(link => link.id === id)!.attachments!;
      return findPort(model, ends.from.node === pair.held ? ends.from : ends.to)!.anchor!.x;
    };
    // The source order: the smaller x at the held node first.
    const sorted = [...pair.links].sort((a, b) => heldX(a.id) - heldX(b.id));
    const ids = (list: readonly { id: string }[]): string[] => list.map(link => link.id);
    const box = model.groups['middle']!.bounds!, farLeft = box.x - 1000, farRight = box.x + box.width + 1000;
    // Both targets ask for the left side: the larger x at the held node takes the inner lane, so it is reserved first.
    expect(ids(nestFacingPairs(model, sorted, () => farLeft))).toEqual(ids([...sorted].reverse()));
    // Both ask for the right side: the source order already puts the inner lane first.
    expect(ids(nestFacingPairs(model, sorted, () => farRight))).toEqual(ids(sorted));
    // The two lanes would take two sides: the pair keeps the source order (the skip branch).
    expect(ids(nestFacingPairs(model, sorted, link => (link.id === sorted[0]!.id ? farRight : farLeft)))).toEqual(ids(sorted));
    expect(ids(nestFacingPairs(model, sorted, link => (link.id === sorted[0]!.id ? farLeft : farRight)))).toEqual(ids(sorted));
  }, 60000);
});
