/**
 * Compare two corpus TSVs (`corpus.mjs` output): the changed cells, side by side, and a flag on
 * every sheet that is worse on bends, removed, gates, crossings (X), canvas (W), labelBorder or track, in that order.
 * A changed `hash` is printed as a changed cell, never judged; the last line counts the sheets whose hash changed. `X` counts the crossings that
 * are not faint; `Xf` (the faint crossings of a fan family, architecture-2 ticket 40) is printed and never judged. Two files of which one has no
 * `Xf` column measure crossings two ways, so they are not compared (exit 2): measure the base again.
 *
 * Usage: npm run gate:compare -- <base.tsv> <head.tsv>
 *
 * The judgement is the reader's: Q is printed when it changed and never judged, and the exit code
 * is non-zero (2) only when a file cannot be read as a corpus TSV. A sheet that lays out in the
 * base and fails in the head is flagged `error`, before the other flags.
 *
 * A sheet only in the head has no base to be worse than, so it is judged on its own: an ERROR or TIMEOUT row, an error gate (`gates` not `-`)
 * `removed > 0`, or an unlisted fallback (`fallback` 1, not in `FALLBACK_SHEETS`) prints `NEW-FAIL` (one row for the sheet, one for each reason),
 * and `gate:branch` fails on it. A clean new sheet passes.
 *
 * Worse means: more bends; more removed links; a gate id with a violation that the base did not
 * have; more crossings; a larger canvas area; more label border crossings; more overlay run pairs on one track; a fallback to the option-off run
 * of `layout.moveBeforeGrow` on a sheet `FALLBACK_SHEETS` does not list (dense-16x9 ticket 56, `unlistedFallback`), whatever the base: a
 * changed row, a row that recovers from a base error, and a head-only row alike. A base with no `fallback` column reads as 0. The `choice`
 * column (the growth choice of dense-16x9 ticket 60) is printed when it changes and judged by nothing: a choice is no fallback, and the sheet is
 * judged on its geometry columns as any other.
 */
import process from 'node:process';
import { COLUMNS, CorpusTsvError, readCorpusTsv, unlistedFallback, worseFlags } from './gate-lib.mjs';

const JUDGED = ['bends', 'removed', 'gates', 'crossings', 'canvas', 'labelBorder', 'track', 'fallback'];
/** The flag of a sheet that only the head has, judged on its own. */
const NEW_FAIL = 'new-fail';
/** The columns in print order: the judged ones first, in judgement order, then the rest as the TSV has them. */
const PRINT_ORDER = ['bends', 'removed', 'gates', 'X', 'W', 'labelBorder', 'track', 'fallback', ...COLUMNS.filter((column) => !['file', 'bends', 'removed', 'gates', 'X', 'W', 'labelBorder', 'track', 'fallback'].includes(column))];

/** What fails on a head-only sheet, as `[column, value]` cells; empty when it is clean. */
function newFailures(row, file) {
  if (row.error !== undefined) return [['(sheet)', row.error]];
  const failures = [];
  if (unlistedFallback(file, row.cells.fallback)) failures.push(['fallback', row.cells.fallback]);
  if ('gates' in row.cells && row.cells.gates !== '-') failures.push(['gates', row.cells.gates]);
  if ('removed' in row.cells && Number(row.cells.removed) > 0) failures.push(['removed', row.cells.removed]);
  return failures;
}

