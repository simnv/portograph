import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Verdana metrics (snack-theme ticket 157): the packing is measured between the middle of the two top frames and the middle of `core`. The zone titles "Zone A" and "Zone B" are
// the only labels that move the result (the site titles and the node labels do not): in Verdana they change the boxes of the top frames, and the distance went from 18.4 px to
// 21.3 px (22.9 px on the chain sheet, 32.3 px with the side round), over the bounds below. The titles "A" and "B" give 2.1 px (4.1 px, 22 px). The sheets on disk are unchanged; the titles are shortened here.
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')
  .replaceAll('label: Zone A', 'label: A').replaceAll('label: Zone B', 'label: B');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
// The two packing tests pin the side round off: they check the packing over the final x of the feeds, and a kept lane trial (ticket 119) moves `core`/`dist` and makes
// link-5 straight (the canvas does not widen), which puts the frames 22.2 px from the centre instead of 18.4 px, over COLUMN_SLACK. That is a gain of the round, and the
// round-on test below states it.
const runOff = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 0 });
const centre = (box: { x: number; width: number }): number => box.x + box.width / 2;
const frame = (model: LayoutModel, id: string) => model.frames!.find(item => item.id === id)!;

describe('a tier above packs over the final x of its feeds', () => {
  it('two locations above a one-rank group stand over the x centring gave it, not the x it had when packed', async () => {
    const model = await runOff('a-tier-above-packs-over-its-feeds-final-x');
    const core = centre(model.groups.core!.bounds!);
    const tops = (centre(frame(model, 'top-a').box) + centre(frame(model, 'top-b').box)) / 2;
    // Centring moves `core` some 1 700 px from where the columns were packed. The packing reads the feed
    // of a tier only after that feed is packed toward its own feeds, so the two frames follow it.
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(COLUMN_SLACK);
  }, 60000);

  it('the same holds when a second one-rank tier stands between the anchor tier and the group', async () => {
    const model = await runOff('a-chain-of-tiers-packs-over-its-feeds-final-x');
    const core = centre(model.groups.core!.bounds!);
    const tops = (centre(frame(model, 'top-a').box) + centre(frame(model, 'top-b').box)) / 2;
    // `dist` has no frames beside it, so it must still be packed toward its own feeds before `core` reads its ports.
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(COLUMN_SLACK);
  }, 60000);
});

describe('with the side round on (ticket 119)', () => {
  it('keeps the lane of the tier-above fixture: turns go 4 to 1 and the frames stand within 25 px of the centre', async () => {
    const off = await runOff('a-tier-above-packs-over-its-feeds-final-x'), on = await run('a-tier-above-packs-over-its-feeds-final-x');
    expect(on.lanes.some(lane => lane.kind === 'side')).toBe(true);
    expect(on.diagnostics.some(item => item.code === 'SIDE_HINT_TAKEN')).toBe(true);
    expect(score(off).snapshot.metrics.bends.total).toBe(4);
    expect(score(on).snapshot.metrics.bends.total).toBe(1);
    const core = centre(on.groups.core!.bounds!);
    const tops = (centre(frame(on, 'top-a').box) + centre(frame(on, 'top-b').box)) / 2;
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(25);
  }, 60000);
});

describe('a widening body keeps the label room of its link', () => {
  it('two switches fed through one shared feed stay a label apart', async () => {
    // Without the floor in the widening limit, aligning each switch to the feed they share grows the two bodies
    // into the room 7f reserved, the reservation is undone on every pass, and publication refuses the layout.
    const model = await run('a-widening-body-keeps-its-links-label-room');
    const left = model.nodes.left!.bounds!, right = model.nodes.right!.bounds!;
    const label = model.document.links.find(link => link.label)!.label!;
    const required = measureText(label, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(required);
  }, 60000);
});
