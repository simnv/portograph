import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandDeadlineError, layout, parse, ResolveError, restoreFinalLayout, serializeLayoutModel } from '../../src/index.js';
import { fallsBack } from '../../src/pipeline/index.js';
import { UNBOUNDED_BUDGET, type Budget } from '../../src/pipeline/budget.js';
import { PlacementRefusal, PostconditionRefusal, qualifyingRefusal } from '../../src/layout/placement-refusal.js';
import * as trunk from '../../src/layout/trunk.js';
import * as lanesModule from '../../src/layout/lanes.js';
import { ElkDeadlineError } from '../../src/layout/elk-worker.js';
import { SkeletonError } from '../../src/layout/skeleton.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { resolve } from '../../src/resolve/index.js';
import { defaultMeansOn, fallbackMessage, MOVE_BEFORE_GROW_FALLBACK, moveBeforeGrow, moveBeforeGrowDefaultTest, moveBeforeGrowMode } from '../../src/layout/read/move-before-grow.js';
import type { LayoutModel, NormalisedDocument } from '../../src/model/index.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 56 (owner ruling 2026-11-18, general fallback): a sheet that does not write `layout.moveBeforeGrow` runs with it on while the
 * default is on; when that run fails for a placement reason, the whole input runs once more with the option off, and that result publishes with
 * a named warning (`MOVE_BEFORE_GROW_FALLBACK`). A sheet that writes `true` is strict and throws; one that writes `false` is off. The default is
 * off until ticket 45, so these tests reach the default-on mode through the test switch of the one reader (`moveBeforeGrowDefaultTest`).
 */
const factories = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
afterEach(() => { delete moveBeforeGrowDefaultTest.on; });

/**
 * The reviewer's two-line variant of the cause-(a) fixture of ticket 46 (review 1 of 46a, P1), with the option line left out: the mode is the
 * default. `core` holds three feeds of `edge` and two overlays, `spare` an author size and two feeds of `edge`. Written `true`, it throws the
 * centring invariant before the chord freeze as written and with links reversed (the frozen bound of cause a does not reach it), and draws with
 * nodes reversed. This file is the one place of the sheet: ticket 56 answers it with the fallback, and a producer fix (ticket 53) changes
 * `STRICT_THROWS`.
 */
const S21 = `portograph: 2
profile: network
title: A two-line row unit
groups:
  up:
    tier: 0
    label: UP
  low:
    tier: 1
    label: LOW
  other:
    tier: 1
    label: OTHER
nodes:
  core:
    group: low
    label: core
    ports:
      - name: wan1
      - name: wan2
      - name: wan3
  spare:
    group: other
    label: spare
    size:
      width: 80
      height: 48
  edge:
    group: up
    label: edge
  peer-b:
    group: up
    label: peer-b
  peer-a:
    group: up
    label: peer-a
links:
  - - spare
    - edge
    - id: spare-link
      label: spare
  - - core.wan1
    - edge
    - id: wan-one
      label: one
  - - core.wan2
    - edge
    - id: wan-two
      label: two
  - - core.wan3
    - edge
    - id: wan-three
      label: three
  - - core
    - peer-a
    - id: overlay-a
      label: ov-a
      route: overlay
  - - core
    - peer-b
    - id: overlay-b
      label: ov-b
      route: overlay
  - - spare
    - edge
    - {}
`;
/** The orders whose strict run (`moveBeforeGrow: true` written) throws today, and the throw. */
const STRICT_THROWS: Record<string, boolean> = { 'as written': true, 'links reversed': true, 'nodes reversed': false };
const S21_THROW = /Centring invariant violated: link-4: the row unit of other stands off its seat: a replay of its tier moves other/;
const written = (document: NormalisedDocument, on: boolean): NormalisedDocument => ({ ...document, layout: { ...document.layout, moveBeforeGrow: on } });
const orders = (yaml: string): Record<string, string> => ({ 'as written': yaml, 'links reversed': reversed(yaml, 'links') as string, 'nodes reversed': reversed(yaml, 'nodes') as string });

