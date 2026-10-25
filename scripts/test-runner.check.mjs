/**
 * Checks of the test runner with tiny node child processes (about 1 s each); no vitest. Run with
 * `npm run test:runner` (node --test). Each case asserts 0 surviving owned processes and a freed lock.
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
const dir = mkdtempSync(join(tmpdir(), 'pg-runner-'));
let counter = 0;
const fresh = () => { counter += 1; return { lock: join(dir, `lock-${counter}`), pids: join(dir, `pids-${counter}`) }; };
const quiet = { write() {} };

/** A child that records its pid and a grandchild's pid in `pids`, then runs `tail`. */
function childCode(pids, tail, ignoreTerm = false) {
  return `
    const { spawn } = require('node:child_process');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    const grand = spawn(process.execPath, ['-e', "${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{},1000)"], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + grand.pid);
    ${tail}`;
}
const step = (code) => ({ command: process.execPath, args: ['-e', code] });
const ownedPids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(' ').map(Number) : []);

async function assertClean(paths, result) {
  assert.equal(result?.survivors ?? 0, 0);
  for (const pid of ownedPids(paths.pids)) {
    const end = Date.now() + 3000;
    while (alive(pid) && Date.now() < end) await sleep(25);
    assert.equal(alive(pid), false, `process ${pid} survives`);
  }
  assert.equal(existsSync(paths.lock), false, 'lock is freed');
}

const job = (paths, tail, extra = {}, ignoreTerm = false) => runJob({ job: 'fixture', steps: [step(childCode(paths.pids, tail, ignoreTerm))], limitMs: 20000, graceMs: 400, lockPath: paths.lock, stdout: quiet, stderr: quiet, ...extra });

test('success', async () => {
  const paths = fresh();
  const result = await job(paths, 'setTimeout(() => process.exit(0), 800);');
  assert.equal(result.code, 0);
  await assertClean(paths, result);
});

test('failure keeps the exit code and kills the leftover grandchild', async () => {
  const paths = fresh();
  const result = await job(paths, 'setTimeout(() => process.exit(3), 800);');
  assert.equal(result.code, 3);
  await assertClean(paths, result);
});

test('timeout', async () => {
  const paths = fresh();
  const result = await job(paths, 'setInterval(() => {}, 1000);', { limitMs: 800 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.code, 124);
  await assertClean(paths, result);
});

test('cancellation by SIGINT', async () => {
  const paths = fresh();
  setTimeout(() => process.emit('SIGINT', 'SIGINT'), 900);
  const result = await job(paths, 'setInterval(() => {}, 1000);');
  assert.equal(result.reason, 'signal');
  assert.equal(result.code, 130);
  await assertClean(paths, result);
});

test('a child that ignores TERM is killed after the grace', async () => {
  const paths = fresh();
  const result = await job(paths, 'setInterval(() => {}, 1000);', { limitMs: 800 }, true);
  assert.equal(result.reason, 'timeout');
  await assertClean(paths, result);
});

/** A runner in its own node process, so the case can SIGKILL it. */
function driver(paths, tail, logFile) {
  const code = `
    import { runJob } from ${JSON.stringify(LIB)};
    import { appendFileSync } from 'node:fs';
    const log = (text) => appendFileSync(${JSON.stringify(logFile)}, text + '\\n');
    const result = await runJob({ job: 'driver', steps: [{ command: process.execPath, args: ['-e', ${JSON.stringify(childCode(paths.pids, tail))}] }],
      limitMs: 20000, graceMs: 400, lockPath: ${JSON.stringify(paths.lock)}, watchdogPollMs: 100,
      stdout: { write() {} }, stderr: { write: (t) => log('wait ' + t.trim()) } });
    log('done ' + result.code);`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
}

test('runner killed with SIGKILL: the watchdog cleans up', async () => {
  const paths = fresh();
  const runner = driver(paths, 'setInterval(() => {}, 1000);', join(dir, 'kill-log'));
  const end = Date.now() + 8000;
  while (ownedPids(paths.pids).length < 2 && Date.now() < end) await sleep(50);
  assert.equal(ownedPids(paths.pids).length, 2, 'child started');
  assert.equal(existsSync(paths.lock), true);
  runner.kill('SIGKILL');
  const cleanEnd = Date.now() + 8000;
  while (existsSync(paths.lock) && Date.now() < cleanEnd) await sleep(50);
  await assertClean(paths, undefined);
});

test('two concurrent admissions: the second waits', async () => {
  const paths = fresh();
  const log = join(dir, 'two-log');
  writeFileSync(log, '');
  const first = driver(paths, 'setTimeout(() => process.exit(0), 1200);', log);
  const end = Date.now() + 8000;
  while (!existsSync(paths.lock) && Date.now() < end) await sleep(25);
  const second = driver({ ...paths, pids: `${paths.pids}-2` }, 'setTimeout(() => process.exit(0), 300);', log);
  await Promise.all([first, second].map((child) => new Promise((resolve) => child.on('close', resolve))));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['wait', 'done', 'done'], lines.join('|'));
  await assertClean(paths, undefined);
  await assertClean({ ...paths, pids: `${paths.pids}-2` }, undefined);
});
