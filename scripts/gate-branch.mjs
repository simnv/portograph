/**
 * The one command before a merge request: run from a branch worktree, `npm run gate:branch` merges
 * main in, runs typecheck, lint and the tests, measures the branch against main (corpus and sweep)
 * and prints a verdict. The last line is exactly `GATE PASS` or `GATE FAIL: <reasons>`.
 *
 * Usage: npm run gate:branch -- [--skip-tests] [--allow-canvas] [--strict]
 *   --skip-tests    skip `npm test` (docs-only changes)
 *   --allow-canvas  a larger canvas does not fail the gate (the default)
 *   --strict        a larger canvas fails the gate too
 *
 * Fails on: a dirty tree or a merge conflict, a typecheck, lint or test failure, any WORSE row of
 * `gate:compare` (canvas aside, unless --strict), any NEW-FAIL row (a sheet only the head has that fails),
 * and any link the sweep removes that main keeps. It also prints the R3 check (`npm run r3`) of the sheets
 * whose hash changed; that report does not fail the gate.
 * The base files `/tmp/pg-main-<sha>.tsv` and `/tmp/pg-main-<sha>-sweep.txt` are reused when
 * they exist; otherwise they are built in a detached worktree `.claude/worktrees/gate-main` under
 * the main checkout. See docs/agents/gates.md.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { COLUMNS, ROOT } from './gate-lib.mjs';
import { changedSheets, worseRows } from './gate-rows.mjs';

/** At most this many changed sheets get the R3 report; each takes three layouts. */
const R3_MAX = 40;
const USAGE = 'npm run gate:branch -- [--skip-tests] [--allow-canvas] [--strict]';

/** A reason to stop: the first line is the verdict, the rest is detail for standard error. */
class Stop extends Error {}

