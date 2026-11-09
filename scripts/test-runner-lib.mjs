/**
 * Heavy-job runner core. Admission is a kernel flock on the lock file, held through a `lockf` keeper
 * child that lives while the runner's pipe is open, so the kernel frees it when the runner dies and
 * nothing is ever unlinked or reclaimed. The file content is only a record of the holder's job
 * (pid, start, group); the next flock holder, or the watchdog, kills and verifies the survivors of
 * the previous record's group under the flock. Also: a child in its own process group, a wall-clock
 * limit, bounded output and a verified group kill. `scripts/test-runner.mjs` is the one entry point;
 * see docs/gates.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const LOCK_PATH = process.env.PORTOGRAPH_TEST_LOCK ?? '/tmp/portograph-test.lock';
// PORTOGRAPH_LOCKF and PORTOGRAPH_WATCHDOG replace the lockf binary and the watchdog script; the fixtures use them.
const lockfPath = () => process.env.PORTOGRAPH_LOCKF ?? '/usr/bin/lockf';
const watchdogPath = () => process.env.PORTOGRAPH_WATCHDOG ?? fileURLToPath(new URL('./test-watchdog.mjs', import.meta.url));
// PORTOGRAPH_HEALTH_PROBE replaces the memory and load probe: an executable that prints JSON {freePct, load1, swapUsedMb, cpus}.
const probePath = () => process.env.PORTOGRAPH_HEALTH_PROBE;
const RECORD_SIZE = 4096;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `promise` for at most `ms`; the timer is cleared, so it does not keep the process alive. */
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});

/** Every `ps` runs with a fixed locale and zone, so start times compare the same in every process. */
function ps(args) {
  const result = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 1 << 26, env: { PATH: process.env.PATH ?? '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });
  return { ok: !result.error && result.signal === null && result.status !== null && result.status <= 1, status: result.status, stdout: result.stdout ?? '' };
}

/** `ps` with retries: a transient failure must not fail a cleanup. Returns undefined after `tries` failures. */
function psRetry(args, tries = 10) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = ps(args);
    if (result.ok && result.status === 0) return result;
    spawnSync('sleep', ['0.2']);
  }
  return undefined;
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
export function groupMembers(pgid, tries = 1) {
  const result = psRetry(['-axo', 'pid=,ppid=,pgid=,lstart='], tries);
  if (result === undefined) return undefined;
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
 * Without `recorded` the group is one this process started itself and is signalled as a group. With
 * `{ since, pgStart }` (ms; the job's start and the group leader's start) the pgid may be stale:
 * nothing is killed when the leader exists with another start time than `pgStart` (the id was
 * reused; without `pgStart`, a leader started outside `since` to `since + 5 s`), and only members
 * started at or after `since` are signalled and counted. A group with no leader cannot be reused.
 * A failing `ps` is retried before the kill counts as unverified.
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
    const members = groupMembers(pgid, 10);
    if (members === undefined) return undefined; // ps failed ten times: cannot tell
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
 * recorded before the spawn. Best effort: a program that rewrites its title is missed. Undefined when
 * `ps` keeps failing.
 */
export function orphanGroups(commandLine, since = 0) {
  if (typeof commandLine !== 'string' || commandLine === '') return [];
  const result = psRetry(['-axo', 'pid=,ppid=,pgid=,command=']);
  if (result === undefined) return undefined;
  const found = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && match[1] === match[3] && match[2] === '1' && match[4] === commandLine) found.push(Number(match[3]));
  }
  return found.filter((pgid) => { const started = startTime(pgid); return started !== undefined && started !== '' && startMs(started) >= since; });
}

