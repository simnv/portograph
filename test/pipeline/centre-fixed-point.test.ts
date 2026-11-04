import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { bars, bundles, centre, createCentreBudget, flanks, lanes, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { centreDraft } from '../../src/layout/centre.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

/**
 * Ticket 75. A centring run ends when a pass changes no geometry. A group whose alignment is infeasible has its
 * `CENTRE_ALIGNMENT_INFEASIBLE` warning and does not keep the run going, and it is not a stall.
 */
const calls = vi.hoisted(() => [] as { stage: string; passes: number; remaining?: number; off?: number; stall?: boolean }[]);
// When `read.off` is set, each call also records what the publication check finds where the call left the model, and the budget it left.
const read = vi.hoisted(() => ({ off: false }));
vi.mock('../../src/layout/centre.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/centre.js')>();
  return { ...original, centreDraft: (model: LayoutModel, budget: { remaining: number; passes: number }): void => {
    const before = budget.passes;
    original.centreDraft(model, budget);
    calls.push({ stage: model.stage, passes: budget.passes - before, ...(read.off ? {
      remaining: budget.remaining, off: original.centreViolations(model, true).length,
      stall: model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE') } : {}) });
  } };
});

const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

describe('centring ends at a fixed point (ticket 75)', () => {
  beforeEach(() => { calls.length = 0; });

  it('a-one-node-title-over-a-skewed-leg-widens-the-group: the replays after 7c end after one pass', async () => {
    const placedModel = flanks(lanes(rows(await placed(golden('a-one-node-title-over-a-skewed-leg-widens-the-group')))));
    const bundled = bundles(bars(centre(placedModel)));
    // Every replay the rules after 7c run (the producer of a stage rebuilds through `centreDraft`) ends after its first pass; it was 8 before.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map(call => call.passes)).toEqual(calls.map(() => 1));
    expect(bundled.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
  }, 60000);

  it('the whole layout of the fixture reports no stall and no group with a spent budget', async () => {
    const model = await layout(parse(golden('a-one-node-title-over-a-skewed-leg-widens-the-group')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'CENTRE_INVARIANT_UNVERIFIED')).toEqual([]);
  }, 120000);

  it('a group with an infeasible alignment that holds still is settled: warned once, no stall, one pass', async () => {
    // Two child groups side by side under one parent: the right one cannot reach its feed for the left one, and holds its place on every pass.
    const model = centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {up: {tier: 0}, left: {tier: 1}, right: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: up, ports: [{name: p, side: bottom}]}
  c: {group: left, ports: [{name: p, side: top}]}
  d: {group: right, ports: [{name: p, side: top}]}
links: [[a.p, c.p], [b.p, d.p]]`)))));
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
  }, 60000);

  it('geometry that really oscillates still spends the budget and reports the stall', async () => {
    // Two ordered child ports whose parents stand in the opposite order: the group jumps 42.75 px on every pass.
    const input = flanks(lanes(rows(await placed(withoutJointOrder(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: up, ports: [{name: p, side: bottom}]}
  spare: {group: up}
  c:
    group: low
    ports:
      - {name: p, side: top, order: 0}
      - {name: q, side: top, order: 1}
links: [[a.p, c.q], [b.p, c.p]]`)))));
    const budget = createCentreBudget();
    const model = withLayoutMutation(input, 'centre', draft => centreDraft(draft, budget));
    expect(budget).toEqual({ remaining: 0, passes: 8 });
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(1);
    expect(model.diagnostics.map(item => item.code)).toContain('CENTRE_ALIGNMENT_INFEASIBLE');
  }, 60000);

  // Snack-theme ticket 157. After the overlay windows, `centreDraft` runs the passes again while the publication check finds an alignment off its
  // feed. A round that changes neither the geometry nor what the check finds is a stall the passes cannot see: the rounds stop there, report it,
  // and keep the rest of the shared budget for the stages after 7c. On three-continents a replay at the bundles stage stands with link-26 7.2 px
  // off its feed and a round moves nothing; the rounds stop with 2 passes left. Before the stop, each round spent a pass until the budget was gone.
  it('a round that changes nothing stops the rounds, reports the stall and keeps the budget', async () => {
    read.off = true;
    try {
      // Architecture-2 ticket 54: three-continents converges since titles are placed last, so the stall is read on a sheet whose centring still stalls (three calls).
      await layout(parse(golden('a-frame-pack-stops-at-a-riser-lane')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    } finally { read.off = false; }
    const kept = calls.filter(call => call.off! > 0 && call.remaining! > 0);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every(call => call.stall)).toBe(true);
  }, 120000);
});
