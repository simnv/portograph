/**
 * Checks of the shared heavy-job lock with tiny node children (no vitest): a corpus-style job and a
 * test job compete, a gate job passes the lock down, and an orphan of a runner that died before it
 * wrote the group id is killed. Run with `npm run test:runner`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alive, readLock, runJob, sleep, takeFlock } from './test-runner-lib.mjs';

const held = (path) => readLock(path)?.pid !== undefined;

const LIB = fileURLToPath(new URL('./test-runner-lib.mjs', import.meta.url));
const LOCKJOB = fileURLToPath(new URL('./with-lock.mjs', import.meta.url));
// The fixtures must not wait for the host: the admission limits are off unless a case sets them.
process.env.PORTOGRAPH_MIN_FREE_PCT ??= '0';
process.env.PORTOGRAPH_MAX_LOAD ??= '1e9';
const dir = mkdtempSync(join(tmpdir(), 'pg-runner-lock-'));
let counter = 0;
const fresh = () => { counter += 1; return join(dir, `lock-${counter}`); };
const exited = (child) => new Promise((resolve) => child.on('close', resolve));
const lockEnv = (lock) => ({ ...process.env, PORTOGRAPH_TEST_LOCK: lock, PORTOGRAPH_LOCK_HELD: '' });
const quiet = { write() {} };

test('a corpus-style job and a test job compete for one lock', async () => {
  const lock = fresh();
  const log = join(dir, 'compete-log');
  writeFileSync(log, '');
  const mark = (name) => `require('node:fs').appendFileSync(${JSON.stringify(log)}, '${name}\\n');`;
  const first = spawn(process.execPath, [LOCKJOB, 'corpus', '--', process.execPath, '-e', `${mark('corpus-start')} setTimeout(() => { ${mark('corpus-end')} }, 1200);`], { env: lockEnv(lock), stdio: 'ignore' });
  const end = Date.now() + 8000;
  while (!held(lock) && Date.now() < end) await sleep(25);
  const second = spawn(process.execPath, [LOCKJOB, 'tests', '--', process.execPath, '-e', `${mark('test-start')} ${mark('test-end')}`], { env: lockEnv(lock), stdio: 'ignore' });
  await Promise.all([exited(first), exited(second)]);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['corpus-start', 'corpus-end', 'test-start', 'test-end']);
  assert.equal(held(lock), false);
});

test('a gate job passes the lock down: no deadlock, and the inner child stays in the holder group', async () => {
  const lock = fresh();
  const out = join(dir, 'gate-out');
  const inner = join(dir, 'gate-inner.mjs');
  const child = `const { execSync } = require('node:child_process');
    const group = (pid) => execSync('ps -o pgid= -p ' + pid).toString().trim();
    require('node:fs').writeFileSync(${JSON.stringify(out)}, [process.pid, group(process.pid), group(process.ppid)].join(' '));`;
  writeFileSync(inner, `
    import { runJob, heldLock } from ${JSON.stringify(LIB)};
    import { writeFileSync } from 'node:fs';
    const held = heldLock();
    const result = await runJob({ job: 'inner test', steps: [{ command: process.execPath, args: ['-e', ${JSON.stringify(child)}] }], limitMs: 10000, stdout: { write() {} }, stderr: { write() {} } });
    writeFileSync(${JSON.stringify(`${out}.result`)}, JSON.stringify({ held, code: result.code }));
  `);
  const outer = spawn(process.execPath, [LOCKJOB, 'gate:branch', '--', process.execPath, inner], { env: lockEnv(lock), stdio: 'ignore' });
  const code = await Promise.race([exited(outer), sleep(15000).then(() => 'deadlock')]);
  assert.equal(code, 0);
  const result = JSON.parse(readFileSync(`${out}.result`, 'utf8'));
  assert.equal(result.code, 0);
  assert.ok(result.held > 0, 'the inner runner saw the held lock');
  const [pid, childGroup, parentGroup] = readFileSync(out, 'utf8').split(' ').map(Number);
  assert.notEqual(childGroup, pid, 'the inner child did not start its own group');
  assert.equal(childGroup, parentGroup, 'the inner child shares the group of its parent, which the holder kills');
  assert.equal(held(lock), false);
});

test('a heavy script refuses to run without the lock', async () => {
  const gateLib = fileURLToPath(new URL('./gate-lib.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withGateLock } from ${JSON.stringify(gateLib)}; await withGateLock(() => {});`], { env: lockEnv(fresh()), stdio: 'ignore' });
  assert.notEqual(await exited(child), 0);
});

test('a runner that died before it wrote the group id: the next job kills the orphan by its recorded command line', async () => {
  const lock = fresh();
  const pidFile = join(dir, 'orphan-pid');
  const since = Date.now();
  const marker = `setInterval(() => {}, 1000); /* orphan ${Date.now()} */`;
  // A short-lived parent starts the orphan as a group leader and exits, so init adopts it.
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const kid = spawn(process.execPath, ['-e', ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid)); kid.unref();`], { stdio: 'ignore' });
  await exited(parent);
  const orphan = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(alive(orphan), true);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await exited(dead);
  writeFileSync(lock, JSON.stringify({ pid: dead.pid, start: 'gone', pgid: null, since, pending: `${process.execPath} -e ${marker}`, job: 'dead' }));
  const result = await runJob({ job: 'next', steps: [{ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 200)'] }], limitMs: 10000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: quiet });
  assert.equal(result.code, 0);
  const end = Date.now() + 3000;
  while (alive(orphan) && Date.now() < end) await sleep(25);
  assert.equal(alive(orphan), false, 'the orphan is killed');
  assert.equal(held(lock), false);
});

// Admission health check. PORTOGRAPH_HEALTH_PROBE is a fake probe: it prints the first line of a state file,
// dropping that line unless it is the last one; a line that is not JSON makes the probe print garbage.
const withEnv = async (values, work) => {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await work(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};
let probeCounter = 0;
const fakeProbe = (readings) => {
  probeCounter += 1;
  const state = join(dir, `probe-state-${probeCounter}`);
  const script = join(dir, `probe-${probeCounter}`);
  writeFileSync(state, readings.map((reading) => (typeof reading === 'string' ? reading : JSON.stringify(reading))).join('\n'));
  writeFileSync(script, `#!${process.execPath}\nconst fs = require('node:fs');\nconst lines = fs.readFileSync(${JSON.stringify(state)}, 'utf8').split('\\n');\nif (lines.length > 1) fs.writeFileSync(${JSON.stringify(state)}, lines.slice(1).join('\\n'));\nprocess.stdout.write(lines[0]);\n`);
  chmodSync(script, 0o755);
  return script;
};
const fast = { PORTOGRAPH_ADMIT_POLL_MS: '60', PORTOGRAPH_ADMIT_WAIT_MS: '5000', PORTOGRAPH_MIN_FREE_PCT: '', PORTOGRAPH_MAX_LOAD: '' };
const collect = () => { const lines = []; return { lines, stream: { write: (text) => lines.push(String(text)) } }; };
const touch = { command: process.execPath, args: ['-e', ''] };
const writeMarker = (file) => ({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x')`] });

test('admission: low memory waits, prints one line, then proceeds and logs the readings in the record', async () => {
  const lock = fresh();
  const out = collect();
  const probe = fakeProbe([{ freePct: 5, load1: 1, swapUsedMb: 900, cpus: 4 }, { freePct: 6, load1: 1, swapUsedMb: 900, cpus: 4 }, { freePct: 55, load1: 1.5, swapUsedMb: 120, cpus: 4 }]);
  const seen = join(dir, `admit-seen-${probeCounter}`);
  const step = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(seen)}, require('node:fs').readFileSync(${JSON.stringify(lock)}, 'utf8'))`] };
  const result = await withEnv({ ...fast, PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'admit', steps: [step], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: out.stream }));
  assert.equal(result.code, 0);
  const waiting = out.lines.filter((line) => line.includes('waiting for the host'));
  assert.equal(waiting.length, 1, 'one waiting line');
  assert.match(waiting[0], /free memory 5% is below 20%/);
  assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')).admit, { freePct: 55, load1: 1.5, swapUsedMb: 120 });
  assert.equal(held(lock), false);
});

test('admission: the flock is free while the job waits for the host', async () => {
  const lock = fresh();
  const probe = fakeProbe([{ freePct: 1, load1: 0, cpus: 4 }]);
  const waiting = withEnv({ ...fast, PORTOGRAPH_ADMIT_WAIT_MS: '1500', PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'starved', steps: [touch], limitMs: 20000, lockPath: lock, stdout: quiet, stderr: quiet }).then(() => 'ran', () => 'gave up'));
  await sleep(500);
  const taken = await takeFlock(lock, { timeoutMs: 1000 });
  await taken.release();
  assert.equal(await waiting, 'gave up');
});

test('admission: a high load average waits', async () => {
  const lock = fresh();
  const out = collect();
  const probe = fakeProbe([{ freePct: 80, load1: 40, cpus: 4 }, { freePct: 80, load1: 3, cpus: 4 }]);
  const result = await withEnv({ ...fast, PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'busy host', steps: [touch], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: out.stream }));
  assert.equal(result.code, 0);
  assert.match(out.lines.join(''), /load 40\.00 is above 8/);
});

test('admission: PORTOGRAPH_MIN_FREE_PCT and PORTOGRAPH_MAX_LOAD override the defaults', async () => {
  const lock = fresh();
  const out = collect();
  const probe = fakeProbe([{ freePct: 10, load1: 5, cpus: 4 }]);
  const result = await withEnv({ ...fast, PORTOGRAPH_MIN_FREE_PCT: '5', PORTOGRAPH_MAX_LOAD: '6', PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'limits', steps: [touch], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: out.stream }));
  assert.equal(result.code, 0);
  assert.equal(out.lines.join('').includes('waiting for the host'), false);
});

test('admission: the cap gives up with a clear error and starts nothing', async () => {
  const lock = fresh();
  const probe = fakeProbe([{ freePct: 2, load1: 0, cpus: 4 }]);
  const ran = join(dir, `ran-${probeCounter}`);
  await assert.rejects(
    withEnv({ ...fast, PORTOGRAPH_ADMIT_WAIT_MS: '400', PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'capped', steps: [writeMarker(ran)], limitMs: 20000, lockPath: lock, stdout: quiet, stderr: quiet })),
    /gave up waiting for the host.*free memory 2% is below 20%/,
  );
  assert.equal(existsSync(ran), false);
  assert.equal(held(lock), false);
});

test('admission: a nested held-lock job skips the check', async () => {
  const lock = fresh();
  const probe = fakeProbe([{ freePct: 90, load1: 0, cpus: 4 }]);
  const inner = join(dir, `nested-${probeCounter}.mjs`);
  const marker = join(dir, `nested-ran-${probeCounter}`);
  writeFileSync(inner, `
    import { runJob } from ${JSON.stringify(LIB)};
    process.env.PORTOGRAPH_HEALTH_PROBE = '/nonexistent/probe';
    process.env.PORTOGRAPH_ADMIT_WAIT_MS = '200';
    process.env.PORTOGRAPH_MIN_FREE_PCT = '101';
    const result = await runJob({ job: 'inner', steps: [${JSON.stringify(writeMarker(marker))}], limitMs: 10000, stdout: { write() {} }, stderr: { write() {} } });
    process.exit(result.code);
  `);
  const outer = spawn(process.execPath, [LOCKJOB, 'outer', '--', process.execPath, inner], { env: { ...lockEnv(lock), PORTOGRAPH_HEALTH_PROBE: probe }, stdio: 'ignore' });
  assert.equal(await exited(outer), 0);
  assert.equal(readFileSync(marker, 'utf8'), 'x', 'the nested step ran although the limits could never pass');
});

test('admission: a failing probe counts as unknown, warns and proceeds', async () => {
  const lock = fresh();
  const out = collect();
  const result = await withEnv({ ...fast, PORTOGRAPH_HEALTH_PROBE: fakeProbe(['not json']) }, () => runJob({ job: 'unknown', steps: [touch], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: out.stream }));
  assert.equal(result.code, 0);
  assert.match(out.lines.join(''), /warning: cannot read the health probe/);
  const missing = await withEnv({ ...fast, PORTOGRAPH_HEALTH_PROBE: join(dir, 'missing-probe') }, () => runJob({ job: 'missing', steps: [touch], limitMs: 20000, graceMs: 400, lockPath: fresh(), stdout: quiet, stderr: quiet }));
  assert.equal(missing.code, 0);
});

test('admission: the host is checked again before the second step', async () => {
  const lock = fresh();
  const out = collect();
  const probe = fakeProbe([{ freePct: 60, load1: 0, cpus: 4 }, { freePct: 3, load1: 0, cpus: 4 }, { freePct: 60, load1: 0, cpus: 4 }]);
  const marker = join(dir, `second-${probeCounter}`);
  const result = await withEnv({ ...fast, PORTOGRAPH_HEALTH_PROBE: probe }, () => runJob({ job: 'steps', steps: [touch, writeMarker(marker)], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: out.stream }));
  assert.equal(result.code, 0);
  assert.match(out.lines.join(''), /free memory 3% is below 20%/);
  assert.equal(readFileSync(marker, 'utf8'), 'x');
});
