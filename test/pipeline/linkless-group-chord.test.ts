import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { crosses } from '../../src/layout/overlay-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

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
