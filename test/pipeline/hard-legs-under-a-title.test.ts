import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { GROUP_LABEL_GEOMETRY } from '../../src/layout/bands.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 66: a skewed leg under a one-node group title is a hard obstacle where the widening is lane-feasible. */
const run = (name: string): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const legBlocked = (model: LayoutModel): string[] => tierGapPlans(model).flatMap(({ plan }) => plan.residual.filter(item => item.reason === 'leg-blocked').map(item => item.link));
const partResiduals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' && /a leg would pass through a label/.test(item.message)).map(item => item.message);

describe('a skewed leg under a one-node title is a hard obstacle (ticket 66)', () => {
  it('the title stands clear of both legs, the group holds it with the clearances, and no part is leg-blocked', async () => {
    const model = await run('a-one-node-title-over-a-skewed-leg-widens-the-group');
    const group = model.groups.mid!.bounds!, title = model.labels.find(label => label.id === 'label:group:mid')!.bounds!;
    const node = model.nodes.m0!;
    const legs = node.ports.filter(port => port.side === 'top' && port.anchor).map(port => port.anchor!.x);
    expect(legs).toHaveLength(2);
    // The legs are skewed: neither top port stands under a source port.
    const feeds = ['a1', 'a2'].map(id => model.nodes[id]!.ports.find(port => port.side === 'bottom')!.anchor!.x);
    for (const x of legs) expect(feeds.every(feed => Math.abs(x - feed) > 1)).toBe(true);
    for (const x of legs) expect(x < title.x - GROUP_LABEL_LINK_CLEARANCE || x > title.x + title.width + GROUP_LABEL_LINK_CLEARANCE, `leg ${x}`).toBe(true);
    // The group is wider than its node: it holds the title and its insets.
    expect(title.x).toBeGreaterThanOrEqual(group.x + GROUP_LABEL_GEOMETRY.horizontalInset - 1e-6);
    expect(title.x + title.width + GROUP_LABEL_GEOMETRY.horizontalInset).toBeLessThanOrEqual(group.x + group.width + 1e-6);
    expect(group.width).toBeGreaterThan(node.bounds!.width + 2 * GROUP_LABEL_LINK_CLEARANCE);
    expect(legBlocked(model)).toEqual([]);
    expect(partResiduals(model)).toEqual([]);
    const g6 = score(model).snapshot.gates.G6.violations;
    expect(g6.filter(item => JSON.stringify(item).includes('link-'))).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);

  it('a widening no lane allows leaves the leg soft, as ticket 62 left it; the one a lane allows is planned', async () => {
    const model = await run('a-title-no-position-clears-leaves-the-leg-to-the-router');
    // Ticket 62 left links 1, 8 and 11 to the router. The title of tier 1 widens its group (lane-feasible) and link-1 is planned; the titles of
    // tiers 3 and 4 have no lane-feasible widening, so those legs stay soft.
    const left = partResiduals(model).map(message => /^(link-\d+) /.exec(message)?.[1]).sort();
    expect(left).toEqual(['link-11', 'link-8']);
    expect(model.groups.t1!.bounds!.width).toBeGreaterThan(300);
  }, 120000);
});
