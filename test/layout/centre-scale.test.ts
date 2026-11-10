import { expect, it } from 'vitest';
import { generateScaleYaml } from '../../scripts/scale-input.mjs';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { placed } from './phase-two-fixture.js';

it('keeps a wide tier finite in scale when its feeds cannot fit between siblings', async () => {
  const input = flanks(lanes(rows(await placed(generateScaleYaml({ nodes: 300 }).yaml))));
  const initialSpan = Math.max(...Object.values(input.groups).map(group => group.bounds!.x + group.bounds!.width))
    - Math.min(...Object.values(input.groups).map(group => group.bounds!.x));
  const result = centre(input);
  // Authoritative parent anchors all lie inside the original diagram span. A child row may grow
  // to reach those feeds, but must not amplify that span by repeated widening and sibling pushes.
  for (const group of Object.values(result.groups)) expect(group.bounds!.width).toBeLessThan(2 * initialSpan);
  for (const group of Object.values(result.groups)) {
    const order = group.rowOrder ?? [];
    for (let i = 1; i < order.length; i++) {
      const left = result.nodes[order[i - 1]!]!.bounds!, right = result.nodes[order[i]!]!.bounds!;
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
    }
  }
  expect(result.diagnostics.some(item => item.code === 'CENTRE_ALIGNMENT_INFEASIBLE')).toBe(true);
  expect(restoreLayoutModel(JSON.stringify(result))).toEqual(result);
});
