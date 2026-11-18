import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { farEnd } from '../../src/pipeline/rounds.js';
import { judgeFarEndTrial } from '../../src/layout/far-end-measure.js';
import type { FarEndFace } from '../../src/layout/far-end-order.js';
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
    // A record whose pairs differ from the face: the reader judges the face again (G5), and restore refuses the record by name.
    const stale = JSON.parse(JSON.stringify(saved)) as LayoutModel;
    const forged = stale.reservations!.find(item => item.id === entry.id) as unknown as { payload: { pairs: string[][] } };
    forged.payload.pairs = [[...forged.payload.pairs[0]!].reverse()];
    expect(g5(stale).length).toBeGreaterThan(0);
    expect(staleFarEndDecisions(stale, routedLinksOf(stale)).map(item => item.why)).toEqual(['the far ends no longer stand in the recorded order']);
    expect(() => restoreLayoutModel(JSON.stringify(stale))).toThrow(/does not hold: the far ends no longer stand in the recorded order/);
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

// Ticket 49 review 1: what evidence may excuse a face. The reviewer's four reproductions.
describe('a far-end decision excuses a face only with the evidence that earned it (dense-16x9 ticket 49, review 1)', () => {
  type Taken = { model: LayoutModel; face: string };
  /** The routed baseline of a far-end trial that the round keeps, with its link labels, where the round takes the order of `node`'s face `side`. */
  const takenBaseline = async (yaml: string, node: string, side: string): Promise<Taken | undefined> => {
    let found: Taken | undefined;
    await layout(parse(yaml), { ...options, testSideTrace: (event: Record<string, unknown>) => {
      const verdict = event.verdict as { kept: boolean } | undefined, faces = event.faces as { node: string; side: string }[] | undefined;
      if (event.ev !== 'far-end-trial' || verdict?.kept !== true || found !== undefined || !faces?.some(face => face.node === node && face.side === side)) return;
      found = { model: JSON.parse(JSON.stringify(linkLabels(event.routedBase as LayoutModel))) as LayoutModel, face: `${node} ${side}` };
    } });
    return found;
  };
  const optioned = (yaml: string, on: boolean): string => { const sheet = readYaml(yaml) as Record<string, unknown>; sheet.layout = { ...(sheet.layout as object ?? {}), moveBeforeGrow: on }; return writeYaml(sheet); };
  const decisionOf = async (yaml: string, node: string, side: string) => {
    const entry = farEndDecisionsOf((await run(yaml)).reservations ?? []).find(item => item.payload.node === node && item.payload.side === side);
    expect(entry).toBeDefined();
    return entry!;
  };
  const transplanted = (taken: Taken, entry: unknown): string => JSON.stringify({ ...taken.model, reservations: [...(taken.model.reservations ?? []).filter(item => item.kind !== 'farEndDecision'), entry] });

  it('a decline of one run does not transfer to a run of the same input that takes the order (option off)', async () => {
    const input = reversedNodes(sweep('v5-0-1'));
    const donor = await decisionOf(optioned(input, true), 'snk1', 'top');
    const taken = await takenBaseline(optioned(input, false), 'snk1', 'top');
    expect(taken).toBeDefined();
    expect(() => restoreFinalLayout(transplanted(taken!, donor))).toThrow(/is of another input or other layout options/);
  }, 240000);

  it('a decline of one document does not transfer to another document', async () => {
    const donor = await decisionOf(optioned(sweep('v5-0-1'), false), 'snk1', 'top');
    const taken = await takenBaseline(optioned(sweep('v5-2-1'), true), 'snk1', 'top');
    expect(taken).toBeDefined();
    expect(() => restoreFinalLayout(transplanted(taken!, donor))).toThrow(/is of another input or other layout options/);
  }, 240000);

  it('restore refuses evidence that contradicts the verdict, a foreign owner or producer, and a reason outside the closed list', async () => {
    const good = await run(text(FIXTURE)), entry = farEndDecisionsOf(good.reservations ?? [])[0]!;
    const plain = await layout(parse(text(FIXTURE)), { ...options, testFarEndOrder: false });
    expect(g5(plain)).toEqual(['port-order src0']);
    type Forged = { owner: { id: string }; producer: string; payload: { tallies?: { trial: unknown }; reason: string; why: string } };
    const edits: [string, (item: Forged) => void, RegExp][] = [
      ['a trial better than its baseline', item => { item.payload.tallies!.trial = { routed: { bent: 0, turns: 0 }, overlay: { bent: 0, turns: 0 }, crossings: 0 }; }, /names no trial worse by the unified order/],
      ['no tallies', item => { delete item.payload.tallies; }, /names no trial worse by the unified order/],
      ['another owner and producer', item => { item.owner.id = 'src1'; item.producer = 'skeleton'; }, /is not the far-end round's own/],
      ['a free-text reason', item => { item.payload.reason = 'other'; item.payload.why = 'trial never started'; delete item.payload.tallies; }, /farEndDecision/],
    ];
    for (const [, edit, refused] of edits) {
      const forged = JSON.parse(JSON.stringify(entry)) as Forged;
      edit(forged);
      expect(() => restoreFinalLayout(JSON.stringify({ ...plain, reservations: [...(plain.reservations ?? []), forged] }))).toThrow(refused);
    }
    // The genuine record stands on the plain run of the same input: the same baseline the judge read.
    expect(g5(restoreFinalLayout(JSON.stringify({ ...plain, reservations: [...(plain.reservations ?? []), entry] })))).toEqual([]);
  }, 240000);

  it('a one-time ELK worker failure in the far-end trial writes no decision', async () => {
    let armed = false, failed = false;
    const events: string[] = [];
    const reserve = farEnd.reserve;
    const spy = vi.spyOn(farEnd, 'reserve').mockImplementation((...args: Parameters<typeof reserve>) => { armed = true; return reserve(...args); });
    try {
      const model = await layout(parse(text(FIXTURE)), { ...options, testSideTrace: (event: Record<string, unknown>) => { if (String(event.ev).startsWith('far-end')) events.push(`${String(event.ev)} ${String(event.why ?? '')}`); },
        createElkAttempt: () => {
          if (armed && !failed) { failed = true; return { layout: async () => { throw new Error('one-time worker failure'); }, terminateWorker() {} } as unknown as ReturnType<typeof createAttempt>; }
          return createAttempt();
        } });
      expect(failed).toBe(true);
      expect(events).toEqual(['far-end-refused ELK fell back during the far-end trial']);
      expect(farEndDecisionsOf(model.reservations ?? [])).toEqual([]);
      expect(g5(model)).toEqual(['port-order src0']);
      expect(g5(restoreFinalLayout(JSON.stringify(model)))).toEqual(['port-order src0']);
    } finally { spy.mockRestore(); }
  }, 120000);
});

// Ticket 49 review 2: no trial carries a decision, only a 7f refusal of 7f itself or a new error decides, and restore reads the proposal and measures the baseline.
describe('a far-end decision earns its evidence on the trial and holds it at restore (dense-16x9 ticket 49, review 2)', () => {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  type Entry = { payload: { ports: unknown[]; binding: { proposal: { ports: unknown[] }[] }; tallies: { base: unknown; trial: unknown } } };

  it('the final flat-gap trial places without the far-end decisions, and the sheet publishes all its links', async () => {
    const model = await run(readFileSync(new URL('../fixtures/staged/a-final-flat-gap-trial-places-without-far-end-decisions.yaml', import.meta.url), 'utf8'));
    expect(model.links.length).toBe(37);
    expect(model.removedLinks ?? []).toEqual([]);
    // The kept final fit moves the ports: the decision of `snk1` top is stale on the published sheet, named and not published.
    expect(model.diagnostics.filter(item => item.code === 'FLAT_BLOCK_GAP_FINAL').length).toBe(1);
    expect(model.diagnostics.filter(item => item.code === 'FAR_END_DECISION_STALE').map(item => item.owners)).toEqual([[{ kind: 'node', id: 'snk1' }]]);
    expect(farEndDecisionsOf(model.reservations ?? [])).toEqual([]);
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 240000);

  it('a worker failure in the replacement placement of a 7f seat retry decides nothing', async () => {
    let armed = false, done = false, remaining = 0, failures = 0;
    const reserve = farEnd.reserve;
    const spy = vi.spyOn(farEnd, 'reserve').mockImplementation((env, s, o) => {
      const out = reserve(env, s, o);
      if (!armed) {
        armed = true;
        const band = env.bands;
        // The first 7f of the trial reports one withdrawn seat set, so 7f places again; that placement's two ELK workers fail.
        env.bands = async (...args: Parameters<typeof band>) => {
          const banded = await band(...args);
          if (done) return banded;
          done = true; env.bands = band; remaining = 2;
          const row = Object.keys(banded.model.groups)[0]!;
          return { ...banded, model: { ...banded.model, reservations: [...banded.model.reservations ?? [], { kind: 'seatSetDeclined', payload: { row, at: 'bands', why: 'controlled withdrawal' } }] } } as typeof banded;
        };
      }
      return out;
    });
    try {
      const model = await layout(parse(withSeats(text(FIXTURE))), { ...options, createElkAttempt: () => {
        if (remaining > 0) { remaining--; failures++; return { layout: async () => { throw new Error('worker unavailable during replacement placement'); }, terminateWorker() {} } as unknown as ReturnType<typeof createAttempt>; }
        return createAttempt();
      } });
      expect(failures).toBe(2);
      expect(farEndDecisionsOf(model.reservations ?? []).map(entry => entry.payload.reason)).not.toContain('postcondition-7f');
      expect(g5(restoreFinalLayout(JSON.stringify(model)))).toContain('port-order src0');
    } finally { spy.mockRestore(); }
  }, 120000);

  it('a trial with a new warning and no new error decides nothing', async () => {
    let event: { routedBase: LayoutModel; routedTrial: LayoutModel; faces: FarEndFace[] } | undefined;
    const doc = parse(reversedNodes(sweep('v5-0-1')));
    doc.layout = { ...doc.layout, moveBeforeGrow: false };
    await layout(doc, { ...options, testSideTrace: (item: Record<string, unknown>) => {
      if (item.ev === 'far-end-trial' && (item.verdict as { kept: boolean }).kept && event === undefined) event = item as unknown as typeof event;
    } });
    expect(event).toBeDefined();
    const base = copy(event!.routedBase), trial = copy(event!.routedTrial), source = Object.values(base.nodes)[0]!;
    // 301 spare bodies make G3 a warning; one label over a spare body in the trial is one new warning and no new error.
    for (const model of [base, trial]) for (let at = 0; at < 301; at++) {
      const id = `spare${at}`;
      model.nodes[id] = { ...copy(source), id, owner: { kind: 'node', id }, ports: [], bounds: { x: 20000 + at * 200, y: 20000, width: 24, height: 24 } } as typeof source;
    }
    const label = trial.labels.find(item => item.role === 'node' && !item.omitted)!;
    trial.labels.push({ ...copy(label), id: 'review-label', bounds: { x: 20004, y: 20004, width: 8, height: 8 } });
    const verdict = judgeFarEndTrial(base, trial, new Map(), event!.faces, () => ({ width: 100, height: 100 }));
    expect(verdict.kept).toBe(false);
    expect(verdict.decline).toBeUndefined();
    const state = { kept: [], sideNotes: [] } as unknown as Parameters<typeof farEnd.refuse>[1];
    farEnd.refuse({ placements: 1, options: {} } as unknown as Parameters<typeof farEnd.refuse>[0], state, { current: base, faces: event!.faces, verdict, decisions: new Map(), split: false }, { at: 'verdict', why: verdict.reason });
    expect(farEndDecisionsOf(state.kept)).toEqual([]);
  }, 120000);

  it('restore refuses a proposal that asks for the standing order or names a face twice', async () => {
    const model = await run(text(FIXTURE));
    for (const [edit, refused] of [
      [(entry: Entry) => { entry.payload.binding.proposal[0]!.ports = copy(entry.payload.ports); }, /the proposal asks for the order that stands/],
      [(entry: Entry) => { entry.payload.binding.proposal.push(copy(entry.payload.binding.proposal[0]!)); }, /the proposal names a face twice/],
    ] as const) {
      const forged = copy(model), entry = forged.reservations!.find(item => item.kind === 'farEndDecision') as unknown as Entry;
      edit(entry);
      expect(g5(forged)).toContain('port-order src0');
      expect(() => restoreFinalLayout(JSON.stringify(forged))).toThrow(refused);
    }
  }, 120000);

  it('restore measures the baseline tally from the saved model', async () => {
    const model = await run(text(FIXTURE)), forged = copy(model), entry = forged.reservations!.find(item => item.kind === 'farEndDecision') as unknown as Entry;
    // The saved model measures 5 bent links, 10 turns and 3 crossings; a claimed baseline of 0/0/0 makes a better trial (4/8/0) look worse.
    entry.payload.tallies.base = { routed: { bent: 0, turns: 0 }, overlay: { bent: 0, turns: 0 }, crossings: 0 };
    entry.payload.tallies.trial = { routed: { bent: 4, turns: 8 }, overlay: { bent: 0, turns: 0 }, crossings: 0 };
    expect(() => restoreFinalLayout(JSON.stringify(forged))).toThrow(/names a baseline tally the model does not have/);
  }, 120000);
});
