import { expect, it } from 'vitest';
import { layout, parse, resolve, score } from '../../src/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

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
  // The pair routes and publishes. Both links leave `a`'s right side and turn up together with no
  // reserved pitch between them, so G6 still reports their parallel clearance — ticket 31's
  // open question (b); every other gate passes and nothing overlaps.
  const report = score(model).snapshot;
  const failed = Object.entries(report.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
  expect(failed).toEqual(['G6']);
  expect(report.gates.G6.violations.every(item => item.code === 'parallel-clearance')).toBe(true);
  expect(report.gates.G4.passed).toBe(true);
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
