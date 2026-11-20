import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { caption, pictureName, selectPairs } from '../../scripts/gate-pairs-lib.mjs';

// Retro 2026-11, ticket 04: the selection of `gate:pairs`, without layout. The base fixture has the columns of a TSV written before
// `fallback`; the head has every column. Each sheet tests one judged column, a tie, a mixed sheet, a recovery or a sheet left out.
const fixture = (name: string): string => new URL(`../fixtures/gate-pairs/${name}`, import.meta.url).pathname;
const BASE = fixture('base-before-fallback.tsv'), HEAD = fixture('head.tsv');
const short = (file: string): string => file.split('/').pop()!.replace(/\.yaml$/, '');
const dir = mkdtempSync(join(tmpdir(), 'gate-pairs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the selection of gate:pairs', () => {
  it('ranks the worse sheets by the judgement order of gate:compare: error, bends, removed, gates, crossings, canvas area', () => {
    const { worse, counts } = selectPairs(BASE, HEAD, 20);
    expect(counts).toEqual({ worse: 10, better: 4 });
    expect(worse.map(pair => [short(pair.file), pair.flags.join('+')])).toEqual([
      ['a-error', 'error'],
      // Two sheets with the same steps keep the order of their names.
      ['b-bends3', 'bends'], ['b2-tie', 'bends'],
      ['c-bends1-canvas', 'bends+canvas'],
      ['d-removed', 'removed'], ['e-gates', 'gates'], ['f-crossings', 'crossings'],
      // The larger relative growth of the canvas area ranks first.
      ['h-canvas-big', 'canvas'], ['g-canvas-small', 'canvas'],
      // Fewer bends but one more crossing: worse, and last, because its bends step is negative.
      ['i-mixed', 'crossings'],
    ]);
  });

  it('ranks the better sheets the same way, a recovered sheet first, and takes a sweep sheet by its path', () => {
    expect(selectPairs(BASE, HEAD, 20).better.map(pair => [short(pair.file), pair.flags.join('+')])).toEqual([
      ['l-recovered', 'error'], ['j-better-bends', 'bends'], ['v1-1-1', 'bends'], ['k-better-canvas', 'canvas'],
    ]);
  });

  it('takes the top N of each list and names the sheets it leaves out', () => {
    const { worse, better, left } = selectPairs(BASE, HEAD, 3);
    expect(worse.map(pair => short(pair.file))).toEqual(['a-error', 'b-bends3', 'b2-tie']);
    expect(better.map(pair => short(pair.file))).toEqual(['l-recovered', 'j-better-bends', 'v1-1-1']);
    expect(left.map(item => [short(item.file), item.reason])).toEqual([['n-only-base', 'only in base'], ['o-only-head', 'only in head'], ['p-both-fail', 'fails in both']]);
  });

  it('does not depend on the order of the rows (R3)', () => {
    const reversed = (path: string, name: string): string => {
      const [header, ...rows] = readFileSync(path, 'utf8').trimEnd().split('\n');
      writeFileSync(join(dir, name), `${[header, ...rows.reverse()].join('\n')}\n`);
      return join(dir, name);
    };
    const pick = (selection: ReturnType<typeof selectPairs>) => [selection.worse, selection.better].map(list => list.map(pair => pair.file));
    expect(pick(selectPairs(reversed(BASE, 'base.tsv'), reversed(HEAD, 'head.tsv'), 20))).toEqual(pick(selectPairs(BASE, HEAD, 20)));
  });

  it('writes a caption from the TSV cells and a file name from the sheet path', () => {
    const { worse } = selectPairs(BASE, HEAD, 20);
    const pair = (name: string) => worse.find(item => short(item.file) === name)!;
    expect(caption(pair('c-bends1-canvas'))).toBe('bends 1 to 2, crossings 0 to 0, canvas 100x100 to 200x100, gates - to -');
    expect(caption(pair('d-removed'))).toBe('bends 0 to 0, crossings 0 to 0, canvas 100x100 to 100x100, gates - to -, removed 0 to 1');
    expect(caption(pair('a-error'))).toBe('base lays out; head TIMEOUT after 120 s');
    expect(pictureName('goldens/synthetic/a-error.yaml')).toBe('goldens--synthetic--a-error');
    expect(pictureName('test/fixtures/sweep/v1-1-1.yaml')).toBe('test--fixtures--sweep--v1-1-1');
  });
});
