import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { ElkAttempt } from '../../src/layout/elk-worker.js';
import { besideGap, frameColumns } from '../../src/layout/columns.js';
import { stepLinklessOutOfChords } from '../../src/layout/overlay-place.js';
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

/**
 * Ticket 75: a frame spends no slack toward a plain group that is its nearest neighbour, so the wall the linkless step reads is the frame
 * box and `besideGap`, wherever the group stands. With slack toward it the wall read the group's own place: halved, every replay moved the
 * group in by half (the step is the rebuild hook of the tier-gap solve); whole, the group stayed 20 px beyond the gap G9 reads.
 * The margin fixture with g2 linkless, renamed `key`.
 */
const linklessBesideFrame = fixture('a-frame-keeps-its-margin-beside-a-plain-group')
  .split('\n').filter(line => !/^ {2}- \[n[04]\b.*n4|^ {2}- \[n4\./.test(line)).join('\n')
  .replace('  g2: { tier: 1, label: g2 }', '  key: { tier: 1, label: key }').replace('group: g2,', 'group: key,');

describe('a linkless group beside a frame of its tier (ticket 75)', () => {
  it.each([-900, 900])('ELK puts the key %i px off: it ends besideGap from the frame box, and a replay of the step moves nothing', async dx => {
    expect(linklessBesideFrame).toContain('key: { tier: 1');
    expect(linklessBesideFrame).not.toContain('n4.up');
    const model = await layout(parse(linklessBesideFrame), { createElkAttempt: shifted(dx), createRouteAttempt: createAvoidAttempt });
    const key = box(model, 'key'), frame = model.frames!.find(item => item.id === 'g1')!.box;
    const near = key.x >= frame.x + frame.width ? key.x - (frame.x + frame.width) : frame.x - (key.x + key.width);
    expect(near).toBeCloseTo(besideGap(model, true, false), 6);
    const again = JSON.parse(JSON.stringify(model)) as LayoutModel;
    for (let call = 0; call < 3; call++) expect(stepLinklessOutOfChords(again)).toBe(false);
    expect(box(again, 'key')).toEqual(key);
  }, 60000);
});
