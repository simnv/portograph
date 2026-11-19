import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { headroom, testDurations } from '../../scripts/ci-headroom-lib.mjs';
import { limitsBelowProject, projectLimits, testsIn } from '../../scripts/test-limits-lib.mjs';

// Retro 2026-11, ticket 01: the limits a test runs with, read from the sources, and the tests of a CI log above half of theirs.
// The fixture log (`test/fixtures/ci-headroom/gh-run-log.txt`) has the form of `gh run view --log`: job, step, time, the vitest text with colours.
const root = mkdtempSync(join(tmpdir(), 'ci-headroom-'));
const write = (file: string, text: string): void => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
write('vite.config.ts', `
const slowFiles = ['test/s.test.ts'];
const heavyFiles = ['test/h.test.ts'];
export default defineConfig({ test: { testTimeout: 30000, projects: [
  { extends: true, test: { name: 'default', include: ['test/**/*.test.ts'] } },
  { extends: true, test: { name: 'heavy', include: heavyFiles, testTimeout: 180000 } },
  { extends: true, test: { name: 'slow', include: slowFiles, testTimeout: 600000 } },
] } });
`);
write('test/a.test.ts', `
const SLOW = 2 * 30000;
const flag = true;
it('a literal title', async () => {});
for (const name of ['a literal', 'another']) it(\`\${name} title\`, async () => {}, 120000);
it('the slow one', async () => {}, SLOW);
it.each(['x', 'y'])('%s each', async () => {}, 10000);
for (const n of ['n7']) (flag ? it : it.fails)(\`\${n} cond\`, { timeout: 20000 }, async () => {});
it('quick', async () => {});
`);
write('test/h.test.ts', `
describe('a block', { timeout: 120000 }, () => {
  it('the heavy one', async () => {});
});
it('heavy and long enough', async () => {}, 240000);
`);
write('test/s.test.ts', `
it('slow and low', async () => {}, 60000);
it('slow without a limit', async () => {});
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const log = readFileSync(new URL('../fixtures/ci-headroom/gh-run-log.txt', import.meta.url), 'utf8');

describe('the limits of the tests, read from the sources', () => {
  it('reads the projects of vite.config.ts', () => {
    expect(projectLimits(root)).toEqual({ default: { limit: 30000 }, heavy: { files: ['test/h.test.ts'], limit: 180000 }, slow: { files: ['test/s.test.ts'], limit: 600000 } });
  });

  it('reads an own limit as a number, a constant, an options object, and none', () => {
    const tests = testsIn(root, 'test/a.test.ts').map(test => [test.line, test.own]);
    expect(tests).toEqual([[4, undefined], [5, 120000], [6, 60000], [7, 10000], [8, 20000], [9, undefined]]);
    expect(testsIn(root, 'test/h.test.ts').map(test => [test.title, test.own, test.describe])).toEqual([["'the heavy one'", undefined, 120000], ["'heavy and long enough'", 240000, undefined]]);
  });

  it('finds each test of a heavy or slow file whose limit is below its project, also through its describe', () => {
    expect(limitsBelowProject(root).map(item => [item.file, item.line, item.limit, item.projectLimit])).toEqual([
      ['test/h.test.ts', 3, 120000, 180000],
      ['test/s.test.ts', 2, 60000, 600000],
    ]);
  });
});

describe('the headroom of a CI log', () => {
  it('reads the timed tests with their job, project and file, without colours or time stamps', () => {
    expect(testDurations(log).map(test => [test.project, test.file, test.title, test.ms, test.failed])).toEqual([
      ['default', 'test/a.test.ts', 'a literal title', 16000, false],
      ['default', 'test/a.test.ts', 'the slow one', 31000, false],
      ['default', 'test/a.test.ts', 'x each', 6000, false],
      ['default', 'test/a.test.ts', 'y each', 4000, false],
      ['default', 'test/a.test.ts', 'n7 cond', 14000, false],
      ['default', 'test/a.test.ts', 'quick', 350, false],
      ['heavy', 'test/h.test.ts', 'the heavy one', 125680, true],
      ['heavy', 'test/h.test.ts', 'not in the sources', 100000, false],
    ]);
    expect(new Set(testDurations(log).map(test => test.job))).toEqual(new Set(['checks / check (Node 24)']));
  });

  it('lists the tests above half of their limit, the largest share first, and a test the sources do not give a limit', () => {
    const rows = headroom(log, root).map(row => [row.file, row.line, row.title, row.ms, row.limit, row.share === undefined ? undefined : Number(row.share.toFixed(2))]);
    expect(rows).toEqual([
      ['test/h.test.ts', undefined, 'not in the sources', 100000, undefined, undefined],
      ['test/h.test.ts', 3, 'the heavy one', 125680, 120000, 1.05],
      ['test/a.test.ts', 8, 'n7 cond', 14000, 20000, 0.7],
      ['test/a.test.ts', 7, 'x each', 6000, 10000, 0.6],
      // The literal title wins over the template `${name} title` that also matches it, so the limit is the project's 30 s, not 120 s.
      ['test/a.test.ts', 4, 'a literal title', 16000, 30000, 0.53],
      ['test/a.test.ts', 6, 'the slow one', 31000, 60000, 0.52],
    ]);
    expect(headroom(log, root, 0.6).map(row => row.title)).toEqual(['not in the sources', 'the heavy one', 'n7 cond']);
  });
});
