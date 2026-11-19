import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layout, parse, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import { CommandDeadlineError, growthShort } from '../../src/pipeline/index.js';
import * as growth from '../../src/layout/read/move-before-grow.js';
import { MOVE_BEFORE_GROW_CHOICE, MOVE_BEFORE_GROW_TRIAL_SKIPPED, growthChoiceTest, judgeGrowthChoice, moveBeforeGrowDefaultTest, trialSkippedMessage } from '../../src/layout/read/move-before-grow.js';
import { added, gateFindings } from '../../src/layout/trial-findings.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { resolve } from '../../src/resolve/index.js';
import type { Diagnostic, LayoutModel, LayoutNode, LayoutPort, NormalisedDocument } from '../../src/model/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * The guards of the growth choice after review 2 of dense-16x9 ticket 60: a G5 finding keeps its face (item 1), the budget is read right before an off
 * run is committed (item 2), the trigger reads the notes the run wrote, and an absent bend count is no bend (item 3), a cause that cannot be printed
 * or is wrapped deep is named safely (item 4), and the record check wants a final model and a message (item 5).
 */
const factories = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
afterEach(() => { delete moveBeforeGrowDefaultTest.on; delete growthChoiceTest.beforeTrial; vi.restoreAllMocks(); });

const sheet = (path: string): NormalisedDocument => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const written = (document: NormalisedDocument, on: boolean): NormalisedDocument => ({ ...document, layout: { ...document.layout, moveBeforeGrow: on } });
const json = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model)) as LayoutModel;
const LEAF = 'goldens/synthetic/a-leaf-child-and-its-beside-cells-stay-one-row.yaml';
const FIXTURE = 'goldens/synthetic/a-child-under-two-parents-grows-when-the-whole-sheet-is-better.yaml';
const skipped = (model: LayoutModel): Diagnostic[] => model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_TRIAL_SKIPPED);

