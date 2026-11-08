import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The tolerance lint (decision review 2026-11, D-Q6; audit P-08, section 3). A raw tolerance literal names no quantity, so a reviewer
 * cannot tell a px distance from a px-squared product, an order key or a solver stop. Two owner files may hold such literals; elsewhere one
 * stands only as the direct initializer of a named exception below, declared at the top level of its file. Comments are not read.
 *
 * A tolerance literal is a number above 0 and at most `SMALL` in any spelling (`1e-6`, `1.e-3`, `0.000001`, `0.000_001`), `Number.EPSILON`,
 * or a power with a negative exponent (`10 ** -6`, `Math.pow(10, -6)`).
 */
const ROOTS = ['src'];
const SMALL = 0.01;
const OWNERS = new Set(['src/layout/tolerance.ts', 'src/geometry/planar.ts']);
/** `file:name` of each named exception, with its quantity. */
const EXCEPTIONS = new Set([
  'src/layout/feed-order.ts:SAME_KEY', // ordinal feed key, a mean row index
  'src/layout/joint-order.ts:SAME_FEED_KEY', // normalised feed key, dimensionless
  'src/layout/joint-order.ts:AUTHOR_ORDER_KEY_STEP', // authored-order step of a normalised feed key
  'src/layout/overlay-window.ts:NEAR_END', // fraction along a chord, a denominator guard
  'src/layout/bands.ts:LABEL_PADDING_GRAIN', // room grain, px
  'src/layout/link-labels.ts:LABEL_WINDOW_GRAIN', // room grain, px
  'src/layout/constraints/evaluate.ts:RESIDUAL_TOLERANCE', // residual of a constraint solve, px
  'src/render/drawio.ts:EPS', // renderer distance owner, px
  'src/render/drawio.ts:PHASE_GRAIN', // renderer phase grain
]);

const value = (text: string): number => Number(text.replace(/_/g, ''));
const negative = (node: ts.Node): boolean => ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken;

/** The initializer of a top-level `const` named in `EXCEPTIONS`: the one place outside the owner files where a tolerance literal may stand. */
function namedException(file: string, node: ts.Node, tree: ts.SourceFile): boolean {
  const declaration = node.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== node) return false;
  const list = declaration.parent, statement = list?.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || !statement || !ts.isVariableStatement(statement) || statement.parent !== tree) return false;
  return EXCEPTIONS.has(`${file}:${declaration.name.getText(tree)}`);
}

/** The refused literals of one source file, as `file:line text`. */
export function unownedLiterals(file: string, source: string): string[] {
  if (OWNERS.has(file)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), found: string[] = [];
  const refuse = (node: ts.Node): void => { found.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} ${node.getText(tree)}`); };
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node)) {
      const number = value(node.getText(tree));
      if (number > 0 && number <= SMALL && !namedException(file, node, tree)) refuse(node);
    } else if (ts.isPropertyAccessExpression(node) && node.getText(tree).replace(/\s/g, '') === 'Number.EPSILON') {
      refuse(node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken && negative(node.right)) {
      refuse(node);
      return;
    } else if (ts.isCallExpression(node) && node.expression.getText(tree) === 'Math.pow' && node.arguments[1] !== undefined && negative(node.arguments[1])) {
      refuse(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

describe('the tolerance lint', () => {
  it('finds no unowned tolerance literal in src', () => {
    const files = ROOTS.flatMap(walk).filter(file => file.endsWith('.ts')).sort();
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(file => unownedLiterals(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('refuses a planted raw literal, also in a file with a named exception', () => {
    expect(unownedLiterals('src/layout/lanes.ts', 'export const near = (a: number): boolean => Math.abs(a) < 1e-9;\n')).toEqual(['src/layout/lanes.ts:1 1e-9']);
    expect(unownedLiterals('src/layout/feed-order.ts', 'const SAME_KEY = 1e-9;\nconst x = 2 < 1e-9;\n')).toEqual(['src/layout/feed-order.ts:2 1e-9']);
    expect(unownedLiterals('src/layout/feed-order.ts', 'const OTHER = 1e-9;\n')).toEqual(['src/layout/feed-order.ts:1 1e-9']);
  });

  it('refuses every spelling of a small number', () => {
    const one = (text: string): string[] => unownedLiterals('src/score/metrics.ts', `export const a = (x: number): boolean => x < ${text};\n`);
    for (const text of ['1e-6', '1E-6', '1.e-3', '0.000001', '0.000_001', '.001', '0.01', 'Number.EPSILON', '10 ** -6', 'Math.pow(10, -6)']) expect(one(text), text).toHaveLength(1);
    for (const text of ['0', '0.5', '2 ** 26', '10 ** 2', 'Math.pow(10, 2)', '1e3']) expect(one(text), text).toEqual([]);
  });

  it('keys an exception by its file, its name and the top level: a nested or a `let` declaration of the name is refused', () => {
    expect(unownedLiterals('src/layout/feed-order.ts', 'function f(): number { const SAME_KEY = 1e-9; return SAME_KEY; }\n')).toHaveLength(1);
    expect(unownedLiterals('src/layout/feed-order.ts', 'let SAME_KEY = 1e-9;\n')).toHaveLength(1);
    expect(unownedLiterals('src/render/drawio.ts', 'export function g(): number { const EPS = 1e-6; return EPS; }\n')).toHaveLength(1);
    expect(unownedLiterals('src/layout/lanes.ts', 'const SAME_KEY = 1e-9;\n')).toHaveLength(1);
    expect(unownedLiterals('src/render/drawio.ts', 'const EPS = 1e-6;\n')).toEqual([]);
  });

  it('reads no comment, and lets the owner files hold literals', () => {
    expect(unownedLiterals('src/layout/lanes.ts', '// at 1e-9 the guard skips\n/* 1e-6 */ export const a = 1;\n')).toEqual([]);
    expect(unownedLiterals('src/layout/tolerance.ts', 'export const X = 1e-9;\nconst y = 3 > 1e-6;\n')).toEqual([]);
  });
});
