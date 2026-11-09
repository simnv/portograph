import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { laneSidesHold, laneWallsBeside, rightWallReach } from '../../src/layout/lanes.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket DR-04 review: the centre rule's tail (7c) reserves the right edge `rightWallReach` gives, and the move guard `laneSidesHold` refuses a box
// past it. Both read one wall set (`laneWallsBeside`, an aligned perimeter lane of another tier included) and the occupied reach toward each lane.
// The sheet has an aligned perimeter lane whose span walls groups of another tier than the lane's own.
const sheet = 'a-link-past-a-canton-runs-in-the-margin';

it('the tail reach at a wall of another tier is the edge the move guard allows, and 1 px more is refused', async () => {
  const model: LayoutModel = await layout(parse(readFileSync(new URL(`../../goldens/synthetic/${sheet}.yaml`, import.meta.url), 'utf8')),
    { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const walled = Object.values(model.groups).filter(group => group.bounds && laneWallsBeside(model, group)
    .some(lane => lane.kind === 'perimeter' && lane.tier !== group.tier && lane.x > group.bounds!.x));
  expect(walled.length).toBeGreaterThan(0);
  for (const group of walled) {
    const reach = rightWallReach(model, group), box = group.bounds!;
    expect(Number.isFinite(reach)).toBe(true);
    const at = (edge: number) => [{ group, bounds: { ...box, x: edge - box.width } }];
    expect(laneSidesHold(model, at(reach), false, false), `${group.id} at its reach`).toBe(true);
    expect(laneSidesHold(model, at(reach + 1), false, false), `${group.id} 1 px past its reach`).toBe(false);
  }
}, 120000);