/** The published JSON without the mode fields: the record, the fallback warning and the written option. */
function withoutMode(model: LayoutModel): unknown {
  const json = JSON.parse(serializeLayoutModel(model)) as LayoutModel;
  delete json.moveBeforeGrowRun;
  json.diagnostics = json.diagnostics.filter(note => note.code !== MOVE_BEFORE_GROW_FALLBACK);
  if (json.document.layout !== undefined) delete json.document.layout.moveBeforeGrow;
  json.runtime = { stages: [] };
  return json;
}

describe('the one reader of layout.moveBeforeGrow gives the mode (dense-16x9 ticket 56)', () => {
  it('reads strict, off and default, and the default is off until ticket 45', () => {
    const base = parse(S21);
    expect(moveBeforeGrowMode(base)).toBe('default');
    expect(moveBeforeGrowMode(written(base, true))).toBe('strict');
    expect(moveBeforeGrowMode(written(base, false))).toBe('off');
    expect(defaultMeansOn()).toBe(false);
    expect(moveBeforeGrow({ document: base })).toBe(false);
    moveBeforeGrowDefaultTest.on = true;
    expect(defaultMeansOn()).toBe(true);
    expect(moveBeforeGrow({ document: base })).toBe(true);
    expect(moveBeforeGrow({ document: written(base, false) })).toBe(false);
  });

  it('falls back on a placement refusal with time left, and on nothing else', () => {
    const spent: Budget = { remainingMs: () => 0, share: () => 0 };
    expect(fallsBack(new PlacementRefusal('centring', 'Centring invariant violated: x'), UNBOUNDED_BUDGET)).toBe(true);
    expect(fallsBack(new PlacementRefusal('budget', 'placed too often'), UNBOUNDED_BUDGET)).toBe(true);
    expect(fallsBack(new PlacementRefusal('centring', 'Centring invariant violated: x'), spent)).toBe(false);
    expect(fallsBack(new ResolveError([{ stage: 'model', severity: 'error', code: 'X', message: 'x' }]), UNBOUNDED_BUDGET)).toBe(false);
    expect(fallsBack(new CommandDeadlineError(1000, 'skeleton'), UNBOUNDED_BUDGET)).toBe(false);
    expect(fallsBack(new ElkDeadlineError(1000), UNBOUNDED_BUDGET)).toBe(false);
    expect(fallsBack(new Error('a bug'), UNBOUNDED_BUDGET)).toBe(false);
    // Review 1, P1: the rule reads the cause, not the wrapper.
    expect(fallsBack(new SkeletonError('Fallback tier 0 failed: bands overlap'), UNBOUNDED_BUDGET)).toBe(true);
    expect(fallsBack(new SkeletonError('Fallback tier 0 failed', new SkeletonError('bands overlap')), UNBOUNDED_BUDGET)).toBe(true);
    expect(fallsBack(new SkeletonError('Fallback tier 0 failed', new TypeError('worker smoke')), UNBOUNDED_BUDGET)).toBe(false);
    expect(fallsBack(new SkeletonError('Fallback tier 0 failed', new CommandDeadlineError(100, 'worker')), UNBOUNDED_BUDGET)).toBe(false);
    // A code outside the closed set is no refusal the command records.
    expect(fallsBack(new PlacementRefusal('not-a-code' as 'centring', 'x'), UNBOUNDED_BUDGET)).toBe(false);
  });

  // Review 1, P1 (R6): a worker exception under the skeleton's tier fallback is no placement reason, so the command ends with it; it does
  // not publish the option-off run. The reviewer's three reproductions: the first two ELK attempts (the partitioned one and tier 0) throw.
  const TWO = 'portograph: 2\ngroups: {g: {tier: 0}, h: {tier: 1}}\nnodes: {a: {group: g}, b: {group: h}}\nlinks: [[a,b]]\n';
  const throwing: Record<string, () => Error> = {
    TypeError: () => new TypeError('worker smoke'),
    TimeoutError: () => new DOMException('upstream timeout', 'TimeoutError'),
    CommandDeadlineError: () => new CommandDeadlineError(100, 'worker'),
  };
  for (const [kind, make] of Object.entries(throwing)) {
    it(`does not fall back on a ${kind} of the ELK worker under the tier fallback`, async () => {
      moveBeforeGrowDefaultTest.on = true;
      let made = 0;
      const createElkAttempt: typeof createAttempt = () => (++made <= 2 ? { terminateWorker() {}, layout() { throw make(); } } as unknown as ReturnType<typeof createAttempt> : createAttempt());
      const error = await layout(parse(TWO), { ...factories, createElkAttempt }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(SkeletonError);
      expect(((error as SkeletonError).cause as Error).name).toBe(kind);
      expect(made).toBe(2);
    }, 120000);
  }
});

describe('a default sheet runs as before while the default is off (dense-16x9 ticket 56)', () => {
  it('writes no record and leaves the document as parsed', async () => {
    const model = await layout(parse(S21), factories);
    expect(model.moveBeforeGrowRun).toBeUndefined();
    expect(model.document.layout?.moveBeforeGrow).toBeUndefined();
    expect(model.diagnostics.some(note => note.code === MOVE_BEFORE_GROW_FALLBACK)).toBe(false);
  }, 120000);
});

describe('a default-on sheet whose option-on run fails publishes the option-off run (dense-16x9 ticket 56)', () => {
  for (const [name, yaml] of Object.entries(orders(S21))) {
    it(`s21 ${name}: ${STRICT_THROWS[name] ? 'written true throws; unset, the option-off run plus the warning' : 'written true draws; unset, the option-on run'}`, async () => {
      const base = parse(yaml);
      let refusal: unknown;
      const strict = await layout(written(base, true), factories).catch((error: unknown) => { refusal = error; return undefined; });
      expect(strict === undefined).toBe(STRICT_THROWS[name]);
      const off = await layout(written(base, false), factories);
      moveBeforeGrowDefaultTest.on = true;
      const model = await layout(base, factories);
      if (strict === undefined) {
        expect(refusal).toBeInstanceOf(PlacementRefusal);
        expect(String((refusal as Error).message)).toMatch(S21_THROW);
        const failure = { code: (refusal as PlacementRefusal).code, message: (refusal as PlacementRefusal).message };
        expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'off', failure });
        expect(model.document.layout?.moveBeforeGrow).toBe(false);
        expect(model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_FALLBACK)).toEqual([expect.objectContaining({ severity: 'warning', message: fallbackMessage(failure) })]);
        expect(withoutMode(model)).toEqual(withoutMode(off));
      } else {
        expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
        expect(withoutMode(model)).toEqual(withoutMode(strict));
      }
      // The restore reads the effective mode from the record and the document.
      expect(() => restoreFinalLayout(serializeLayoutModel(model))).not.toThrow();
    }, 300000);
  }

  it('does not fall back when the command budget has no time left', async () => {
    let spent = false;
    const budget: Budget = { remainingMs: () => spent ? 0 : Number.POSITIVE_INFINITY, share: stageMs => spent ? 0 : stageMs };
    moveBeforeGrowDefaultTest.on = true;
    // The budget runs out once 7c is done, so the refusal of 7e, or a later deadline, finds no time for the option-off run.
    await expect(layout(parse(S21), { ...factories, budget, onProgress: progress => { if (progress.stage === 'centre') spent = true; } })).rejects.toThrow();
  }, 300000);
});

