/**
 * Heavy-job runner core: a host-wide admission lock, a child in its own process group, a wall-clock
 * limit, bounded output, a group kill that is verified, and a detached watchdog that cleans up when
 * the runner itself dies. `scripts/test-runner.mjs` is the one entry point; see docs/agents/gates.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const LOCK_PATH = process.env.PORTOGRAPH_TEST_LOCK ?? '/tmp/portograph-test.lock';
const LEGACY_GATE_LOCK = '/tmp/portograph-gate.lock';
const WATCHDOG = fileURLToPath(new URL('./test-watchdog.mjs', import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every `ps` runs with a fixed locale and zone, so start times compare the same in every process. */
function ps(args) {
  const result = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 1 << 26, env: { PATH: process.env.PATH ?? '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });
  return { ok: !result.error && result.signal === null && result.status !== null && result.status <= 1, status: result.status, stdout: result.stdout ?? '' };
}

/** True when a process (pid > 0) or a whole group (negative pid) has a live member. */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The start time of a process as `ps` prints it: a string, '' when the process does not exist, undefined when `ps` failed. */
export function startTime(pid) {
  const result = ps(['-o', 'lstart=', '-p', String(pid)]);
  if (!result.ok) return undefined;
  const text = result.stdout.trim();
  return result.status === 0 && text !== '' ? text : '';
}

const startMs = (text) => Date.parse(`${text} UTC`);
const startFloor = (ms) => Math.floor(ms / 1000) * 1000;

/** Members of a process group as `{ pid, ppid, start (ms) }`, or undefined when `ps` failed. */
export function groupMembers(pgid) {
  const result = ps(['-axo', 'pid=,ppid=,pgid=,lstart=']);
  if (!result.ok || result.status !== 0) return undefined;
  const members = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match && Number(match[3]) === pgid) members.push({ pid: Number(match[1]), ppid: Number(match[2]), start: startMs(match[4]) });
  }
  return members;
}

/** TERM one process, wait, KILL it if it stays. */
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

/**
 * TERM the group, wait `graceMs`, KILL what remains, and report whether 0 members remain.
 * Without `since` the group is one this process started itself and is signalled as a group. With
 * `{ since, pgStart }` (ms; the job's start and the group leader's start) the pgid may be stale:
 * nothing is killed when the leader exists with another start time than `pgStart` (the id was
 * reused; without `pgStart`, a leader started outside `since` to `since + 5 s`), and only members
 * started at or after `since` are signalled and counted. A group with no leader cannot be reused.
 */
export async function killGroup(pgid, graceMs = 3000, recorded) {
  if (!Number.isInteger(pgid) || pgid <= 1) return true;
  if (recorded === undefined) {
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
  const ours = () => {
    const members = groupMembers(pgid);
    if (members === undefined) return undefined; // ps failed: cannot tell
    const leader = members.find((member) => member.pid === pgid);
    const foreign = leader !== undefined && recorded.since > 0 && (recorded.pgStart === undefined ? !(leader.start >= recorded.since && leader.start <= recorded.since + 5000) : leader.start !== recorded.pgStart);
    if (foreign) return []; // pgid reused by an unrelated job
    return members.filter((member) => member.start >= recorded.since).map((member) => member.pid);
  };
  for (const [signal, wait] of [['SIGTERM', graceMs], ['SIGKILL', 5000]]) {
    const first = ours();
    if (first === undefined) return false;
    if (first.length === 0) return true;
    for (const pid of first) { try { process.kill(pid, signal); } catch { /* gone */ } }
    const end = Date.now() + wait;
    for (;;) {
      await sleep(50);
      const left = ours();
      if (left === undefined) return false;
      if (left.length === 0) return true;
      if (Date.now() >= end) break;
    }
  }
  return false;
}

/**
 * Group ids of orphans of a job whose runner died before it wrote the group id: group leaders (pid ==
 * pgid) that `init` adopted (ppid 1), started at or after `since`, whose command line equals the one
 * recorded in the lock before the spawn. Best effort: a program that rewrites its title is missed.
 */
export function orphanGroups(commandLine, since = 0) {
  if (typeof commandLine !== 'string' || commandLine === '') return [];
  const result = ps(['-axo', 'pid=,ppid=,pgid=,command=']);
  if (!result.ok || result.status !== 0) return [];
  const found = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && match[1] === match[3] && match[2] === '1' && match[4] === commandLine) found.push(Number(match[3]));
  }
  return found.filter((pgid) => { const started = startTime(pgid); return started !== undefined && started !== '' && startMs(started) >= since; });
}

