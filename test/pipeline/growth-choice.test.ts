import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, parse, render, restoreFinalLayout, serializeLayoutModel } from '../../src/index.js';
import { growthShort } from '../../src/pipeline/index.js';
import type { Budget } from '../../src/pipeline/budget.js';
import { choiceMessage, growthChoiceTest, judgeGrowthChoice, MOVE_BEFORE_GROW_CHOICE, moveBeforeGrowDefaultTest } from '../../src/layout/read/move-before-grow.js';
import type { LayoutModel, NormalisedDocument } from '../../src/model/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 60 (owner ruling 2026-11-19, "whole-sheet choice, narrow the trigger"): a sheet that does not write `layout.moveBeforeGrow`
 * runs with it on while the default is on. When that run leaves a seat short (`growthShort`), the whole input runs once more with the option off,
 * and the run that is better on the whole sheet by the unified order, with no new error-gate finding, publishes (`judgeGrowthChoice`). A tie keeps
 * the on run; a trial that fails decides nothing. The default is off until ticket 45, so these tests reach it through the test switch of ticket 56.
 */
const factories = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
afterEach(() => { delete moveBeforeGrowDefaultTest.on; delete growthChoiceTest.beforeTrial; });

const sheet = (path: string): NormalisedDocument => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const written = (document: NormalisedDocument, on: boolean): NormalisedDocument => ({ ...document, layout: { ...document.layout, moveBeforeGrow: on } });
const byDefault = (document: NormalisedDocument, options: Parameters<typeof layout>[1] = {}): Promise<LayoutModel> => {
  moveBeforeGrowDefaultTest.on = true;
  return layout(document, { ...factories, ...options });
};
const WITNESSES = ['goldens/synthetic/a-course-lane-stands-beside-the-box-before-the-grid-widens-it.yaml',
  'goldens/synthetic/a-leaf-child-and-its-beside-cells-stay-one-row.yaml', 'goldens/synthetic/a-child-under-two-parents-grows-when-the-whole-sheet-is-better.yaml'];

