import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import { MIN_STEM, edgeMargin } from '../../src/layout/bundle-geometry.js';
import { DEFAULT_STROKE_WIDTHS, routedStrokeWidth } from '../../src/theme/geometry.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** Every link of the fan leaves the parent anchor on one identical first stem, and no two paths overlap. */
function sharedStem(model: LayoutModel, parent: string): void {
  const fans = model.links.filter(link => link.attachments!.from.node === parent);
  const stems = fans.map(link => link.sharedRuns!.from![0]!);
  for (const stem of stems) expect(stem).toEqual(stems[0]);
  expect(stems[0]!.from).toEqual(model.nodes[parent]!.ports[0]!.anchor);
  expect(model.junctions.length).toBeGreaterThanOrEqual(1);
  expect(model.junctions[0]!.links).toEqual(fans.map(link => link.id));
  for (const link of fans) expect(link.path!.segments[0]).toMatchObject({ from: stems[0]!.from, to: stems[0]!.to });
}

it('ticket 20: a plain fan from one parent port passes every gate through one reserved shared stem', async () => {
  const model = await run(fixture('parent-two-children'));
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  sharedStem(model, 'parent');
  // The first child by x keeps the vertical link; the second fans off the stem.
  const [first, second] = model.links;
  expect(first!.path!.segments.every(s => s.from.x === s.to.x)).toBe(true);
  expect(second!.path!.segments.some(s => s.from.y === s.to.y)).toBe(true);
}, 60000);

it('ticket 20: a one-port transit fan owns lanes in the children\'s order and passes every gate', async () => {
  for (const children of [2, 3]) {
    const yaml = children === 3 ? fixture('transit-fan')
      : fixture('transit-fan').replace('  c3: { group: bottom, ports: [{ name: p, side: top }] }\n', '').replace('  - [a.p#1, c3.p]\n', '');
    const model = await run(yaml);
    const report = score(model).snapshot;
    expect(report.passed, `${children} children`).toBe(true);
    expect(report.metrics.crossings.count).toBe(0);
    sharedStem(model, 'a');
    // Lane x in the transit tier ascends with the children's x: sorted by child, the lanes are ascending.
    const byLink = new Map(model.lanes.map(lane => [lane.owner.kind === 'link' ? lane.owner.id : lane.owner.kind, lane.x]));
    const lanesByChild = model.links.map(link => ({ lane: byLink.get(link.id)!, child: model.nodes[link.attachments!.to.node]!.bounds!.x }))
      .sort((a, b) => a.child - b.child).map(item => item.lane);
    expect(lanesByChild).toEqual([...lanesByChild].sort((a, b) => a - b));
    expect(new Set(lanesByChild).size).toBe(children);
    // Every leaf ends on its lane's x, so the gap to the lane is a straight head-on join.
    for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.x).toBe(byLink.get(link.id));
  }
}, 120000);

it('ticket 20: stage 7e reserves the depth a plain transit fan needs before its lanes, bundle or not', async () => {
  const model = await run(fixture('transit-fan'));
  expect(model.bundles).toEqual([]);
  const anchor = model.nodes['a']!.ports[0]!.anchor!.y;
  const lanes = model.lanes.filter(lane => lane.tier === 1);
  const stroke = Math.max(...model.links.map(link => link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path));
  const q = Math.max(17.5, 16 + stroke);
  // Rows for three members and their normal continuation, each row free to move one edge margin.
  const required = 2 * MIN_STEM + q * (model.links.length + 1) + 2 * edgeMargin(routedStrokeWidth(model));
  // Measured to the adjacent tier band's top, the same entry point 7e reserves against.
  const entry = model.tierBands.find(band => band.tier === 1)!.bounds!.y - 10.75;
  expect(entry - anchor).toBeGreaterThanOrEqual(required - 1e-6);
  // The deepest leaf still ends before the lane entry, so the join is a straight head-on gap.
  for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.y).toBeLessThan(Math.min(...lanes.map(lane => lane.bounds.y)));
}, 60000);

it('ticket 20: a five-child fan into the adjacent tier reserves its depth against that tier band', async () => {
  const yaml = `portograph: 2
groups: {parents: {tier: 0}, children: {tier: 1}}
nodes:
  parent: {group: parents, ports: [{name: p, side: bottom}]}
${[1, 2, 3, 4, 5].map(i => `  c${i}: {group: children, ports: [{name: p, side: top}]}`).join('\n')}
links:
${[1, 2, 3, 4, 5].map(i => `  - [parent.p#1, c${i}.p]`).join('\n')}`;
  const model = await run(yaml);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  sharedStem(model, 'parent');
  // No link owns a lane, so the next tier band is the boundary: every leaf ends before its entry.
  expect(model.lanes).toEqual([]);
  const band = model.tierBands.find(item => item.tier === 1)!.bounds!;
  for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.y).toBeLessThan(band.y - 10.75);
}, 60000);

it('ticket 20: a plain-fan tree survives the final-layout round trip and a forged run is rejected', async () => {
  const model = await run(fixture('parent-two-children'));
  const restored = restoreFinalLayout(JSON.stringify(model));
  expect(restored.junctions).toEqual(model.junctions);
  expect(restored.links.map(link => link.sharedRuns)).toEqual(model.links.map(link => link.sharedRuns));
  const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
  forged.links[1]!.sharedRuns!.from![0]!.to.y += 5;
  expect(() => restoreFinalLayout(JSON.stringify(forged))).toThrow();
  const dropped = JSON.parse(JSON.stringify(model)) as LayoutModel;
  delete dropped.links[1]!.sharedRuns;
  expect(() => restoreFinalLayout(JSON.stringify(dropped))).toThrow();
}, 60000);
