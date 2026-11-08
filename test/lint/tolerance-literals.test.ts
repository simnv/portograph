import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The tolerance lint (decision review 2026-11, D-Q6; audit P-08, section 3). A raw `1e-N` literal in the scanned roots names no quantity,
 * so a reviewer cannot tell a px distance from a px-squared product, an order key or a solver stop. Two owner files may hold such
 * literals; elsewhere a literal stands only as the direct initializer of a named exception below. Comments are not read.
 */
const ROOTS = ['src/layout', 'src/route', 'src/pipeline', 'src/geometry', 'src/render'];
const OWNERS = new Set(['src/layout/tolerance.ts', 'src/geometry/planar.ts']);
/** `file:name` of each named exception, with its quantity. */
const EXCEPTIONS = new Set([
  'src/layout/feed-order.ts:SAME_KEY', // ordinal feed key, a mean row index
  'src/layout/joint-order.ts:SAME_FEED_KEY', // normalised feed key, dimensionless
  'src/layout/joint-order.ts:AUTHOR_ORDER_KEY_STEP', // authored-order step of a normalised feed key
  'src/layout/overlay-window.ts:NEAR_END', // fraction along a chord, a denominator guard
  'src/layout/bands.ts:LABEL_PADDING_GRAIN', // room grain, px
  'src/layout/link-labels.ts:LABEL_WINDOW_GRAIN', // room grain, px
  'src/render/drawio.ts:EPS', // renderer distance owner, px
  'src/render/drawio.ts:PHASE_GRAIN', // renderer phase grain
]);
const LITERAL = /^\d*\.?\d+e-\d+$/i;

/** The refused literals of one source file, as `file:line literal`. */
export function unownedLiterals(file: string, source: string): string[] {
  if (OWNERS.has(file)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) && LITERAL.test(node.getText(tree))) {
      const parent = node.parent;
      // Only the initializer itself: a raw comparison in the same file is still refused.
      if (!ts.isVariableDeclaration(parent) || parent.initializer !== node || !EXCEPTIONS.has(`${file}:${parent.name.getText(tree)}`)) {
        found.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} ${node.getText(tree)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

describe('the tolerance lint', () => {
  it('finds no unowned 1e-N literal in the scanned roots', () => {
    const files = ROOTS.flatMap(walk).filter(file => file.endsWith('.ts')).sort();
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(file => unownedLiterals(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('refuses a planted raw literal, also in a file with a named exception', () => {
    expect(unownedLiterals('src/layout/lanes.ts', 'export const near = (a: number): boolean => Math.abs(a) < 1e-9;\n')).toEqual(['src/layout/lanes.ts:1 1e-9']);
    expect(unownedLiterals('src/layout/feed-order.ts', 'const SAME_KEY = 1e-9;\nconst x = 2 < 1e-9;\n')).toEqual(['src/layout/feed-order.ts:2 1e-9']);
    expect(unownedLiterals('src/layout/feed-order.ts', 'const OTHER = 1e-9;\n')).toEqual(['src/layout/feed-order.ts:1 1e-9']);
  });

  it('reads no comment, and lets the owner files hold literals', () => {
    expect(unownedLiterals('src/layout/lanes.ts', '// at 1e-9 the guard skips\n/* 1e-6 */ export const a = 1;\n')).toEqual([]);
    expect(unownedLiterals('src/layout/tolerance.ts', 'export const X = 1e-9;\nconst y = 3 > 1e-6;\n')).toEqual([]);
  });
});
