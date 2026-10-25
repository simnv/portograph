/**
 * Heavy-job runner core. Admission is a kernel flock on the lock file, held through a `lockf` keeper
 * child that lives while the runner's pipe is open, so the kernel frees it when the runner dies and
 * nothing is ever unlinked or reclaimed. The file content is only a record of the holder's job
 * (pid, start, group); the next flock holder, or the watchdog, kills and verifies the survivors of
 * the previous record's group under the flock. Also: a child in its own process group, a wall-clock
 * limit, bounded output and a verified group kill. `scripts/test-runner.mjs` is the one entry point;
 * see docs/agents/gates.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const LOCK_PATH = process.env.PORTOGRAPH_TEST_LOCK ?? '/tmp/portograph-test.lock';
const LOCKF = '/usr/bin/lockf';
const WATCHDOG = fileURLToPath(new URL('./test-watchdog.mjs', import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Rewrite the record in place (same inode: the flock lives on it). Only the flock holder calls this. */
function writeRecord(path, record) {
  const text = JSON.stringify(record);
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, text, 0);
    ftruncateSync(fd, Buffer.byteLength(text));
  } finally { closeSync(fd); }
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
 * `release()` runs or this process dies. Throws on timeout.
 */
export async function takeFlock(path, { timeoutMs = Infinity, onWait = () => {} } = {}) {
  const end = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const keeper = spawn(LOCKF, ['-k', '-t', '1', path, '/bin/sh', '-c', 'echo locked; exec /bin/cat'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const outcome = await new Promise((resolve) => {
      let seen = '';
      keeper.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('locked')) resolve('locked'); });
      keeper.on('exit', (code) => resolve(code === 75 ? 'busy' : `failed with exit ${code}`));
      keeper.on('error', (error) => resolve(`failed: ${error.message}`));
    });
    if (outcome === 'locked') {
      return {
        async release() {
          keeper.stdin.end();
          const gone = new Promise((resolve) => (keeper.exitCode !== null ? resolve() : keeper.on('exit', resolve)));
          await Promise.race([gone, sleep(2000)]);
          if (keeper.exitCode === null) { try { process.kill(keeper.pid, 'SIGKILL'); } catch { /* gone */ } await gone; }
          keeper.stdout.destroy();
        },
      };
    }
    if (outcome !== 'busy') throw new Error(`cannot take the lock ${path}: ${outcome}`);
    if (Date.now() >= end) throw new Error(`the lock ${path} stays busy; see "stuck lock" in docs/agents/gates.md`);
    if (!announced) { onWait(readLock(path) ?? {}); announced = true; }
  }
}

/**
 * With the flock held: kill and verify the survivors of the previous record's group (the checks of
 * `killGroup`), then clear the record. Throws when a survivor will not die; the record stays.
 */
export async function cleanupRecord(path, graceMs = 3000) {
  const record = readLock(path);
  if (record === undefined || (record.pgid == null && !record.pending)) return;
  if (!(await killJobGroups(record, graceMs))) {
    throw new Error(`processes of the previous job (pid ${record.pid}, group ${record.pgid}) will not die; see "stuck lock" in docs/agents/gates.md`);
  }
  writeRecord(path, {});
}

const held = new Map();

/**
 * Take the lock for `job`: the flock, then the cleanup of the previous record, then this job's record.
 * Throws (and holds nothing) when the previous job's survivors will not die.
 */
export async function acquireLock(job, { path = LOCK_PATH, graceMs = 3000, onWait = () => {} } = {}) {
  const start = startTime(process.pid);
  if (start === undefined || start === '') throw new Error('cannot read the start time of this process with ps; refusing to take the lock');
  const flock = await takeFlock(path, { onWait });
  try {
    await cleanupRecord(path, graceMs);
    const record = { pid: process.pid, start, pgid: null, job, since: Date.now() };
    writeRecord(path, record);
    held.set(path, flock);
    return record;
  } catch (error) {
    await flock.release();
    throw error;
  }
}

/** Free the lock. The record is cleared unless `keepRecord` (a group survives: the next holder kills it). */
export async function releaseLock(path, pid, start, { keepRecord = false } = {}) {
  const flock = held.get(path);
  if (flock === undefined) return;
  held.delete(path);
  if (!keepRecord) { const record = readLock(path); if (record?.pid === pid) writeRecord(path, {}); }
  await flock.release();
}

/**
 * Run `steps` (each `{ command, args }`) one after another as one job under the lock. Returns
 * `{ code, reason, survivors }`; `reason` is 'exit', 'timeout' or 'signal'. The record is cleared only
 * after the job's process group is verified empty; if a group survives, it stays for the next holder.
 */
export async function runJob({ job, steps, limitMs, graceMs = 3000, lockPath = LOCK_PATH, maxOutput = 4 << 20, cwd, env, stdout = process.stdout, stderr = process.stderr, watchdogPollMs = 200 }) {
  // Inside a job that holds the lock: no second lock and no watchdog; the child stays in the holder's group so the holder's kill reaches it.
  const inherited = heldLock(lockPath) !== undefined;
  const lock = inherited ? undefined : await acquireLock(job, { path: lockPath, graceMs, onWait: (owner) => stderr.write(`waiting for the test lock (pid ${owner.pid ?? '?'}, ${owner.job ?? '?'}); a stuck lock: see docs/agents/gates.md\n`) });
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
      // The command line goes into the record first; the group id follows in the same tick as spawn() returns.
      const since = Date.now();
      if (lock) writeRecord(lockPath, { ...lock, pgid: null, since, pending: [step.command, ...step.args].join(' ') });
      current = spawn(step.command, step.args, { cwd, env: { ...(env ?? process.env), ...(lock ? { PORTOGRAPH_LOCK_HELD: String(process.pid) } : {}) }, detached: !inherited, stdio: ['ignore', 'pipe', 'pipe'] });
      if (lock) {
        writeRecord(lockPath, { ...lock, pgid: current.pid, pending: null, since });
        // The leader's start time tells the group from a later process that reuses the id.
        const pgStart = startTime(current.pid);
        if (pgStart) writeRecord(lockPath, { ...lock, pgid: current.pid, pending: null, since, pgStart });
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
  if (lock) await releaseLock(lockPath, process.pid, lock.start, { keepRecord: survivors > 0 });
  return { code, reason, survivors };
}
