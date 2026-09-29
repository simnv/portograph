import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

describe('a leaf child keeps its depth ranks beside the parent members (ranked-groups tickets 19 and 28)', () => {
  it('the zone frame holds ranks 2 and 3 beside the location\'s own cells, and both flow links are straight', async () => {
    const model = await layout(parse(fixture('a-leaf-zone-stands-at-the-bottom-of-its-location')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frames = model.frames!;
    const loc = frames.find(frame => frame.id === 'loc')!, zone = frames.find(frame => frame.id === 'zone')!;
    expect(zone.parent).toBe('loc');
    // Ticket 19 put the zone after the location's last rank (ranks 5 and 6). Ticket 28: a leaf child pushes nothing and
    // keeps its depth ranks, 2 and 3, and the location's own members of those ranks (crt, sw2) stand beside it.
    const tiers = (ids: string[]) => ids.map(id => model.groups[id]!.tier!);
    expect(zone.cells).toEqual(['zone#2', 'zone#3']);
    expect(loc.cells).toEqual(['loc#0', 'loc#1', 'loc#2', 'loc#3', 'loc#4']);
    expect(tiers(zone.cells)).toEqual([model.groups['loc#2']!.tier, model.groups['loc#3']!.tier]);
    // The zone's ntp stands in the row of crt, the location's own member of rank 2.
    expect(model.nodes['ntp']!.bounds!.y).toBeCloseTo(model.nodes['crt']!.bounds!.y, 0);
    const flows = model.links.filter(link => link.layer === 'overlay');
    expect(flows).toHaveLength(2);
    for (const link of flows) expect(link.path!.segments).toHaveLength(1);
  }, 60000);
});
