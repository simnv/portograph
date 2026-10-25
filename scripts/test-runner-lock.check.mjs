/**
 * Checks of the shared heavy-job lock with tiny node children (no vitest): a corpus-style job and a
 * test job compete, a gate job passes the lock down, and an orphan of a runner that died before it
 * wrote the group id is killed. Run with `npm run test:runner`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alive, runJob, sleep } from './test-runner-lib.mjs';

const LIB = fileURLToPath(new URL('./test-runner-lib.mjs', import.meta.url));
const LOCKJOB = fileURLToPath(new URL('./with-lock.mjs', import.meta.url));
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
  while (!existsSync(lock) && Date.now() < end) await sleep(25);
  const second = spawn(process.execPath, [LOCKJOB, 'tests', '--', process.execPath, '-e', `${mark('test-start')} ${mark('test-end')}`], { env: lockEnv(lock), stdio: 'ignore' });
  await Promise.all([exited(first), exited(second)]);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['corpus-start', 'corpus-end', 'test-start', 'test-end']);
  assert.equal(existsSync(lock), false);
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
  assert.equal(existsSync(lock), false);
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
  assert.equal(existsSync(lock), false);
});
