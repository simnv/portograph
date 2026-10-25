/**
 * Checks of the lock and kill safety rules with tiny node children (no vitest): the stale-lock race,
 * ps locale and failure, group id reuse, the base worktree copy list, held-lock group check, orphan
 * workers, the double-forked watchdog and pipes held open by a grandchild. Run with `npm run test:runner`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alive, runJob, sleep, startTime } from './test-runner-lib.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const LIB = here('./test-runner-lib.mjs');
const LOCKJOB = here('./with-lock.mjs');
const dir = mkdtempSync(join(tmpdir(), 'pg-runner-safety-'));
let counter = 0;
const fresh = () => { counter += 1; return join(dir, `lock-${counter}`); };
const exited = (child) => new Promise((resolve) => child.on('close', resolve));
const lockEnv = (lock, extra = {}) => ({ ...process.env, PORTOGRAPH_TEST_LOCK: lock, PORTOGRAPH_LOCK_HELD: '', ...extra });
const quiet = { write() {} };
const until = async (test, ms = 5000) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await sleep(25); return test(); };
const module = (code, lock, extra) => spawn(process.execPath, ['--input-type=module', '-e', code], { env: lockEnv(lock, extra), stdio: 'ignore' });

test('B1: six jobs race for the lock of a dead owner; never two holders', async () => {
  for (let trial = 0; trial < 5; trial += 1) {
    const lock = fresh();
    const log = join(dir, `race-${trial}`);
    writeFileSync(log, '');
    writeFileSync(lock, JSON.stringify({ pid: 999999, start: 'x', pgid: null, job: 'dead' }));
    const racer = `
      import { acquireLock, releaseLock, sleep } from ${JSON.stringify(LIB)};
      import { appendFileSync } from 'node:fs';
      const record = await acquireLock('race', { path: ${JSON.stringify(lock)} });
      appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + '\\n');
      await sleep(300);
      appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n');
      releaseLock(${JSON.stringify(lock)}, process.pid, record.start);`;
    await Promise.all(Array.from({ length: 6 }, () => exited(module(racer, lock))));
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')).sort((a, b) => a[1] - b[1] || (a[0] === 'end' ? -1 : 1));
    let current = 0;
    let max = 0;
    for (const [kind] of events) { current += kind === 'start' ? 1 : -1; max = Math.max(max, current); }
    assert.equal(events.length, 12, 'all six jobs ran');
    assert.equal(max, 1, `trial ${trial}: ${max} holders at once`);
    assert.equal(existsSync(lock), false);
  }
});

test('B2: start time does not depend on locale or zone', () => {
  const read = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { startTime } from ${JSON.stringify(LIB)}; process.stdout.write(startTime(${process.pid}));`], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout;
  const base = read({});
  assert.notEqual(base, '');
  assert.equal(read({ TZ: 'Asia/Tokyo', LC_ALL: 'ru_RU.UTF-8', LANG: 'ru_RU.UTF-8' }), base);
  assert.equal(startTime(process.pid), base);
});

test('B2: a failing ps is "unknown" (the owner counts as live), and an empty start refuses the lock', async () => {
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin);
  const okFile = join(dir, 'ok-pid');
  // The fake ps answers only for the pid in okFile and fails for every other call.
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\nif [ "$3" = "$(cat ${okFile})" ]; then echo "Mon Jan  1 00:00:00 2026"; exit 0; fi\nexit 3\n`);
  chmodSync(join(bin, 'ps'), 0o755);
  const lock = fresh();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'Sat Jan  1 00:00:00 2000', pgid: null, job: 'live owner, ps cannot tell' }));
  const before = readFileSync(lock, 'utf8');
  const code = `
    import { acquireLock } from ${JSON.stringify(LIB)};
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(okFile)}, String(process.pid));
    await acquireLock('x', { path: ${JSON.stringify(lock)} });
    writeFileSync(${JSON.stringify(`${lock}.acquired`)}, 'yes');`;
  const child = module(code, lock, { PATH: `${bin}:${process.env.PATH}` });
  await sleep(1200);
  child.kill('SIGKILL');
  assert.equal(existsSync(`${lock}.acquired`), false, 'did not take a lock whose owner ps cannot judge');
  assert.equal(readFileSync(lock, 'utf8'), before);
  // An empty start (ps fails for the job's own pid) refuses outright.
  writeFileSync(okFile, '1');
  const refuse = module(code.replace(/writeFileSync\(\S+okFile\S+, String\(process.pid\)\);/, ''), fresh(), { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(await exited(refuse), 0);
});

test('B3: a reused group id is not killed; the job\'s own group is', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const mine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await sleep(300);
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await exited(dead);
    const record = (child, pgStart) => ({ pid: dead.pid, start: 'gone', pgid: child.pid, pgStart, since: Date.now() - 5000, job: 'dead' });
    const take = (lock) => runJob({ job: 'next', steps: [{ command: process.execPath, args: ['-e', ''] }], limitMs: 10000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: quiet });
    // Wrong leader start time: the id belongs to someone else now.
    const lockA = fresh();
    writeFileSync(lockA, JSON.stringify(record(bystander, 'Sat Jan  1 00:00:00 2000')));
    assert.equal((await take(lockA)).code, 0);
    assert.equal(alive(bystander.pid), true, 'the unrelated group survives');
    // Right leader start time: it is the job's group.
    const lockB = fresh();
    writeFileSync(lockB, JSON.stringify(record(mine, startTime(mine.pid))));
    assert.equal((await take(lockB)).code, 0);
    assert.equal(await until(() => !alive(mine.pid)), true, 'the recorded group is killed');
  } finally {
    for (const child of [bystander, mine]) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

test('B4: every file gate-branch copies into gate-main brings its relative imports along', () => {
  const source = readFileSync(here('./gate-branch.mjs'), 'utf8');
  const list = /for \(const file of (\[[^\]]*\])\) cpSync/.exec(source);
  assert.ok(list, 'copy list found');
  const files = new Set(JSON.parse(list[1].replaceAll("'", '"')));
  for (const name of ['test-runner-lib.mjs', 'test-watchdog.mjs', 'with-lock.mjs']) assert.ok(files.has(name), `${name} is copied`);
  for (const file of files) {
    for (const match of readFileSync(here(`./${file}`), 'utf8').matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) assert.ok(files.has(match[1]), `${file} imports ${match[1]}, which is not copied`);
  }
});

test('N1: vite.config.ts stops a raw vitest load', () => {
  const source = readFileSync(here('../vite.config.ts'), 'utf8');
  assert.match(source, /process\.env\.VITEST[^\n]*heldLock\(\) === undefined/);
  assert.match(source, /throw new Error\('vitest runs only through/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { heldLock } from ${JSON.stringify(LIB)}; process.stdout.write(String(heldLock()));`], { env: lockEnv(fresh()), encoding: 'utf8' });
  assert.equal(child.stdout, 'undefined');
});

test('N3: a timeout inside a held lock also kills fork workers that init adopted', async () => {
  const lock = fresh();
  const pidFile = join(dir, 'worker-pid');
  const inner = join(dir, 'worker-inner.mjs');
  const step = `const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(inner, `
    import { runJob } from ${JSON.stringify(LIB)};
    const result = await runJob({ job: 'inner', steps: [{ command: process.execPath, args: ['-e', ${JSON.stringify(step)}] }], limitMs: 1200, graceMs: 300, stdout: { write() {} }, stderr: { write() {} } });
    process.exit(result.reason === 'timeout' ? 0 : 9);`);
  const outer = spawn(process.execPath, [LOCKJOB, 'gate', '--', process.execPath, inner], { env: lockEnv(lock), stdio: 'ignore' });
  assert.equal(await Promise.race([exited(outer), sleep(20000).then(() => 'hang')]), 0);
  const worker = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(await until(() => !alive(worker)), true, 'the adopted worker is killed');
  assert.equal(existsSync(lock), false);
});

test('N5: the watchdog is adopted by launchd, not left under the runner', async () => {
  const lock = fresh();
  const code = `
    import { runJob } from ${JSON.stringify(LIB)};
    await runJob({ job: 'w', steps: [{ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 2500)'] }], limitMs: 20000, lockPath: ${JSON.stringify(lock)}, stdout: { write() {} }, stderr: { write() {} } });`;
  const runner = module(code, lock);
  let line;
  assert.equal(await until(() => {
    const listing = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' } }).stdout;
    line = listing.split('\n').find((row) => row.includes('test-watchdog.mjs') && row.includes(lock));
    return line !== undefined;
  }, 5000), true, 'watchdog running');
  assert.equal(line.trim().split(/\s+/)[1], '1', 'the watchdog parent is launchd');
  await exited(runner);
  assert.equal(await until(() => !existsSync(lock)), true);
});

test('N7: a grandchild that holds the pipes open does not hold the job', async () => {
  const lock = fresh();
  const pidFile = join(dir, 'pipe-holder');
  const step = `const { spawn } = require('node:child_process');
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid)); setTimeout(() => process.exit(0), 300);`;
  const started = Date.now();
  const result = await runJob({ job: 'pipes', steps: [{ command: process.execPath, args: ['-e', step] }], limitMs: 20000, graceMs: 400, lockPath: lock, stdout: quiet, stderr: quiet });
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 4000, 'returned without waiting for the pipe holder');
  assert.equal(await until(() => !alive(Number(readFileSync(pidFile, 'utf8')))), true);
  assert.equal(existsSync(lock), false);
});

test('N8: a process outside the holder group does not inherit the lock', () => {
  const lock = fresh();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: startTime(process.pid), pgid: 1234567, job: 'holder' }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { heldLock } from ${JSON.stringify(LIB)}; process.stdout.write(String(heldLock()));`], { env: lockEnv(lock, { PORTOGRAPH_LOCK_HELD: String(process.pid) }), encoding: 'utf8' });
  assert.equal(child.stdout, 'undefined');
});
