import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { ElkAttempt } from '../../src/layout/elk-worker.js';
import { frameColumns } from '../../src/layout/columns.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const shiftAll = (node: ElkNode, dx: number): void => {
  node.x = (node.x ?? 0) + dx;
  for (const child of node.children ?? []) shiftAll(child, dx);
};
const find = (node: ElkNode, id: string): ElkNode | undefined =>
  node.id === id ? node : (node.children ?? []).map(child => find(child, id)).find(found => found !== undefined);
/** An ELK attempt that puts the group `key` (with its children) `dx` px to one side of where ELK left it: the skeleton x of a linkless group is arbitrary. */
const shifted = (dx: number) => (): ElkAttempt => {
  const inner = createAttempt();
  return {
    terminateWorker: () => inner.terminateWorker(),
    async layout(graph) {
      const result = await inner.layout(graph);
      const key = find(result, 'group:key');
      if (key) shiftAll(key, dx);
      return result;
    },
  };
};
const run = (name: string, dx: number): Promise<LayoutModel> =>
  layout(parse(fixture(name)), { createElkAttempt: shifted(dx), createRouteAttempt: createAvoidAttempt });
const box = (model: LayoutModel, id: string) => model.groups[id]!.bounds!;

describe('a group with no links stands beside the connected diagram (ticket 92)', () => {
  it.each([-900, 900])('a chain: ELK puts the key %i px off, and the key ends one band gap from the relays on that side', async dx => {
    const model = await run('a-group-with-no-links-stands-beside-the-diagram', dx);
    const key = box(model, 'key'), gap = bandGap(model);
    const others = Object.values(model.groups).filter(group => group.id !== 'key').map(group => group.bounds!);
    const low = Math.min(...others.map(item => item.x)), high = Math.max(...others.map(item => item.x + item.width));
    const near = key.x + key.width <= low + 1e-6 ? low - (key.x + key.width) : key.x - high;
    expect(near).toBeGreaterThanOrEqual(gap - 1e-6);
    expect(near).toBeLessThanOrEqual(gap + 1e-6);
    // The canvas is the connected extent, the key and one band gap (plus the canvas margin on each side).
    const spread = Math.max(high, key.x + key.width) - Math.min(low, key.x);
    expect(model.canvas!.width).toBeLessThan(spread + 40);
    expect(model.canvas!.width).toBeLessThan(high - low + key.width + gap + 40);
    expect(model.diagnostics.some(d => d.code === 'LINKLESS_GROUP_MOVE_REFUSED')).toBe(false);
  }, 60000);

  it.each([-900, 900])('cantons: the key ends one band gap from the nearest frame, not from a group in it (%i px)', async dx => {
    const model = await run('a-group-with-no-links-stands-beside-a-canton', dx);
    const key = box(model, 'key'), gap = bandGap(model);
    const frames = frameColumns(model);
    expect(frames.length).toBeGreaterThan(0);
    const low = Math.min(...frames.map(item => item.x)), high = Math.max(...frames.map(item => item.x + item.width));
    const near = key.x + key.width <= low + 1e-6 ? low - (key.x + key.width) : key.x - high;
    expect(near).toBeGreaterThanOrEqual(gap - 1e-6);
    expect(near).toBeLessThanOrEqual(gap + 1e-6);
  }, 60000);
});
