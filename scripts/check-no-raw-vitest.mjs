/** Lint step: tests run only through scripts/test-runner.mjs. Fails on a raw `vitest run` in scripts/ or package.json. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['check-no-raw-vitest.mjs', 'test-runner.mjs', 'test-runner-lib.mjs', 'test-runner.check.mjs']);
const files = ['package.json', ...readdirSync(join(root, 'scripts')).filter((name) => /\.(mjs|cjs|js|sh)$/.test(name) && !allowed.has(name)).map((name) => `scripts/${name}`)];
const raw = /\bvitest(\.mjs)?['"]?\s*,?\s*['"]?(run|watch|bench|related)\b/;
const bad = files.flatMap((file) => readFileSync(join(root, file), 'utf8').split('\n').flatMap((line, index) => (raw.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])));
if (bad.length > 0) {
  process.stderr.write(`Raw vitest call; tests run only through scripts/test-runner.mjs:\n${bad.join('\n')}\n`);
  process.exit(1);
}
