import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { routeObstacles } from '../../src/route/obstacles.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a link leaves its own group through a door (architecture ticket 13)', () => {
  it.each(['a-link-leaves-its-group-through-a-door', 'a-claimed-run-clears-a-shared-run'])('%s: no gate fails and every link is routed', async name => {
    const model = await run(fixture(name));
    for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
  }, 60000);

  it('walls the own group for a link whose shared run ends inside it, except at the doors', async () => {
    const model = structuredClone(await run(fixture('a-link-leaves-its-group-through-a-door')));
    // The state stage 8 starts from: no routed paths, the shared runs kept.
    for (const link of model.links) delete link.path;
    const walls = routeObstacles(model).filter(item => item.id.startsWith('exit-wall:'));
    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) expect(wall.consumers).not.toContain(wall.id.split(':')[1]);
  }, 60000);
});
