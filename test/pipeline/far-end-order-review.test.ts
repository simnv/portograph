import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreFinalLayout } from '../../src/internal.js';
import * as gap from '../../src/layout/gap-room.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { PlacementRefusal, PostconditionRefusal } from '../../src/layout/placement-refusal.js';
import { farEndOwner, engineSequence } from '../../src/layout/far-end-order.js';
import { farEndEntries } from '../../src/layout/reservations.js';
import { RouteDeadlineError } from '../../src/route/index.js';
import { CommandDeadlineError } from '../../src/pipeline/budget.js';
import { ElkDeadlineError } from '../../src/layout/elk-worker.js';
import { PlacementBudgetExceeded } from '../../src/pipeline/limits.js';
import { close } from '../../src/pipeline/round.js';
import { farEnd } from '../../src/pipeline/rounds.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 07, review 1 (`.scratch/dense-16x9/design/07a-review-1.md`): the round withdraws a trial on a named refusal only; restore refuses a far-end record that no ledger
 * backs or that a second owner holds; the judge reads the published canvas; the budget is the round's own and bounded.
 */
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const forge = (model: LayoutModel, edit: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; edit(copy); return JSON.stringify(copy); };

describe('finding 1: a trial is withdrawn on a named refusal only (R4, R6)', () => {
  const tolerates = (error: unknown, phase: 'place' | 'bands'): boolean => farEnd.tolerates(error, phase);
  it('propagates every deadline, the placement budget and a plain error, at both phases', () => {
    for (const phase of ['place', 'bands'] as const) {
      expect(tolerates(new RouteDeadlineError(1), phase)).toBe(false);
      expect(tolerates(new ElkDeadlineError(1), phase)).toBe(false);
      expect(tolerates(new CommandDeadlineError(0, 'route'), phase)).toBe(false);
      expect(tolerates(new PlacementBudgetExceeded(5), phase)).toBe(false);
      expect(tolerates(new Error('The tier-gap solve moved a node in x'), phase)).toBe(false);
    }
  });
  it('withdraws a trial on a named placement refusal', () => {
    expect(tolerates(new PlacementRefusal('ledger', 'FAR_END_ORDER_DECLINED: x'), 'place')).toBe(true);
    expect(tolerates(new PlacementRefusal('stagger', 'a stagger refusal'), 'bands')).toBe(true);
  });
  const env = (route: () => Promise<never>, bands: () => Promise<never> = async () => ({ model: {}, moved: false, unmoved: undefined }) as never): never => ({
    options: {}, bands, route, timed: (_label: string, run: () => unknown) => run() }) as never;
  const opened = { ledger: [], trial7e: { freeze: undefined } as never };
  const offer = { faces: [], current: {} as never, decisions: new Map(), split: false };
  const state = { sideNotes: [], farEnd: undefined } as never;
  it('close() lets a router deadline end the command instead of picking the old drawing', async () => {
    await expect(close(env(async () => { throw new RouteDeadlineError(1); }), state, farEnd, offer, opened)).rejects.toBeInstanceOf(RouteDeadlineError);
  });
  it('close() lets a plain error of 7f propagate, and answers a producer refusal of 7f with a refusal', async () => {
    await expect(close(env(async () => ({}) as never, async () => { throw new Error('plain defect'); }), state, farEnd, offer, opened)).rejects.toThrow('plain defect');
    const refused = await close(env(async () => ({}) as never, async () => { throw new PostconditionRefusal('bands', [{ kind: 'tier-gap solve', subject: 'n', detail: 'moved in x; a move in y may move no x' }]); }), state, farEnd, offer, opened);
    expect(refused).toMatchObject({ at: 'bands' });
    expect(refused!.why).toMatch(/moved in x/);
  });
  it('drives the real x move of the tier-gap solve into a typed refusal, and the round declines the trial (review 2)', async () => {
    // The unchanged sheet: the far-end trial of `core-sw.bottom` makes the tier-gap solve move two nodes in x. On 697f438a that was a plain `Error`; it is a named producer refusal now.
    // The spy calls the real solve and rethrows what it threw.
    const original = gap.solveTierGaps, thrown: unknown[] = [], events: Record<string, unknown>[] = [];
    const spy = vi.spyOn(gap, 'solveTierGaps').mockImplementation((...args) => {
      try { return original(...args); } catch (error) { thrown.push(error); throw error; }
    });
    let model: LayoutModel;
    try {
      model = await layout(parse(golden('a-single-feed-port-follows-its-child-over-a-pushed-row')), { ...options, testSideTrace: event => { if (event.ev === 'far-end-refused') events.push(event); } });
    } finally { spy.mockRestore(); }
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(PostconditionRefusal);
    expect(thrown[0]).toMatchObject({ code: 'postcondition', rule: 'bands' });
    expect((thrown[0] as Error).message).toMatch(/tier-gap solve .*moved in x; a move in y may move no x/);
    expect(events).toHaveLength(1);
    expect(events[0]!.why).toMatch(/tier-gap solve/);
    expect(model.diagnostics.some(item => item.code === 'FAR_END_ORDER_DECLINED')).toBe(true);
    // The baseline publishes, with its own G5 failure, and restores.
    expect(model.farEndOrder ?? []).toEqual([]);
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 180000);
});

describe('findings 2 and 3: restore backs the far-end record by a ledger and one owner', () => {
  const lay = (name: string): Promise<LayoutModel> => layout(parse(golden(name)), options);
  it('refuses a record whose ledger is gone altogether, not only one with its entries removed', async () => {
    const on = await lay('far-ends-cross-after-centring');
    expect(on.freeze!.farEndOrder!.length).toBeGreaterThan(0);
    expect(() => restoreFinalLayout(forge(on, copy => { delete copy.reservations; }))).toThrow(/far-end order of the model has no reservation ledger/);
  });
  it('refuses a face that the record names twice', async () => {
    const on = await lay('far-ends-cross-after-centring');
    expect(() => restoreFinalLayout(forge(on, copy => {
      const face = copy.freeze!.farEndOrder![0]!;
      for (const list of [copy.freeze!.farEndOrder!, copy.farEndOrder!]) list.push(JSON.parse(JSON.stringify(face)));
    }))).toThrow(/twice|held twice|far-end/);
  });
  const BLOCKS = ['a-solid-block-prototype-keeps-all-members-straight', 'a-solid-block-enters-beside-a-foreign-group', 'a-solid-block-spans-two-far-groups', 'a-capped-solid-block-prototype-keeps-foreign-boxes'];
  it.each(BLOCKS)('never seats a block-owned face, and refuses a forged record that names one (%s)', async name => {
    const model = await lay(name);
    const owned: { node: string; side: 'top' | 'right' | 'bottom' | 'left' }[] = [];
    for (const node of Object.values(model.nodes)) for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      if (node.ports.filter(port => port.side === side).length > 1 && farEndOwner(model, node.id, side) === 'block') owned.push({ node: node.id, side });
    }
    for (const face of model.freeze?.farEndOrder ?? []) expect(owned.some(item => item.node === face.node && item.side === face.side)).toBe(false);
    if (owned.length === 0) return;
    const face = owned[0]!, ports = engineSequence(model, face.node, face.side)!;
    const entry = farEndEntries([{ ...face, ports }], 'farEnd', 9);
    expect(() => restoreFinalLayout(forge(model, copy => {
      copy.reservations = [...(copy.reservations ?? []), ...JSON.parse(JSON.stringify(entry))];
      copy.farEndOrder = [{ ...face, ports }];
      copy.freeze!.farEndOrder = [{ ...face, ports }];
    }))).toThrow(/belongs to a block/);
  });
  it('owns the whole face of a block: a foreign link on a slot beside the members does not free the face', async () => {
    const text = golden('a-solid-block-prototype-keeps-all-members-straight').replace('  upper: { tier: 0 }', '  upper: { tier: 0 }\n  lone: { tier: 0 }').replace('  leaf0: {', '  outsider: { group: lone, class: router }\n  leaf0: {').replace('links:\n', 'links:\n  - { from: outsider, to: leaf0 }\n');
    const model = await layout(parse(text), options);
    const solid = new Set((model.fanFamilies ?? []).filter(family => family.kind === 'solid').map(family => family.id));
    expect(solid.size).toBeGreaterThan(0);
    const face = model.nodes['leaf0']!.ports.find(port => port.side === 'top')!.side!;
    const onFace = model.links.filter(link => link.attachments && [link.attachments.from, link.attachments.to].some(ref => ref.node === 'leaf0'));
    expect(onFace.some(link => link.fanFamily !== undefined && solid.has(link.fanFamily))).toBe(true);
    expect(onFace.some(link => link.fanFamily === undefined || !solid.has(link.fanFamily))).toBe(true);
    expect(farEndOwner(model, 'leaf0', face)).toBe('block');
  });
});

