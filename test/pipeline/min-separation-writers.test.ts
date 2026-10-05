import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gateFailures } from './open-min-separation.js';

/**
 * Architecture ticket 19. Each sheet published a G9 `min-separation` finding that a required stage wrote. The writers, by stage:
 * - sides-two sweep: a flank, grid or bar stood a band gap from the cells of a frame, not from the frame box (and a frame after a left flank moved a cell, not the frame);
 * - columns pull: the wall a flank makes held a frame a band gap from it less the margin;
 * - sizeNodes (phase two): a bar's width floor (its label, its ports at their pitch, the padding) was left to 7d, which grew the bar into the gap;
 * - 7e bundle block: a node grown to reach a bundle peer was not held off the group beside it;
 * - the linked-group grid: a box widened in a document with no frames (nothing packs the rows after it) stood closer than the band gap to its neighbour.
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
];

it.each(SHEETS)('%s publishes no minimum-separation finding', async name => {
  const yaml = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.links.filter(link => link.removed === true)).toEqual([]);
  expect(gateFailures(score(model).snapshot).filter(item => item.startsWith('G9:min-separation'))).toEqual([]);
}, 120000);
