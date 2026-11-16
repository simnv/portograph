import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreFinalLayout } from '../../src/internal.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { staleFaces } from '../../src/layout/far-end-order.js';
import { FAR_END_ORDER_RUNS } from '../../src/pipeline/limits.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * Dense-16x9 ticket 07: far-end order from final positions. Stage 5 sorts a face by the far ends as they stand then and 7c to 7f move them; the far-end round reads the final
 * positions of a completed placement, reserves the order of every face that fails G5 and places once more. Each fixture is one rule, under generic names.
 */
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const g5 = (model: LayoutModel): number => score(model).snapshot.gates.G5.violations.length;
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const FIXTURES = ['far-ends-cross-after-centring', 'far-ends-cross-after-close-up', 'far-order-rebuilds-stems'];

describe.each(FIXTURES)('%s', name => {
  it('fails G5 with the far-end round off and passes it with the round on, with no crossing added', async () => {
    const off = await layout(parse(sheet(name)), { ...options, testFarEndOrder: false });
    const on = await layout(parse(sheet(name)), options);
    expect(g5(off)).toBeGreaterThan(0);
    expect(off.freeze?.farEndOrder).toBeUndefined();
    expect(g5(on)).toBe(0);
    expect(codes(on)).toContain('FAR_END_ORDER_TAKEN');
    expect(score(on).snapshot.counts.routed.crossings).toBeLessThanOrEqual(score(off).snapshot.counts.routed.crossings);
    expect(score(on).snapshot.counters.removedLinks).toBe(0);
  });

  it('records the seated faces, which are no turn-ordered faces, and restores', async () => {
    const on = await layout(parse(sheet(name)), options);
    const record = on.freeze!.farEndOrder!;
    expect(record.length).toBeGreaterThan(0);
    expect(on.farEndOrder).toEqual(record);
    expect(on.reservations!.filter(item => item.kind === 'farEndOrder')).toHaveLength(record.length);
    const turned = new Set((on.freeze!.turnOrder ?? []).map(face => `${face.node}|${face.side}`));
    for (const face of record) expect(turned.has(`${face.node}|${face.side}`)).toBe(false);
    expect(restoreFinalLayout(JSON.stringify(on)).freeze!.farEndOrder).toEqual(record);
    expect(staleFaces(on)).toEqual([]);
  });

  it('refuses a forged record: another order, a record that the model does not carry, a ledger without it', async () => {
    const on = await layout(parse(sheet(name)), options);
    const forge = (change: (model: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(on)) as LayoutModel; change(copy); return JSON.stringify(copy); };
    expect(() => restoreFinalLayout(forge(model => { model.freeze!.farEndOrder![0]!.ports.reverse(); }))).toThrow(/far-end order/i);
    expect(() => restoreFinalLayout(forge(model => { delete model.freeze!.farEndOrder; }))).toThrow(/far-end order/i);
    expect(() => restoreFinalLayout(forge(model => { delete model.farEndOrder; }))).toThrow(/far-end order/i);
    expect(() => restoreFinalLayout(forge(model => { model.reservations = model.reservations!.filter(item => item.kind !== 'farEndOrder'); }))).toThrow(/far-end order/i);
  });

  it('grants no G5 exemption: a model that carries the record and stands out of order still fails', async () => {
    const off = await layout(parse(sheet(name)), { ...options, testFarEndOrder: false });
    // A forged note and a record for the stale face do not excuse it: G5 reads the geometry (R5).
    const stale = staleFaces(off)[0]!;
    const forged = JSON.parse(JSON.stringify(off)) as LayoutModel;
    forged.diagnostics.push({ stage: 'placement', severity: 'info', code: 'FAR_END_ORDER_TAKEN', message: 'forged', owners: [{ kind: 'node', id: stale.node }] });
    expect(g5(forged)).toBeGreaterThan(0);
  });

  it('is the same layout on a second run and whatever the order of the links (R3); the order of the nodes is author input and the round still repairs it', async () => {
    const text = sheet(name);
    const json = async (source: string): Promise<string> => JSON.stringify((await layout(parse(source), options)).links.map(link => [link.id, link.path?.segments.map(segment => [segment.from, segment.to])]));
    const base = await json(text);
    expect(await json(text)).toBe(base);
    expect(await json(reversed(text, 'links') as string)).toBe(base);
    expect(g5(await layout(parse(reversed(text, 'nodes') as string), options))).toBe(0);
  });

  it('spends starts of its own: at most FAR_END_ORDER_RUNS, and the command keeps its MAX_RERUNS', async () => {
    resetAttemptCounters();
    await layout(parse(sheet(name)), options);
    expect(attemptCounters.farEndStarts).toBeGreaterThan(0);
    expect(attemptCounters.farEndStarts).toBeLessThanOrEqual(FAR_END_ORDER_RUNS);
  });
});
