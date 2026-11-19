/**
 * The headroom of the tests in a CI log (retro 2026-11, ticket 01): each test that took more than a part of its limit, with the limit the
 * sources give it (`test-limits-lib.mjs`). `testDurations` reads the log; `headroom` joins it with the limits.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { limitOf, projectLimits, projectOf, specificity, testsIn } from './test-limits-lib.mjs';

// ESC [ ... m, also when a copy wrote the escape as the two characters `^[`.
const ESC = String.fromCharCode(27);
const COLOUR = new RegExp(`(?:${ESC}|\\^\\[)\\[[0-9;]*m`, 'g');
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// ` ✓  heavy  test/x.test.ts (12 tests) 613ms`: the line of a file, with its project when the run has several.
const FILE = /^ [✓×❯↓] +(?:(\w+) +)?(test\/\S+\.test\.ts) \(\d+ tests?[^)]*\)/;
// `     ✓ a test title 1234ms`: the line of a test that took long enough for vitest to print its time.
const TEST = /^ +([✓×]) (.+) (\d+)ms$/;

/**
 * The text of one line of a log: `gh run view --log` writes `<job>\t<step>\t<time> <text>`, a downloaded job log `<time> <text>`.
 * Returns `{ job, text }`, the colours removed.
 */
function lineOf(raw) {
  const fields = raw.split('\t');
  const job = fields.length >= 3 && STAMP.test(fields[2].replace(/^\uFEFF/, '')) ? fields[0] : undefined;
  const rest = job === undefined ? raw : fields.slice(2).join('\t');
  return { job, text: rest.replace(STAMP, '').replace(COLOUR, '') };
}

/** The tests a vitest log prints with a time: `{ job, project, file, title, ms, failed }`, in log order. */
export function testDurations(log) {
  const found = [];
  const current = new Map();
  for (const raw of log.split(/\r?\n/)) {
    const { job, text } = lineOf(raw);
    const file = FILE.exec(text);
    if (file !== null) { current.set(job, { project: file[1], file: file[2] }); continue; }
    const test = TEST.exec(text);
    const at = current.get(job);
    if (test !== null && at !== undefined) found.push({ job, project: at.project, file: at.file, title: test[2], ms: Number(test[3]), failed: test[1] === '×' });
  }
  return found;
}

/**
 * The tests of a log that took more than `part` of their limit, the largest share first: `{ job, file, line, title, ms, limit, share,
 * failed }`. The limit is read from the sources under `root`; a test that no source call matches, or that two calls with different limits
 * match, has `limit` undefined and is listed too, so a reader sees what the sources do not answer.
 */
export function headroom(log, root, part = 0.5) {
  const limits = projectLimits(root);
  const files = new Map();
  const callsOf = (file) => {
    if (!files.has(file)) files.set(file, existsSync(join(root, file)) ? testsIn(root, file) : []);
    return files.get(file);
  };
  const rows = [];
  for (const run of testDurations(log)) {
    const project = projectOf(limits, run.file);
    // The most specific calls whose title pattern matches: a literal title wins over a template that also matches it.
    const matched = callsOf(run.file).filter(call => call.pattern.test(run.title));
    const best = Math.max(...matched.map(call => specificity(call.pattern)));
    const calls = matched.filter(call => specificity(call.pattern) === best);
    const set = [...new Set(calls.map(call => limitOf(call, limits[project].limit)))];
    const limit = set.length === 1 && !Number.isNaN(set[0]) ? set[0] : undefined;
    const share = limit === undefined ? undefined : run.ms / limit;
    if (share !== undefined && share <= part) continue;
    rows.push({ job: run.job, file: run.file, line: calls.length === 1 ? calls[0].line : undefined, title: run.title, ms: run.ms, limit, share, failed: run.failed });
  }
  return rows.sort((a, b) => (b.share ?? Infinity) - (a.share ?? Infinity) || b.ms - a.ms);
}