describe('the growth choice after review 2 (dense-16x9 ticket 60)', () => {
  it('item 1: one authored reversal on the top face against one on the bottom face is a new finding, and the published finding is unchanged', async () => {
    // The reviewer's equal-count face swap: the scorer publishes the node alone for both.
    const on = json(await layout(written(sheet(LEAF), true), factories)), off = json(await layout(written(sheet(LEAF), false), factories));
    for (const [model, reversed] of [[on, 'top'], [off, 'bottom']] as const) {
      const base = Object.values(model.nodes)[0]!, probe = JSON.parse(JSON.stringify(base)) as LayoutNode;
      probe.id = 'probe'; probe.bounds = { x: 30000, y: 20000, width: 160, height: 70 }; probe.ports = [];
      (probe as unknown as { owner: unknown }).owner = { kind: 'node', id: 'probe' };
      for (const side of ['top', 'bottom'] as const) for (let i = 0; i < 2; i++) {
        probe.ports.push({ ...JSON.parse(JSON.stringify(base.ports[0]!)) as LayoutPort, ref: { node: 'probe', anonymous: true, ordinal: (side === 'top' ? 1 : 3) + i },
          owner: { kind: 'node', id: 'probe' }, side, anchor: { x: 30032 + (side === reversed ? 1 - i : i) * 50, y: side === 'top' ? 20000 : 20070 }, authorOrder: i } as LayoutPort);
      }
      model.nodes.probe = probe;
    }
    const published = (model: LayoutModel) => score(model, { force: true }).snapshot.gates.G5!.violations.filter(item => item.elements[0] === 'probe');
    // The published finding is what it was: the code, the node and the text, and no more fields.
    for (const model of [on, off]) expect(JSON.parse(JSON.stringify(published(model)))).toEqual([{ code: 'author-port-order', elements: ['probe'], message: 'Physical port order reverses unequal authored keys' }]);
    expect(added(gateFindings(off, 'error')!.findings, gateFindings(on, 'error')!.findings)).toEqual(['G5|author-port-order|probe|bottom']);
    expect(judgeGrowthChoice(on, off).keep).toBe('on');
  }, 240000);

  it('item 2: a budget that runs out while the trial is judged keeps the option-on run, named', async () => {
    // The reviewer's late probe: the real judge finishes, then the budget is at zero before the choice is committed.
    moveBeforeGrowDefaultTest.on = true;
    let expired = false;
    const judge = growth.judgeGrowthChoice;
    vi.spyOn(growth, 'judgeGrowthChoice').mockImplementation((a, b) => { const verdict = judge(a, b); expired = true; return verdict; });
    const model = await layout(sheet(FIXTURE), { ...factories, budget: { remainingMs: () => (expired ? 0 : 1e7), share: ms => (expired ? 0 : ms) } });
    expect(expired).toBe(true);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(skipped(model).map(note => [note.severity, note.message]))
      .toEqual([['info', trialSkippedMessage({ code: 'deadline', message: 'the command budget ran out while the trial was judged' })]]);
  }, 240000);

  it('item 3: a caller that passes the genuine notes neither suppresses the trial nor loses its notes, and a removed link is not bent', async () => {
    // The reviewer's replay: the strict run's two CENTRE_ALIGNMENT_INFEASIBLE notes, passed back as they are and as parse copies.
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet(FIXTURE), on = await layout(written(document, true), factories);
    const notes = on.diagnostics.filter(note => note.code === 'CENTRE_ALIGNMENT_INFEASIBLE' || note.code === 'SEAT_SET_DECLINED');
    expect(notes.length).toBeGreaterThan(0);
    for (const extra of [[], notes, notes.map(note => ({ ...note, stage: 'parse' as const }))]) {
      let trials = 0;
      growthChoiceTest.beforeTrial = () => { trials++; };
      const model = await layout(document, { ...factories, diagnostics: extra });
      expect(trials).toBe(1);
      expect(model.moveBeforeGrowRun?.effective).toBe('off');
      expect(model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_CHOICE)).toHaveLength(1);
      // The caller's notes publish ahead of the run's, as `resolve` puts them.
      expect(model.diagnostics.slice(0, extra.length)).toEqual(JSON.parse(JSON.stringify(extra)));
      expect(() => restoreFinalLayout(serializeLayoutModel(model))).not.toThrow();
    }
    // A named link that the route removed has no bend count: it fires nothing.
    const removed = json(await layout(written(sheet(LEAF), true), factories)), link = removed.links.find(item => item.path !== undefined)!;
    delete link.path; link.removed = true; removed.removedLinks = [link.id];
    removed.diagnostics = [{ stage: 'placement', code: 'CENTRE_ALIGNMENT_INFEASIBLE', severity: 'warning', message: 'short', owners: [{ kind: 'link', id: link.id }] }];
    expect(growthShort(removed)).toBe(false);
  }, 240000);

  it('item 4: a thrown value with no toString, a deadline under nine wrappers and a cyclic cause are named safely', async () => {
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet(FIXTURE);
    // The reviewer's public callback replay: the progress callback throws a null-prototype object during the off run's resolve stage.
    let inside = false;
    growthChoiceTest.beforeTrial = () => { inside = true; };
    const bare = Object.assign(Object.create(null) as object, { code: 'backend unavailable' });
    const unprintable = await layout(document, { ...factories, onProgress: progress => { if (inside && progress.stage === 'resolve') throw bare; } });
    expect(inside).toBe(true);
    expect(unprintable.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(skipped(unprintable).map(note => [note.severity, note.message]))
      .toEqual([['warning', trialSkippedMessage({ code: 'unknown', message: 'a thrown value that cannot be printed' })]]);
    // A deadline under nine wrappers is a spent budget; a cause chain that loops ends and is a warning.
    const deep = Array.from({ length: 9 }).reduce<unknown>(previous => new Error('outer', { cause: previous }), new CommandDeadlineError(10, 'test'));
    const looped = new Error('first'), second = new Error('second', { cause: looped });
    (looped as { cause?: unknown }).cause = second;
    const rows: [string, string][] = [];
    for (const thrown of [deep, looped]) {
      growthChoiceTest.beforeTrial = () => { throw thrown; };
      const model = await layout(document, factories);
      rows.push(...skipped(model).map(note => [note.severity, note.message] as [string, string]));
    }
    expect(rows).toEqual([['info', trialSkippedMessage({ code: 'deadline', message: 'Command deadline of 10 ms reached before test' })],
      ['warning', trialSkippedMessage({ code: 'Error', message: 'first' })]]);
  }, 240000);

  it('item 5: the record check refuses a skipped-trial note on a resolve model and one without its message', async () => {
    moveBeforeGrowDefaultTest.on = true;
    growthChoiceTest.beforeTrial = () => { throw new TypeError('trial worker smoke'); };
    const saved = json(await layout(sheet(FIXTURE), factories));
    expect(skipped(saved)).toHaveLength(1);
    expect(() => restoreLayoutModel(JSON.stringify(saved))).not.toThrow();
    const blank = JSON.parse(JSON.stringify(saved)) as LayoutModel;
    delete (skipped(blank)[0] as { message?: string }).message;
    expect(() => restoreLayoutModel(JSON.stringify(blank))).toThrow(/a skipped-trial note without a message/);
    const early = JSON.parse(JSON.stringify(resolve(saved.document))) as LayoutModel;
    early.moveBeforeGrowRun = { requested: 'default', effective: 'on' };
    early.diagnostics.push({ stage: 'placement', severity: 'info', code: MOVE_BEFORE_GROW_TRIAL_SKIPPED, message: 'arbitrary' });
    expect(() => restoreLayoutModel(JSON.stringify(early))).toThrow(/skipped-trial note on a .* model, which is no final layout/);
  }, 240000);
});
