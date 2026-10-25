/**
 * Detached watchdog of one test job. Usage: node test-watchdog.mjs <runnerPid> <runnerStart> <lockPath> <pollMs>.
 * It waits for the runner to die (even by SIGKILL), then takes the same kernel flock as any job and,
 * if the record still names that runner, kills and verifies the job's group and clears the record.
 * If the next job took the flock first, that job did the cleanup and the record is no longer the runner's.
 */
import { alive, cleanupRecord, readLock, sleep, startTime, takeFlock } from './test-runner-lib.mjs';

const [pidText, start, lockPath, pollText] = process.argv.slice(2);
const pid = Number(pidText);
const poll = Number(pollText) || 200;
const ours = (record) => record?.pid === pid && record.start === start;

for (;;) {
  if (!ours(readLock(lockPath))) process.exit(0); // released normally, or another job cleaned up
  const started = alive(pid) ? startTime(pid) : '';
  if (!alive(pid) || (started !== undefined && started !== start)) break;
  await sleep(poll);
}
let flock;
try {
  flock = await takeFlock(lockPath, { timeoutMs: 120_000 });
  if (ours(readLock(lockPath))) await cleanupRecord(lockPath, 3000);
} catch {
  process.exit(1);
} finally {
  await flock?.release();
}
