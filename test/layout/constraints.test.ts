import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { evaluate, termValue, xCatalogue } from '../../src/layout/constraints/index.js';
import type { Constraint } from '../../src/layout/constraints/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { CONSTRAINT_SHEETS } from './constraints-sheets.js';

// Architecture ticket 05. The catalogue reads a published layout and fails only on KNOWN contracts: the hard separations and the
// containment of frames, cells and held lanes, each anchored in a named constant or rule. Lane clearance, flank gaps and cell gaps inside
// a frame are this catalogue's translation of a rule; they are measured and reported, never asserted.
const sheets = ['goldens/m1-sip-edge', ...CONSTRAINT_SHEETS.map(name => `goldens/synthetic/${name}`)];
const owed = (item: Constraint): boolean => item.strength === 'hard' && item.contract === 'known' && /^(separation|containment)/.test(item.kind);

describe('the x constraint catalogue on published layouts', () => {
  for (const sheet of sheets) {
    it(`${sheet.split('/').pop()}: no known hard separation or containment is violated`, async () => {
      const model = await layout(parse(readFileSync(new URL(`../../${sheet}.yaml`, import.meta.url), 'utf8')), {
        createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      });
      const residuals = evaluate(model, xCatalogue(model));
      const broken = residuals.filter(item => item.violated && owed(item.constraint) && item.class === 'invariant-violation');
      expect(broken.map(item => `${item.constraint.kind} ${item.constraint.owners.join(' | ')} ${item.residual?.toFixed(2)} px`)).toEqual([]);
      // Every entry names its source, anchor and owners; no entry reads its own bound off the boxes it checks.
      for (const item of residuals) {
        expect(item.constraint.source.length).toBeGreaterThan(0);
        expect(item.constraint.owners.length).toBeGreaterThan(0);
      }
    }, 120000);
  }
});

describe('the residual evaluator', () => {
  const model = (): LayoutModel => ({
    groups: { a: { id: 'a', nodes: [], bounds: { x: 0, y: 0, width: 50, height: 10 } }, b: { id: 'b', nodes: [], bounds: { x: 100, y: 0, width: 50, height: 10 } } },
    frames: [], diagnostics: [],
  } as unknown as LayoutModel);
  const separation = (bound: number): Constraint => ({ id: 's', kind: 'separation-root-groups', strength: 'hard', owners: ['a', 'b'], source: 'Q80', anchor: 'documented-clearance',
    contract: 'known', support: 'difference', a: { at: 'group', owner: 'a', offset: 50 }, b: { at: 'group', owner: 'b', offset: 0 }, bound });

  it('reports a signed residual and flags a violation only below the bound', () => {
    const [ok] = evaluate(model(), [separation(50)]);
    expect(ok).toMatchObject({ residual: 0, violated: false });
    const [short] = evaluate(model(), [separation(60)]);
    expect(short).toMatchObject({ residual: -10, violated: true, class: 'invariant-violation' });
  });

  it('classifies a translation entry, a declared exception and an unsupported entry apart', () => {
    const translated = { ...separation(60), contract: 'translation' as const };
    expect(evaluate(model(), [translated])[0]?.class).toBe('translation-error');
    const declared = model();
    declared.diagnostics = [{ stage: 'placement', severity: 'warning', code: 'COLUMN_AXIS_HELD', message: 'held', owners: [{ kind: 'group', id: 'b' }] }];
    expect(evaluate(declared, [separation(60)])[0]?.class).toBe('legacy-exception');
    const rest: Partial<Constraint> = separation(60);
    delete rest.a;
    delete rest.b;
    const unsupported = { ...rest, kind: 'chord-side', support: 'unsupported' } as Constraint;
    expect(evaluate(model(), [unsupported])[0]).toMatchObject({ violated: false, class: 'unsupported' });
  });

  it('reads group, frame and fixed terms', () => {
    const m = model();
    m.frames = [{ id: 'f', label: 'F', cells: [], tier: 0, box: { x: 10, y: 0, width: 30, height: 10 } }];
    expect(termValue(m, { at: 'group', owner: 'b', offset: 5 })).toBe(105);
    expect(termValue(m, { at: 'frame-right', owner: 'f', offset: -1 })).toBe(39);
    expect(termValue(m, { at: 'fixed', owner: '', offset: 7 })).toBe(7);
    expect(termValue(m, { at: 'group', owner: 'missing', offset: 0 })).toBeUndefined();
  });
});
