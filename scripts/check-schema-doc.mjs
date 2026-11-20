/**
 * Lint step (retro 2026-11, ticket 03): every key the parser accepts (`src/parse/index.ts`) has a row or a named mention in the matching
 * section of `docs/design/schema.md` (`scripts/schema-doc-lib.mjs`). It fails with the key and the section.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaGaps } from './schema-doc-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { gaps, found } = schemaGaps(readFileSync(join(root, 'src', 'parse', 'index.ts'), 'utf8'), readFileSync(join(root, 'docs', 'design', 'schema.md'), 'utf8'));
if (found.length === 0) gaps.push('src/parse/index.ts: no accepted key read; the check no longer finds the parser lists');
if (gaps.length > 0) {
  process.stderr.write(`Schema doc out of step with the parser (add a row or a named mention):\n${gaps.join('\n')}\n`);
  process.exit(1);
}
