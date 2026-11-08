import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { stepOutOfChords } from '../../src/layout/overlay-place.js';
import { crosses, overlayPath } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  // The group lift (ticket 08) is off: the key group rises beside its source, so it no longer stands in the chord the tests pin.
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });

describe('a group with no links', () => {
  it.each(['a-group-with-no-links-stands-in-a-straight-chord', 'a-group-with-no-links-stands-in-a-straight-signal-chord'])('%s: stands where its box crosses no overlay chord, and every overlay link is one straight segment', async name => {
    const model = await run(fixture(name));
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(model.diagnostics.some(d => d.code === 'LINKLESS_GROUP_MOVE_REFUSED')).toBe(false);
    const overlays = model.links.filter(link => link.layer === 'overlay');
    expect(overlays).toHaveLength(4);
    const box = model.groups['key']!.bounds!;
    for (const link of overlays) {
      const segments = link.path!.segments;
      expect(segments, link.id).toHaveLength(1);
      expect(crosses(segments[0]!.from, segments[0]!.to, box), link.id).toBe(false);
    }
  }, 60000);
});

const refused = (model: LayoutModel): boolean => model.diagnostics.some(d => d.code === 'LINKLESS_GROUP_MOVE_REFUSED');
const overlaysOf = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.layer === 'overlay');
const straightAndClear = (model: LayoutModel): void => {
  const box = model.groups['key']!.bounds!;
  for (const link of overlaysOf(model)) {
    const path = overlayPath(model, link);
    expect(path.segments, link.id).toHaveLength(1);
    expect(crosses(path.segments[0]!.from, path.segments[0]!.to, box), link.id).toBe(false);
  }
};
/** The x of a published chord at the middle row of the key. */
const chordX = (model: LayoutModel, link: LayoutLink): number => {
  const box = model.groups['key']!.bounds!, y = box.y + box.height / 2;
  const [from, to] = [link.path!.segments[0]!.from, link.path!.segments.at(-1)!.to];
  return from.x + (to.x - from.x) * (y - from.y) / (to.y - from.y);
};

describe('the step out of the chords, edge cases (review)', () => {
  it('clears two close chords at once: the nearest edge of the first lies inside the second', async () => {
    const model = structuredClone(await run(fixture('a-group-with-no-links-clears-two-close-chords')));
    const key = model.groups['key']!;
    const [one] = overlaysOf(model).sort((a, b) => chordX(model, a) - chordX(model, b));
    // Put the group across the first chord only, near its own left edge, so the nearer way out is the far side of that chord, into the second.
    moveGroup(model, key, chordX(model, one!) - 20 - key.bounds!.x, 0);
    rebuildNodeGeometry(model, key.nodes, 'current');
    stepOutOfChords(model, [1], new Set(['key']), []);
    expect(refused(model)).toBe(false);
    straightAndClear(model);
  }, 60000);

  it('goes past the end of the tier when no x inside its span is clear of the chords', async () => {
    const model = structuredClone(await run(fixture('a-group-with-no-links-clears-two-close-chords')));
    const key = model.groups['key']!, wall = { ...model.groups['sources']!.bounds! };
    // The sources become a wall of the tier that spans every chord; the only clear x lies beyond it.
    model.groups['sources']!.tier = 1;
    moveGroup(model, key, chordX(model, overlaysOf(model)[0]!) - 20 - key.bounds!.x, 0);
    rebuildNodeGeometry(model, key.nodes, 'current');
    stepOutOfChords(model, [1], new Set(['key']), []);
    const box = key.bounds!;
    expect(refused(model)).toBe(false);
    expect(box.x + box.width <= wall.x || box.x >= wall.x + wall.width).toBe(true);
    straightAndClear(model);
  }, 60000);

  it('keeps every chord straight and clear when a labelled routed link grows the tier gap', async () => {
    const model = await run(fixture('a-group-with-no-links-steps-out-again-after-the-gaps-grow'));
    // Without the labelled link the sources and the targets stand about 314 px apart.
    expect(model.groups['targets']!.bounds!.y - model.groups['sources']!.bounds!.y).toBeGreaterThan(400);
    expect(refused(model)).toBe(false);
    straightAndClear(model);
  }, 60000);
});
