import { expect, it } from 'vitest';
import { layout, parse, resolve, score } from '../../src/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gapLegs, gapPlan, legReservation } from '../../src/layout/sides-two.js';
import { MEMBER_GAP } from '../../src/layout/bundle-geometry.js';
import { routedStroke } from '../../src/layout/bands.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const pair = (bSides: [string, string]) => `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}, {name: q, side: right}]}
  b: {group: g, ports: [{name: p, side: ${bSides[0]}}, {name: q, side: ${bSides[1]}}]}
links: [[a.p, b.p], [a.q, b.q]]
`;

it('ticket 35: two links between one pair that end on different sides of a node are not bundled', async () => {
  const model = await run(pair(['right', 'left']));
  expect(model.bundles).toEqual([]);
  expect(model.links.map(link => link.bundle)).toEqual([undefined, undefined]);
  expect(model.diagnostics.filter(d => d.code === 'BUNDLE_MIXED_SIDES')).toEqual([expect.objectContaining({
    severity: 'warning', owners: [{ kind: 'link', id: 'link-1' }, { kind: 'link', id: 'link-2' }] })]);
  // Both links leave `a`'s right side and turn into the same row gap, so they are two legs of that
  // gap and take a slot each: one turns at the reserved stem, the other a pitch further out
  // (ADR-0015 rule 1, ticket 38 case C). Every gate passes; the pair was 7.9 px apart before.
  expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id)).toEqual([]);
  const plan = gapPlan(model, 'a', 'b')!;
  const edge = model.nodes['a']!.bounds!.x + model.nodes['a']!.bounds!.width;
  expect([...plan.slot.values()].sort((x, y) => x - y))
    .toEqual([edge + plan.base.a, edge + plan.base.a + MEMBER_GAP + routedStroke(model)]);
  // The slot belongs to the leg, so both ends of a jogging link name one x, and the run reserved at
  // that x is one stage 8 routes *through*: each leg turns exactly there.
  const leg = (id: string): number => model.links.find(link => link.id === id)!.path!.segments
    .find(segment => segment.from.x === segment.to.x)!.from.x;
  for (const [id, slot] of plan.slot) {
    expect(legReservation(model, model.links.find(link => link.id === id)!)!.from.x).toBe(slot);
    expect(leg(id)).toBe(slot);
  }
  expect(Math.abs(leg('link-2') - leg('link-1'))).toBe(MEMBER_GAP + routedStroke(model));
}, 60000);

it('ticket 38 case C: a weighted leg keeps the slot its own reservation supplies', async () => {
  // `nodeObstacleReach` already carries the routed half stroke, so the corridor test must not add
  // it again: at a 4.5 px stroke that refused a slot 0.25 px outside the node's real obstacle and
  // cost the whole gap its reservation. The node obstacle also swallows the node's outward pills.
  const model = await run(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a:
    group: g
    ports:
      - {name: p, side: right, order: 0}
      - {name: r, side: right, order: 1}
      - {name: q, side: right, order: 2}
  b:
    group: g
    ports:
      - {name: p, side: right, order: 0}
      - {name: q, side: left}
links:
  - [a.p, b.p, {weight: 3}]
  - [a.q, b.q, {weight: 3}]`);
  expect(score(model).snapshot.passed).toBe(true);
  const plan = gapPlan(model, 'a', 'b')!;
  const leg = (id: string): number => model.links.find(link => link.id === id)!.path!.segments
    .find(segment => segment.from.x === segment.to.x)!.from.x;
  for (const [id, slot] of plan.slot) expect(leg(id)).toBe(slot);
  expect(Math.abs(leg('link-2') - leg('link-1'))).toBe(MEMBER_GAP + routedStroke(model));
}, 60000);

it('ticket 38 case C: a gap whose legs leave the tier keeps its flat stems', async () => {
  // A leg is modelled only as far as the neighbour it turns beside. These two keep going to the
  // tier above, and where those runs lie decides the order too, so the gap is left alone.
  const model = await run(`portograph: 2
groups: {top: {tier: 0}, g: {tier: 1}}
nodes:
  u: {group: top, ports: [{name: p, side: bottom}]}
  v: {group: top, ports: [{name: p, side: bottom}]}
  a: {group: g, ports: [{name: x, side: right, order: 0}, {name: y, side: right, order: 1}, {name: p, side: right, order: 2}]}
  b: {group: g, ports: [{name: q, side: left, order: 0}, {name: r, side: left, order: 1}, {name: p, side: left, order: 2}]}
links:
  - [a.p, b.p, {label: This label is deliberately long enough to make the row gap much wider than its turning reservation}]
  - {from: b.q, to: u.p, route: orthogonal}
  - {from: b.r, to: v.p, route: orthogonal}`);
  expect(gapLegs(model, 'b', 'left', 'a').links.size).toBe(2);
  expect(gapPlan(model, 'a', 'b')).toBeUndefined();
  expect(score(model).snapshot.passed).toBe(true);
}, 60000);

