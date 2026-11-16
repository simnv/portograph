import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 27: the groups of one row that the packing pushes together and are fed by the same parents stand as one unit
 * (`rowSeats` in centre.ts, pool adjacent violators on the weighted median of the x each group's own feeds want). Before, 7c centred each group alone in group
 * order and packed it after the one before: the first site stood under the hubs and grew to reach both, the other four stacked to its right.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-row-fed-by-two-hubs-stands-centred-under-them.yaml', import.meta.url), 'utf8');
const run = (source: string): Promise<LayoutModel> => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const SITES = ['site-1', 'site-2', 'site-3', 'site-4', 'site-5'];

/** The x span of the site row, and the mean x of the hub ports its links leave. */
function row(model: LayoutModel): { low: number; high: number; hubs: number; gaps: number[]; widths: number[] } {
  const boxes = SITES.map(id => model.groups[id]!.bounds!).sort((a, b) => a.x - b.x);
  const hubPorts = ['core-a', 'core-b'].flatMap(id => model.nodes[id]!.ports.filter(port => port.side === 'bottom').map(port => port.anchor!.x));
  return {
    low: boxes[0]!.x, high: boxes[boxes.length - 1]!.x + boxes[boxes.length - 1]!.width,
    hubs: hubPorts.reduce((sum, x) => sum + x, 0) / hubPorts.length,
    gaps: boxes.slice(1).map((box, i) => box.x - (boxes[i]!.x + boxes[i]!.width)),
    widths: boxes.map(box => box.width),
  };
}

describe('a row the packing pushes together stands centred as one unit (dense-16x9 ticket 27)', () => {
  it('stands the five sites centred under the two hubs, packed at the band gap, none grown', async () => {
    const model = await run(yaml);
    const { low, high, hubs, gaps, widths } = row(model);
    // One unit: the sites stand packed at the band gap, and the unit's centre is the mean of the hub ports (every site wants that x).
    for (const gap of gaps) expect(gap).toBeCloseTo(bandGap(model), 3);
    expect(Math.abs((low + high) / 2 - hubs)).toBeLessThan(2);
    // No member of the unit grows toward its own feeds: a growth would only push the others off (the first site grew to 425 px before).
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.5);
    const gates = score(model).snapshot.gates;
    expect(Object.entries(gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length > 0).map(([id]) => id)).toEqual([]);
  }, 60000);

  it('seats the row the same way when the links or the nodes are listed in reverse (R3)', async () => {
    const seat = (model: LayoutModel): number[] => SITES.map(id => model.groups[id]!.bounds!.x);
    const base = seat(await run(yaml));
    expect(seat(await run(reversed(yaml, 'links')))).toEqual(base);
    expect(seat(await run(reversed(yaml, 'nodes')))).toEqual(base);
  }, 120000);
});
