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

/** TERM one process, wait, KILL it if it stays (used inside a held lock, where the holder kills the group). */
export async function killPid(pid, graceMs = 3000) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  for (const [signal, wait] of [['SIGTERM', graceMs], ['SIGKILL', 5000]]) {
    try { process.kill(pid, signal); } catch { return true; }
    const end = Date.now() + wait;
    while (alive(pid) && Date.now() < end) await sleep(25);
    if (!alive(pid)) return true;
  }
  return false;
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

/**
 * Group ids of orphans of a job whose runner died before it wrote the group id: group leaders (pid ==
 * pgid) that `init` adopted (ppid 1) and whose command line equals the one recorded in the lock before
 * the spawn. The lock is exclusive, so only a raw bypass run could match by mistake.
 */
export function orphanGroups(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return [];
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ps.status !== 0) return [];
  const found = [];
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && match[1] === match[3] && match[2] === '1' && match[4] === commandLine) found.push(Number(match[3]));
  }
  return found;
}

/** Kill every group a lock record names: its recorded one, or the orphans of its pending spawn. */
export async function killJobGroups(lock, graceMs = 3000) {
  const groups = Number.isInteger(lock.pgid) ? [lock.pgid] : orphanGroups(lock.pending);
  const results = await Promise.all(groups.map((group) => killGroup(group, graceMs)));
  return results.every(Boolean);
}

/** The holder's PID when this process runs inside a job that holds the lock (`PORTOGRAPH_LOCK_HELD`), else undefined. */
export function heldLock(path = LOCK_PATH) {
  const held = Number(process.env.PORTOGRAPH_LOCK_HELD);
  const lock = readLock(path);
  return Number.isInteger(held) && lock?.pid === held && ownerLive(lock) ? held : undefined;
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
    if (!(await killJobGroups(lock, graceMs))) throw new Error(`stale lock owner ${lock.pid}: group ${lock.pgid} will not die`);
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
  // Inside a job that holds the lock: no second lock and no watchdog; the child stays in the holder's group so the holder's kill reaches it.
  const inherited = heldLock(lockPath) !== undefined;
  const lock = inherited ? undefined : await acquireLock(job, { path: lockPath, graceMs, onWait: (owner) => stderr.write(`waiting for the test lock (pid ${owner.pid}, ${owner.job})\n`) });
  if (lock) spawn(process.execPath, [WATCHDOG, String(process.pid), lock.start, lockPath, String(watchdogPollMs)], { detached: true, stdio: 'ignore' }).unref();
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
  const killStep = () => (inherited ? killPid(current?.pid, graceMs) : killGroup(current?.pid, graceMs));
  const stop = (why) => { reason = why; stopping ??= killStep(); return stopping; };
  const onSignal = (signal) => { code = signal === 'SIGINT' ? 130 : 143; void stop('signal'); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  const timer = setTimeout(() => { code = 124; void stop('timeout'); }, limitMs);
  try {
    for (const step of steps) {
      if (stopping) break;
      // A new process group: the whole job can be killed by one negative PID. Nothing else detaches.
      // The command line goes into the lock first; the group id follows in the same tick as spawn() returns.
      if (lock) writeLock(lockPath, { ...lock, pgid: null, pending: [step.command, ...step.args].join(' ') });
      current = spawn(step.command, step.args, { cwd, env: { ...(env ?? process.env), ...(lock ? { PORTOGRAPH_LOCK_HELD: String(process.pid) } : {}) }, detached: !inherited, stdio: ['ignore', 'pipe', 'pipe'] });
      if (lock) writeLock(lockPath, { ...lock, pgid: current.pid, pending: null });
      current.stdout.on('data', sink(stdout));
      current.stderr.on('data', sink(stderr));
      const status = await new Promise((resolve) => { current.on('close', (c, s) => resolve(c ?? (s ? 128 : 1))); current.on('error', () => resolve(127)); });
      // Also reap anything the step left behind in its group.
      if (!stopping && !inherited) await killGroup(current.pid, graceMs);
      if (stopping) break;
      if (status !== 0) { code = status; break; }
    }
    if (stopping) await stopping;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, onSignal);
  }
  const survivors = !inherited && current && alive(-current.pid) ? 1 : 0;
  if (lock && survivors === 0) releaseLock(lockPath, process.pid);
  return { code, reason, survivors };
}
