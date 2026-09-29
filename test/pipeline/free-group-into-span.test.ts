import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { centreDraft, createCentreBudget } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { overlayBlockers, overlayPath } from '../../src/layout/overlay-paths.js';
import { placeOverlayFree } from '../../src/layout/overlay-place.js';
import { rows } from '../../src/layout/rows.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { placed } from '../layout/phase-two-fixture.js';

const yaml = readFileSync(new URL('../../goldens/synthetic/a-free-group-moves-into-the-span-of-its-partners.yaml', import.meta.url), 'utf8');
const centreX = (model: LayoutModel, node: string): number => model.nodes[node]!.bounds!.x + model.nodes[node]!.bounds!.width / 2;
const straight = (model: LayoutModel): number => {
  const blockers = overlayBlockers(model);
  return model.links.filter(link => link.layer === 'overlay' && link.attachments)
    .filter(link => overlayPath(model, link, blockers).segments.length === 1).length;
};

describe('a free group moves into the span of its partners (ranked-groups ticket 22)', () => {
  it('moves a group that stands outside the x-span of its overlay partners into the span, though the straight count falls', async () => {
    const model = flanks(lanes(rows(await placed(yaml))));
    let before = 0, after = 0, from = 0, to = 0, span: [number, number] = [0, 0];
    const result = withLayoutMutation(model, 'centre', draft => {
      // ELK puts a group with no routed link at its own x, far from its partners (the outlet groups of the
      // NTP sheet stand 2 000 px from theirs). The test sets that condition where the skeleton does not.
      const client = draft.groups['client']!;
      moveGroup(draft, client, 12 - client.bounds!.x, 0);
      const xs = ['e1', 'e2'].map(node => centreX(draft, node));
      span = [Math.min(...xs), Math.max(...xs)];
      from = client.bounds!.x + client.bounds!.width / 2;
      before = straight(draft);
      placeOverlayFree(draft);
      to = client.bounds!.x + client.bounds!.width / 2;
      after = straight(draft);
      centreDraft(draft, createCentreBudget());
    });
    // The condition holds: the group stands outside the span, and both links are straight there.
    expect(from).toBeLessThan(span[0] - 200);
    expect(before).toBe(2);
    // The rule: the group is inside the span, and the move crossed the row of `mid`, so the count fell.
    expect(to).toBeGreaterThanOrEqual(span[0] - 0.5);
    expect(to).toBeLessThanOrEqual(span[1] + 0.5);
    expect(after).toBeLessThan(before);
    // The centre steps that follow move the partners; the group still stands inside their span.
    const client = result.groups['client']!;
    const end = client.bounds!.x + client.bounds!.width / 2;
    const ends = ['e1', 'e2'].map(node => centreX(result, node));
    expect(end).toBeGreaterThanOrEqual(Math.min(...ends) - 0.5);
    expect(end).toBeLessThanOrEqual(Math.max(...ends) + 0.5);
  }, 60000);

  it('is idempotent: a second pass leaves the group where the first put it', async () => {
    const model = flanks(lanes(rows(await placed(yaml))));
    withLayoutMutation(model, 'centre', draft => {
      const client = draft.groups['client']!;
      moveGroup(draft, client, 12 - client.bounds!.x, 0);
      placeOverlayFree(draft);
      const once = JSON.stringify(draft);
      placeOverlayFree(draft);
      expect(JSON.stringify(draft)).toBe(once);
      centreDraft(draft, createCentreBudget());
    });
  }, 60000);
});
