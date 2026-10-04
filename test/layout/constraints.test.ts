import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { evaluate, termValue, xCatalogue } from '../../src/layout/constraints/index.js';
import type { Constraint } from '../../src/layout/constraints/index.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { COLUMN_SLACK } from '../../src/layout/columns.js';
import { CELL_TO_CHILD_FRAME_GAP, FRAME_TO_FRAME_GAP } from '../../src/layout/frames.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { CONSTRAINT_SHEETS } from './constraints-sheets.js';

// Architecture ticket 05. The catalogue reads a published layout and fails only on KNOWN contracts: the hard separations that are
// evidence (role 'evidence', contract 'known'). Containment entries are role 'hull': `deriveFrames` builds the frame boxes from the same terms,
// so they pass by construction and are neither asserted nor counted as evidence. Lane clearance and cell gaps inside a frame are this
// catalogue's translation of a rule; they are measured and reported, never asserted.
// Each hard entry names its `basis`: the test asserts it is a named constant or input, and that each separation bound equals that constant.
const sheets = ['goldens/m1-sip-edge', ...CONSTRAINT_SHEETS.map(name => `goldens/synthetic/${name}`)];
const owed = (item: Constraint): boolean => item.strength === 'hard' && item.contract === 'known' && item.role === 'evidence' && item.kind.startsWith('separation');
const BASES = new Set(['bandGap', 'bandGap + COLUMN_SLACK', 'FRAME_TO_FRAME_GAP', 'CELL_TO_CHILD_FRAME_GAP', 'zero (non-overlap)', 'cellReach', 'GROUP_PADDING',
  'lane bounds', 'reference layout', 'author preference', 'frozen chord']);
/** Violations the pipeline publishes today and no ticket has fixed. The test pins them: a fix must delete the entry, a new one fails the run. */
const KNOWN_OPEN: Record<string, string> = {};

describe('the x constraint catalogue on published layouts', () => {
  for (const sheet of sheets) {
    it(`${sheet.split('/').pop()}: no known hard separation or containment is violated`, async () => {
      const model = await layout(parse(readFileSync(new URL(`../../${sheet}.yaml`, import.meta.url), 'utf8')), {
        createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      });
      const residuals = evaluate(model, xCatalogue(model));
      const name = sheet.split('/').pop()!;
      const broken = residuals.filter(item => item.violated && owed(item.constraint) && item.class === 'invariant-violation')
        .map(item => `${name}|${item.constraint.id}`);
      const open = Object.keys(KNOWN_OPEN).filter(key => key.startsWith(`${name}|`));
      expect(broken.filter(key => !open.includes(key)), 'violations of a known contract').toEqual([]);
      expect(open.filter(key => !broken.includes(key)), 'a known-open finding no longer occurs: delete it from KNOWN_OPEN').toEqual([]);
      const catalogue = residuals.map(item => item.constraint);
      expect(new Set(catalogue.map(item => item.id)).size, 'ids are unique').toBe(catalogue.length);
      for (const item of catalogue) {
        expect(item.source.length).toBeGreaterThan(0);
        expect(item.owners.length).toBeGreaterThan(0);
        expect(BASES.has(item.basis), `${item.id}: basis ${item.basis}`).toBe(true);
      }
      const bg = bandGap(model);
      const expected: Record<string, number> = { 'separation-root-frames': bg, 'separation-root-frame-group': bg + COLUMN_SLACK, 'separation-root-groups': bg, 'separation-flank': bg,
        'separation-frame-frames': FRAME_TO_FRAME_GAP, 'separation-cell-child-frame': CELL_TO_CHILD_FRAME_GAP };
      for (const item of catalogue) if (item.kind in expected) expect(item.bound, item.id).toBe(expected[item.kind]);
    }, 120000);
  }
});

describe('the residual evaluator', () => {
  const model = (): LayoutModel => ({
    groups: { a: { id: 'a', nodes: [], bounds: { x: 0, y: 0, width: 50, height: 10 } }, b: { id: 'b', nodes: [], bounds: { x: 100, y: 0, width: 50, height: 10 } } },
    frames: [], diagnostics: [],
  } as unknown as LayoutModel);
  const separation = (bound: number): Constraint => ({ id: 's', kind: 'separation-root-groups', strength: 'hard', owners: ['group:a', 'group:b'], source: 'Q80', basis: 'bandGap', role: 'evidence', anchor: 'documented-clearance',
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
    const other = model();
    other.diagnostics = [{ stage: 'placement', severity: 'warning', code: 'COLUMN_AXIS_HELD', message: 'held', owners: [{ kind: 'node', id: 'b' }] }];
    expect(evaluate(other, [separation(60)])[0]?.class, 'a node named b is not the group named b').toBe('invariant-violation');
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