function compare(base, head) {
  const files = [...new Set([...base.rows.keys(), ...head.rows.keys()])].sort();
  const columns = PRINT_ORDER.filter((column) => base.columns.includes(column) && head.columns.includes(column));
  const lines = []; // [file, column, base, head, flag]
  const counts = Object.fromEntries(['error', NEW_FAIL, ...JUDGED].map((flag) => [flag, 0]));
  let changed = 0;
  let geometry = 0;
  for (const file of files) {
    const b = base.rows.get(file);
    const h = head.rows.get(file);
    let sheetFlags = [];
    let cells = [];
    if (b === undefined) {
      // Only in the head: no base to be worse than, so the sheet is judged on its own. Every row of a failing sheet carries the flag.
      const failures = newFailures(h, file);
      cells = h.error !== undefined ? [['(sheet)', '-', h.error]] : [['(sheet)', '-', 'only in head'], ...failures.map(([column, value]) => [column, '-', value])];
      if (failures.length > 0) sheetFlags = [NEW_FAIL];
    } else if (h === undefined) cells.push(['(sheet)', 'only in base', '-']);
    else if (b.error !== undefined || h.error !== undefined) {
      if (b.error === h.error) continue;
      cells.push(['(sheet)', b.error ?? 'ok', h.error ?? 'ok']);
      if (h.error !== undefined && b.error === undefined) sheetFlags = ['error'];
      // A head that recovers from a base error is judged on its fallback all the same (review 1 of ticket 56).
      if (h.error === undefined && unlistedFallback(file, h.cells.fallback)) { cells.push(['fallback', '-', h.cells.fallback]); sheetFlags = ['fallback']; }
    } else {
      cells = columns.filter((column) => b.cells[column] !== h.cells[column]).map((column) => [column, b.cells[column], h.cells[column]]);
      // The head's fallback is judged before an unchanged row is skipped (review 2 of ticket 56): an unlisted fallback shows as a cell even when the
      // base has it too, or has no column (read as 0).
      sheetFlags = worseFlags(b.cells, h.cells, file);
      if (sheetFlags.includes('fallback') && !cells.some(([column]) => column === 'fallback')) cells.push(['fallback', b.cells.fallback ?? '-', h.cells.fallback]);
      if (cells.length === 0) continue;
    }
    changed++;
    if (cells.some(([column]) => column === 'hash')) geometry++;
    for (const flag of sheetFlags) counts[flag]++;
    for (const [column, left, right] of cells) {
      const flag = column === 'bends' ? 'bends' : column === 'removed' ? 'removed' : column === 'gates' ? 'gates' : column === 'X' ? 'crossings' : column === 'W' ? 'canvas' : column === 'labelBorder' ? 'labelBorder' : column === 'track' ? 'track' : column === 'fallback' ? 'fallback' : column === '(sheet)' ? 'error' : undefined;
      lines.push([file, column, left, right, sheetFlags.includes(NEW_FAIL) ? 'NEW-FAIL' : flag !== undefined && sheetFlags.includes(flag) ? 'WORSE' : '']);
    }
  }
  return { lines, changed, counts, total: files.length, geometry };
}

function format({ lines, changed, counts, total, geometry }) {
  if (changed === 0) return `no change: ${total} sheets\n${geometry} sheets with a geometry change (hash)\n`;
  const table = [['file', 'column', 'base', 'head', ''], ...lines];
  const widths = [0, 1, 2, 3].map((position) => Math.max(...table.map((row) => row[position].length)));
  const out = table.map((row) => row.map((cell, position) => (position < 4 ? cell.padEnd(widths[position]) : cell)).join('  ').trimEnd());
  const worse = ['error', NEW_FAIL, ...JUDGED].filter((flag) => counts[flag] > 0).map((flag) => `${flag} ${counts[flag]}`).join(', ');
  out.push('', `${changed} of ${total} sheets changed; worse: ${worse || 'none'}`);
  out.push(`${geometry} sheets with a geometry change (hash)`);
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const [basePath, headPath, ...rest] = argv;
  if (basePath === undefined || headPath === undefined || rest.length > 0) throw new CorpusTsvError('usage: npm run gate:compare -- <base.tsv> <head.tsv>');
  const base = readCorpusTsv(basePath), head = readCorpusTsv(headPath);
  // Without `Xf`, `X` counts the faint crossings too: a pair that mixes the two meanings would judge a fan's own crossings (ticket 40).
  for (const [path, file] of [[basePath, base], [headPath, head]]) {
    if (!file.columns.includes('Xf')) throw new CorpusTsvError(`${path}: no Xf column; X there counts faint crossings too, so it cannot be compared (measure it again)`);
  }
  process.stdout.write(format(compare(base, head)));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CorpusTsvError)) throw error;
  process.stderr.write(`gate:compare: ${error.message}\n`);
  process.exitCode = 2;
}
