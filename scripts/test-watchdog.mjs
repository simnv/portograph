/**
 * Detached watchdog of one test job. Usage: node test-watchdog.mjs <runnerPid> <runnerStart> <lockPath> <pollMs>.
 * When the runner dies (even by SIGKILL) it kills the job group recorded in the lock, verifies the group
 * is empty and frees the lock. It exits as soon as the lock no longer names the runner.
 */
import { alive, killGroup, readLock, releaseLock, sleep, startTime } from './test-runner-lib.mjs';

const [pidText, start, lockPath, pollText] = process.argv.slice(2);
const pid = Number(pidText);
const poll = Number(pollText) || 200;

for (;;) {
  const lock = readLock(lockPath);
  if (lock === undefined || lock.pid !== pid) process.exit(0); // released normally
  if (!alive(pid) || startTime(pid) !== start) {
    const gone = await killGroup(lock.pgid, 3000);
    if (gone) releaseLock(lockPath, pid);
    process.exit(gone ? 0 : 1);
  }
  await sleep(poll);
}
