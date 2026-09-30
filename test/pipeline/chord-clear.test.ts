import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { crosses, overlayPath } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/**
 * Ticket 77. A straight overlay chord between two tiers is a reservation for the tiers between them: a node with an overlay link of
 * its own, on a tier between, steps along its tier to the nearest x that clears the chord, and both links stay one straight segment.
 */
describe('a linked node on a middle tier stands off a straight overlay chord (ticket 77)', () => {
  it('the chord from the source to the far target is one straight segment, and the middle node does not cross it', async () => {
    const model = await run(fixture('a-linked-node-steps-out-of-a-straight-chord'));
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const overlays = model.links.filter(link => link.layer === 'overlay');
    expect(overlays).toHaveLength(2);
    const body = model.nodes['mid']!.bounds!;
    for (const link of overlays) {
      // Read on the placed model: the decision placement made is the one the overlay rule re-derives.
      const path = overlayPath(model, link);
      expect(path.segments, link.id).toHaveLength(1);
      expect(link.path!.segments, link.id).toHaveLength(1);
      if (link.attachments!.from.node === 'src') expect(crosses(path.segments[0]!.from, path.segments[0]!.to, body)).toBe(false);
    }
  }, 60000);
});
