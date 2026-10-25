/**
 * Detached watchdog of one test job. Usage: node test-watchdog.mjs <runnerPid> <runnerStart> <lockPath> <pollMs>.
 * It waits for the runner to die (even by SIGKILL), then takes the same kernel flock as any job and,
 * if the record still names that runner, kills and verifies the job's group and clears the record.
 * If the next job took the flock first, that job did the cleanup and the record is no longer the runner's.
 */
import { alive, cleanupRecord, readRecord, sleep, startTime, takeFlock } from './test-runner-lib.mjs';

const [pidText, start, lockPath, pollText] = process.argv.slice(2);
const pid = Number(pidText);
const poll = Number(pollText) || 200;
const ours = (record) => record?.pid === pid && record.start === start;
// Exit only on a record that parses and names another job (or is {}); a read error means keep watching.
const current = () => readRecord(lockPath);

for (;;) {
  const seen = current();
  if (seen.state === 'record' && !ours(seen.record)) process.exit(0); // released normally, or another job cleaned up
  const started = alive(pid) ? startTime(pid) : '';
  if (!alive(pid) || (started !== undefined && started !== start)) break;
  await sleep(poll);
}
let flock;
try {
  flock = await takeFlock(lockPath, { timeoutMs: 120_000 });
  const seen = current();
  if (seen.state === 'record' && ours(seen.record)) await cleanupRecord(lockPath, 3000, flock);
} catch {
  process.exit(1);
} finally {
  await flock?.release();
}