describe('the growth choice of a default-on sheet (dense-16x9 ticket 60)', () => {
  for (const path of WITNESSES) {
    it(`keeps the option-off run of ${path.split('/').pop()!}, which draws as the option-off run does`, async () => {
      const document = sheet(path);
      const model = await byDefault(document);
      const off = await layout(written(document, false), factories);
      const run = model.moveBeforeGrowRun!;
      expect(run.requested).toBe('default');
      expect(run.effective).toBe('off');
      expect(run.failure).toBeUndefined();
      expect(run.choice).toBeDefined();
      expect(model.document.layout?.moveBeforeGrow).toBe(false);
      expect(model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_CHOICE).map(note => [note.stage, note.severity, note.message]))
        .toEqual([['placement', 'info', choiceMessage(run.choice!)]]);
      expect(model.diagnostics.filter(note => note.code === 'MOVE_BEFORE_GROW_FALLBACK')).toEqual([]);
      // The same drawing as the option-off run, and the same saved layout but for the record and its note.
      expect(render(model)).toBe(render(off));
      const json = JSON.parse(serializeLayoutModel(model)) as LayoutModel;
      delete json.moveBeforeGrowRun;
      json.diagnostics = json.diagnostics.filter(note => note.code !== MOVE_BEFORE_GROW_CHOICE);
      json.runtime = { stages: [] };
      expect(JSON.stringify(json)).toBe(JSON.stringify({ ...JSON.parse(serializeLayoutModel(off)) as LayoutModel, runtime: { stages: [] } }));
      // The option-on run left a seat short, and the off run is better by the unified order.
      expect(growthShort(await layout(written(document, true), factories))).toBe(true);
      expect(run.choice!.off.routed.bent + run.choice!.off.overlay.bent).toBeLessThan(run.choice!.on.routed.bent + run.choice!.on.overlay.bent);
      // The record restores.
      expect(restoreFinalLayout(serializeLayoutModel(model)).moveBeforeGrowRun).toEqual(run);
    }, 240000);
  }

  it('keeps the option-on run of a sheet the default makes better (private-datacenter-spine-leaf)', async () => {
    const document = sheet('goldens/real/private-datacenter-spine-leaf.yaml');
    const model = await byDefault(document);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_CHOICE)).toEqual([]);
    expect(render(model)).toBe(render(await layout(written(document, true), factories)));
  }, 240000);

  it('a tie keeps the option-on run', async () => {
    const model = await layout(written(sheet(WITNESSES[2]!), true), factories);
    const verdict = judgeGrowthChoice(model, model);
    expect(verdict.keep).toBe('on');
    expect(verdict.tallies?.on).toEqual(verdict.tallies?.off);
  }, 120000);

  it('a trial that reaches the deadline decides nothing, and no trial runs when the budget has no time left', async () => {
    const document = sheet(WITNESSES[2]!);
    const on = await layout(written(document, true), factories);
    // The deadline falls when the trial starts: every stage of it has no time.
    let late = false, trials = 0;
    const closing: Budget = { remainingMs: () => (late ? 1 : Number.POSITIVE_INFINITY), share: stageMs => (late ? 0 : stageMs) };
    growthChoiceTest.beforeTrial = () => { trials++; late = true; };
    const kept = await byDefault(document, { budget: closing });
    expect(trials).toBe(1);
    expect(kept.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(render(kept)).toBe(render(on));
    // A budget that is spent once the option-on run has placed its link labels, its last stage: the trial does not start.
    let spent = false;
    trials = 0;
    const none = await byDefault(document, { budget: { remainingMs: () => (spent ? 0 : Number.POSITIVE_INFINITY), share: stageMs => stageMs },
      onProgress: progress => { if (progress.stage === 'link-labels' && progress.trial === undefined) spent = true; } });
    expect(trials).toBe(0);
    expect(none.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
  }, 240000);

  it('restore refuses a forged choice record (R5)', async () => {
    const model = await byDefault(sheet(WITNESSES[2]!));
    const saved = JSON.parse(serializeLayoutModel(model)) as LayoutModel;
    const forge = (edit: (json: LayoutModel) => void): string => { const json = JSON.parse(JSON.stringify(saved)) as LayoutModel; edit(json); return JSON.stringify(json); };
    const choice = saved.moveBeforeGrowRun!.choice!;
    const note = (json: LayoutModel) => json.diagnostics.find(item => item.code === MOVE_BEFORE_GROW_CHOICE)!;
    expect(() => restoreFinalLayout(JSON.stringify(saved))).not.toThrow();
    // The kept tally is measured again on the published model; the other tally is evidence, read only for the order of the two.
    expect(() => restoreFinalLayout(forge(json => { json.moveBeforeGrowRun!.choice!.off.crossings += 1; note(json).message = choiceMessage(json.moveBeforeGrowRun!.choice!); })))
      .toThrow(/off tally is not the tally of the published model/);
    expect(() => restoreFinalLayout(forge(json => { json.moveBeforeGrowRun!.choice!.on = JSON.parse(JSON.stringify(choice.off)); note(json).message = choiceMessage(json.moveBeforeGrowRun!.choice!); })))
      .toThrow(/off tally is not better than its on tally/);
    expect(() => restoreFinalLayout(forge(json => { json.diagnostics = json.diagnostics.filter(item => item.code !== MOVE_BEFORE_GROW_CHOICE); }))).toThrow(/not named once/);
    expect(() => restoreFinalLayout(forge(json => { note(json).message += ' '; }))).toThrow(/not named once/);
    expect(() => restoreFinalLayout(forge(json => { note(json).stage = 'final-geometry'; }))).toThrow(/choice note has the stage final-geometry/);
    expect(() => restoreFinalLayout(forge(json => { json.moveBeforeGrowRun!.failure = { code: 'centring', message: 'x' }; }))).toThrow(/names a failure or an unknown field/);
    expect(() => restoreFinalLayout(forge(json => { (json.moveBeforeGrowRun!.choice!.on as unknown as Record<string, unknown>).extra = 1; }))).toThrow(/not a tally/);
    expect(() => restoreFinalLayout(forge(json => { json.document.layout!.moveBeforeGrow = true; }))).toThrow();
    expect(() => restoreFinalLayout(forge(json => { json.moveBeforeGrowRun = { requested: 'default', effective: 'on' }; json.document.layout!.moveBeforeGrow = true; }))).toThrow();
    expect(() => restoreFinalLayout(forge(json => { delete json.moveBeforeGrowRun; }))).toThrow(/a choice note without a record/);
  }, 240000);
});
