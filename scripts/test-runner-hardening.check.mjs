/**
 * Checks of the hardening rules with tiny node children (no vitest): untorn records, a watchdog that
 * keeps watching on read errors and must be alive before a job starts, a lost lock (keeper exit,
 * replaced file), lockf failures with back-off, and a stale PORTOGRAPH_LOCK_HELD. Run with
 * `npm run test:runner`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alive, readLock, runJob, sleep, startTime, takeFlock, writeRecord } from './test-runner-lib.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const LIB = here('./test-runner-lib.mjs');
const WATCHDOG = here('./test-watchdog.mjs');
// The fixtures must not wait for the host: the admission limits are off unless a case sets them.
process.env.PORTOGRAPH_MIN_FREE_PCT ??= '0';
process.env.PORTOGRAPH_MAX_LOAD ??= '1e9';
const dir = mkdtempSync(join(tmpdir(), 'pg-runner-hard-'));
let counter = 0;
const fresh = () => { counter += 1; return join(dir, `lock-${counter}`); };
const exited = (child) => new Promise((resolve) => child.on('close', resolve));
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await sleep(25); return check(); };
const quiet = { write() {} };
const idle = { command: process.execPath, args: ['-e', ''] };
const held = (path) => readLock(path)?.pid !== undefined;
const job = (lock, steps = [idle], extra = {}) => runJob({ job: 'fixture', steps, limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: quiet, ...extra });
const withEnv = async (values, work) => {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await work(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};

test('F2: a reader never sees a torn record while the holder rewrites it', async () => {
  const lock = fresh();
  writeFileSync(lock, '');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeRecord } from ${JSON.stringify(LIB)};
    for (let i = 0; i < 4000; i += 1) writeRecord(${JSON.stringify(lock)}, i % 2 === 0 ? { pid: 1, job: 'short' } : { pid: 2, job: 'x'.repeat(800), pending: 'y'.repeat(800) });`], { stdio: 'ignore' });
  const done = exited(writer);
  let reads = 0;
  let finished = false;
  done.then(() => { finished = true; });
  while (!finished) {
    const text = readFileSync(lock, 'utf8');
    if (text !== '') { JSON.parse(text); reads += 1; }
    await sleep(0);
  }
  assert.ok(reads > 50, `read ${reads} records`);
});

test('F2: the watchdog keeps watching on a read error and exits on a record that names another job', async () => {
  const lock = fresh();
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await sleep(200);
    const start = startTime(runner.pid);
    writeFileSync(lock, '');
    writeRecord(lock, { pid: runner.pid, start, pgid: null, job: 'x' });
    const watchdog = spawn(process.execPath, [WATCHDOG, String(runner.pid), start, lock, '50'], { stdio: 'ignore' });
    const done = exited(watchdog);
    await sleep(300);
    writeFileSync(lock, 'garbage {{{');
    await sleep(700);
    assert.equal(watchdog.exitCode, null, 'still watching after a read error');
    writeFileSync(lock, '{}');
    assert.equal(await Promise.race([done, sleep(3000).then(() => 'hang')]), 0);
  } finally { runner.kill('SIGKILL'); }
});

test('F2: the runner refuses to start when the watchdog is not alive, and frees the lock', async () => {
  const lock = fresh();
  const dead = join(dir, 'dead-watchdog.mjs');
  writeFileSync(dead, 'process.exit(0);\n');
  const marker = join(dir, 'should-not-run');
  await assert.rejects(withEnv({ PORTOGRAPH_WATCHDOG: dead }, () => job(lock, [{ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }])), /watchdog did not start/);
  assert.equal(existsSync(marker), false);
  assert.equal(held(lock), false);
  assert.equal((await job(lock)).code, 0, 'the next job starts');
});

test('F1: the keeper exiting during a job stops the job group and writes no record again', async () => {
  const lock = fresh();
  const pids = join(dir, 'f1-pids');
  const step = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pids)}, String(process.pid)); setInterval(() => {}, 1000)`] };
  const running = job(lock, [step], { limitMs: 30000 });
  assert.equal(await until(() => existsSync(pids)), true);
  await sleep(300);
  const listing = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n');
  const keeper = listing.map((line) => line.trim().split(/\s+/)).find((fields) => Number(fields[1]) === process.pid && fields[2]?.endsWith('lockf'));
  assert.ok(keeper, 'keeper found');
  process.kill(Number(keeper[0]), 'SIGKILL');
  const result = await running;
  assert.equal(result.reason, 'lock lost');
  assert.equal(result.code, 125);
  assert.equal(alive(Number(readFileSync(pids, 'utf8'))), false, 'the job group is stopped');
  assert.equal(typeof readLock(lock)?.pgid, 'number', 'no record write after the loss: the group stays recorded');
  assert.equal((await job(lock)).code, 0, 'the next job cleans up and starts');
});

test('F3: a replaced lock file stops the job before the next step', async () => {
  const lock = fresh();
  const marker = join(dir, 'f3-second-step');
  const slow = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 900)'] };
  const second = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] };
  const running = job(lock, [slow, second]);
  await sleep(400);
  unlinkSync(lock);
  writeFileSync(lock, '{}');
  const result = await running;
  assert.equal(result.reason, 'lock lost');
  assert.equal(existsSync(marker), false, 'the second step did not start');
});

test('F4: lockf failing with exit 71 or a signal is retried with a back-off', async () => {
  const lock = fresh();
  const count = join(dir, 'lockf-count');
  const fake = join(dir, 'fake-lockf');
  writeFileSync(count, '0');
  writeFileSync(fake, `#!/bin/sh\nn=$(cat ${count}); echo $((n + 1)) > ${count}\nif [ "$n" -eq 0 ]; then exit 71; fi\nif [ "$n" -eq 1 ]; then kill -9 $$; fi\nexec /usr/bin/lockf "$@"\n`);
  chmodSync(fake, 0o755);
  const result = await withEnv({ PORTOGRAPH_LOCKF: fake }, () => job(lock));
  assert.equal(result.code, 0);
  assert.ok(Number(readFileSync(count, 'utf8')) >= 3, 'lockf ran after both failures');
  assert.equal(held(lock), false);
});

test('F5: a stale PORTOGRAPH_LOCK_HELD throws at once and does not queue', async () => {
  const lock = fresh();
  const holder = await takeFlock(lock);
  try {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runJob } from ${JSON.stringify(LIB)};
      try { await runJob({ job: 'x', steps: [{ command: process.execPath, args: ['-e', ''] }], limitMs: 5000, lockPath: ${JSON.stringify(lock)}, stdout: { write() {} }, stderr: { write() {} } }); process.exit(0); }
      catch (error) { process.stdout.write(error.message); process.exit(3); }`], { env: { ...process.env, PORTOGRAPH_LOCK_HELD: '424242' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    assert.equal(await exited(child), 3);
    assert.match(out, /not queueing/);
    assert.ok(Date.now() - started < 3000, 'did not wait for the busy lock');
  } finally { await holder.release(); }
});

test('continueOnFailure: every step runs after a failure, the first failing code wins, a timeout still stops at once', async () => {
  const lock = fresh();
  const log = join(dir, 'steps-log');
  writeFileSync(log, '');
  const step = (name, exit) => ({ command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(log)}, '${name}\\n'); process.exit(${exit})`] });
  const all = await job(lock, [step('a', 3), step('b', 0), step('c', 5)], { continueOnFailure: true });
  assert.equal(all.code, 3);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['a', 'b', 'c']);
  writeFileSync(log, '');
  const stopped = await job(lock, [step('a', 3), step('b', 0)]);
  assert.equal(stopped.code, 3);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['a'], 'without the option a failure stops the job');
  writeFileSync(log, '');
  const hang = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
  const timed = await job(lock, [hang, step('late', 0)], { continueOnFailure: true, limitMs: 700 });
  assert.equal(timed.reason, 'timeout');
  assert.equal(readFileSync(log, 'utf8'), '', 'a timeout stops the later steps');
  assert.equal(held(lock), false);
});
