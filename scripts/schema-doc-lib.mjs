/**
 * The schema doc against the parser (retro 2026-11, ticket 03): every key that `src/parse/index.ts` accepts has a row or a named mention in
 * the matching section of `docs/design/schema.md`. The keys are read from the parser source with the TypeScript AST: each `v.keys(fields,
 * [...], path)` list, and the keys the `layout:` and `render:` loops compare against `key`. A key is mentioned when it stands as a word in an
 * inline code span of its section (a row `| \`key\` |`, or `{ name, side?, order? }`).
 */
import ts from 'typescript';

/** The schema section of the keys each parser function accepts. A `v.keys` list in another function fails the check until it is mapped here. */
export const SECTION_OF = { parseWithDiagnostics: 'Top level', groups: 'Group', nodes: 'Node', ports: 'Node', endpoint: 'Link', links: 'Link' };
/** The keys of `meta:` are free (a pattern and a reserved list, not a key list), so the check asks only that the section exists. */
export const FREE_SECTIONS = ['Meta'];

/** `{ key, section, where }` for every key the parser accepts. */
export function acceptedKeys(source, file = 'src/parse/index.ts') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [], unmapped = [];
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const owner = node => { for (let at = node.parent; at; at = at.parent) if (ts.isFunctionDeclaration(at) && at.name) return at.name.text; return '(top level)'; };
  const strings = node => (ts.isArrayLiteralExpression(node) ? node.elements.filter(ts.isStringLiteral).map(item => item.text) : []);
  // `for (const [key, value] of v.map(root.get('layout'), ...))`: the string literals compared with `key` in its body.
  const settingsLoop = node => {
    if (!ts.isForOfStatement(node) || !ts.isCallExpression(node.expression)) return undefined;
    const [first] = node.expression.arguments;
    if (!first || !ts.isCallExpression(first) || !ts.isPropertyAccessExpression(first.expression) || first.expression.name.text !== 'get') return undefined;
    const [name] = first.arguments;
    return name && ts.isStringLiteral(name) && (name.text === 'layout' || name.text === 'render') && SECTION_OF[owner(node)] === 'Top level' ? name.text : undefined;
  };
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'keys'
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'v') {
      const fn = owner(node), section = SECTION_OF[fn];
      if (section === undefined) unmapped.push(`${file}:${line(node)} (${fn})`);
      else for (const key of strings(node.arguments[1])) found.push({ key, section, where: `${file}:${line(node)} (${fn})` });
    }
    const setting = settingsLoop(node);
    if (setting !== undefined) {
      const compare = inner => {
        if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(inner.operatorToken.kind)) {
          const [a, b] = [inner.left, inner.right];
          const literal = ts.isIdentifier(a) && a.text === 'key' && ts.isStringLiteral(b) ? b : ts.isIdentifier(b) && b.text === 'key' && ts.isStringLiteral(a) ? a : undefined;
          if (literal) found.push({ key: literal.text, section: 'Top level', where: `${file}:${line(literal)} (${setting}.${literal.text})` });
        }
        ts.forEachChild(inner, compare);
      };
      compare(node.statement);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { found, unmapped };
}

/** The text of each `## ` section of the schema doc, by title. */
export function sections(doc) {
  const out = new Map();
  let title;
  for (const text of doc.split('\n')) {
    const head = /^## (.+)$/.exec(text);
    if (head) { title = head[1].trim(); out.set(title, ''); continue; }
    if (title !== undefined) out.set(title, `${out.get(title)}${text}\n`);
  }
  return out;
}

/** The words of the inline code spans of `text`. */
const codeWords = text => new Set([...text.matchAll(/`([^`]+)`/g)].flatMap(([, span]) => span.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? []));

/** Every accepted key with no row or named mention in its section, and every section that is missing; one line each. */
export function schemaGaps(source, doc) {
  const { found, unmapped } = acceptedKeys(source);
  const bySection = sections(doc), words = new Map([...bySection].map(([title, text]) => [title, codeWords(text)]));
  const gaps = unmapped.map(where => `${where}: a v.keys list in a function the check does not map to a schema section (SECTION_OF in scripts/schema-doc-lib.mjs)`);
  for (const title of new Set([...found.map(item => item.section), ...FREE_SECTIONS])) if (!bySection.has(title)) gaps.push(`docs/design/schema.md: no section "## ${title}"`);
  const seen = new Set();
  for (const { key, section, where } of found) {
    if (!words.get(section)?.has(key) && !seen.has(`${section}|${key}`)) { seen.add(`${section}|${key}`); gaps.push(`${key}: accepted at ${where}, no row or named mention in "## ${section}" of docs/design/schema.md`); }
  }
  return { gaps, found };
}
