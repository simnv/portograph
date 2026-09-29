import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 62: a title band nudges along its edge to clear the legs of the ports under it, before the row plan reads the labels. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

function legsOf(model: LayoutModel, ports: 'top' | 'bottom', nodes: string[]): number[] {
  return nodes.flatMap(id => model.nodes[id]!.ports.filter(port => port.side === ports && port.anchor).map(port => port.anchor!.x));
}
const residuals = (model: LayoutModel): string[] => tierGapPlans(model).flatMap(({ plan }) => plan.residual.map(item => `${item.link}:${item.reason}`));
const partResiduals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' && /a leg would pass through a label/.test(item.message)).map(item => item.message);

describe('a title over a port\'s leg is nudged aside (ticket 62)', () => {
  it('the canton title clears the legs of the member routers, and no part is leg-blocked', async () => {
    const model = await run('a-title-over-a-ports-leg-is-nudged-aside');
    const title = model.labels.find(label => label.id === 'label:group:west')!.bounds!;
    const legs = legsOf(model, 'bottom', ['r0', 'r1', 'r2']);
    expect(legs.length).toBeGreaterThan(0);
    for (const x of legs) expect(x < title.x - GROUP_LABEL_LINK_CLEARANCE || x > title.x + title.width + GROUP_LABEL_LINK_CLEARANCE, `leg ${x}`).toBe(true);
    expect(residuals(model).filter(item => item.endsWith(':leg-blocked'))).toEqual([]);
    expect(partResiduals(model)).toEqual([]);
  }, 120000);

  it('a canton title is not moved by the ports of a member above its last sub-tier (review B1)', async () => {
    // Values measured with the nudge off (main 0c4f699): a bottom port of a first-tier member whose link ends in a second-tier member is no leg
    // through the canton's bottom band.
    const one = await run('a-link-between-two-members-of-a-canton-group');
    const two = await run('overlay-links-reorder-two-members-of-a-canton-group');
    const at = (model: LayoutModel, id: string): number => model.labels.find(label => label.id === `label:group:${id}`)!.bounds!.x;
    expect(at(one, 'west')).toBeCloseTo(144.42626953125, 6);
    expect(at(one, 'lab#0')).toBeCloseTo(148.09423828125, 6);
    expect(at(two, 'west')).toBeCloseTo(243.45263671875, 6);
    // `lab#0` stood at 240.366 before ticket 66; its leg (a real one, not the phantom of B1) is a hard obstacle since, the group widens and the title stands 4.29 px further right.
    expect(at(two, 'lab#0')).toBeCloseTo(244.65380959375, 6);
  }, 120000);
});