/** Kill every group a record names: its recorded one, or the orphans of its pending spawn. */
export async function killJobGroups(record, graceMs = 3000) {
  const since = startFloor(Number(record.since) || 0);
  const pgStart = typeof record.pgStart === 'string' && record.pgStart !== '' ? startMs(record.pgStart) : undefined;
  const groups = Number.isInteger(record.pgid) ? [record.pgid] : orphanGroups(record.pending, since);
  if (groups === undefined) return false;
  const results = await Promise.all(groups.map((group) => killGroup(group, graceMs, { since, pgStart })));
  return results.every(Boolean);
}

/** This process's own group id, or undefined when `ps` fails. */
function ownGroup() {
  const result = ps(['-o', 'pgid=', '-p', String(process.pid)]);
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The record in the lock file, or undefined when it is empty, garbage or being rewritten (one retry). */
export function readLock(path) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return value !== null && typeof value === 'object' ? value : undefined;
    } catch { spawnSync('sleep', ['0.02']); }
  }
  return undefined;
}

/** Like `readLock` but tells a record apart from a read error: `{ state: 'record', record }` or `{ state: 'unreadable' }`. */
export function readRecord(path) {
  const record = readLock(path);
  return record === undefined ? { state: 'unreadable' } : { state: 'record', record };
}

/**
 * Rewrite the record in place (same inode: the flock lives on it) as one fixed-length write padded
 * with spaces, with no truncate, so no reader sees a torn record. Only the flock holder calls this.
 * Long text fields are cut so the record fits.
 */
export function writeRecord(path, record) {
  const cut = (value) => (typeof value === 'string' && value.length > 900 ? `${value.slice(0, 900)}...` : value);
  const text = JSON.stringify({ ...record, job: cut(record.job), pending: cut(record.pending) });
  if (Buffer.byteLength(text) > RECORD_SIZE) throw new Error('lock record is too long');
  const fd = openSync(path, 'r+');
  try { writeSync(fd, Buffer.from(text.padEnd(RECORD_SIZE - (Buffer.byteLength(text) - text.length), ' ')), 0, RECORD_SIZE, 0); } finally { closeSync(fd); }
}

/** 'live', 'dead' (provably gone) or 'unknown' (`ps` failed or no start time); unknown counts as live. */
function ownerState(record) {
  if (!Number.isInteger(record.pid) || !alive(record.pid)) return 'dead';
  if (typeof record.start !== 'string' || record.start === '') return 'unknown';
  const started = startTime(record.pid);
  if (started === undefined) return 'unknown';
  return started === record.start ? 'live' : 'dead';
}

/**
 * The holder's PID when this process runs inside a job that holds the lock (`PORTOGRAPH_LOCK_HELD`),
 * else undefined. The holder must be live and this process must stand in the record's job group.
 */
export function heldLock(path = LOCK_PATH) {
  const held = Number(process.env.PORTOGRAPH_LOCK_HELD);
  const record = readLock(path);
  if (!Number.isInteger(held) || record?.pid !== held || ownerState(record) === 'dead') return undefined;
  const group = ownGroup();
  return group === undefined || group === record.pgid ? held : undefined;
}

/**
 * Take the kernel flock on `path`, blocking up to `timeoutMs`. The flock lives in a `lockf` keeper
 * whose command waits on a pipe from this process; it ends, and the kernel frees the flock, when
 * `release()` runs or this process dies. Busy answers (exit 75) wait; `lockf` failing to run (exit 71,
 * a signal, EAGAIN and the like) backs off and retries. Throws on timeout or after 8 such failures.
 * The returned handle has `write(record)` (false once the lock is lost), `onLost(fn)` and `release()`.
 * The lock is lost when the keeper exits before `release()` or the lock file's inode changes.
 */
