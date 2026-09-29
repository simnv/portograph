import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

describe('a leaf child span stands at the bottom of its parent (ranked-groups ticket 19)', () => {
  it('the zone frame holds the location\'s last ranks, and both flow links are straight', async () => {
    const model = await layout(parse(fixture('a-leaf-zone-stands-at-the-bottom-of-its-location')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frames = model.frames!;
    const loc = frames.find(frame => frame.id === 'loc')!, zone = frames.find(frame => frame.id === 'zone')!;
    expect(zone.parent).toBe('loc');
    // The location has seven ranks: five own (0-4) and the two of the zone (5, 6).
    const tiers = (ids: string[]) => ids.map(id => model.groups[id]!.tier!);
    expect(zone.cells).toEqual(['zone#5', 'zone#6']);
    expect(loc.cells).toEqual(['loc#0', 'loc#1', 'loc#2', 'loc#3', 'loc#4']);
    expect(Math.min(...tiers(zone.cells))).toBeGreaterThan(Math.max(...tiers(loc.cells)));
    // The zone's ntp stands below srv, the location's own last rank.
    expect(model.nodes['ntp']!.bounds!.y).toBeGreaterThan(model.nodes['srv']!.bounds!.y);
    const flows = model.links.filter(link => link.layer === 'overlay');
    expect(flows).toHaveLength(2);
    for (const link of flows) expect(link.path!.segments).toHaveLength(1);
  }, 60000);
});
