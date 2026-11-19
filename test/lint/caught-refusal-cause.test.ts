import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import local, { REFUSAL_CLASSES } from '../../scripts/eslint-local.mjs';

/**
 * The local lint rules of R6 (retro 2026-11, ticket 02): a refusal built in a catch carries the caught value (`local/caught-refusal-cause`),
 * and a postcondition finding made from a caught value keeps the value (`local/caught-finding-cause`). The three sites that dense-16x9 ticket 56
 * fixed pass as written and fail without their cause.
 */
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' } });
const rule = (name: string) => local.rules![name]!;

// The tier attempt of `src/layout/skeleton.ts`, as written, inside the partitioned attempt's catch.
const tierAttempt = (cause: string): string => `
async function tiers(work, tiers) {
  try { await partitioned(work); } catch (error) {
    for (const tier of tiers) {
      try {
        const errors = validateSkeletonBands(work, tier);
        if (errors.length) throw new SkeletonError(errors.join('; '));
      } catch (error) {
        if (error instanceof ElkDeadlineError) { work.deadlineHit = true; throw error; }
        throw new SkeletonError(\`Fallback tier \${tier} failed: \${String(error)}\`${cause});
      }
    }
  }
}`;
// The two catches of `readViolations` in `src/layout/postconditions.ts`, as written.
const attemptCatch = (keep: string): string => `
function attempt(kind, run) {
  try { run(); } catch (error) { add(kind, 'check', \`the check could not read the draft: \${message(error)}\`);${keep} }
}`;
const laneCatch = (keep: string): string => `
function laneSide(after) {
  try { validateLanes(after); } catch (error) { add('laneSide', 'lanes', message(error));${keep} }
}`;
const keepValue = ' caughtBy.set(out.at(-1), { value: error });';

describe('local/caught-refusal-cause', () => {
  tester.run('caught-refusal-cause', rule('caught-refusal-cause'), {
    valid: [
      tierAttempt(', error'),
      "try { f(); } catch (error) { throw new PlacementRefusal('side', 'refused', { stage: 'bands', cause: error }); }",
      "try { f(); } catch (error) { throw new PostconditionRefusal('bands', [], { value: error }); }",
      "p.catch(error => { throw new SpanRefusal('refused', { cause: error }); });",
      // Outside a catch, a refusal is a measurement.
      "if (bad) throw new PlacementRefusal('ledger', why);",
      // Another class is no refusal.
      'try { f(); } catch (error) { throw new Error(String(error)); }',
    ],
    invalid: [
      { code: tierAttempt(''), errors: [{ messageId: 'noCause' }] },
      { code: "try { f(); } catch (error) { throw new TrunkBlocked(key, `blocked: ${String(error)}`); }", errors: [{ messageId: 'noCause' }] },
      { code: "try { f(); } catch { throw new SolidBlockRefusal(blocks); }", errors: [{ messageId: 'noBinding' }] },
      { code: "p.catch(error => { throw new CourseRefusal(error.message); });", errors: [{ messageId: 'noCause' }] },
      { code: "p.catch(function () { throw new BundleFeasibilityError('no room'); });", errors: [{ messageId: 'noBinding' }] },
    ],
  });
});

describe('local/caught-finding-cause', () => {
  tester.run('caught-finding-cause', rule('caught-finding-cause'), {
    valid: [attemptCatch(keepValue), laneCatch(keepValue), "try { f(); } catch (error) { throw error; }", "p.catch(error => record(error));"],
    invalid: [
      { code: attemptCatch(''), errors: [{ messageId: 'textOnly' }] },
      { code: laneCatch(''), errors: [{ messageId: 'textOnly' }] },
      { code: "p.catch(error => { notes.push(`failed: ${error.message}`); });", errors: [{ messageId: 'textOnly' }] },
    ],
  });
});

describe('the lint setup reads the rules where R6 needs them', () => {
  it('REFUSAL_CLASSES equals PlacementRefusal and every class that extends it in src/', () => {
    const parents = new Map<string, string>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { visit(path); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        const walk = (node: ts.Node): void => {
          if (ts.isClassDeclaration(node) && node.name !== undefined) {
            const base = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
            if (base !== undefined && ts.isIdentifier(base)) parents.set(node.name.text, base.text);
          }
          ts.forEachChild(node, walk);
        };
        walk(source);
      }
    };
    visit(new URL('../../src', import.meta.url).pathname);
    const family = (name: string): boolean => name === 'PlacementRefusal' || (parents.has(name) && family(parents.get(name)!));
    const hierarchy = [...parents.keys(), 'PlacementRefusal'].filter(family);
    expect([...new Set(hierarchy)].sort()).toEqual([...REFUSAL_CLASSES].sort());
  });

  it('src/ lints with the refusal rule, and the postcondition file with the finding rule too', async () => {
    const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });
    const rules = async (file: string): Promise<Record<string, unknown>> => ((await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown> }).rules;
    const postconditions = await rules('src/layout/postconditions.ts'), skeleton = await rules('src/layout/skeleton.ts');
    expect(postconditions['local/caught-refusal-cause']).toEqual([2]);
    expect(postconditions['local/caught-finding-cause']).toEqual([2]);
    expect(skeleton['local/caught-refusal-cause']).toEqual([2]);
    expect(skeleton['local/caught-finding-cause']).toBeUndefined();
  });
});