/** Run a command and capture its output; `cwd` defaults to this checkout. */
function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`, stdout: result.stdout ?? '' };
}

const git = (...args) => run('git', args);
const say = (text) => process.stdout.write(`${text}\n`);
const tail = (text, lines = 25) => text.trimEnd().split('\n').slice(-lines).join('\n');

function parseArguments(argv) {
  const options = { skipTests: false, strict: false };
  for (const argument of argv) {
    if (argument === '--skip-tests') options.skipTests = true;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--allow-canvas') options.strict = false;
    else throw new Stop(`usage: ${USAGE}`);
  }
  return options;
}

/** The failing test names in vitest output, or its last lines. */
function failingTests(output) {
  const names = [...new Set(output.split('\n').filter((line) => /^\s*(FAIL|×|✗)\s/.test(line)).map((line) => line.trim()))];
  return names.length > 0 ? names.join('\n') : tail(output);
}

const hasHeader = (path) => existsSync(path) && readFileSync(path, 'utf8').split('\n')[0] === COLUMNS.join('\t');

/** Measure `cwd` into `tsv` and `sweep` (or only `only`), through a partial name so a failed run leaves no reusable file. */
function measure(cwd, tsv, sweep, only) {
  for (const [script, target] of [['corpus', tsv], ['sweep', sweep]]) {
    if (only !== undefined && only !== script) continue;
    say(`gate:branch: ${script} in ${cwd} -> ${target}`);
    const partial = `${target}.partial`;
    const result = run('npm', ['run', script, '--silent', '--', partial], cwd);
    if (!result.ok) throw new Stop(`${script} failed in ${cwd}\n${tail(result.out)}`);
    renameSync(partial, target);
  }
}

function ensureBase(sha, baseTsv, baseSweep) {
  const needTsv = !hasHeader(baseTsv);
  const needSweep = !existsSync(baseSweep);
  if (!needTsv && !needSweep) {
    say(`gate:branch: base reused (${baseTsv})`);
    return;
  }
  const common = resolve(ROOT, git('rev-parse', '--git-common-dir').stdout.trim());
  const worktree = join(dirname(common), '.claude', 'worktrees', 'gate-main');
  const prepared = existsSync(worktree)
    ? run('git', ['checkout', '--detach', '--force', sha], worktree)
    : run('git', ['worktree', 'add', '--detach', worktree, sha]);
  if (!prepared.ok) throw new Stop(`cannot prepare the base worktree ${worktree}\n${tail(prepared.out)}`);
  // The base is measured with this branch's gate scripts, so both sides write the same columns even when main's scripts are older.
  for (const file of ['corpus.mjs', 'sweep.mjs', 'gate-lib.mjs', 'test-runner-lib.mjs', 'test-watchdog.mjs', 'with-lock.mjs']) cpSync(join(ROOT, 'scripts', file), join(worktree, 'scripts', file));
  measure(worktree, baseTsv, baseSweep, needTsv && needSweep ? undefined : needTsv ? 'corpus' : 'sweep');
}

/** R3 report (it does not fail the gate): `npm run r3` on `files` through `node scripts/r3.mjs`, which runs inside this job's lock; at most R3_MAX sheets. */
function reportR3(files) {
  if (files.length === 0) return say('r3: no sheet with a new hash');
  const checked = files.slice(0, R3_MAX);
  say(`r3: ${checked.length} of ${files.length} changed sheets (report only; a difference does not fail the gate)${files.length > checked.length ? `; the rest: npm run r3 -- <sheet>...` : ''}`);
  const result = run('node', [join(ROOT, 'scripts', 'r3.mjs'), ...checked]);
  const lines = result.stdout.trimEnd().split('\n').filter(Boolean);
  const different = lines.filter((line) => !/\t(SAME|SKIP .*)$/.test(line));
  say(different.length === 0 ? `r3: ${lines.length} reversals, all SAME or SKIP` : `r3: ${different.length} of ${lines.length} reversals differ or failed:\n${different.join('\n')}`);
  if (!result.ok && different.length === 0) say(`r3: the script failed\n${tail(result.out)}`);
}

/** Links a sweep file removes that the base sweep did not, as `name:id`; a new ERROR or TIMEOUT counts as one. */
function newRemovals(baseText, headText) {
  const parse = (text) => new Map(text.split('\n').filter(Boolean).map((line) => {
    const [name, rest = ''] = line.split('\t');
    return [name, rest];
  }));
  const ids = (value) => (value === undefined || !value.startsWith('removed=') ? [] : value.slice(8).split(',').filter((id) => id !== '-' && id !== ''));
  const base = parse(baseText);
  const found = [];
  for (const [name, rest] of parse(headText)) {
    const before = base.get(name);
    if (rest.startsWith('ERROR') || rest.startsWith('TIMEOUT')) {
      if (before !== rest) found.push(`${name}:${rest}`);
      continue;
    }
    const known = new Set(ids(before));
    for (const id of ids(rest)) if (!known.has(id)) found.push(`${name}:${id}`);
  }
  return found;
}

function main(argv) {
  const { skipTests, strict } = parseArguments(argv);
  const reasons = [];
  if (git('status', '--porcelain').stdout.trim() !== '') throw new Stop('the working tree is dirty; commit or discard first');
  const branch = git('branch', '--show-current').stdout.trim();
  if (branch === '') throw new Stop('detached HEAD; run gate:branch from a branch worktree');
  if (branch === 'main') throw new Stop('run gate:branch from a branch, not main');

  const merged = git('merge', 'main', '--no-edit');
  if (!merged.ok) {
    git('merge', '--abort');
    throw new Stop(`git merge main failed and was aborted; resolve the conflict by hand, then run again\n${tail(merged.out, 10)}`);
  }
  say(`gate:branch: merged main into ${branch}`);

  for (const script of ['typecheck', 'lint']) {
    if (!run('npm', ['run', script, '--silent']).ok) {
      const again = run('npm', ['run', script, '--silent']);
      throw new Stop(`${script} failed\n${tail(again.out)}`);
    }
    say(`gate:branch: ${script} ok`);
  }
  if (skipTests) say('gate:branch: tests skipped');
  else {
    const result = run('npm', ['test', '--silent']);
    if (!result.ok) throw new Stop(`tests failed\n${failingTests(result.out)}`);
    say('gate:branch: tests ok');
  }

  const sha = git('rev-parse', '--short', 'main').stdout.trim();
  const baseTsv = `/tmp/pg-main-${sha}.tsv`;
  const baseSweep = `/tmp/pg-main-${sha}-sweep.txt`;
  ensureBase(sha, baseTsv, baseSweep);

  const head = git('rev-parse', '--short', 'HEAD').stdout.trim();
  const slug = branch.replace(/[^\w.-]+/g, '-');
  const headTsv = `/tmp/pg-${slug}-${head}.tsv`;
  const headSweep = `/tmp/pg-${slug}-${head}-sweep.txt`;
  measure(ROOT, headTsv, headSweep);

  const compared = run('node', [join(ROOT, 'scripts', 'gate-compare.mjs'), baseTsv, headTsv]);
  if (!compared.ok) throw new Stop(`gate:compare failed\n${compared.out}`);
  say(compared.stdout.trimEnd());
  for (const row of worseRows(compared.stdout)) {
    if (row.flag === 'NEW-FAIL') reasons.push(`NEW-FAIL ${row.file} ${row.column} ${row.head}`);
    else if (strict || row.column !== 'W') reasons.push(`WORSE ${row.file} ${row.column} ${row.base} -> ${row.head}`);
  }
  reportR3(changedSheets(compared.stdout));

  const diff = run('diff', [baseSweep, headSweep]);
  say(diff.stdout.trim() === '' ? 'sweep: no change' : `sweep diff:\n${diff.stdout.trimEnd()}`);
  for (const removal of newRemovals(readFileSync(baseSweep, 'utf8'), readFileSync(headSweep, 'utf8'))) reasons.push(`new removed link ${removal}`);
  return reasons;
}

try {
  const reasons = main(process.argv.slice(2));
  say(reasons.length === 0 ? 'GATE PASS' : `GATE FAIL: ${reasons.join('; ')}`);
  process.exitCode = reasons.length === 0 ? 0 : 1;
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  const [verdict, ...detail] = error.message.split('\n');
  if (detail.length > 0) process.stderr.write(`${detail.join('\n')}\n`);
  say(`GATE FAIL: ${verdict}`);
  process.exitCode = 1;
}