export async function takeFlock(path, { timeoutMs = Infinity, onWait = () => {} } = {}) {
  const end = Date.now() + timeoutMs;
  let announced = false;
  let failures = 0;
  for (;;) {
    let keeper;
    const outcome = await new Promise((resolve) => {
      try { keeper = spawn(lockfPath(), ['-k', '-t', '1', path, '/bin/sh', '-c', 'echo locked; exec /bin/cat'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true }); } catch (error) { resolve(`retry: ${error.message}`); return; }
      let seen = '';
      keeper.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('locked')) resolve('locked'); });
      keeper.on('exit', (code, signal) => resolve(code === 75 ? 'busy' : `retry: lockf ended with ${signal ?? `exit ${code}`}`));
      keeper.on('error', (error) => resolve(`retry: ${error.message}`));
    });
    if (outcome === 'locked') {
      const flock = {
        inode: statSync(path).ino,
        lost: undefined,
        released: false,
        handlers: [],
        onLost(handler) { if (this.lost) handler(this.lost); else this.handlers.push(handler); },
        markLost(why) { if (this.lost) return; this.lost = why; for (const handler of this.handlers) handler(why); },
        write(record) {
          if (this.lost) return false;
          try {
            if (statSync(path).ino !== this.inode) { this.markLost('the lock file was replaced'); return false; }
            writeRecord(path, record);
            return true;
          } catch { this.markLost('the lock file cannot be written'); return false; }
        },
        async release() {
          this.released = true;
          keeper.stdin.end();
          const gone = new Promise((resolve) => (keeper.exitCode !== null || keeper.signalCode !== null ? resolve() : keeper.on('exit', resolve)));
          await within(gone, 2000);
          if (keeper.exitCode === null && keeper.signalCode === null) { try { process.kill(keeper.pid, 'SIGKILL'); } catch { /* gone */ } await gone; }
          keeper.stdout.destroy();
        },
      };
      keeper.on('exit', () => { if (!flock.released) flock.markLost('the lock keeper exited'); });
      if (keeper.exitCode !== null || keeper.signalCode !== null) flock.markLost('the lock keeper exited');
      return flock;
    }
    if (outcome === 'busy') {
      failures = 0;
      if (Date.now() >= end) throw new Error(`the lock ${path} stays busy; see "stuck lock" in docs/gates.md`);
      if (!announced) { onWait(readLock(path) ?? {}); announced = true; }
      continue;
    }
    failures += 1;
    if (failures >= 8) throw new Error(`cannot take the lock ${path}: ${outcome}`);
    await sleep(Math.min(2000, 100 * 2 ** failures));
  }
}

/**
 * With the flock held: kill and verify the survivors of the previous record's group (the checks of
 * `killGroup`), then clear the record. Throws when a survivor will not die; the record stays.
 */
export async function cleanupRecord(path, graceMs = 3000, flock) {
  const record = readLock(path);
  if (record === undefined || (record.pgid == null && !record.pending)) return;
  if (!(await killJobGroups(record, graceMs))) {
    throw new Error(`processes of the previous job (pid ${record.pid}, group ${record.pgid}) will not die; see "stuck lock" in docs/gates.md`);
  }
  if (flock) flock.write({}); else writeRecord(path, {});
}

/** Run a command with a fixed locale; its trimmed stdout, or undefined when it fails. */
function probeCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
  return result.error || result.status !== 0 ? undefined : result.stdout.trim();
}

/**
 * The host's memory and load: `{ freePct, load1, swapUsedMb, cpus, errors }`. A field is undefined when
 * it cannot be read (unknown), and `errors` names what failed. On macOS: `sysctl kern.memorystatus_level`
 * (percent of memory free) and `sysctl vm.swapusage`; elsewhere memory is unknown and not an error.
 */
