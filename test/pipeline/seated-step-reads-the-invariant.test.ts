import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { centreCheckTrace } from '../../src/layout/centre.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 38 (R1): the seated centring step and the centring invariant read one set. A port the seat leaves off its feed is
// unresolved by the step, so the check excuses it, and no round of the passes runs again on geometry that does not change.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-seated-row-names-the-ports-its-seat-leaves-off-their-feeds.yaml', import.meta.url), 'utf8');

it('a seated row leaves no stall round, and centring converges', async () => {
  resetAttemptCounters();
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect((model.reservations ?? []).filter(entry => entry.kind === 'seatSet').length).toBeGreaterThan(0);
  expect(attemptCounters.centreStallRounds).toBe(0);
  expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' || item.code === 'CENTRE_ALIGNMENT_OPEN').map(item => item.code)).toEqual([]);
}, 120000);

// Review 1 (R1, R10): the seated step and the invariant read one distance test and one ownership test. A seated row whose lower feeds come from a
// bar (bar shaping owns those ports) names none of them: the step names only ports the invariant reads. Before, k1.b1 and k1.b2 were named.
const BAR = `portograph: 2
layout: {moveBeforeGrow: true}
groups:
  up: {tier: 0}
  site: {tier: 1, label: One site in ranks}
  down: {tier: 2, shape: bar}
nodes:
  t0: {group: up, ports: [{name: a, side: bottom}, {name: b, side: bottom}]}
  p1: {group: site, size: {width: 420, height: 40}, ports: [{name: up, side: top}, {name: d1, side: bottom}]}
  p2: {group: site, size: {width: 420, height: 40}, ports: [{name: up, side: top}, {name: d1, side: bottom}]}
  c1: {group: site, ports: [{name: u1, side: top}, {name: b, side: bottom}]}
  n1: {group: site, ports: [{name: b, side: bottom}]}
  c2: {group: site, ports: [{name: u1, side: top}, {name: b, side: bottom}]}
  k1: {group: site, ports: [{name: t1, side: top}, {name: t3, side: top}, {name: b1, side: bottom}, {name: b2, side: bottom}]}
  n4: {group: down}
  n5: {group: down}
  n6: {group: down}
  n7: {group: down}
  n8: {group: down}
  n9: {group: down}
  z1: {group: down, ports: [{name: in, side: top}]}
  z2: {group: down, ports: [{name: in, side: top}]}
links:
  - {from: t0.a, to: p1.up}
  - {from: t0.b, to: p2.up}
  - {from: p1.d1, to: c1.u1}
  - {from: p2.d1, to: c2.u1}
  - {from: c1.b, to: k1.t1}
  - {from: c2.b, to: k1.t3}
  - {from: k1.b1, to: z1.in}
  - {from: k1.b2, to: z2.in}`;

it('a seated step names no port another rule owns (a feed from a bar)', async () => {
  const named = new Set<string>();
  let steps = 0;
  centreCheckTrace.hook = (_model, reader, found) => { if (reader === 'seated') { steps++; for (const port of found) named.add(port); } };
  try {
    await layout(parse(BAR), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { delete centreCheckTrace.hook; }
  expect(steps, 'the seated step ran').toBeGreaterThan(0);
  expect([...named].filter(port => port.startsWith('port:["k1",') && /"b[12]"/.test(port))).toEqual([]);
}, 120000);
