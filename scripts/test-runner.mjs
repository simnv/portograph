/**
 * The one entry point of every test run (`npm test`, `test:full`, the gate's test step, targeted runs).
 * It takes the host-wide test lock, runs vitest in its own process group with a wall-clock limit and a
 * worker cap, and kills the group on any exit. Usage:
 *   node scripts/test-runner.mjs [--full]                  all three projects, one after another
 *   node scripts/test-runner.mjs [--full] <vitest args>    one `vitest run` with those arguments
 * Env: PORTOGRAPH_TEST_WORKERS (default 1), PORTOGRAPH_TEST_TIMEOUT_MS (default 45 min),
 * PORTOGRAPH_TEST_LOCK (default /tmp/portograph-test.lock).
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { runJob } from './test-runner-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(dirname(createRequire(join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
const workers = process.env.PORTOGRAPH_TEST_WORKERS ?? '1';
const limitMs = Number(process.env.PORTOGRAPH_TEST_TIMEOUT_MS ?? 45 * 60_000);

const args = process.argv.slice(2);
const full = args.includes('--full');
const rest = args.filter((argument) => argument !== '--full');
const reporter = full ? ['--reporter=default'] : [];
const make = (extra) => ({ command: process.execPath, args: [vitest, 'run', `--maxWorkers=${workers}`, ...reporter, ...extra] });
const steps = rest.length > 0 ? [make(rest)] : ['default', 'heavy', 'slow'].map((project) => make(['--project', project]));

const result = await runJob({ job: `${process.cwd()} vitest ${rest.join(' ') || 'all projects'}`, steps, limitMs, cwd: root }).catch((error) => {
  process.stderr.write(`[test-runner] ${error.message}\n`);
  return process.exit(1);
});
if (result.reason === 'timeout') process.stderr.write(`[test-runner] wall-clock limit of ${limitMs} ms passed; the job was killed\n`);
if (result.survivors > 0) process.stderr.write('[test-runner] processes of the job survive; the lock stays so the next job kills them\n');
process.exit(result.code);