export function readHealth() {
  const hook = probePath();
  if (hook !== undefined) {
    try {
      const value = JSON.parse(probeCommand(hook, []) ?? '');
      if (value === null || typeof value !== 'object') throw new Error('not an object');
      const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
      return { freePct: num(value.freePct), load1: num(value.load1), swapUsedMb: num(value.swapUsedMb), cpus: num(value.cpus) ?? cpus().length, errors: [] };
    } catch { return { freePct: undefined, load1: undefined, swapUsedMb: undefined, cpus: cpus().length, errors: ['the health probe'] }; }
  }
  const errors = [];
  let freePct;
  let swapUsedMb;
  if (process.platform === 'darwin') {
    const level = probeCommand('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']);
    if (level !== undefined && /^\d+$/.test(level) && Number(level) <= 100) freePct = Number(level); else errors.push('kern.memorystatus_level');
    const swap = /used = ([\d.]+)([KMG])/.exec(probeCommand('/usr/sbin/sysctl', ['-n', 'vm.swapusage']) ?? '');
    if (swap) swapUsedMb = Math.round(Number(swap[1]) * { K: 1 / 1024, M: 1, G: 1024 }[swap[2]]); else errors.push('vm.swapusage');
  }
  const load1 = loadavg()[0];
  return { freePct, load1: Number.isFinite(load1) ? load1 : undefined, swapUsedMb, cpus: cpus().length, errors };
}

const envNumber = (name, fallback) => { const value = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) ? value : fallback; };

/**
 * One admission decision: `{ reading, admit, reason }`. `reason` is undefined when the host may run a
 * job (an unknown reading passes); `admit` is the record of the readings. Limits: PORTOGRAPH_MIN_FREE_PCT
 * (default 20) and PORTOGRAPH_MAX_LOAD (default 2 x CPU count).
 */
export function checkHealth() {
  const reading = readHealth();
  const minFree = envNumber('PORTOGRAPH_MIN_FREE_PCT', 20);
  const maxLoad = envNumber('PORTOGRAPH_MAX_LOAD', 2 * reading.cpus);
  const reasons = [];
  if (reading.freePct !== undefined && reading.freePct < minFree) reasons.push(`free memory ${reading.freePct}% is below ${minFree}%`);
  if (reading.load1 !== undefined && reading.load1 > maxLoad) reasons.push(`load ${reading.load1.toFixed(2)} is above ${maxLoad}`);
  const admit = { freePct: reading.freePct ?? null, load1: reading.load1 === undefined ? null : Math.round(reading.load1 * 100) / 100, swapUsedMb: reading.swapUsedMb ?? null };
  return { reading, admit, reason: reasons.length > 0 ? reasons.join(' and ') : undefined };
}

/**
 * The wait for a healthy host. `check()` returns `{ admit }` when the host may run a job, else
 * `{ reason }`; an unreadable probe warns once and counts as unknown. `pause(reason)` prints one waiting
 * line, sleeps PORTOGRAPH_ADMIT_POLL_MS (default 15 s) and returns true, or returns false once
 * PORTOGRAPH_ADMIT_WAIT_MS (default 15 min) of waiting has passed: the caller gives up.
 */
export function healthWaiter({ onWait = () => {}, onWarn = () => {} } = {}) {
  const pollMs = envNumber('PORTOGRAPH_ADMIT_POLL_MS', 15_000);
  const capMs = envNumber('PORTOGRAPH_ADMIT_WAIT_MS', 15 * 60_000);
  const begin = Date.now();
  let announced = false;
  let warned = false;
  return {
    capMs,
    check() {
      const { reading, admit, reason } = checkHealth();
      if (reading.errors.length > 0 && !warned) { warned = true; onWarn(`cannot read ${reading.errors.join(', ')}; counting it as unknown and going on`); }
      return reason === undefined ? { admit } : { reason };
    },
    async pause(reason) {
      const left = capMs - (Date.now() - begin);
      if (left <= 0) return false;
      if (!announced) { announced = true; onWait(`waiting for the host: ${reason}; polling every ${Math.round(pollMs / 1000)} s, giving up after ${Math.round(capMs / 6000) / 10} min`); }
      await sleep(Math.max(1, Math.min(pollMs, left)));
      return true;
    },
  };
}

const held = new Map();

/**
 * Take the lock for `job`: the flock, then the cleanup of the previous record, then this job's record.
 * Throws (and holds nothing) when the previous job's survivors will not die.
 */