describe('finding 3: a recorded turn-order face is never seated by the far-end order', () => {
  it('refuses a forged record that names a face of freeze.turnOrder', async () => {
    const model = await layout(parse(golden('two-skirts-from-one-face-nest')), options);
    const turned = model.freeze!.turnOrder![0]!;
    const ports = engineSequence(model, turned.node, turned.side)!;
    expect(farEndOwner(model, turned.node, turned.side)).toBe('turn');
    expect(() => restoreFinalLayout(forge(model, copy => {
      copy.reservations = [...(copy.reservations ?? []), ...JSON.parse(JSON.stringify(farEndEntries([{ node: turned.node, side: turned.side, ports }], 'farEnd', 9)))];
      copy.farEndOrder = [{ node: turned.node, side: turned.side, ports }];
      copy.freeze!.farEndOrder = [{ node: turned.node, side: turned.side, ports }];
    }))).toThrow(/turn order/);
  });
});

describe('finding 4: the judge reads the published canvas', () => {
  it('names the growth of the published canvas in the note of a kept trial, as the sheet publishes it', async () => {
    const off = await layout(parse(golden('far-ends-cross-after-centring')), { ...options, testFarEndOrder: false });
    const on = await layout(parse(golden('far-ends-cross-after-centring')), options);
    const note = on.diagnostics.find(item => item.code === 'FAR_END_ORDER_TAKEN')!;
    const was = off.canvas!, now = on.canvas!;
    expect(now.width * now.height).toBeGreaterThan(was.width * was.height);
    expect(note.message).toContain(`the published canvas grows from ${Math.round(was.width)}x${Math.round(was.height)} to ${Math.round(now.width)}x${Math.round(now.height)} px`);
  });
});

describe('finding 5: the budget is the round\'s own, bounded, and a sheet with no stale face pays nothing', () => {
  it('makes no far-end start on a sheet whose faces all stand in far-end order', async () => {
    resetAttemptCounters();
    const model = await layout(parse(golden('a-shared-end-reads-its-port-order')), options);
    expect(score(model).snapshot.gates.G5.violations).toEqual([]);
    expect(attemptCounters.farEndStarts).toBe(0);
  });
  it('stops at the count it is given, names the faces it did not try, and never exceeds FAR_END_ORDER_RUNS', async () => {
    resetAttemptCounters();
    const limited = await layout(parse(golden('a-grid-group-stands-fixed-beside-frames')), { ...options, testFarEndRuns: 1, testLiftOff: true });
    expect(attemptCounters.farEndStarts).toBeLessThanOrEqual(1);
    resetAttemptCounters();
    await layout(parse(golden('a-grid-group-stands-fixed-beside-frames')), { ...options, testLiftOff: true });
    expect(attemptCounters.farEndStarts).toBeLessThanOrEqual(4);
    expect(limited.diagnostics.filter(item => item.code.startsWith('FAR_END_ORDER')).length).toBeGreaterThan(0);
  }, 120000);
});