describe('a default-on sheet whose option-on run draws publishes it (dense-16x9 ticket 56)', () => {
  it('equals the strict run but for the record, and its document holds the effective mode', async () => {
    const text = readFileSync(new URL('../../goldens/synthetic/a-seat-keeps-the-ports-it-stands.yaml', import.meta.url), 'utf8').replace('layout: { moveBeforeGrow: true }\n', '');
    const base = parse(text);
    expect(moveBeforeGrowMode(base)).toBe('default');
    const strict = await layout(written(base, true), factories);
    moveBeforeGrowDefaultTest.on = true;
    const model = await layout(base, factories);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(model.document.layout?.moveBeforeGrow).toBe(true);
    expect(Object.keys(model.alignmentSeats ?? {}).length).toBeGreaterThan(0);
    expect(withoutMode(model)).toEqual(withoutMode(strict));
    // A caller cannot write the record: the command replaces it.
    const forged = await layout(base, { ...factories, moveBeforeGrowRun: { requested: 'default', effective: 'off', failure: { code: 'centring', message: 'x' } } });
    expect(forged.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
  }, 300000);
});

describe('the restore refuses a run record the command cannot have written (dense-16x9 ticket 56, R5)', () => {
  it('checks the effective mode against the document and the failure against the warning', async () => {
    moveBeforeGrowDefaultTest.on = true;
    const model = await layout(parse(S21), factories);
    expect(model.moveBeforeGrowRun?.effective).toBe('off');
    const forge = (change: (forged: LayoutModel) => void): string => { const forged = JSON.parse(serializeLayoutModel(model)) as LayoutModel; change(forged); return JSON.stringify(forged); };
    expect(() => restoreFinalLayout(forge(() => {}))).not.toThrow();
    expect(() => restoreFinalLayout(forge(forged => { forged.moveBeforeGrowRun = { requested: 'default', effective: 'on' }; }))).toThrow(/run record is forged: an on run whose document/);
    expect(() => restoreFinalLayout(forge(forged => { delete forged.moveBeforeGrowRun!.failure; }))).toThrow(/run record is forged: an off run without a failure/);
    expect(() => restoreFinalLayout(forge(forged => { forged.document.layout!.moveBeforeGrow = true; }))).toThrow(/run record is forged: an off run whose document/);
    expect(() => restoreFinalLayout(forge(forged => { forged.diagnostics = forged.diagnostics.filter(note => note.code !== MOVE_BEFORE_GROW_FALLBACK); }))).toThrow(/does not name its failure once/);
    expect(() => restoreFinalLayout(forge(forged => { delete forged.moveBeforeGrowRun; }))).toThrow(/a fallback warning without a record/);
    expect(() => restoreFinalLayout(forge(forged => { (forged.moveBeforeGrowRun as unknown as Record<string, unknown>).requested = 'strict'; }))).toThrow(/the requested mode is not default/);
    expect(() => restoreFinalLayout(forge(forged => { (forged.moveBeforeGrowRun as unknown as Record<string, unknown>).extra = 1; }))).toThrow(/unknown field/);
    // Review 1, P2: a code outside the closed set, with a warning that matches it, and a warning of another stage, at both restore boundaries.
    const unknownCode = (forged: LayoutModel): void => {
      forged.moveBeforeGrowRun!.failure!.code = 'not-a-placement-refusal';
      forged.diagnostics.find(note => note.code === MOVE_BEFORE_GROW_FALLBACK)!.message = fallbackMessage(forged.moveBeforeGrowRun!.failure!);
    };
    const parseStage = (forged: LayoutModel): void => { forged.diagnostics.find(note => note.code === MOVE_BEFORE_GROW_FALLBACK)!.stage = 'parse'; };
    expect(() => restoreFinalLayout(forge(unknownCode))).toThrow(/the failure code not-a-placement-refusal is no refusal code/);
    expect(() => restoreFinalLayout(forge(parseStage))).toThrow(/the fallback warning has the stage parse, not placement/);
    const early = (change: (forged: LayoutModel) => void): string => {
      const forged = JSON.parse(JSON.stringify(resolve(written(parse(S21), false)))) as LayoutModel;
      forged.moveBeforeGrowRun = structuredClone(model.moveBeforeGrowRun!);
      forged.diagnostics.push(structuredClone(model.diagnostics.find(note => note.code === MOVE_BEFORE_GROW_FALLBACK)!));
      change(forged);
      return JSON.stringify(forged);
    };
    expect(() => restoreLayoutModel(early(() => {}))).not.toThrow();
    expect(() => restoreLayoutModel(early(unknownCode))).toThrow(/is no refusal code/);
    expect(() => restoreLayoutModel(early(parseStage))).toThrow(/has the stage parse/);
  }, 300000);
});

/**
 * Review 2 (R6): a refusal built in a catch carries the caught value, also `undefined`, and is no placement reason unless that value is one
 * (`qualifyingRefusal`). The census of review 2 found three such catches that reach a default-on run: the tier attempt of the skeleton, and the
 * two catches of the postcondition checks (a check that cannot read its draft; the lane validator of the lane-side check).
 */
describe('a refusal built from a caught value does not fall back unless that value is a placement reason (dense-16x9 ticket 56, review 2)', () => {
  const TWO_GROUPS = 'portograph: 2\ngroups: {g: {tier: 0}, h: {tier: 1}}\nnodes: {a: {group: g}, b: {group: h}}\nlinks: [[a,b]]\n';
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the caught marker, also for an undefined or null cause', () => {
    const measured = new PlacementRefusal('centring', 'measured');
    expect(measured.caught).toBe(false);
    expect(qualifyingRefusal(measured)).toBe(true);
    expect(qualifyingRefusal(new PlacementRefusal('skeleton', 'x', { cause: undefined }))).toBe(false);
    expect(qualifyingRefusal(new PlacementRefusal('skeleton', 'x', { cause: null }))).toBe(false);
    expect(qualifyingRefusal(new PlacementRefusal('skeleton', 'x', { cause: measured }))).toBe(true);
    expect(qualifyingRefusal(new SkeletonError('x', undefined))).toBe(false);
    expect(qualifyingRefusal(new SkeletonError('x'))).toBe(true);
    expect(qualifyingRefusal(new PostconditionRefusal('bundles', [], { value: new TypeError('reader') }))).toBe(false);
    expect(qualifyingRefusal(new PostconditionRefusal('bundles', [], { value: measured }))).toBe(true);
    expect(qualifyingRefusal(new PostconditionRefusal('bundles', []))).toBe(true);
  });

  it('does not fall back on an ELK rejection with no reason under the tier fallback (the reviewer\'s Promise.reject())', async () => {
    moveBeforeGrowDefaultTest.on = true;
    let made = 0;
    const createElkAttempt: typeof createAttempt = () => (++made <= 2 ? { terminateWorker() {}, layout: () => Promise.reject() } as unknown as ReturnType<typeof createAttempt> : createAttempt());
    const error = await layout(parse(TWO_GROUPS), { ...factories, createElkAttempt }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SkeletonError);
    expect((error as SkeletonError).caught).toBe(true);
    expect((error as SkeletonError).cause).toBeUndefined();
    expect(made).toBe(2);
  }, 120000);

  // The reviewer's probe: a TypeError of `trunkHeads`, read by the bundles postcondition of the option-on run only.
  const failIn = (pattern: string, make: () => Error) => <T extends (...args: never[]) => unknown>(real: T) => ((...args: Parameters<T>) => {
    const model = args[0] as unknown as { document?: { layout?: { moveBeforeGrow?: boolean } } };
    if (model.document?.layout?.moveBeforeGrow === true && new Error().stack?.includes(pattern)) throw make();
    return real(...args);
  }) as T;
  for (const [site, mock] of [
    ['a check that cannot read its draft (trunkHeads)', () => { const real = trunk.trunkHeads; vi.spyOn(trunk, 'trunkHeads').mockImplementation(failIn('postconditions.ts', () => new TypeError('trunk reader failed'))(real)); }],
    ['the lane validator of the lane-side check (validateLanes)', () => { const real = lanesModule.validateLanes; vi.spyOn(lanesModule, 'validateLanes').mockImplementation(failIn('postconditions.ts', () => new TypeError('lane reader failed'))(real)); }],
  ] as const) {
    it(`does not fall back on a reader exception in a postcondition: ${site}`, async () => {
      mock();
      const strict = await layout(written(parse(TWO_GROUPS), true), factories).then(() => undefined, (caught: unknown) => caught);
      expect(strict).toBeInstanceOf(PostconditionRefusal);
      expect((strict as PostconditionRefusal).caught).toBe(true);
      expect((strict as PostconditionRefusal).cause).toBeInstanceOf(TypeError);
      moveBeforeGrowDefaultTest.on = true;
      const error = await layout(parse(TWO_GROUPS), factories).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(PostconditionRefusal);
      expect((error as PostconditionRefusal).cause).toBeInstanceOf(TypeError);
      // The option-off run is unaffected by the mock and draws.
      expect((await layout(written(parse(TWO_GROUPS), false), factories)).moveBeforeGrowRun).toBeUndefined();
    }, 120000);
  }
});
