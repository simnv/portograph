/**
 * The time limits of the tests, read from the sources (retro 2026-11, ticket 01). `projectLimits` reads the vitest projects of
 * `vite.config.ts`: their files and their limit. `testsIn` reads the `it` and `test` calls of one test file with their own limit. The lint
 * step `check-test-limits.mjs` and `ci-headroom.mjs` read the limits through these two functions only.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');

const parse = (root, file) => ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const nameOf = (property) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
const propertyOf = (object, name) => object.properties.find(item => ts.isPropertyAssignment(item) && nameOf(item) === name);

/** The number an expression gives with the numeric constants of its file, or undefined. */
function numberOf(node, constants) {
  if (node === undefined) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return numberOf(node.expression, constants);
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isBinaryExpression(node)) {
    const left = numberOf(node.left, constants), right = numberOf(node.right, constants);
    if (left === undefined || right === undefined) return undefined;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
  }
  return undefined;
}

/** The numeric `const` declarations of a file, in source order (a constant may read an earlier one). */
function constantsOf(source) {
  const constants = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const value = numberOf(node.initializer, constants);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

/** The string elements of `const <name> = [...]` in a source, or undefined. */
function stringArray(source, name) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      found = node.initializer.elements.map(item => (ts.isStringLiteral(item) ? item.text : undefined));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found?.every(item => item !== undefined) ? found : undefined;
}

/**
 * The vitest projects of `vite.config.ts`: `{ default: { limit }, heavy: { files, limit }, slow: { files, limit } }`. The default limit is
 * the `testTimeout` of the `test` block; `heavy` and `slow` name their files in `heavyFiles` and `slowFiles` and set their own `testTimeout`.
 * Throws when the config has another form, so a check never reads a limit it guessed.
 */
