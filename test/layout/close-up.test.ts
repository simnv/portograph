import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { untrimmedModel } from '../../src/layout/end-trim.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 69, the close-up: after the end trim, a leaf top-level group moves toward its sibling on its left by at most the width
 * the trim freed, its order kept, when no guard declines. The shifts are recorded with the trim (`bodyTrims.shifts`, `laneShifts`), and the
 * centring replay reads the geometry before the trim and the close-up (`untrimmedModel`, R1).
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const right = (box: { x: number; width: number }): number => box.x + box.width;
const forge = (model: LayoutModel, edit: (copy: LayoutModel) => void): string => {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  edit(copy);
  return JSON.stringify(copy);
};

/** Lays the sheet out with a tap on the drafts the producer had before the trim (one per placement attempt). */
async function run(name: string): Promise<{ model: LayoutModel; drafts: LayoutModel[] }> {
  const drafts: LayoutModel[] = [], sink = targetTap.sink;
  targetTap.sink = (tap, value) => { if (tap === 'beforeEndTrim') drafts.push(JSON.parse(value) as LayoutModel); };
  try {
    const model = await layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    return { model, drafts };
  } finally { if (sink === undefined) delete targetTap.sink; else targetTap.sink = sink; }
}

/** A number to 1e-9 px: a shift and its undo are two float sums, so the replay may differ from the producer in the last bit (about 1e-13 px). */
const round = (_key: string, value: unknown): unknown => typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value;
/** The placement geometry the replay reads: bodies, ports, boxes, lanes, bands, regions, frames and the rule-owned paths. */
function geometry(model: LayoutModel): string {
  return JSON.stringify({
    nodes: Object.values(model.nodes).map(node => [node.id, node.bounds, node.size, node.ports.map(port => [port.side, port.anchor])]),
    groups: Object.values(model.groups).map(group => [group.id, group.bounds]),
    lanes: model.lanes.map(lane => [lane.id, lane.x, lane.bounds, lane.group]),
    tierBands: model.tierBands, regions: model.regions, frames: model.frames, labelBands: model.labelBands,
    paths: model.links.map(link => [link.id, link.path?.fixed === true ? link.path : undefined, link.fixedSegments]),
    barDrops: model.barDrops, nodeLabels: model.labels.filter(label => label.role === 'node'),
  }, round);
}

describe('a sibling group closes up after the trim', () => {
  let model: LayoutModel, drafts: LayoutModel[];
  beforeAll(async () => { ({ model, drafts } = await run('a-sibling-group-closes-up-after-the-trim')); }, 120000);

  it('moves `far` left toward `near` and records the shift', () => {
    const dx = model.bodyTrims?.shifts?.['far'];
    expect(dx).toBeLessThan(-500);
    expect(model.diagnostics.some(item => item.code === 'CLOSE_UP' && item.message.includes('far by'))).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'CLOSE_UP_DECLINED')).toEqual([]);
  });

  it('keeps the order and at least the band gap, and closes no more than the width the trim freed', () => {
    const near = model.groups['near']!.bounds!, far = model.groups['far']!.bounds!;
    expect(far.x - right(near)).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    const back = untrimmedModel(model), wasNear = back.groups['near']!.bounds!, wasFar = back.groups['far']!.bounds!;
    // `near` is the one box on the left of `far` in its rows: the gap is the one it had before the trim, at least the band gap.
    expect(far.x - right(near)).toBeCloseTo(Math.max(wasFar.x - right(wasNear), bandGap(model)), 6);
  });

  it('R1: the replay builds the geometry the producer had before the trim and the close-up (to 1e-9 px)', () => {
    expect(drafts.length).toBeGreaterThan(0);
    const back = geometry(untrimmedModel(model));
    expect(drafts.some(draft => geometry(draft) === back)).toBe(true);
  });

  it('round-trips through the restore API with its record', () => {
    expect(restoreLayoutModel(JSON.stringify(model)).bodyTrims).toEqual(model.bodyTrims);
  });

  // A shift that is itself a fixed point (the close-up of the geometry it names gives it again) passes: the record is the trusted decision,
  // as a trimmed body recorded wider into free space is (ticket 68, R5 limit). `far` stands a band gap from `near`, so a shorter forged shift is
  // one, and so is a record with no shift: the closed-up geometry closes up no further.
  it('refuses a forged shift: another dx, a group that may not move, a shift under the least move, a lane shift alone', () => {
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.shifts!['far']! -= 30; }))).toThrow(/end trim record is forged/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.shifts!['src'] = -20; }))).toThrow(/end trim record is forged/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.shifts!['far'] = -0.5; }))).toThrow(/end trim record is forged: shift of group far/);
    expect(() => restoreLayoutModel(forge(model, copy => { delete copy.bodyTrims!.shifts; copy.bodyTrims!.laneShifts = { [copy.lanes[0]?.id ?? 'none']: -10 }; })))
      .toThrow(/end trim record is forged: malformed lane shifts/);
  });
});

