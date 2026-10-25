/**
 * Run one command as a supervised heavy job under the host-wide lock (the same lock and group
 * supervision as the test runner). Usage: node scripts/with-lock.mjs <job> -- <command> [args...]
 * Inside the job, `PORTOGRAPH_LOCK_HELD` lets nested heavy commands (npm test, corpus, sweep) run
 * without taking the lock again. Env: PORTOGRAPH_TEST_TIMEOUT_MS (default 90 min), PORTOGRAPH_TEST_LOCK.
 */
import process from 'node:process';
import { runJob } from './test-runner-lib.mjs';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 1 || split === argv.length - 1) {
  process.stderr.write('usage: node scripts/with-lock.mjs <job> -- <command> [args...]\n');
  process.exit(2);
}
const [command, ...args] = argv.slice(split + 1);
const result = await runJob({ job: `${argv.slice(0, split).join(' ')} (${process.cwd()})`, steps: [{ command, args }], limitMs: Number(process.env.PORTOGRAPH_TEST_TIMEOUT_MS ?? 90 * 60_000), cwd: process.cwd(), maxOutput: 64 << 20 });
if (result.reason === 'timeout') process.stderr.write('[with-lock] wall-clock limit passed; the job was killed\n');
process.exit(result.code);