it('ticket 38 case C: a leg heading past its neighbour to somewhere else keeps the gap flat', async () => {
  // Placement knows a leg's whole shape when it jogs into the neighbour's facing side, and when it
  // wraps the neighbour to reach a port on the neighbour itself. A link heading past the neighbour
  // to a third node may wrap either way, for reasons placement cannot see, so the gap is left alone.
  const model = await run(`portograph: 2
groups:
  g:  {tier: 0, label: ''}
  gx: {tier: 0, label: ''}
  gy: {tier: 0, label: ''}
  gz: {tier: 0, label: ''}
nodes:
  a:
    group: g
    size: {width: 50, height: 120}
    ports: [{name: p, side: right, order: 0}, {name: q, side: right, order: 1}, {name: r, side: right, order: 2}]
  b: {group: g, size: {width: 50, height: 240}}
  x: {group: gx, ports: [{name: p, side: right}]}
  y: {group: gy, ports: [{name: p, side: right}]}
  z: {group: gz, ports: [{name: p, side: right}]}
links:
  - {from: x.p, to: a.p, route: orthogonal}
  - {from: y.p, to: a.q, route: orthogonal}
  - {from: z.p, to: a.r, route: orthogonal}`);
  expect(gapLegs(model, 'a', 'right', 'b').links.size).toBe(3);
  expect(gapPlan(model, 'a', 'b')).toBeUndefined();
  for (const link of model.links) expect(legReservation(model, link)).toBeUndefined();
}, 60000);

it('ticket 38 case C: a link that is a leg in two gaps leaves both of them flat', async () => {
  // One link holds one reserved run. Which of its two slots it should take is a question about both
  // gaps at once, so a link seen in two of them declines this one and, by the same test, the other.
  const model = await run(`portograph: 2
groups:
  g:  {tier: 0, label: ''}
  gx: {tier: 0, label: ''}
  gy: {tier: 0, label: ''}
nodes:
  a: {group: g, size: {width: 50, height: 80}, ports: [{name: p, side: right, order: 0}, {name: q, side: right, order: 1}]}
  b: {group: g, size: {width: 50, height: 240}}
  c: {group: g, size: {width: 50, height: 120}, ports: [{name: p, side: left, order: 0}, {name: q, side: left, order: 1}]}
  x: {group: gx, ports: [{name: p, side: right}]}
  y: {group: gy, ports: [{name: p, side: right}]}
links:
  - {from: a.p, to: c.p, route: orthogonal}
  - {from: x.p, to: a.q, route: orthogonal}
  - {from: y.p, to: c.q, route: orthogonal}`);
  expect(model.groups['g']!.rowOrder).toEqual(['a', 'b', 'c']);
  expect(gapPlan(model, 'a', 'b')).toBeUndefined();
  expect(gapPlan(model, 'b', 'c')).toBeUndefined();
  expect(legReservation(model, model.links.find(link => link.id === 'link-1')!)).toBeUndefined();
}, 60000);

it('ticket 38 case C: the legs of a gap do not move when the links are written the other way round', async () => {
  // Both ends of a leg name one slot and the run is reserved, not asked for, so an undirected
  // link's geometry cannot depend on which end the document names first.
  const forward = await run(pair(['right', 'left']));
  const reverse = await run(`
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}, {name: q, side: right}]}
  b: {group: g, ports: [{name: p, side: right}, {name: q, side: left}]}
links: [[b.p, a.p], [b.q, a.q]]
`);
  expect(score(reverse).snapshot.passed).toBe(true);
  expect(score(reverse).snapshot.Q).toBe(score(forward).snapshot.Q);
  expect([...gapPlan(reverse, 'a', 'b')!.slot.values()].sort((x, y) => x - y))
    .toEqual([...gapPlan(forward, 'a', 'b')!.slot.values()].sort((x, y) => x - y));
}, 60000);

