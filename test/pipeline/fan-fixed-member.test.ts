import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = readFileSync(new URL('../../goldens/synthetic/bar-fan.yaml', import.meta.url), 'utf8');

/** The drop's path starts with exactly the stems and continuation it shares, owned by the junction ids. */
function dropJoinsTree(model: LayoutModel): void {
  const drop = model.links[0]!;
  expect(drop.path!.fixed).toBe(true);
  const shared = drop.sharedRuns!.from!;
  expect(shared.length).toBeGreaterThanOrEqual(2);
  expect(drop.path!.segments.slice(0, shared.length)).toEqual(shared);
  for (const segment of shared) expect(segment.owner.kind).toBe('shared-stem');
  expect(drop.path!.segments[shared.length]!.owner).toEqual(drop.owner);
  // The root junction names every link of the fan, the drop included.
  const root = model.junctions.find(junction => !junction.parent)!;
  expect(root.links).toEqual(model.links.map(link => link.id));
  for (const link of model.links) expect(link.sharedRuns!.from![0]).toEqual(shared[0]);
}

it('ticket 36: a bar drop and two remainders from one port share one root stem and pass every gate', async () => {
  const model = await run(fixture);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  dropJoinsTree(model);
  expect(model.junctions).toHaveLength(2);
  // The drop's path is connected, every segment has length, and it reaches the bar anchor.
  const drop = model.links[0]!;
  drop.path!.segments.forEach((segment, index) => {
    expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThan(1e-6);
    if (index) expect(segment.from).toEqual(drop.path!.segments[index - 1]!.to);
  });
  expect(drop.path!.segments.at(-1)!.to).toEqual(model.nodes['b']!.ports[0]!.anchor);
  const restored = restoreFinalLayout(JSON.stringify(model));
  expect(restored.links.map(link => link.path)).toEqual(model.links.map(link => link.path));
  expect(restored.junctions).toEqual(model.junctions);
}, 60000);

it('ticket 36: a bar drop and one remainder form a tree of two', async () => {
  const one = fixture.replace('  c2: { group: leaves, ports: [{ name: p, side: top }] }\n', '').replace('  - [parent.p#1, c2.p]\n', '');
  const model = await run(one);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(model.junctions).toHaveLength(1);
  dropJoinsTree(model);
}, 60000);
