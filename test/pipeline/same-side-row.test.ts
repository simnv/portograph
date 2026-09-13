import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { nodeObstacleReach, stemReach } from '../../src/layout/bands.js';
import { PILL_WIRE_GAP } from '../../src/layout/sides-two.js';
import { measurePortPill } from '../../src/text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const row = (aSide: string, bSide: string) => `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: ${aSide}}]}
  b: {group: g, ports: [{name: p, side: ${bSide}}]}
links: [[a.p, b.p]]
`;

it('ticket 29: a link to the far side of a row neighbour reserves the pass-by stem in the row gap', async () => {
  const model = await run(row('right', 'right'));
  const a = model.nodes['a']!, b = model.nodes['b']!;
  // The stem checkpoint of a.p lies strictly outside b's stroke-aware obstacle.
  const checkpoint = a.ports[0]!.anchor!.x + stemReach(model, a);
  expect(checkpoint).toBeLessThanOrEqual(b.bounds!.x - nodeObstacleReach(model, b));
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(model.links[0]!.path!.segments.length).toBeGreaterThan(1);
});

it('ticket 29: a link that enters the facing side keeps the facing-pill gap and needs no stem', async () => {
  const facing = await run(row('right', 'left'));
  const far = await run(row('right', 'right'));
  const gap = (model: Awaited<ReturnType<typeof run>>) => model.nodes['b']!.bounds!.x - (model.nodes['a']!.bounds!.x + model.nodes['a']!.bounds!.width);
  // Two facing pills with their visible wire; the pass-by stem is not added on top.
  expect(gap(facing)).toBeCloseTo(measurePortPill('p').width + DEFAULT_STROKE_WIDTHS.pill + PILL_WIRE_GAP, 6);
  // The far-side pair reserves exactly the stem plus the neighbour's obstacle reach.
  expect(gap(far)).toBeCloseTo(stemReach(far, far.nodes['a']!) + nodeObstacleReach(far, far.nodes['b']!), 6);
  expect(score(facing).snapshot.passed).toBe(true);
  expect(facing.links[0]!.path!.segments).toHaveLength(1);
});
