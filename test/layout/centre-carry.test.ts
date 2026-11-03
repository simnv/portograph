import { describe, expect, it, vi } from 'vitest';
// Imported first: the mock of `columns.js` below must be the module `centre.js` binds, and the two modules are on one import cycle.
import { centreDraft, createCentreBudget } from '../../src/layout/centre.js';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { attemptCounters } from '../../src/layout/attempt-counters.js';
import { checkReadCaches, readCacheCounts } from '../../src/model/read-cache.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 62. At a chord stage a producer step that stood hands the chord readings it took after its move to the next step, which takes them as
 * its readings before. A step that is declined, or a group the pass does not centre, leaves no readings: the next step reads the model.
 */
// When `decline.on` is set, every read of the keep-out reports one more group than any read before it: each step then breaches a frame edge it did not
// breach before, and is declined.
const decline = vi.hoisted(() => ({ on: false, count: 0 }));
vi.mock('../../src/layout/columns.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/columns.js')>();
  return { ...original, keepOutShifts: (...args: Parameters<typeof original.keepOutShifts>) => {
    const shifts = original.keepOutShifts(...args);
    if (decline.on) shifts.set({ id: `ghost-${decline.count++}` } as never, 1);
    return shifts;
  } };
});

/**
 * Three child groups in a row under the anchor tier. The middle one has a feed of its own from the anchor tier, or only a link down to a fourth group
 * (no feed of its own: the pass clears it and does not step it).
 */
const sheet = (middle: boolean): string => `portograph: 2
groups: {up: {tier: 0}, one: {tier: 1}, two: {tier: 1}, three: {tier: 1}, low: {tier: 2}}
nodes:
  a1: {group: up, ports: [{name: p, side: bottom}]}
  a2: {group: up, ports: [{name: p, side: bottom}]}
  a3: {group: up, ports: [{name: p, side: bottom}]}
  a4: {group: up}
  a5: {group: up}
  c: {group: one, ports: [{name: p, side: top}, {name: q, side: bottom}]}
  d: {group: two, ports: [{name: p, side: top}, {name: q, side: bottom}]}
  e: {group: three, ports: [{name: p, side: top}, {name: q, side: bottom}]}
  f: {group: low, ports: [{name: p, side: top}, {name: q, side: top}, {name: r, side: top}]}
links: [[a1.p, c.p], ${middle ? '[a2.p, d.p], ' : ''}[a3.p, e.p], [c.q, f.p], [d.q, f.q], [e.q, f.r]]`;

/** The finished layout of `yaml`, copied so the producer can run on it again at its chord stage, and the carried and fresh steps of one run. */
async function rerun(yaml: string, declining = false): Promise<{ carried: number; fresh: number; model: LayoutModel }> {
  const model = JSON.parse(JSON.stringify(await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }))) as LayoutModel;
  const before = { ...attemptCounters.centreCarry };
  decline.on = declining;
  try { centreDraft(model, createCentreBudget()); } finally { decline.on = false; }
  return { carried: attemptCounters.centreCarry.carried - before.carried, fresh: attemptCounters.centreCarry.fresh - before.fresh, model };
}

describe('a centring step carries the chord readings of the step before it (ticket 62)', () => {
  it('a step after a step that stood carries; under the check the carried readings equal fresh ones', async () => {
    // One pass over one, two, three, then low on the next tier: the first step reads the model, the three after it carry.
    const run = await rerun(sheet(true));
    expect(run).toMatchObject({ carried: 3, fresh: 1 });
    const checked = readCacheCounts().centreCarry?.checked ?? 0;
    const model = JSON.parse(JSON.stringify(run.model)) as LayoutModel;
    await checkReadCaches(async () => centreDraft(model, createCentreBudget()));
    expect(readCacheCounts().centreCarry!.checked).toBeGreaterThan(checked);
  }, 120000);

  it('a step after a group the pass does not centre reads fresh', async () => {
    // The middle group has no feed of its own from the anchor tier: the pass clears it and does not step it, so the third group reads the model.
    // one reads fresh, two is cleared, three reads fresh, and low carries what three left.
    const run = await rerun(sheet(false));
    expect(run).toMatchObject({ carried: 1, fresh: 2 });
  }, 120000);

  it('a step after a declined step reads fresh', async () => {
    // Every step is declined: all four read the model.
    const run = await rerun(sheet(true), true);
    expect(run).toMatchObject({ carried: 0, fresh: 4 });
  }, 120000);
});
