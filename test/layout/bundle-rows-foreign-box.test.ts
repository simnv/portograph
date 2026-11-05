import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { edgeMargin } from '../../src/layout/bundle-geometry.js';

/**
 * Architecture-2 ticket 76: the turn rows of a bent bundle were centred between its two stems. That range holds the padding of the
 * lower end's group, so a row could stand under the top of a foreign box that the upper end stands over; the leg went into the box, and
 * the routed channel fallback threw `BUNDLE_CHANNEL_BLOCKED`. The rows now keep clear of every foreign box and one edge margin off every
 * group edge (the boxes gate G6 reads).
 */
const SOURCE = readFileSync(new URL('../../goldens/synthetic/a-bent-bundle-turns-clear-of-a-foreign-box.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };

/** The sheet with n5 in slot `slot` of the g0 row (the node order of the document is the row order). */
function inSlot(source: string, slot: number): string {
  const lines = source.split('\n'), row = lines.filter(line => /^ {2}n[0-5]: /.test(line)), moved = row.find(line => line.startsWith('  n5:'))!;
  const order = row.filter(line => line !== moved);
  order.splice(slot, 0, moved);
  let at = 0;
  return lines.map(line => (/^ {2}n[0-5]: /.test(line) ? order[at++]! : line)).join('\n');
}

const bundled = (model: LayoutModel) => model.links.filter(link => link.bundle !== undefined);

describe('a bent bundle turns clear of a foreign box', () => {
  // On main the slots 1, 2 and 3 threw BUNDLE_CHANNEL_BLOCKED. The bundle's first end is n5, the upper one: g2 stands under the legs
  // from the near end, so it forbids every deeper row.
  for (const slot of [1, 2, 3]) {
    it(`slot ${slot}: publishes, every gate passes, and every turn row stands one edge margin above g2`, async () => {
      const model = await layout(parse(inSlot(SOURCE, slot)), options);
      expect(model.bundles.map(bundle => bundle.nodes[0])).toEqual(['n5']);
      const gates = score(model).snapshot.gates;
      for (const [id, gate] of Object.entries(gates)) if (gate.severity === 'error') expect(gate.violations, id).toEqual([]);
      const g2 = model.groups.g2!.bounds!, n5 = model.nodes.n5!.bounds!;
      // The upper end stands over g2: the case of the report.
      expect(n5.x < g2.x + g2.width && n5.x + n5.width > g2.x).toBe(true);
      const links = bundled(model);
      expect(links).toHaveLength(3);
      for (const link of links) {
        const rows = link.path!.segments.filter(segment => segment.from.y === segment.to.y).map(segment => segment.from.y);
        expect(rows, link.id).toHaveLength(1);
        expect(rows[0]!, link.id).toBeLessThanOrEqual(g2.y - edgeMargin(1.5) + 1e-6);
      }
    }, 120000);
  }

  for (const slot of [0, 4, 5]) {
    it(`slot ${slot}: publishes, every gate passes, and the bundle links stand vertical`, async () => {
      const model = await layout(parse(inSlot(SOURCE, slot)), options);
      for (const [id, gate] of Object.entries(score(model).snapshot.gates)) if (gate.severity === 'error') expect(gate.violations, id).toEqual([]);
      for (const link of bundled(model)) expect(link.path!.segments, link.id).toHaveLength(1);
    }, 120000);
  }
});
