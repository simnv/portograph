/**
 * Detached watchdog of one test job. Usage: node test-watchdog.mjs <runnerPid> <runnerStart> <lockPath> <pollMs>.
 * When the runner dies (even by SIGKILL) it reclaims the lock through the same serialized path as a
 * waiting job: kill the recorded job group, verify it is empty, remove the lock. It exits as soon as
 * the lock no longer names the runner.
 */
import { readLock, reclaimStale, sleep, startTime } from './test-runner-lib.mjs';

const [pidText, start, lockPath, pollText] = process.argv.slice(2);
const pid = Number(pidText);
const poll = Number(pollText) || 200;
const alive = (id) => { try { process.kill(id, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

for (;;) {
  const lock = readLock(lockPath);
  if (lock === undefined || lock.pid !== pid || lock.start !== start) process.exit(0); // released, or taken over
  const started = alive(pid) ? startTime(pid) : '';
  if (!alive(pid) || (started !== undefined && started !== start)) {
    // reclaimStale re-checks under its sidecar that the owner is provably dead (pid gone or start time differs).
    const outcome = await reclaimStale(lockPath, lock, 3000).catch(() => 'failed');
    if (outcome === 'removed' || outcome === 'changed') process.exit(0);
    if (outcome === 'failed') process.exit(1);
  }
  await sleep(poll);
}