describe('a corridor follows the group that closes up', () => {
  let model: LayoutModel, drafts: LayoutModel[];
  beforeAll(async () => { ({ model, drafts } = await run('a-stretched-body-is-trimmed-to-its-ports')); }, 120000);

  it('moves `far` and the lane of its link by one shift, and the lane still stands on the port', () => {
    const dx = model.bodyTrims?.shifts?.['far'];
    expect(dx).toBeLessThan(-1);
    const shifted = Object.entries(model.bodyTrims?.laneShifts ?? {});
    expect(shifted.length).toBe(1);
    const [id, laneDx] = shifted[0]!, lane = model.lanes.find(item => item.id === id)!;
    expect(laneDx).toBe(dx);
    expect(lane.bounds.x).toBe(lane.x - lane.bounds.width / 2);
    const port = model.nodes['sink-far']!.ports.find(item => Math.abs(item.anchor!.x - lane.x) < 1e-9);
    expect(port).toBeDefined();
  });

  it('R1: the replay moves the lane back and builds the geometry before the trim and the close-up (to 1e-9 px)', () => {
    const back = geometry(untrimmedModel(model));
    expect(drafts.some(draft => geometry(draft) === back)).toBe(true);
  });

  it('refuses a forged lane shift', () => {
    const id = Object.keys(model.bodyTrims!.laneShifts!)[0]!;
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.laneShifts![id]! -= 40; }))).toThrow(/end trim record is forged/);
    // Review re-check: the lanes that stand on a shifted group's ports in the published model must be named, so leaving one out is refused.
    expect(() => restoreLayoutModel(forge(model, copy => { delete copy.bodyTrims!.laneShifts; }))).toThrow(/end trim record is forged: the lane shifts are not the lanes/);
  });
});

describe('a close-up a guard declines', () => {
  let model: LayoutModel, drafts: LayoutModel[];
  beforeAll(async () => { ({ model, drafts } = await run('a-close-up-that-would-reseat-a-bundled-port-is-declined')); }, 120000);

  it('names the group and the guard, and records no shift for it', () => {
    const declined = model.diagnostics.filter(item => item.code === 'CLOSE_UP_DECLINED').map(item => item.message).join(' ');
    expect(declined).toMatch(/side \(the port \d+ of sw-3 would not move with its node\)/);
    expect(model.bodyTrims?.shifts?.['side']).toBeUndefined();
  });

  it('leaves the declined group where the trim left it: no node of `side` moves', () => {
    expect(drafts.length).toBeGreaterThan(0);
    const xs = (item: LayoutModel): string => JSON.stringify(['sw-3', 'sink-far'].flatMap(id => item.nodes[id]!.ports.map(port => port.anchor!.x)));
    expect(drafts.some(draft => xs(draft) === xs(model))).toBe(true);
  });

  it('R1: with nothing closed up, the replay builds the geometry before the trim (to 1e-9 px)', () => {
    expect(model.bodyTrims?.shifts).toBeUndefined();
    const back = geometry(untrimmedModel(model));
    expect(drafts.some(draft => geometry(draft) === back)).toBe(true);
  });

  it('keeps the two bundled drops straight', () => {
    const links = model.links.filter(item => item.attachments?.from.node === 'sw-3' || item.attachments?.to.node === 'sw-3');
    expect(links).toHaveLength(2);
    for (const link of links) {
      const xs = [link.attachments!.from, link.attachments!.to].map(ref => findPort(model, ref)?.anchor?.x);
      expect(Math.abs(xs[0]! - xs[1]!)).toBeLessThan(1e-6);
    }
  });
});

// Architecture-2 ticket 71: a close-up that changes how a node side nests its stems is declined, so the stem depth record still holds. Before
// the guard, the sweep sheet v5-5-0 (with ticket 71) and the user's tier-gap sheet with reversed links (on main) threw at publication.
describe('a close-up keeps the stem depth record', () => {
  it('lays out v5-5-0 and the tier-gap sheet with reversed links, and the record is the one the geometry nests', async () => {
    const { stemDepthsFault } = await import('../../src/layout/sides-two.js');
    const sweep = readFileSync(new URL('../fixtures/sweep/v5-5-0.yaml', import.meta.url), 'utf8');
    const tierGap = source('a-tier-gap-plan-orders-every-part');
    const lines = tierGap.split('\n'), at = lines.indexOf('links:');
    const reversed = [...lines.slice(0, at + 1), ...lines.slice(at + 1).filter(line => line.startsWith('  - ')).reverse()].join('\n') + '\n';
    for (const text of [sweep, reversed]) {
      const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      expect(stemDepthsFault(model)).toBeUndefined();
    }
  }, 120000);
});