export function projectLimits(root) {
  const source = parse(root, 'vite.config.ts');
  const constants = constantsOf(source);
  const files = { heavy: stringArray(source, 'heavyFiles'), slow: stringArray(source, 'slowFiles') };
  let base;
  const named = {};
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && nameOf(node) === 'test' && ts.isObjectLiteralExpression(node.initializer)) {
      const block = node.initializer, timeout = propertyOf(block, 'testTimeout'), projects = propertyOf(block, 'projects');
      if (timeout !== undefined && projects !== undefined && base === undefined) {
        base = numberOf(timeout.initializer, constants);
        for (const project of ts.isArrayLiteralExpression(projects.initializer) ? projects.initializer.elements : []) {
          const inner = ts.isObjectLiteralExpression(project) ? propertyOf(project, 'test') : undefined;
          if (inner === undefined || !ts.isObjectLiteralExpression(inner.initializer)) continue;
          const name = propertyOf(inner.initializer, 'name');
          if (name === undefined || !ts.isStringLiteral(name.initializer)) continue;
          const own = propertyOf(inner.initializer, 'testTimeout');
          named[name.initializer.text] = own === undefined ? base : numberOf(own.initializer, constants);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const limits = { default: { limit: named.default ?? base }, heavy: { files: files.heavy, limit: named.heavy }, slow: { files: files.slow, limit: named.slow } };
  for (const [name, project] of Object.entries(limits)) {
    if (!(project.limit > 0) || (name !== 'default' && project.files === undefined)) {
      throw new Error(`vite.config.ts: cannot read the ${name} project (its files and its testTimeout); test-limits-lib.mjs reads \`const ${name}Files = ['...']\` and \`{ name: '${name}', testTimeout: <number> }\``);
    }
  }
  return limits;
}

/** The project of a test file: `heavy` or `slow` when the config lists it, else `default`. */
export function projectOf(limits, file) {
  return limits.heavy.files.includes(file) ? 'heavy' : limits.slow.files.includes(file) ? 'slow' : 'default';
}

/**
 * The identifier a test call starts from: `it` in `it(...)`, `it.fails(...)`, `it.each(rows)(...)`, `it.skipIf(c)(...)` and
 * `(c ? it : it.fails)(...)` (a conditional whose two branches start from one identifier).
 */
function calleeRoot(call) {
  const rootOf = (start) => {
    let node = start;
    while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isConditionalExpression(node)) {
      const yes = rootOf(node.whenTrue), no = rootOf(node.whenFalse);
      return yes === no ? yes : undefined;
    }
    return ts.isIdentifier(node) ? node.text : undefined;
  };
  return rootOf(call.expression);
}

/** How much fixed text a title pattern holds: the longer, the more specific (`${a}: ${b}` matches many titles, a literal one). */
export function specificity(pattern) {
  return pattern.source.replaceAll('.*', '').length;
}

/** A regular expression for the titles a title argument gives: `%s` and `$name` of `each`, and `${...}` of a template, match any text. */
function titlePattern(node) {
  const escape = text => text.replace(/%[sdifjo]|\$[A-Za-z_][\w.]*/g, '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\u0000', '.*');
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return new RegExp(`^${escape(node.text)}$`);
  if (ts.isTemplateExpression(node)) return new RegExp(`^${escape(node.head.text)}${node.templateSpans.map(span => `.*${escape(span.literal.text)}`).join('')}$`);
  return /^.*$/;
}

/**
 * The limit an argument list gives a call: the number after the function (`it(title, fn, 60000)`), or `timeout` of an options object
 * (`it(title, { timeout }, fn)`). `{ node }` is the argument that holds it; `limit` is undefined for none and NaN when it cannot be read.
 */
function ownLimit(args, constants) {
  const options = args.length >= 3 && ts.isObjectLiteralExpression(args[1]) ? args[1] : args.length === 2 && ts.isObjectLiteralExpression(args[1]) ? args[1] : undefined;
  if (options !== undefined) {
    const timeout = propertyOf(options, 'timeout');
    return timeout === undefined ? { limit: undefined } : { limit: numberOf(timeout.initializer, constants) ?? Number.NaN, node: timeout };
  }
  if (args.length < 3) return { limit: undefined };
  const last = args[2];
  if (ts.isObjectLiteralExpression(last)) {
    const timeout = propertyOf(last, 'timeout');
    return timeout === undefined ? { limit: undefined } : { limit: numberOf(timeout.initializer, constants) ?? Number.NaN, node: timeout };
  }
  return { limit: numberOf(last, constants) ?? Number.NaN, node: last };
}

/**
 * The tests of one file: `{ line, title, pattern, own, ownNode, describe }`. `own` is the limit the call sets (undefined for none, NaN
 * when it cannot be read); `describe` is the limit of the closest `describe` that sets one. `ownNode` is the argument that sets `own`.
 */
export function testsIn(root, file) {
  const source = parse(root, file);
  const constants = constantsOf(source);
  const tests = [];
  const visit = (node, inherited) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const name = calleeRoot(node);
      if (name === 'describe') {
        const set = ownLimit(node.arguments, constants).limit;
        for (const child of node.arguments) visit(child, set ?? inherited);
        return;
      }
      if (name === 'it' || name === 'test') {
        const { limit, node: ownNode } = ownLimit(node.arguments, constants);
        tests.push({ line: lineOf(source, node), title: node.arguments[0].getText(source), pattern: titlePattern(node.arguments[0]), own: limit, ownNode, call: node, describe: inherited, source });
      }
    }
    ts.forEachChild(node, child => visit(child, inherited));
  };
  visit(source, undefined);
  return tests;
}

/** The limit a test runs with: its own, else that of its `describe`, else that of its project. */
export function limitOf(test, projectLimit) {
  return test.own ?? test.describe ?? projectLimit;
}

/**
 * The tests of the heavy and slow files whose limit is below that of their project, or cannot be read (docs/gates.md: a test in a heavy or
 * slow file gets no timeout below its project's, because the same commit ran 1.5 times slower on one CI runner than on the next).
 * Each is `{ file, line, title, project, limit, projectLimit }`; `limit` is NaN when the source does not give a number.
 */
export function limitsBelowProject(root) {
  const limits = projectLimits(root);
  const found = [];
  for (const project of ['heavy', 'slow']) {
    for (const file of limits[project].files) {
      for (const test of testsIn(root, file)) {
        const limit = test.own ?? test.describe;
        if (limit === undefined || limit >= limits[project].limit) continue;
        found.push({ file, line: test.line, title: test.title, project, limit, projectLimit: limits[project].limit });
      }
    }
  }
  return found;
}