/** Kill every group a lock record names: its recorded one, or the orphans of its pending spawn. */
export async function killJobGroups(lock, graceMs = 3000) {
  const since = startFloor(Number(lock.since) || 0);
  const pgStart = typeof lock.pgStart === 'string' && lock.pgStart !== '' ? startMs(lock.pgStart) : undefined;
  const groups = Number.isInteger(lock.pgid) ? [lock.pgid] : orphanGroups(lock.pending, since);
  const results = await Promise.all(groups.map((group) => killGroup(group, graceMs, { since, pgStart })));
  return results.every(Boolean);
}

/** This process's own group id, or undefined when `ps` fails. */
function ownGroup() {
  const result = ps(['-o', 'pgid=', '-p', String(process.pid)]);
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/**
 * The holder's PID when this process runs inside a job that holds the lock (`PORTOGRAPH_LOCK_HELD`),
 * else undefined. The holder must be live and this process must stand in the holder's job group.
 */
export function heldLock(path = LOCK_PATH) {
  const held = Number(process.env.PORTOGRAPH_LOCK_HELD);
  const lock = readLock(path);
  if (!Number.isInteger(held) || lock?.pid !== held || ownerState(lock) === 'dead') return undefined;
  const group = ownGroup();
  return group === undefined || group === lock.pgid ? held : undefined;
}

function writeLock(path, record) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, path);
}

let ownStart;
/** The same owner: equal pid and start time (the job fields change while the job runs). */
const sameOwner = (a, b) => a !== undefined && b !== undefined && a.pid === b.pid && a.start === b.start;

/** Remove the lock file only while it still names this owner (pid and start time). */
export function releaseLock(path, pid, start) {
  if (start === undefined && pid === process.pid) { ownStart ??= startTime(process.pid); start = ownStart; }
  const lock = readLock(path);
  if (lock !== undefined && lock.pid === pid && (start === undefined || lock.start === start)) { try { unlinkSync(path); } catch { /* already removed */ } }
}

/** 'live', 'dead' (provably gone) or 'unknown' (`ps` failed or the record has no start time); unknown counts as live. */
function ownerState(lock) {
  if (!Number.isInteger(lock.pid) || !alive(lock.pid)) return 'dead';
  if (typeof lock.start !== 'string' || lock.start === '') return 'unknown';
  const started = startTime(lock.pid);
  if (started === undefined) return 'unknown';
  return started === lock.start ? 'live' : 'dead';
}

/** Take the sidecar that serializes the reclaim of a stale lock; false when another job holds it. */
function takeReclaim(path) {
  const side = `${path}.reclaim`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(side, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, start: startTime(process.pid) }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(side);
      if (holder !== undefined && ownerState(holder) !== 'dead') return false;
      if (holder === undefined) return false; // half-written; the next round decides
      const claim = `${side}.${process.pid}`;
      try { renameSync(side, claim); unlinkSync(claim); } catch { /* another job removed it */ }
    }
  }
  return false;
}

const dropReclaim = (path) => { try { unlinkSync(`${path}.reclaim`); } catch { /* gone */ } };

/**
 * Reclaim the lock of a dead owner `expected` (pid and start): under the `.reclaim` sidecar, re-read the
 * lock; only if it still names that owner and the owner is provably dead, kill and verify the job's
 * groups, then remove the file. Returns 'removed', 'busy' (another job reclaims) or 'changed' (the lock
 * is no longer that stale record). Throws when a group will not die.
 */
export async function reclaimStale(path, expected, graceMs = 3000) {
  if (!takeReclaim(path)) return 'busy';
  try {
    const lock = readLock(path);
    if (!sameOwner(lock, expected) || ownerState(lock) !== 'dead') return 'changed';
    if (!(await killJobGroups(lock, graceMs))) throw new Error(`stale lock owner ${lock.pid}: its job group will not die; see "stuck lock" in docs/agents/gates.md`);
    unlinkSync(path);
    return 'removed';
  } finally {
    dropReclaim(path);
  }
}

/** True while the old gate lock (a bare pid) names a live process; its runs must still queue behind this lock's. */
function legacyGateLive() {
  try {
    const owner = Number(readFileSync(LEGACY_GATE_LOCK, 'utf8'));
    return Number.isInteger(owner) && owner > 0 && alive(owner);
  } catch { return false; }
}

/**
 * Take the lock. Waits while a live owner holds it (or `ps` cannot tell). A dead owner's job group is
 * killed and verified gone before the lock is reused; if it cannot be killed, this throws.
 */
