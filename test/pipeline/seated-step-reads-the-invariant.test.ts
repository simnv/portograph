import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { centreCheckTrace } from '../../src/layout/centre.js';
import { LAYOUT_STAGES, type LayoutStage } from '../../src/model/layout.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 38 (R1): the seated centring step and the centring invariant read one set. A port the seat leaves off its feed is
// unresolved by the step, so the check excuses it, and no round of the passes runs again on geometry that does not change.
//
// The callers of the one ownership test (`otherRuleOwns(model, ahead)`, src/layout/centre.ts) and the phase each one passes (review 2):
// - `readCentreViolations` (the invariant): the `ahead` of its check.
//   - true: the producer's own checks in centre.ts (`centreDraftFound`, the two stall reads, `flagUnverifiedCentring`, `openLinks` for
//     `recordOpen`); and `recordDeclineFindings`, whose one caller is the reseat judge (decide.ts), which reads one draft in both phases.
//   - false: the publication (`publishedCentreViolations` in mutation.ts `validateRegionClaims`) and the placement judges (`centreViolations(model)`
//     in decide.ts, gap-room.ts, placement-attempt.ts). The judges read the 7f draft, which stands at `bundles`: with false they judge `bundles`,
//     while the draft publishes at `bands`. The two differ in one clause (a feed whose parent port a bundle member uses is excused at `bundles`
//     only); the same on main, and it cannot refuse a seated row, because the replay inside a judge takes the judge's phase (review 3).
// - `centreGroupStepRaw`, the seated step: the `ahead` its caller hands down through `centreGroupStep` and `centreGroupStepChecked`, with no default.
//   - The producer's passes (`centreDraftFound` → the tier loop): true, the stage it makes is published one stage on.
//   - The replay of a group inside `readCentreViolations`: the `ahead` of that check.
//   - The replay of a tier's row units (`rowUnitFaults`, called by `readCentreViolations`): the `ahead` of that check.
// So in one check the step and the invariant answer for the same stage. The phase of the row-unit replay changes no answer (it reads only the
// step's group), so no test holds it by behaviour; it is passed for one reading (R1).
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

// Review 2 (R1, R2): a seated row port with an ordinary feed that a bundle member also uses. The publication at 7d judges the port as 7d owns it
// (the centre rule); a replay that read one stage ahead (7e, the bundle owns it) did not name it, and the invariant refused the sheet at bars.
const SHARED = readFileSync(new URL('../fixtures/staged/a-seated-row-port-a-bundle-shares-keeps-its-feed-until-the-bundles.yaml', import.meta.url), 'utf8');

it('a seated row port a bundle shares publishes past bars, and the bundle keeps it from 7e on', async () => {
  const model = await layout(parse(SHARED), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.stage).toBe('link-labels');
  expect((model.reservations ?? []).filter(entry => entry.kind === 'seatSet').length).toBe(2);
  expect(model.diagnostics.filter(item => item.severity === 'error').map(item => item.code)).toEqual([]);
  expect(model.links.filter(link => link.bundle).length).toBeGreaterThan(0);
}, 120000);

// The stage an answer is for: a check that reads ahead judges the stage after the one its model stands at.
const judged = (stage: LayoutStage, ahead: boolean): LayoutStage => ahead ? LAYOUT_STAGES[LAYOUT_STAGES.indexOf(stage) + 1]! : stage;

it('for every stage from 7c to 7f, the seated step gives the owner the publication gives, for every port', async () => {
  // The publication's answers (the invariant of a check that does not read ahead), by stage and port; and every seated step's answer: a
  // replay inside a check, or a producer step, which reads ahead. Both are keyed by the stage they judge. The one clause the two phases read
  // differently by design (a held cross chord excuses its port only at publication) meets no step answer here: link-1 (t0.a to p1.up) is a held
  // cross chord, but no seated row has a wanted port on it. The phase sheets below include a seated row that has one.
  const published = new Map<string, boolean>(), steps: { key: string; owned: boolean }[] = [];
  centreCheckTrace.owner = (model, reader, _check, ahead, child, owned) => {
    const key = `${judged(model.stage, ahead)} ${child}`;
    if (reader === 'step') { steps.push({ key, owned }); return; }
    if (ahead) return;
    expect(published.get(key) ?? owned, `the publication gives one owner for ${key}`).toBe(owned);
    published.set(key, owned);
  };
  try {
    await layout(parse(SHARED), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { delete centreCheckTrace.owner; }
  const compared = steps.filter(step => published.has(step.key));
  expect(compared.filter(step => published.get(step.key) !== step.owned).map(step => `${step.key}: step ${step.owned}, publication ${!step.owned}`)).toEqual([]);
  expect([...new Set(compared.map(step => step.key.split(' ')[0]))].sort()).toEqual(['bands', 'bars', 'bundles', 'centre']);
  // The shared port: the centre rule answers for it at 7c and 7d, the bundle from 7e on.
  const shared = (stage: string): boolean | undefined => [...published].find(([key]) => key.startsWith(`${stage} port:["k1",`) && key.includes('"t1"'))?.[1];
  expect(['centre', 'bars', 'bundles', 'bands'].map(shared)).toEqual([false, false, true, true]);
}, 120000);

// Review 3 (R1): each replayed seated step asks for the phase of the check that replays it, and gives that check's owner, joined by check id.
// The test above keys an answer by the stage it judges and so does not see a replay that asks for the other phase. On the two phase sheets
// such a replay stalls the 7f passes (PLACEMENT_NON_CONVERGENCE, CENTRE_ALIGNMENT_OPEN); the staged shared-port sheet fails it on 8 answers.
const PHASE_SHEETS: readonly (readonly [string, string])[] = [
  ['the shared-port sheet', 'a-seated-row-port-a-bundle-shares-keeps-its-feed-until-the-bundles'],
  ['a held cross chord and a bundle on one seated row', 'a-seated-row-with-a-held-cross-chord-and-a-bundle-reads-the-phase-of-its-check'],
  ['a feed whose port a bundle uses, with a row below', 'a-seated-row-feed-whose-port-a-bundle-uses-reads-the-phase-of-its-check'],
];
for (const [name, file] of PHASE_SHEETS) it(`${name}: a replayed seated step reads the phase of its check`, async () => {
  const checks = new Map<string, { ahead: boolean; owned: boolean }>(), replays: { key: string; ahead: boolean; owned: boolean }[] = [];
  centreCheckTrace.owner = (_model, reader, check, ahead, child, owned) => {
    if (reader === 'invariant') checks.set(`${check} ${child}`, { ahead, owned });
    else if (check !== undefined) replays.push({ key: `${check} ${child}`, ahead, owned });
  };
  let model;
  try {
    model = await layout(parse(readFileSync(new URL(`../fixtures/staged/${file}.yaml`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { delete centreCheckTrace.owner; }
  expect(replays.length).toBeGreaterThan(0);
  expect(replays.filter(step => checks.get(step.key)?.ahead !== step.ahead || checks.get(step.key)?.owned !== step.owned).map(step => step.key)).toEqual([]);
  expect(model.stage).toBe('link-labels');
  expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' || item.code === 'CENTRE_ALIGNMENT_OPEN').map(item => item.code)).toEqual([]);
}, 120000);
