import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { COLUMN_AXIS_HELD, holdColumnAxes } from '../../src/layout/columns.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Feeds four nodes apart (`west-5`, `west-9`): the two frames can both stand under their feed. */
const reachable = readFileSync(new URL('../../goldens/synthetic/two-locations-keep-their-feed-axis.yaml', import.meta.url), 'utf8');
/** The same input with the feeds two nodes apart (`west-6`, `west-8`): the frames cannot both stand under theirs. */
const forcedInput = reachable.replace('[west-5, one-gw]', '[west-6, one-gw]').replace('[west-9, two-gw]', '[west-8, two-gw]');
const run = (source: string): Promise<LayoutModel> => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const portX = (model: LayoutModel, node: string, side: 'top' | 'bottom'): number => model.nodes[node]!.ports.find(port => port.side === side)!.anchor!.x;
const jog = (model: LayoutModel, from: string, to: string): number => Math.abs(portX(model, from, 'bottom') - portX(model, to, 'top'));
const owners = (model: LayoutModel, code: string): string[] => model.diagnostics.filter(diagnostic => diagnostic.code === code).flatMap(diagnostic => (diagnostic.owners ?? []).flatMap(owner => 'id' in owner ? [owner.id] : []));

/**
 * The least the two feed links can jog together: the gateways stand as close as the frames allow, the two
 * frames a band gap apart, each gateway at the wall of its own frame that faces the other, one frame margin
 * inside it. What is left of that against the spacing of the two feeds is the forced jog, never below 0.
 */
function forcedJog(model: LayoutModel, feeds: readonly [string, string]): number {
  const margin = (id: string): number => Math.min(...Object.entries(model.nodes).filter(([name]) => name.startsWith(`${id}-`)).map(([, node]) => node.bounds!.x)) - model.frames!.find(frame => frame.id === id)!.box.x;
  const reach = (id: string): number => model.nodes[`${id}-gw`]!.bounds!.width / 2 + margin(id);
  const spacing = portX(model, feeds[1], 'bottom') - portX(model, feeds[0], 'bottom');
  return Math.max(0, reach('one') + reach('two') + bandGap(model) - spacing);
}

describe('columns hold their feed axis after rows and centre', () => {
  it('two locations under two feeds that both reach stay straight', async () => {
    const model = await run(reachable);
    expect(forcedJog(model, ['west-5', 'west-9'])).toBe(0);
    expect(jog(model, 'west-5', 'one-gw') + jog(model, 'west-9', 'two-gw')).toBeLessThanOrEqual(1);
    // The fans of the gateways cannot align every switch, so centring reports the switch rows (`one#1`, `two#1`)
    // as unresolved on every layout of this input. The gateway cells (`#0`) carry the feeds: none may be left.
    expect(owners(model, 'PLACEMENT_NON_CONVERGENCE').filter(id => id.endsWith('#0'))).toEqual([]);
    expect(owners(model, COLUMN_AXIS_HELD)).toEqual([]);
  }, 60000);

  it('two locations under two feeds too close for both keep the least jog and say so once each', async () => {
    const model = await run(forcedInput);
    const forced = forcedJog(model, ['west-6', 'west-8']);
    expect(forced).toBeGreaterThan(0);
    const jogs = jog(model, 'west-6', 'one-gw') + jog(model, 'west-8', 'two-gw');
    expect(jogs).toBeLessThanOrEqual(forced + 1);
    const held = model.diagnostics.filter(diagnostic => diagnostic.code === COLUMN_AXIS_HELD);
    expect(owners(model, COLUMN_AXIS_HELD).sort()).toEqual(['one', 'two']);
    for (const diagnostic of held) expect(diagnostic.message).toMatch(/jog of \d+\.\d px/);
  }, 60000);

  it('is idempotent: once the pass has run on a layout, a second run moves nothing', async () => {
    for (const source of [reachable, forcedInput]) {
      const model = structuredClone(await run(source));
      holdColumnAxes(model);
      const before = JSON.stringify(Object.values(model.groups).map(group => group.bounds));
      expect(holdColumnAxes(model)).toBe(false);
      expect(JSON.stringify(Object.values(model.groups).map(group => group.bounds))).toBe(before);
    }
  }, 60000);
});
