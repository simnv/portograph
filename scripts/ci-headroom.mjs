/**
 * Lists the tests of a CI log that took more than half of their limit (retro 2026-11, ticket 01): they are the next to fail on a slower
 * runner. The limits are read from the sources of this checkout, so read the log of the commit you have checked out.
 *
 * Usage: node scripts/ci-headroom.mjs <log file | - | --run <run id>> [--part 0.5]
 *   <log file>   a log of `gh run view <id> --log`, or a downloaded job log
 *   -            the log on stdin
 *   --run <id>   reads `gh run view <id> --log`
 * Prints one tab-separated line per test: job, file:line, test, duration ms, limit ms, share. Exit 0; exit 2 when the log has no test time.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headroom, testDurations } from './ci-headroom-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const usage = () => { process.stderr.write('usage: node scripts/ci-headroom.mjs <log file | - | --run <run id>> [--part 0.5]\n'); process.exit(2); };
const option = (name) => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (value === undefined) usage(); args.splice(at, 2); return value; };
const part = Number(option('--part') ?? 0.5);
const run = option('--run');
if (!(part > 0 && part < 1) || (run === undefined) === (args.length !== 1)) usage();
const log = run !== undefined ? execFileSync('gh', ['run', 'view', run, '--log'], { encoding: 'utf8', maxBuffer: 256 << 20 })
  : args[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(args[0], 'utf8');
if (testDurations(log).length === 0) {
  process.stderr.write('ci-headroom: the log has no test time; read a log of the test step of ci.yml\n');
  process.exit(2);
}
const rows = headroom(log, root, part);
process.stdout.write('job\tfile:line\ttest\tms\tlimit\tshare\n');
for (const row of rows) {
  const where = row.line === undefined ? `${row.file}:?` : `${row.file}:${row.line}`;
  const share = row.share === undefined ? '?' : row.share.toFixed(2);
  process.stdout.write(`${row.job ?? '-'}\t${where}\t${row.title}${row.failed ? ' (failed)' : ''}\t${row.ms}\t${row.limit ?? '?'}\t${share}\n`);
}
process.stderr.write(`ci-headroom: ${rows.length} test(s) above ${part} of their limit\n`);
