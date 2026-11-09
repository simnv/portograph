import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { Rect } from '../../src/model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../../src/model/layout.js';
import { laneSidesHold, riserNoDeeper, riserPenetrations, sideLanesHold, spanBreaches } from '../../src/layout/lanes.js';
import { foreignOverExtensions, trunkHeads, trunkXAfter } from '../../src/layout/trunk.js';
import { NO_MOVE_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { readSheet } from '../hand-solves.js';

type Proposed = { group: LayoutGroup; bounds: Rect }[];

/**
 * The oracle: the five guards of `optionalMoveHolds` as they were chained before the move checks became derived reservations (architecture 2, ticket 03), rebuilt from the
 * exported primitives. `holdsMove` must give the verdict of this chain on every move a real layout asks about.
 */
export function legacyOptionalMoveHolds(model: LayoutModel, proposed: Proposed): boolean {
  const riser = proposed.every(({ group, bounds }) => {
    const dx = bounds.x - group.bounds!.x;
    return Math.abs(dx) <= NO_MOVE_EPS || riserNoDeeper(riserPenetrations(model, group), riserPenetrations(model, group, dx));
  });
  const trunk = (): boolean => trunkHeads(model).every(head => {
    const now = new Set(foreignOverExtensions(model, head).map(item => `${item.group}|${item.bus}`));
    return foreignOverExtensions(model, head, proposed, trunkXAfter(model, head, proposed)).every(item => now.has(`${item.group}|${item.bus}`));
  });
  const span = (): boolean => {
    if (!model.lanes.some(lane => lane.kind === 'span')) return true;
    const before = spanBreaches(model);
    for (const key of spanBreaches(model, proposed)) if (!before.has(key)) return false;
    return true;
  };
  return riser && trunk() && laneSidesHold(model, proposed, false) && sideLanesHold(model, proposed, false) && span();
}

const seen: { calls: number; differences: string[] } = { calls: 0, differences: [] };
vi.mock('../../src/layout/move-reservations.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/layout/move-reservations.js')>();
  return { ...real, holdsMove: (model: LayoutModel, proposed: Proposed, report?: boolean, only?: readonly string[]) => {
    const verdict = real.holdsMove(model, proposed, report, only as never);
    if (only === undefined) {
      seen.calls++;
      const old = legacyOptionalMoveHolds(model, proposed);
      if (old !== verdict) seen.differences.push(`guards ${old}, ledger ${verdict}, groups ${proposed.map(item => item.group.id).join(',')}`);
    }
    return verdict;
  } };
});

const SHEETS = [
  'goldens/synthetic/a-mesh-over-three-rows-joins-its-bars-with-one-trunk.yaml',
  'goldens/synthetic/a-corridor-moves-after-the-grid-settles.yaml',
  'goldens/synthetic/a-chord-and-a-lane-share-a-middle-tier.yaml',
  'goldens/synthetic/a-chord-over-three-tier-gaps-passes-two-middle-tiers.yaml',
  'hand-solves/04-mesh-across-a-tier.yaml',
];

describe('holdsMove against the guards it replaced', () => {
  it('gives the verdict of the old chain on every move a layout asks about', async () => {
    for (const sheet of SHEETS) await layout(parse(readSheet(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(seen.calls).toBeGreaterThan(0);
    expect(seen.differences).toEqual([]);
  }, 300000);
});
