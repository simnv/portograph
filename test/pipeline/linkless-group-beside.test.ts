import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { frameColumns } from '../../src/layout/columns.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { standLinklessBeside } from '../../src/layout/overlay-place.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const yaml = readFileSync(new URL('../../goldens/synthetic/a-group-with-no-links-stands-beside-the-diagram.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const connected = (model: LayoutModel): { low: number; high: number } => {
  const boxes = Object.values(model.groups).filter(group => group.id !== 'key').map(group => group.bounds!);
  return { low: Math.min(...boxes.map(box => box.x)), high: Math.max(...boxes.map(box => box.x + box.width)) };
};

describe('a group with no links stands beside the connected diagram (ticket 92)', () => {
  it('keeps the canvas at the connected extent when the group already stands in it', async () => {
    const model = await run();
    const extent = connected(model), box = model.groups['key']!.bounds!;
    expect(box.x + box.width).toBeGreaterThan(extent.low);
    expect(box.x).toBeLessThan(extent.high);
    expect(model.canvas!.width).toBeLessThan(extent.high - extent.low + 2 * bandGap(model) + 30);
  }, 60000);

  it.each([['left', -900], ['right', 900]] as const)('brings a group left %s of the diagram back to one band gap from it', async (side, shift) => {
    const model = structuredClone(await run());
    const key = model.groups['key']!, extent = connected(model);
    moveGroup(model, key, (shift < 0 ? extent.low - key.bounds!.width : extent.high) + shift - key.bounds!.x, 0);
    rebuildNodeGeometry(model, key.nodes, 'current');
    standLinklessBeside(model, [key.tier!], new Set(['key']), frameColumns(model));
    const box = key.bounds!;
    // The side it stood on is kept.
    if (side === 'left') expect(box.x + box.width).toBeCloseTo(extent.low - bandGap(model), 3);
    else expect(box.x).toBeCloseTo(extent.high + bandGap(model), 3);
  }, 60000);

  it('leaves a group that stands within one band gap of the diagram', async () => {
    const model = structuredClone(await run());
    const key = model.groups['key']!, extent = connected(model);
    moveGroup(model, key, extent.high + bandGap(model) - key.bounds!.x, 0);
    rebuildNodeGeometry(model, key.nodes, 'current');
    const before = key.bounds!.x;
    standLinklessBeside(model, [key.tier!], new Set(['key']), frameColumns(model));
    expect(key.bounds!.x).toBe(before);
  }, 60000);
});
