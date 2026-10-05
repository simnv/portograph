import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { separationShortfalls } from '../../src/layout/constraints/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { sweepTiers } from '../../src/layout/sides-two.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { placed } from '../layout/phase-two-fixture.js';

/**
 * Architecture ticket 19 review. A canton that spans two tiers is moved whole by the band that holds a fixed group beside one of its cells. The cells of
 * the other tier move with it, into the gap of the group beside them there, and a band swept once never sees it again. The sweep runs until no group moves.
 * The sheet gives the shape (tier 0: a member of the canton and a row group; tier 1: a grid group and the other member); the test stands the groups where
 * the sweep meets them (the grid left of the member in tier 1, the row group exactly a band gap from the member in tier 0), because the order inside a tier is ELK's.
 */
it('a frame that spans two tiers is seated against both after one band moves it', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-frame-over-two-tiers-is-seated-against-both.yaml', import.meta.url), 'utf8');
  const model = structuredClone(await placed(yaml)) as LayoutModel;
  const group = (id: string) => model.groups[id]!;
  // Tier 1: the grid group stands where the canton's member stands, so the member must move right of it. Tier 0: the row group stands a band gap and the
  // slack right of the frame box, which the move would otherwise close.
  moveGroup(model, group('spares'), group('lower-member#0').bounds!.x - group('spares').bounds!.x, 0);
  moveGroup(model, group('upper-row'), deriveFrames(model)!.map(frame => frame.box.x + frame.box.width).reduce((a, b) => Math.max(a, b)) + 60 + COLUMN_SLACK - group('upper-row').bounds!.x, 0);
  sweepTiers(model);
  const short = [...separationShortfalls(model)].filter(([, item]) => item.owners.every(owner => owner.startsWith('group:')));
  expect(short, 'group separations broken after the sweep').toEqual([]);
  // The frame stands clear of the grid group in tier 1, and by the same move of the row group in tier 0.
  const box = deriveFrames(model)!.find(frame => frame.id === 'town')!.box, row = group('upper-row').bounds!, spares = group('spares').bounds!;
  expect(box.x, 'the frame box clears the grid group by a band gap and the slack').toBeGreaterThanOrEqual(spares.x + spares.width + 60 + COLUMN_SLACK - 1e-6);
  expect(Math.max(row.x - (box.x + box.width), box.x - (row.x + row.width)), 'the row group stands a band gap and the slack from the frame box, on whichever side').toBeGreaterThanOrEqual(60 + COLUMN_SLACK - 1e-6);
});
