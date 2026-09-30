import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// The side round is off: this file checks the packing over the final x of the feeds. With the round on, a side lane (ticket 119: link-8 goes from 2 bends to 1, the
// other fixture from 4 to 1) widens the sheet and the frames stand 22 px off the centre, over COLUMN_SLACK; that is a gain of the round, not a fault of the packing.
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 0 });
const centre = (box: { x: number; width: number }): number => box.x + box.width / 2;
const frame = (model: LayoutModel, id: string) => model.frames!.find(item => item.id === id)!;

describe('a tier above packs over the final x of its feeds', () => {
  it('two locations above a one-rank group stand over the x centring gave it, not the x it had when packed', async () => {
    const model = await run('a-tier-above-packs-over-its-feeds-final-x');
    const core = centre(model.groups.core!.bounds!);
    const tops = (centre(frame(model, 'top-a').box) + centre(frame(model, 'top-b').box)) / 2;
    // Centring moves `core` some 1 700 px from where the columns were packed. The packing reads the feed
    // of a tier only after that feed is packed toward its own feeds, so the two frames follow it.
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(COLUMN_SLACK);
  }, 60000);

  it('the same holds when a second one-rank tier stands between the anchor tier and the group', async () => {
    const model = await run('a-chain-of-tiers-packs-over-its-feeds-final-x');
    const core = centre(model.groups.core!.bounds!);
    const tops = (centre(frame(model, 'top-a').box) + centre(frame(model, 'top-b').box)) / 2;
    // `dist` has no frames beside it, so it must still be packed toward its own feeds before `core` reads its ports.
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(COLUMN_SLACK);
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
