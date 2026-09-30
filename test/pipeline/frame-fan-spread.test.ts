import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { measureFans } from '../../src/layout/fan-spread.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 89: two nodes each linked to four nodes on the rank below, one frame. Neighbouring
 * chords of a fan stand closer than the chord clearance at the base pitch, so on main only the two outer links
 * take the chord. Placement measures the fan on the placed chords and runs again with the pitch that holds
 * the clearance; all eight links are then one straight segment.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-fan-spreads-its-ports-so-its-chords-hold-clearance.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fan = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.attachments!.from.node.startsWith('core-'));

describe('a fan spreads its ports so its diagonals hold clearance', () => {
  it('takes the frame chord on all eight links and removes none', async () => {
    const model = await run();
    expect(fan(model)).toHaveLength(8);
    for (const link of fan(model)) {
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments, link.id).toHaveLength(1);
    }
    expect(model.removedLinks ?? []).toEqual([]);
  });

  it('spreads the ports of a core face past the base pitch and grows the body around them', async () => {
    const model = await run();
    const core = model.nodes['core-1']!;
    const xs = core.ports.filter(port => port.side === 'bottom').map(port => port.anchor!.x).sort((a, b) => a - b);
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(12 + 1e-6);
    const [first, last] = [xs[0]!, xs[3]!];
    expect(core.bounds!.x).toBeLessThan(first);
    expect(core.bounds!.x + core.bounds!.width).toBeGreaterThan(last);
  });

  it('orders the ports of a face by the x of the far end, so no two chords of a face cross', async () => {
    const model = await run();
    for (const id of ['core-1', 'core-2']) {
      const ports = model.nodes[id]!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.anchor!.x - b.anchor!.x);
      const far = ports.map(port => {
        const link = fan(model).find(item => item.attachments!.from.node === id && item.attachments!.from.ordinal === port.ref.ordinal
          && item.attachments!.from.name === port.ref.name)!;
        return model.nodes[link.attachments!.to.node]!.ports.find(item => item.ref.ordinal === link.attachments!.to.ordinal
          && item.ref.name === link.attachments!.to.name)!.anchor!.x;
      });
      expect(far, id).toEqual([...far].sort((a, b) => a - b));
    }
  });

  it('measures nothing more on the published placement: every fan pair holds the clearance', async () => {
    const model = await run();
    const measured = measureFans(model);
    expect([...measured.floors]).toEqual([]);
    expect(measured.declined).toEqual([]);
  });
});
