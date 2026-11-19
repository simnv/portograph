/**
 * Lint step (retro 2026-11, ticket 01): no test in a heavy or slow file of `vite.config.ts` sets a limit below that of its project
 * (docs/gates.md). The heavy and slow projects run one file at a time with a long limit because their tests are slow, and the same
 * commit ran 1.5 times slower on one CI runner than on the next: an own limit below the project's is the first to fail there.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { limitsBelowProject } from './test-limits-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const found = limitsBelowProject(root);
if (found.length > 0) {
  for (const item of found) {
    const what = Number.isNaN(item.limit) ? 'sets a limit the check cannot read as a number' : `sets ${item.limit} ms`;
    process.stderr.write(`${item.file}:${item.line}: a test of the ${item.project} project ${what}, below the project's ${item.projectLimit} ms. Remove the own limit, or set one of ${item.projectLimit} ms or more (docs/gates.md).\n`);
  }
  process.stderr.write(`Test limits: ${found.length} test(s) of the heavy and slow files below their project's limit.\n`);
  process.exit(1);
}