export async function acquireLock(job, { path = LOCK_PATH, graceMs = 3000, onWait = () => {}, onHealthWait = () => {}, onWarn = () => {} } = {}) {
  const start = startTime(process.pid);
  if (start === undefined || start === '') throw new Error('cannot read the start time of this process with ps; refusing to take the lock');
  const waiter = healthWaiter({ onWait: onHealthWait, onWarn });
  for (;;) {
    const flock = await takeFlock(path, { onWait });
    let verdict;
    try {
      await cleanupRecord(path, graceMs, flock);
      verdict = waiter.check();
      if (verdict.admit) {
        const record = { pid: process.pid, start, pgid: null, job, since: Date.now(), admit: verdict.admit };
        if (statSync(path).size > RECORD_SIZE) ftruncateSync(openSync(path, 'r+'), RECORD_SIZE); // a longer leftover file: cut it once, before the job
        if (!flock.write(record)) throw new Error(`cannot write the lock record: ${flock.lost}`);
        held.set(path, flock);
        return record;
      }
    } catch (error) {
      await flock.release();
      throw error;
    }
    // The host is short of memory or busy: let go of the flock so others are not held up, and poll.
    await flock.release();
    if (!(await waiter.pause(verdict.reason))) throw new Error(`gave up waiting for the host after ${waiter.capMs / 60_000} min: ${verdict.reason}; PORTOGRAPH_MIN_FREE_PCT and PORTOGRAPH_MAX_LOAD change the limits`);
  }
}

/** Free the lock. The record is cleared unless `keepRecord` (a group survives: the next holder kills it). */
export async function releaseLock(path, pid, start, { keepRecord = false } = {}) {
  const flock = held.get(path);
  if (flock === undefined) return;
  held.delete(path);
  if (!keepRecord) { const record = readLock(path); if (record?.pid === pid) flock.write({}); }
  await flock.release();
}

/**
 * Run `steps` (each `{ command, args }`) one after another as one job under the lock. Returns
 * `{ code, reason, survivors }`; `reason` is 'exit', 'timeout' or 'signal'. The record is cleared only
 * after the job's process group is verified empty; if a group survives, it stays for the next holder.
 * A failing step stops the job unless `continueOnFailure`; a timeout, a signal, a lost lock or a
 * surviving group always stops it.
 */
