import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const centre = (box: { x: number; width: number }): number => box.x + box.width / 2;
const frame = (model: LayoutModel, id: string) => model.frames!.find(item => item.id === id)!;

describe('a tier above packs over the final x of its feeds', () => {
  it('two locations above a one-rank group stand over the x centring gave it, not the x it had when packed', async () => {
    const model = await run('a-tier-above-packs-over-its-feeds-final-x');
    const core = centre(model.groups.core!.bounds!);
    const tops = (centre(frame(model, 'top-a').box) + centre(frame(model, 'top-b').box)) / 2;
    // Centring moves `core` some 1 700 px from where the columns were packed. The packing reads the feed
    // of a tier only after that feed is packed toward its own feeds, so the two frames follow it.
    expect(Math.abs(tops - core)).toBeLessThanOrEqual(COLUMN_SLACK);
  }, 60000);
});
