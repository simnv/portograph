import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { farEndDecisionsOf } from '../../src/layout/reservations.js';
import { routedLinksOf } from '../../src/layout/far-end-order.js';
import { readFaces, staleFarEndDecisions } from '../../src/layout/far-end-faults.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 49 (owner ruling 2026-11-18: the whole-sheet measure wins): a far-end order that a full trial measures worse is declined once and
// recorded (`farEndDecision`); G5, the far-end round and the publication read the face through one reader (`readFace`).
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const sweep = (name: string): string => readFileSync(new URL(`../fixtures/sweep/${name}.yaml`, import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), options);
const g5 = (model: LayoutModel): string[] => score(model).snapshot.gates.G5.violations.map(item => `${item.code} ${item.elements.join(',')}`);
const withSeats = (yaml: string): string => { const sheet = readYaml(yaml) as Record<string, unknown>; sheet.layout = { ...(sheet.layout as object ?? {}), moveBeforeGrow: true }; return writeYaml(sheet); };
const reversedNodes = (yaml: string): string => { const sheet = readYaml(yaml) as { nodes: Record<string, unknown> }; sheet.nodes = Object.fromEntries(Object.entries(sheet.nodes).reverse()); return writeYaml(sheet); };
const FIXTURE = 'a-far-end-order-a-full-trial-measures-worse-is-decided-once';

describe('a far-end order a full trial measures worse is decided once (dense-16x9 ticket 49)', () => {
  it('records the decision, and G5 accepts the face while the record holds', async () => {
    const model = await run(text(FIXTURE));
    const decisions = farEndDecisionsOf(model.reservations ?? []);
    expect(decisions.length).toBeGreaterThan(0);
    for (const { payload } of decisions) {
      expect(payload.reason).toBe('unified');
      expect(payload.tallies).toBeDefined();
      expect(payload.pairs.length).toBeGreaterThan(0);
    }
    expect(model.diagnostics.some(item => item.code === 'FAR_END_ORDER_DECLINED')).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'FAR_END_DECISION_STALE')).toEqual([]);
    expect(staleFarEndDecisions(model, routedLinksOf(model))).toEqual([]);
    expect(g5(model)).toEqual([]);
    // The decided face still stands the wrong way round by its far ends: the record, not the geometry, passes it.
    const decided = readFaces(model, routedLinksOf(model)).filter(face => face.record?.kind === 'decision');
    expect(decided.length).toBe(decisions.length);
    expect(decided.every(face => face.wrong.length > 0 && !face.fails)).toBe(true);
    // The saved layout restores with the record.
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('a stale or forged record buys nothing (R5)', async () => {
    const model = await run(text(FIXTURE));
    const saved = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const entry = saved.reservations!.find(item => item.kind === 'farEndDecision')!;
    // A record whose pairs differ from the face: G5 judges the face again.
    const stale = JSON.parse(JSON.stringify(saved)) as LayoutModel;
    const forged = stale.reservations!.find(item => item.id === entry.id) as unknown as { payload: { pairs: string[][] } };
    forged.payload.pairs = [[...forged.payload.pairs[0]!].reverse()];
    const restored = restoreLayoutModel(JSON.stringify(stale));
    expect(g5(restored).length).toBeGreaterThan(0);
    expect(staleFarEndDecisions(restored, routedLinksOf(restored)).map(item => item.why)).toEqual(['the far ends no longer stand in the recorded order']);
    // A record that names a port the face does not hold is refused at restore.
    const missing = JSON.parse(JSON.stringify(saved)) as LayoutModel;
    const named = missing.reservations!.find(item => item.id === entry.id) as unknown as { payload: { pairs: string[][] } };
    named.payload.pairs = [['nowhere', named.payload.pairs[0]![1]!]];
    expect(() => restoreLayoutModel(JSON.stringify(missing))).toThrow(/names a port it does not hold/);
  }, 120000);

  // The census cases of ticket 49 class A with `layout.moveBeforeGrow`: the seats move the far ends after stage 5, the trial is declined, G5 reads the decision.
  for (const [name, form] of [['v7-0-0', 'as written'], ['v5-0-1', 'nodes reversed']] as const) {
    it(`no G5 with the option on: ${name}, ${form}`, async () => {
      const yaml = withSeats(sweep(name));
      const model = await run(form === 'as written' ? yaml : reversedNodes(yaml));
      expect(g5(model)).toEqual([]);
      expect(farEndDecisionsOf(model.reservations ?? []).length).toBeGreaterThan(0);
    }, 120000);
  }
});