it('ticket 35: the same pair with both ends on one side still bundles', async () => {
  const model = await run(pair(['left', 'left']));
  expect(model.bundles).toHaveLength(1);
  expect(model.bundles[0]!.members).toEqual(['link-1', 'link-2']);
  expect(model.diagnostics.filter(d => d.code === 'BUNDLE_MIXED_SIDES')).toEqual([]);
  expect(score(model).snapshot.passed).toBe(true);
}, 60000);

it('ticket 35: a facing pair bundles while the odd-sided third link is singled out, and a merge member so singled out is an error', () => {
  // Stage 1 alone: routing such a trio is ticket 31's open problem (the wrapping link meets the
  // pair's reserved envelope), so membership and diagnostics are asserted on the resolved model.
  const three = `
portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}, {name: q, side: right}, {name: r, side: right}]}
  b: {group: g, ports: [{name: p, side: left}, {name: q, side: left}, {name: r, side: right}]}
links: [[a.p, b.p], [a.q, b.q], [a.r, b.r]]`;
  const model = resolve(parse(three));
  expect(model.bundles.map(bundle => bundle.members)).toEqual([['link-1', 'link-2']]);
  expect(model.links[2]!.bundle).toBeUndefined();
  expect(model.diagnostics.filter(d => d.code === 'BUNDLE_MIXED_SIDES')).toEqual([expect.objectContaining({
    severity: 'warning', owners: [{ kind: 'link', id: 'link-3' }] })]);
  // A `route: merge` link left out of every bundle is the existing model-time error, beside the warning.
  expect(() => resolve(parse(three.replace('[a.r, b.r]', '{from: a.r, to: b.r, route: merge}')))).toThrow(/MERGE_REQUIRES_BUNDLE|merge/i);
});

it('ticket 35: engine-chosen sides of one bundle leave a shared node together even with other peers pulling apart', async () => {
  // `a.p` also feeds an upper-tier peer and `a.q` a lower-tier one, so side resolution alone sends
  // the two bundle members out of `a` on top and bottom; stage 5 unifies them. (Laying this diagram
  // out fully trips a 7e crossing check that is not this ticket's; the sides are asserted after stage 5.)
  const yaml = `
portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  u: {group: up, ports: [{name: p, side: bottom}]}
  a: {group: mid, ports: [p, q]}
  b: {group: mid, ports: [p, q]}
  d: {group: down, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [a.q, b.q], [u.p, a.p], [a.q, d.p]]`;
  const model = await placed(yaml);
  expect(model.bundles).toHaveLength(1);
  const sideAt = (node: string) => model.bundles[0]!.members.map(id => {
    const link = model.links.find(item => item.id === id)!;
    const end = link.attachments!.from.node === node ? link.attachments!.from : link.attachments!.to;
    return model.nodes[node]!.ports.find(port => port.ref.name === end.name && port.ref.ordinal === end.ordinal)!.side;
  });
  expect(new Set(sideAt('a')).size).toBe(1);
  expect(new Set(sideAt('b')).size).toBe(1);
  expect(model.stage).toBe('sides-two');
}, 60000);

it('ticket 35: a port in two bundles ties both to one side, whatever the bundle order', async () => {
  // `a.x` is a member of the `a`–`b` bundle (with `a.p`, `a.q`) and of the `a`–`c` bundle (with
  // `a.r`, `a.s`); `b` sits above and `c` below, so the votes pull `x` down and `p`/`q` up. One
  // component, one side for all five ports, and the same answer with the bundles declared reversed.
  const doc = (order: 'bc' | 'cb') => {
    const toB = ['[a.x, b.x]', '[a.p, b.p]', '[a.q, b.q]'], toC = ['[a.x, c.x]', '[a.r, c.r]', '[a.s, c.s]'];
    return `
portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, down: {tier: 2}}
nodes:
  b: {group: up, ports: [x, p, q]}
  a: {group: mid, ports: [x, p, q, r, s]}
  c: {group: down, ports: [x, r, s]}
links: [${(order === 'bc' ? [...toB, ...toC] : [...toC, ...toB]).join(', ')}]`;
  };
  for (const order of ['bc', 'cb'] as const) {
    const model = await placed(doc(order));
    expect(model.bundles).toHaveLength(2);
    const sides = model.nodes['a']!.ports.map(port => port.side);
    expect(new Set(sides).size, order).toBe(1);
  }
}, 120000);