export async function acquireLock(job, { path = LOCK_PATH, graceMs = 3000, onWait = () => {} } = {}) {
  const start = startTime(process.pid);
  if (start === undefined || start === '') throw new Error('cannot read the start time of this process with ps; refusing to take the lock');
  let announced = false;
  for (;;) {
    const waitFor = (lock) => { if (!announced) { onWait(lock); announced = true; } return sleep(100); };
    if (legacyGateLive()) { await waitFor({ pid: 'legacy gate lock', job: LEGACY_GATE_LOCK }); continue; }
    const record = { pid: process.pid, start, pgid: null, job, since: Date.now() };
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx' });
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const lock = readLock(path);
    if (lock === undefined) { await sleep(50); continue; } // being replaced, or half-written
    if (ownerState(lock) !== 'dead') { await waitFor(lock); continue; }
    // Stale: the owner is gone. The reclaim is serialized and re-checks the record under the sidecar.
    if ((await reclaimStale(path, lock, graceMs)) === 'busy') await sleep(50);
  }
}

/**
 * Run `steps` (each `{ command, args }`) one after another as one job under the lock. Returns
 * `{ code, reason, survivors }`; `reason` is 'exit', 'timeout' or 'signal'. The lock is released only
 * after the job's process group is verified empty; if a group survives, the lock stays.
 */
export async function runJob({ job, steps, limitMs, graceMs = 3000, lockPath = LOCK_PATH, maxOutput = 4 << 20, cwd, env, stdout = process.stdout, stderr = process.stderr, watchdogPollMs = 200 }) {
  // Inside a job that holds the lock: no second lock and no watchdog; the child stays in the holder's group so the holder's kill reaches it.
  const inherited = heldLock(lockPath) !== undefined;
  const lock = inherited ? undefined : await acquireLock(job, { path: lockPath, graceMs, onWait: (owner) => stderr.write(`waiting for the test lock (pid ${owner.pid}, ${owner.job}); a stuck lock: see docs/agents/gates.md\n`) });
  if (lock) {
    // Double fork: a short-lived node starts the watchdog and exits, so launchd adopts the watchdog.
    const launcher = spawn(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref();`, WATCHDOG, String(process.pid), lock.start, lockPath, String(watchdogPollMs)], { stdio: 'ignore' });
    launcher.on('error', () => {});
    launcher.unref();
  }
  let current;
  let reason = 'exit';
  let code = 0;
  let written = 0;
  let dropped = false;
  let leaked = false;
  const sink = (stream) => (chunk) => {
    if (written < maxOutput) { written += chunk.length; stream.write(chunk); } else if (!dropped) {
      dropped = true;
      stream.write(`\n[test-runner] output passed ${maxOutput} bytes; the rest is dropped\n`);
    }
  };
  let stopping;
  const killStep = async () => {
    if (!inherited) { if (!(await killGroup(current?.pid, graceMs))) leaked = true; return; }
    await killPid(current?.pid, graceMs);
    // Fork workers of the step are adopted by init and stay in the holder's group: kill those too.
    const group = ownGroup();
    if (group === undefined) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const orphans = (groupMembers(group) ?? []).filter((member) => member.ppid === 1 && member.pid !== process.pid);
      for (const member of orphans) { try { process.kill(member.pid, signal); } catch { /* gone */ } }
      if (orphans.length === 0) break;
      await sleep(signal === 'SIGTERM' ? graceMs : 50);
    }
  };
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
      const since = Date.now();
      if (lock) writeLock(lockPath, { ...lock, pgid: null, since, pending: [step.command, ...step.args].join(' ') });
      current = spawn(step.command, step.args, { cwd, env: { ...(env ?? process.env), ...(lock ? { PORTOGRAPH_LOCK_HELD: String(process.pid) } : {}) }, detached: !inherited, stdio: ['ignore', 'pipe', 'pipe'] });
      if (lock) {
        writeLock(lockPath, { ...lock, pgid: current.pid, pending: null, since });
        // The leader's start time tells the group from a later process that reuses the id.
        const pgStart = startTime(current.pid);
        if (pgStart) writeLock(lockPath, { ...lock, pgid: current.pid, pending: null, since, pgStart });
      }
      current.stdout.on('data', sink(stdout));
      current.stderr.on('data', sink(stderr));
      const closed = new Promise((resolve) => current.on('close', resolve));
      // Wait for 'exit', not 'close': a grandchild that holds the pipes open must not hold the job.
      const status = await new Promise((resolve) => { current.on('exit', (c, s) => resolve(c ?? (s ? 128 : 1))); current.on('error', () => resolve(127)); });
      // Also reap anything the step left behind in its group, then drain and destroy the pipes.
      if (!stopping && !inherited && !(await killGroup(current.pid, graceMs))) leaked = true;
      await Promise.race([closed, sleep(1000)]);
      current.stdout.destroy();
      current.stderr.destroy();
      if (stopping || leaked) break;
      if (status !== 0) { code = status; break; }
    }
    if (stopping) await stopping;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, onSignal);
  }
  const survivors = !inherited && (leaked || (current && alive(-current.pid))) ? 1 : 0;
  if (lock && survivors === 0) releaseLock(lockPath, process.pid, lock.start);
  return { code, reason, survivors };
}
