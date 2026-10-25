/**
 * Test-job runner core: a host-wide admission lock, a child in its own process group, a wall-clock
 * limit, bounded output, a group kill that is verified, and a detached watchdog that cleans up when
 * the runner itself dies. `scripts/test-runner.mjs` is the one entry point; see docs/agents/gates.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const LOCK_PATH = process.env.PORTOGRAPH_TEST_LOCK ?? '/tmp/portograph-test.lock';
const WATCHDOG = fileURLToPath(new URL('./test-watchdog.mjs', import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a process (pid > 0) or a whole group (negative pid) has a live member. */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The start time of a process as `ps` prints it; it tells a reused PID from the owner. */
export function startTime(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** TERM the group, wait `graceMs`, KILL what remains, and report whether 0 members remain. */
export async function killGroup(pgid, graceMs = 3000) {
  if (!Number.isInteger(pgid) || pgid <= 1) return true;
  const waitGone = async (ms) => {
    const end = Date.now() + ms;
    while (alive(-pgid) && Date.now() < end) await sleep(25);
    return !alive(-pgid);
  };
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* group already gone */ }
  if (await waitGone(graceMs)) return true;
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already gone */ }
  return waitGone(5000);
}

export function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function writeLock(path, record) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, path);
}

/** Remove the lock file only while it still names `pid` as owner. */
export function releaseLock(path, pid) {
  if (readLock(path)?.pid === pid) { try { unlinkSync(path); } catch { /* already removed */ } }
}

/** An owner is live when its PID exists with the recorded start time. */
function ownerLive(lock) {
  return Number.isInteger(lock.pid) && alive(lock.pid) && startTime(lock.pid) === lock.start;
}

/**
 * Take the lock. Waits while a live owner holds it. A dead owner's job group is killed and verified
 * gone before the lock is reused; if it cannot be killed, this throws.
 */
export async function acquireLock(job, { path = LOCK_PATH, graceMs = 3000, onWait = () => {} } = {}) {
  let announced = false;
  for (;;) {
    const record = { pid: process.pid, start: startTime(process.pid), pgid: null, job };
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx' });
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const lock = readLock(path);
    if (lock === undefined) { await sleep(50); continue; } // being replaced, or half-written
    if (ownerLive(lock)) {
      if (!announced) { onWait(lock); announced = true; }
      await sleep(100);
      continue;
    }
    // Stale: the owner is gone. No survivor of its group may remain before the lock is reused.
    if (!(await killGroup(lock.pgid, graceMs))) throw new Error(`stale lock owner ${lock.pid}: group ${lock.pgid} will not die`);
    const claim = `${path}.stale.${process.pid}`;
    try { renameSync(path, claim); unlinkSync(claim); } catch { /* another job took it first */ }
  }
}

/**
 * Run `steps` (each `{ command, args }`) one after another as one job under the lock. Returns
 * `{ code, reason, survivors }`; `reason` is 'exit', 'timeout' or 'signal'. The lock is released only
 * after the job's process group is verified empty.
 */
export async function runJob({ job, steps, limitMs, graceMs = 3000, lockPath = LOCK_PATH, maxOutput = 4 << 20, cwd, env, stdout = process.stdout, stderr = process.stderr, watchdogPollMs = 200 }) {
  const lock = await acquireLock(job, { path: lockPath, graceMs, onWait: (owner) => stderr.write(`waiting for the test lock (pid ${owner.pid}, ${owner.job})\n`) });
  const watchdog = spawn(process.execPath, [WATCHDOG, String(process.pid), lock.start, lockPath, String(watchdogPollMs)], { detached: true, stdio: 'ignore' });
  watchdog.unref();
  let current;
  let reason = 'exit';
  let code = 0;
  let written = 0;
  let dropped = false;
  const sink = (stream) => (chunk) => {
    if (written < maxOutput) { written += chunk.length; stream.write(chunk); } else if (!dropped) {
      dropped = true;
      stream.write(`\n[test-runner] output passed ${maxOutput} bytes; the rest is dropped\n`);
    }
  };
  let stopping;
  const stop = (why) => { reason = why; stopping ??= killGroup(current?.pid, graceMs); return stopping; };
  const onSignal = (signal) => { code = signal === 'SIGINT' ? 130 : 143; void stop('signal'); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  const timer = setTimeout(() => { code = 124; void stop('timeout'); }, limitMs);
  try {
    for (const step of steps) {
      if (stopping) break;
      // A new process group: the whole job can be killed by one negative PID. Nothing else detaches.
      current = spawn(step.command, step.args, { cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      current.stdout.on('data', sink(stdout));
      current.stderr.on('data', sink(stderr));
      writeLock(lockPath, { ...lock, pgid: current.pid });
      const status = await new Promise((resolve) => { current.on('close', (c, s) => resolve(c ?? (s ? 128 : 1))); current.on('error', () => resolve(127)); });
      // Also reap anything the step left behind in its group.
      if (!stopping) await killGroup(current.pid, graceMs);
      if (stopping) break;
      if (status !== 0) { code = status; break; }
    }
    if (stopping) await stopping;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, onSignal);
  }
  const survivors = current && alive(-current.pid) ? 1 : 0;
  if (survivors === 0) releaseLock(lockPath, process.pid);
  return { code, reason, survivors };
}
