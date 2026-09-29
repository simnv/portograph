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
/** The jog of a routed link between its two ports, read from the ends of its path. */
const linkJog = (model: LayoutModel, id: string): number => {
  const segments = model.links.find(link => link.id === id)!.path!.segments;
  return Math.abs(segments[0]!.from.x - segments.at(-1)!.to.x);
};
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

  it('frames that hold overlay ends are pulled back under their feeds all the same', async () => {
    // The feeds are `link-1` and `link-2`. A sync between the two locations (same tier, face to face) and an overlay
    // link parallel to each feed do not pin a frame: the overlay target agrees with the feed target, and a
    // same-tier partner cannot be bent by a move in x. Each is measured alone and all three together.
    const overlay = readFileSync(new URL('../../goldens/synthetic/overlay-ends-keep-the-feed-axis.yaml', import.meta.url), 'utf8');
    const links = overlay.trimEnd().split('\n');
    const [sync, ...parallel] = links.slice(-3);
    const stem = links.slice(0, -3).join('\n');
    for (const source of [overlay, `${stem}\n${sync}\n`, `${stem}\n${parallel.join('\n')}\n`]) {
      const model = await run(source);
      expect(linkJog(model, 'link-1') + linkJog(model, 'link-2')).toBeLessThanOrEqual(1);
      expect(owners(model, COLUMN_AXIS_HELD)).toEqual([]);
    }
  }, 180000);

  it('a frame stays put, and says why, when no move meets its feed and an overlay partner that stays', async () => {
    // `west-1` is in the anchor tier, so `placeOverlayFree` never moves it, and it is 8 nodes from the feed `west-9`
    // of `two`: no slide of the cells reaches both, so `two` keeps the place the overlay order gave it.
    const links = readFileSync(new URL('../../goldens/synthetic/overlay-ends-keep-the-feed-axis.yaml', import.meta.url), 'utf8').trimEnd().split('\n');
    const stem = links.slice(0, -3).join('\n');
    const model = await run(`${stem}\n  - [west-1, two-s5, { route: overlay }]\n`);
    const held = model.diagnostics.filter(diagnostic => diagnostic.code === COLUMN_AXIS_HELD && diagnostic.owners?.some(owner => 'id' in owner && owner.id === 'two'));
    expect(held).toHaveLength(1);
    expect(held[0]!.message).toContain('overlay link');
    expect(held[0]!.message).not.toContain('siblings');
  }, 180000);

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
