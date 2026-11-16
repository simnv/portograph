import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolveBeforeExpansion } from '../../src/internal.js';
import { deriveRanks } from '../../src/layout/ranks.js';
import { rankInputOf } from '../../src/layout/rank-input.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 01, ADR-0026: a group with anchors on both sides has two poles.
const ONE_RULE = 'a-group-ranks-two-poles-with-a-leaf-of-the-lower-anchor';
const TWIN = 'two-cores-reach-seven-pairs-through-hubs-on-the-last-rank';
const fixture = (name: string): string => readFileSync(new URL(name === TWIN ? `../fixtures/staged/${name}.yaml` : `../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const ranksOf = (name: string, group: string) => deriveRanks(rankInputOf(resolveBeforeExpansion(parse(fixture(name))), group));
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('two-pole ranks on the synthetic fixtures', () => {
  it('a leaf of the downward anchor stands above it, not below', () => {
    const result = ranksOf(ONE_RULE, 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ gate: 0, mid: 1, spare: 1, core: 2 });
    expect(result.rankCount).toBe(3);
    expect(result.anchoredFrom).toBe('above');
  });

  it.each(['a', 'b'])('the twin: three ranks in core %s, the hubs on the last', core => {
    const result = ranksOf(TWIN, `core-${core}`);
    const ranks = Object.fromEntries(result.ranks);
    expect(result.rankCount).toBe(3);
    // up-x3 and up-x4 link only to middle members: two links from each pole, a tie, so they stand beside the upward anchors.
    for (const id of [1, 2, 3, 4].map(i => `up-${core}${i}`)) expect(ranks[id]).toBe(0);
    for (const id of [`hub-${core}1`, `hub-${core}2`]) expect(ranks[id]).toBe(2);
    for (const id of [...[1, 2, 3, 4].map(i => `mid-${core}${i}`), `leaf-${core}1`, `leaf-${core}2`]) expect(ranks[id]).toBe(1);
  });
});

describe('two-pole ranks in the layout', () => {
  it('the links of a downward anchor to the tier below take no lane', async () => {
    const model = await run(ONE_RULE);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.lanes.filter(lane => lane.owner.kind === 'link')).toEqual([]);
  });

  it('the twin: no link from a hub to the tier below takes a lane or crosses a rank row', async () => {
    const model = await run(TWIN);
    expect(model.removedLinks ?? []).toEqual([]);
    const hubLinks = new Set(model.links.filter(link => link.attachments!.from.node.startsWith('hub-') && link.attachments!.to.node.startsWith('node-')).map(link => link.id));
    expect(hubLinks.size).toBe(28);
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && hubLinks.has(lane.owner.id))).toEqual([]);
    // Three sub-tiers hold each core, so the hubs stand on the last one and no rank row lies between them and the tier below.
    expect(model.tierBands.filter(band => band.groups.some(id => id.startsWith('core-'))).length).toBe(3);
  });

  it('the twin: the known gate state of the staged sheet (G5 and G6 only), to be removed when tickets 04, 05 and 06 make it clean', async () => {
    const model = await run(TWIN);
    const gates = score(model).snapshot.gates;
    const failing = Object.entries(gates).filter(([, gate]) => gate.violations.length > 0).map(([id, gate]) => [id, gate.violations.map(item => item.code)]);
    // Measured: one port-order violation (ticket 05, far-end order) and four parallel-clearance pairs between same-tier links (ticket 06).
    expect(failing).toEqual([['G5', ['port-order']], ['G6', ['parallel-clearance', 'parallel-clearance', 'parallel-clearance', 'parallel-clearance']]]);
  });
});
