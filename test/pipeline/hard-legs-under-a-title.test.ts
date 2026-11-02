import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { GROUP_LABEL_GEOMETRY } from '../../src/layout/bands.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 66 widened a one-node group for a skewed leg under its title; architecture-2 ticket 54 replaced it: a title yields to the legs under
 * it (it slides to a free span, or takes the halo and records them), no group widens for it, and no leg is left to the router for it.
 */
const run = (name: string): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const legBlocked = (model: LayoutModel): string[] => tierGapPlans(model).flatMap(({ plan }) => plan.residual.filter(item => item.reason === 'leg-blocked').map(item => item.link));

describe('a skewed leg under a one-node title (ticket 66, as ticket 54 changed it)', () => {
  it('the title yields to both legs, and no part is leg-blocked', async () => {
    const model = await run('a-one-node-title-over-a-skewed-leg-widens-the-group');
    const group = model.groups.mid!.bounds!, label = model.labels.find(item => item.id === 'label:group:mid')!, title = label.bounds!;
    const legs = model.nodes.m0!.ports.filter(port => port.side === 'top' && port.anchor).map(port => port.anchor!.x);
    expect(legs).toHaveLength(2);
    // A leg under the title is recorded; a leg clear of it is not.
    const under = model.links.filter(link => link.attachments!.to.node === 'm0' || link.attachments!.from.node === 'm0').filter(link => {
      const ref = link.attachments!.to.node === 'm0' ? link.attachments!.to : link.attachments!.from;
      const port = model.nodes.m0!.ports.find(item => item.ref.name === ref.name && item.ref.ordinal === ref.ordinal)!, x = port.anchor!.x;
      return port.side === 'top' && x >= title.x - GROUP_LABEL_LINK_CLEARANCE - 1 && x <= title.x + title.width + GROUP_LABEL_LINK_CLEARANCE + 1;
    }).map(link => link.id).sort();
    expect(label.crossedBy).toEqual(under);
    expect(title.x).toBeGreaterThanOrEqual(group.x + GROUP_LABEL_GEOMETRY.horizontalInset - 1e-6);
    expect(title.x + title.width + GROUP_LABEL_GEOMETRY.horizontalInset).toBeLessThanOrEqual(group.x + group.width + 1e-6);
    expect(legBlocked(model)).toEqual([]);
    expect(score(model).snapshot.gates.G3.violations).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);

  it('leaves no leg to the router on the fixture whose titles no position clears', async () => {
    const model = await run('a-title-no-position-clears-leaves-the-leg-to-the-router');
    expect(legBlocked(model)).toEqual([]);
    for (const id of ['t1', 't3', 't4']) expect(model.labels.find(item => item.id === `label:group:${id}`)!.yield, id).toBe('halo');
  }, 120000);
});
