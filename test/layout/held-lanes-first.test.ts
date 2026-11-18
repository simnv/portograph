import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 46, review 1: 7a reserves a held lane of the tier pass before the lanes foreign to its frame only where, in the order of the passes, a
 * foreign lane crosses the frame the held lane grows (`heldLanesOverForeign`, read through `crossesOccupied`, the predicate `validateLanes` throws on). Every
 * other held lane keeps that order, so a sheet the order draws is drawn as before: the same error gates and the same crossings, in three orders, option
 * off and on. A form the order threw on ("Lane crosses occupied group") publishes, every link kept. Before, every held lane of the tier pass was
 * reserved first: the lane of mid-a took the other margin of `zone#3` and turned the ports of `a` over (G5), and the second lane of the pair b-e took
 * the other margin of `zone#2` (5 crossings, not 2).
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
type Form = { gates: string[]; crossings?: number; threwBefore?: true; throwsYet?: string };
const forms = (yaml: string): Record<string, string> => {
  const off = yaml.replace(/^layout: \{moveBeforeGrow: true\}\n/m, '');
  const on = `layout: {moveBeforeGrow: true}\n${off}`;
  return Object.fromEntries((['off', 'on'] as const).flatMap(mode => {
    const text = mode === 'on' ? on : off;
    return [[`${mode}, as written`, text], [`${mode}, links reversed`, reversed(text, 'links') as string], [`${mode}, nodes reversed`, reversed(text, 'nodes') as string]];
  }));
};
const none: Form = { gates: [] };
const sheets: Record<string, { path: string; expect: Record<string, Form> }> = {
  'a held lane keeps the order of the passes': {
    path: '../../goldens/synthetic/a-held-lane-keeps-the-order-of-the-passes-where-no-lane-crosses-its-frame.yaml',
    expect: {
      'off, as written': { ...none, crossings: 0, threwBefore: true }, 'off, links reversed': { ...none, crossings: 0, threwBefore: true }, 'off, nodes reversed': { ...none, crossings: 1 },
      'on, as written': { ...none, crossings: 0 }, 'on, links reversed': { ...none, crossings: 0 }, 'on, nodes reversed': { ...none, crossings: 0 },
    },
  },
  'a held pair keeps its margin': {
    path: '../../goldens/synthetic/a-held-pair-keeps-its-margin-where-no-lane-crosses-its-frame.yaml',
    expect: Object.fromEntries(['off', 'on'].flatMap(mode => ['as written', 'links reversed', 'nodes reversed'].map(order => [`${mode}, ${order}`, { ...none, crossings: 2 }]))),
  },
  'a held lane on the other margin of its cell is not reserved first': {
    path: '../fixtures/staged/a-held-lane-on-the-other-margin-of-its-cell-is-not-reserved-first.yaml',
    expect: {
      // Main throws in all six forms ("Lane crosses occupied group zone#2"). The forms with the option off publish with a G5 on the router, not asserted.
      'off, as written': { gates: ['G5'], crossings: 8, threwBefore: true }, 'off, links reversed': { gates: ['G5'], crossings: 8, threwBefore: true },
      'off, nodes reversed': { gates: ['G5'], threwBefore: true },
      // Review 2: only the held lane on the right margin is reserved first.
      'on, nodes reversed': { ...none, crossings: 4, threwBefore: true },
      // A known defect that stays: after the held lane is reserved first, the seat set of the cell above no longer holds its vertical link.
      'on, as written': { gates: [], threwBefore: true, throwsYet: 'seat set of site#4' }, 'on, links reversed': { gates: [], threwBefore: true, throwsYet: 'seat set of site#4' },
    },
  },
  'a held lane of a second router': {
    path: '../fixtures/staged/a-held-lane-of-a-second-router-keeps-the-order-of-the-passes.yaml',
    expect: {
      // The order of the passes has a G5 on e here, before ticket 46 and after; the forms with nodes reversed threw, and publish with a G5 on mid, not asserted.
      'off, as written': { gates: ['G5'], crossings: 5 }, 'off, links reversed': { gates: ['G5'], crossings: 5 }, 'off, nodes reversed': { gates: ['G5'], threwBefore: true },
      'on, as written': { ...none, crossings: 7 }, 'on, links reversed': { ...none, crossings: 7 }, 'on, nodes reversed': { gates: ['G5'], threwBefore: true },
    },
  },
};

describe('7a reserves a held lane first only where the order of the passes makes a foreign lane cross its frame (dense-16x9 ticket 46, review 1)', () => {
  for (const [sheet, { path, expect: expected }] of Object.entries(sheets)) for (const [form, text] of Object.entries(forms(read(path)))) {
    const want = expected[form]!;
    // A form that still throws is a named expected-fail: the assertion below is what it must reach.
    (want.throwsYet === undefined ? it : it.fails)(`${sheet} (${form}): ${want.throwsYet !== undefined ? `publishes (expected fail: it throws on the ${want.throwsYet})` : want.threwBefore ? 'publishes where the order threw' : 'draws as the order of the passes draws it'}`, async () => {
      const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      expect(model.document.layout?.moveBeforeGrow === true).toBe(form.startsWith('on'));
      const snapshot = score(model).snapshot;
      expect(Object.entries(snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id)).toEqual(want.gates);
      if (want.crossings !== undefined) expect(snapshot.metrics.crossings.count).toBe(want.crossings);
      expect(model.removedLinks ?? []).toEqual([]);
    }, 120000);
  }
});
