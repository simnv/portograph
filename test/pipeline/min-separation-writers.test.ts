import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { separationsBrokenBy } from '../../src/layout/constraints/separation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gateFailures } from './open-min-separation.js';

/**
 * Architecture ticket 19. Each sheet published a G9 `min-separation` finding that a required stage wrote. The writers, by stage:
 * - sides-two sweep: a flank, grid or bar stood a band gap from the cells of a frame, not from the frame box (and a frame after a left flank moved a cell, not the frame);
 * - columns pull: the wall a flank makes held a frame a band gap from it less the margin;
 * - sizeNodes (phase two): a bar's width floor (its label, its ports at their pitch, the padding) was left to 7d, which grew the bar into the gap;
 * - 7e bundle block: a node grown to reach a bundle peer was not held off the group beside it;
 * - 7d bar span: the bar's width follows its ports (the leaves of its drops), which no stage before it had read; centring now clears the groups beside the bar from the
 *   extent 7d will give it (`barReach`), and one rule decides the width (`bar-width.ts`);
 * - the linked-group grid: a box it widened stood closer than the band gap to its neighbour; it is refused when it would, in a sheet with frames too (the pack of the beside rows seats frame cells only).
 */
const SHEETS = [
  'a-grid-group-stands-fixed-beside-frames',
  'a-canton-column-is-not-pulled-into-a-flank',
  'bar-fan',
  'a-bar-end-keeps-its-corridor',
  'a-corridor-moves-after-the-grid-settles',
  'a-canton-next-to-a-flank-keeps-the-flank-gap',
  'a-one-node-title-over-a-skewed-leg-widens-the-group',
  'a-right-flank-beside-a-bundle-into-a-canton',
  'overlay-links-reorder-an-indifferent-tier',
  'two-titles-over-skewed-legs-each-widen-their-group',
  // The review fixtures: a bar whose leaves are far apart (the span the bar reserves where centring first knows it), and a grid widening in a sheet that has a canton.
  'a-bar-spans-leaves-far-apart-and-keeps-its-neighbour-gap',
  'a-grid-widening-in-a-framed-sheet-keeps-the-band-gap',
];

// Open (architecture ticket 19): a bar whose leaves stand left of its own box takes its span to the left and 7d may move no other group, so the group before it stands
// inside the band gap. Placement does not reserve this (nothing moves left); the final G9 finding reports it, naming the group and the bar.
it('a bar that spans left into the gap of the group before it is reported by G9, not reserved', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-bar-spans-left-into-the-gap-of-the-group-before-it.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(gateFailures(score(model).snapshot)).toEqual(['G9:min-separation:group:before,group:bar']);
}, 120000);

it.each(SHEETS)('%s publishes no minimum-separation finding', async name => {
  const yaml = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(gateFailures(score(model).snapshot).filter(item => item.startsWith('G9:min-separation'))).toEqual([]);
}, 120000);

// Ticket 157 re-check. The grid of linked groups widens a box by setting its bounds and leaves the bodies where they stand (`dx: 0`); a move shifts
// them with the box. A frame reaches the bodies of its cells (`cellReach`, 20 px past the outermost body), so `framesAfter` moves the bodies only by
// the shift the stage gives them. On this sheet `top-b-zone#1` is a cell of frame `top-b`, which stands a band gap right of `top-a`: grown 10 px left
// with its bodies in place, the frame keeps its edge (the bodies still reach farther than the box) and the widening is not refused. Moved 10 px with
// its bodies, the frame would stand 10 px closer to `top-a`, and the guard says so.
it('a grid widening that grows a box left is not refused while the frames keep their gap', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-chain-of-tiers-packs-over-its-feeds-final-x.yaml', import.meta.url), 'utf8');
  const model = JSON.parse(JSON.stringify(await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }))) as LayoutModel;
  const group = model.groups['top-b-zone#1']!, box = { ...group.bounds! };
  const bounds = { ...box, x: box.x - 10, width: box.width + 10 };
  expect(separationsBrokenBy(model, [{ group, bounds, dx: 0 }])).toEqual([]);
  expect(separationsBrokenBy(model, [{ group, bounds, dx: -10 }])).toEqual(['separation-root-frames:frame:top-a|frame:top-b']);
  expect(group.bounds).toEqual(box);
}, 120000);
