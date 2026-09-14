import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { routedStroke, stemReach } from '../../src/layout/bands.js';
import { MEMBER_GAP } from '../../src/layout/bundle-geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { gapLegs, rowGap } from '../../src/layout/sides-two.js';
import { rows } from '../../src/layout/rows.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** ADR-0015 rule 1, ticket 31 case B: a port facing away from its peer wraps its node beside another turning link. */
const row = `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: p, side: right}, {name: q, side: left}]}
  c: {group: g, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [b.q, c.p]]
`;

it('ticket 31 case B: two links turning in one row gap get a stem each and the gate clearance between them', async () => {
  const model = await run(row);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  const a = model.nodes['a']!, b = model.nodes['b']!;
  // `a.p` wraps `b`; `b.q` passes `a` on its way to `c`: two legs in the gap.
  const gap = b.bounds!.x - (a.bounds!.x + a.bounds!.width);
  // One pitch between the two legs, as ADR-0015 rule 1 defines it.
  expect(gap).toBeCloseTo(stemReach(model, a) + stemReach(model, b) + MEMBER_GAP + routedStroke(model), 6);
  // Both routes reach their anchors with a stem; the router's truncation at a bent final stem is retried away.
  for (const link of model.links) {
    const first = link.path!.segments[0]!, last = link.path!.segments.at(-1)!;
    expect(Math.hypot(first.to.x - first.from.x, first.to.y - first.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
    expect(Math.hypot(last.to.x - last.from.x, last.to.y - last.from.y)).toBeGreaterThanOrEqual(15 - 1e-9);
  }
}, 60000);

it('ticket 31: a facing pair that levels keeps the plain gap — no leg turns there', async () => {
  const model = await run(`
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: p, side: left}]}
links: [[a.p, b.p]]`);
  expect(model.links[0]!.path!.segments).toHaveLength(1);
  expect(score(model).snapshot.passed).toBe(true);
}, 60000);

it('ticket 31: a link that crosses the gap straight beside a leg reserves no pitch of its own', async () => {
  // Codex round 2: the classifier marks the port, not the link. `a.p` carries a pass-by to `c` and
  // an aligned link straight into `b`'s facing side. Only the pass-by turns in the gap, so the gap
  // is the one the pass-by alone reserves. (The pair also shares a stem out of `a.p`, which nothing
  // reserves yet — ticket 37 — so this measures the reservation, not a routed diagram.)
  const diagram = (aligned: boolean): string => `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: p, side: left}, {name: q, side: right}]}
  c: {group: g, ports: [{name: p, side: left}]}
links: [${aligned ? '[a.p, b.p], ' : ''}[a.p, c.p]]
`;
  const both = rows(await placed(diagram(true))), alone = rows(await placed(diagram(false)));
  expect(gapLegs(both, 'a', 'right', 'b').links.size).toBe(1);
  expect(rowGap(both, 'a', 'b')).toBeCloseTo(rowGap(alone, 'a', 'b'), 6);
}, 60000);

it('ticket 31: an aligned link into a bare facing side asks for no stem there', async () => {
  // Codex round 3: only a link the classifier accepted jogs into the facing side. `a.p` passes `b`
  // by and also runs straight into an anonymous port on `b`; `b` contributes no leg and receives no
  // jog, so its side of the gap is its obstacle reach, not a full stem.
  const model = rows(await placed(`
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g}
  c: {group: g, ports: [{name: p, side: left}]}
links: [[a.p, b], [a.p, c.p]]
`));
  expect(gapLegs(model, 'a', 'right', 'b').links.size).toBe(1);
  expect(rowGap(model, 'a', 'b')).toBeLessThan(stemReach(model, model.nodes['a']!) + stemReach(model, model.nodes['b']!) - 1e-9);
}, 60000);

it('ticket 31: the row gap still holds after facing ports level', async () => {
  // Codex round 5: levelling moves anchors after the repack, so a crossing that was straight can
  // become a jog. Stage 6 asks the gap again on the levelled anchors; every row pair must satisfy
  // the requirement its own final anchors imply.
  const diagrams = [
    [[0, 1], [1, 2], [2, 4]],
    [[0, 2], [1, 0], [2, 1]],
    [[0, 1], [2, 2], [3, 3]],
  ].map(pairs => `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [${[0, 1, 2, 3].map(i => `{name: a${i}, side: right, order: ${i}}`).join(', ')}]}
  b: {group: g, ports: [${[0, 1, 2, 3, 4].map(i => `{name: b${i}, side: left, order: ${i}}`).join(', ')}]}
links: [${pairs.map(([x, y]) => `[a.a${x}, b.b${y}]`).join(', ')}]
`);
  for (const diagram of diagrams) {
    const model = rows(await placed(diagram));
    const a = model.nodes['a']!, b = model.nodes['b']!;
    expect(b.bounds!.x - (a.bounds!.x + a.bounds!.width)).toBeGreaterThanOrEqual(rowGap(model, 'a', 'b') - 1e-6);
  }
}, 120000);
