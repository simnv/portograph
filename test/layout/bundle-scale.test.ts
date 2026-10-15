import { expect, it } from 'vitest';
import { generateScaleYaml } from '../../scripts/scale-input.mjs';
import { bands, bars, bundles, centre, flanks, lanes, restoreLayoutModel, rows } from '../../src/internal.js';
import { bundleCrossings } from '../../src/layout/bundle-paths.js';
import { members } from '../../src/layout/bundle-geometry.js';
import { placed } from './phase-two-fixture.js';

it.each([40, 100])('routes mixed-class parallel bundles inside the %i-node fan without bend contact', async nodes => {
  const before = bars(centre(flanks(lanes(rows(await placed(generateScaleYaml({ nodes, multiplicity: 3 }).yaml))))));
  const result = bands(bundles(before));
  expect(result.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width, lane.side]))
    .toEqual(before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width, lane.side]));
  expect(result.bundles.length).toBeGreaterThan(0);
  for (const bundle of result.bundles) {
    expect(bundle.members.every(id => result.links.find(link => link.id === id)!.path?.fixed)).toBe(true);
    expect(bundleCrossings(members(result, bundle))).toBe(bundle.inversions);
  }
  expect(restoreLayoutModel(JSON.stringify(result))).toEqual(result);
}, 30000);