export async function runJob({ job, steps, limitMs, graceMs = 3000, lockPath = LOCK_PATH, maxOutput = 4 << 20, cwd, env, stdout = process.stdout, stderr = process.stderr, watchdogPollMs = 200, continueOnFailure = false }) {
  // Inside a job that holds the lock: no second lock and no watchdog; the child stays in the holder's group so the holder's kill reaches it.
  const inherited = heldLock(lockPath) !== undefined;
  // A stale or foreign PORTOGRAPH_LOCK_HELD must not queue behind a lock this process could never get.
  if (!inherited && process.env.PORTOGRAPH_LOCK_HELD) throw new Error('PORTOGRAPH_LOCK_HELD is set but the held lock is not valid (the holder is gone, or this process stands outside its group); not queueing');
  const lock = inherited ? undefined : await acquireLock(job, { path: lockPath, graceMs, onWait: (owner) => stderr.write(`waiting for the test lock (pid ${owner.pid ?? '?'}, ${owner.job ?? '?'}); a stuck lock: see docs/gates.md\n`) , onHealthWait: (line) => stderr.write(`[test-runner] ${line}\n`), onWarn: (line) => stderr.write(`[test-runner] warning: ${line}\n`) });
  const flock = lock ? held.get(lockPath) : undefined;
  if (lock) {
    // Double fork: a short-lived node starts the watchdog, prints its pid and exits, so launchd adopts the watchdog.
    const launcher = spawn(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }); c.on('error', () => {}); process.stdout.write(String(c.pid)); c.unref();`, watchdogPath(), String(process.pid), lock.start, lockPath, String(watchdogPollMs)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let printed = '';
    launcher.stdout.on('data', (chunk) => { printed += chunk; });
    launcher.on('error', () => {});
    await within(new Promise((resolve) => launcher.on('exit', resolve)), 3000);
    await sleep(150);
    const watchdog = Number(printed);
    if (!Number.isInteger(watchdog) || watchdog <= 1 || !alive(watchdog)) {
      await releaseLock(lockPath, process.pid, lock.start);
      throw new Error('the watchdog did not start; refusing to run a job nothing would clean up after');
    }
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
  flock?.onLost(() => { code = 125; void stop('lock lost'); });
  const onSignal = (signal) => { code = signal === 'SIGINT' ? 130 : 143; void stop('signal'); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  const timer = setTimeout(() => { code = 124; void stop('timeout'); }, limitMs);
  const waiter = lock ? healthWaiter({ onWait: (line) => stderr.write(`[test-runner] ${line}\n`), onWarn: (line) => stderr.write(`[test-runner] warning: ${line}\n`) }) : undefined;
  let stepsRun = 0;
  try {
    for (const step of steps) {
      if (stopping) break;
      // Before each later step the host is checked again. The lock stays held (no other heavy job may start); the wait is capped.
      if (waiter && stepsRun > 0) {
        let verdict = waiter.check();
        while (verdict.reason !== undefined && !stopping) {
          if (!(await waiter.pause(verdict.reason))) {
            stderr.write(`[test-runner] gave up waiting for the host before the next step: ${verdict.reason}\n`);
            if (code === 0) code = 1;
            reason = 'host busy';
            stopping = Promise.resolve();
            break;
          }
          verdict = waiter.check();
        }
        if (stopping) break;
        lock.admit = verdict.admit;
      }
      stepsRun += 1;
      // A new process group: the whole job can be killed by one negative PID. Nothing else detaches.
      // The command line goes into the record first; the group id follows in the same tick as spawn() returns.
      const since = Date.now();
      if (flock && !flock.write({ ...lock, pgid: null, since, pending: [step.command, ...step.args].join(' ') })) break;
      current = spawn(step.command, step.args, { cwd, env: { ...(env ?? process.env), ...(lock ? { PORTOGRAPH_LOCK_HELD: String(process.pid) } : {}) }, detached: !inherited, stdio: ['ignore', 'pipe', 'pipe'] });
      if (flock) {
        flock.write({ ...lock, pgid: current.pid, pending: null, since });
        // The leader's start time tells the group from a later process that reuses the id.
        const pgStart = startTime(current.pid);
        if (pgStart) flock.write({ ...lock, pgid: current.pid, pending: null, since, pgStart });
      }
      current.stdout.on('data', sink(stdout));
      current.stderr.on('data', sink(stderr));
      const closed = new Promise((resolve) => current.on('close', resolve));
      // Wait for 'exit', not 'close': a grandchild that holds the pipes open must not hold the job.
      const status = await new Promise((resolve) => { current.on('exit', (c, s) => resolve(c ?? (s ? 128 : 1))); current.on('error', () => resolve(127)); });
      // Also reap anything the step left behind in its group, then drain and destroy the pipes.
      if (!stopping && !inherited && !(await killGroup(current.pid, graceMs))) leaked = true;
      await within(closed, 1000);
      current.stdout.destroy();
      current.stderr.destroy();
      if (stopping || leaked) break;
      if (status !== 0) {
        // With continueOnFailure the later steps still run; the first failing code is the job's code.
        if (code === 0) code = status;
        if (!continueOnFailure) break;
      }
    }
    if (stopping) await stopping;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, onSignal);
  }
  const survivors = !inherited && (leaked || (current && alive(-current.pid))) ? 1 : 0;
  if (lock) await releaseLock(lockPath, process.pid, lock.start, { keepRecord: survivors > 0 || flock.lost !== undefined });
  return { code, reason, survivors };
}
