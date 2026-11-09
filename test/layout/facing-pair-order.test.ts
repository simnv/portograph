import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { findPort } from '../../src/layout/row-paths.js';
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
 * Decision review ticket 17: two routed links between one node pair whose ends leave facing faces (the router's bottom face and the switch's top face, one
 * link written each way) are ordered once, from both ends (`facingPairKeys`). Before, each face sorted by the other face's draft slots; the stage-4 draft
 * crosses the pair, so both faces flipped and disagreed in every input order. Held: the two faces order the pair alike as written, with `links` reversed and
 * with `nodes` reversed, and with `nodes` reversed every gate passes. Not held: as written, 7a nests the two lanes left of the zone opposite to both faces
 * (the lanes sort by `laneSource` x and each later lane stands farther out), so G5 still fails on the switch face there.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/an-allocated-run-ends-on-the-tip-of-a-lone-port.yaml', import.meta.url), 'utf8');
const inputs = { 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string };

/** The links between `a` and `b` in x order of their ends at `at`. */
const order = (model: LayoutModel, a: string, b: string, at: string): string[] => model.links
  .filter(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join() === [a, b].sort().join())
  .map(link => ({ id: link.id, x: findPort(model, link.attachments!.from.node === at ? link.attachments!.from : link.attachments!.to)!.anchor!.x }))
  .sort((p, q) => p.x - q.x).map(item => item.id);

describe('a facing pair keeps one order at both ends', () => {
  for (const [name, text] of Object.entries(inputs)) {
    it(`stage 5 orders the router and switch faces alike (${name})`, async () => {
      const model = sizeNodes(sidesOne(resolve(parse(text))));
      await skeleton(model, { createAttempt });
      const placed = sidesTwo(model);
      expect(order(placed, 'router', 'mid', 'router')).toHaveLength(2);
      expect(order(placed, 'router', 'mid', 'router')).toEqual(order(placed, 'router', 'mid', 'mid'));
    }, 60000);
  }

  it('passes every gate with nodes reversed', async () => {
    const model = await layout(parse(inputs['nodes reversed']), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const report = score(model).snapshot;
    expect(Object.entries(report.gates).filter(([, gate]) => gate.violations.length).map(([id]) => id)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);
});
