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
 * Worse means: more bends; more removed links; a gate id with a violation that the base did not
 * have; more crossings; a larger canvas area; more label border crossings; more overlay run pairs on one track.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { COLUMNS } from './gate-lib.mjs';

const JUDGED = ['bends', 'removed', 'gates', 'crossings', 'canvas', 'labelBorder', 'track'];
/** The columns in print order: the judged ones first, in judgement order, then the rest as the TSV has them. */
const PRINT_ORDER = ['bends', 'removed', 'gates', 'X', 'W', 'labelBorder', 'track', ...COLUMNS.filter((column) => !['file', 'bends', 'removed', 'gates', 'X', 'W', 'labelBorder', 'track'].includes(column))];

class ParseError extends Error {}

/** `{ columns, rows: Map<file, { cells } | { error }> }` from one TSV, or a ParseError. */
function parseTsv(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ParseError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const columns = (lines[0] ?? '').split('\t');
  if (columns[0] !== 'file' || columns.some((column) => !COLUMNS.includes(column))) {
    throw new ParseError(`${path}:1: not a corpus header (expected ${COLUMNS.join(', ')})`);
  }
  const rows = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split('\t');
    const file = fields[0];
    if (file === undefined || file === '') throw new ParseError(`${path}:${index + 2}: no file`);
    if (rows.has(file)) throw new ParseError(`${path}:${index + 2}: ${file} appears twice`);
    if (/^(ERROR|TIMEOUT)/.test(fields[1] ?? '')) {
      rows.set(file, { error: fields.slice(1).join(' ') });
      continue;
    }
    if (fields.length !== columns.length) throw new ParseError(`${path}:${index + 2}: ${fields.length} fields, header has ${columns.length}`);
    const cells = Object.fromEntries(columns.map((column, position) => [column, fields[position]]));
    for (const column of ['bends', 'removed', 'X', 'Xf', 'labelBorder', 'track']) {
      if (column in cells && !/^\d+$/.test(cells[column])) throw new ParseError(`${path}:${index + 2}: ${column} is not a count: ${cells[column]}`);
    }
    if ('W' in cells && cells.W !== '-' && !/^\d+x\d+$/.test(cells.W)) throw new ParseError(`${path}:${index + 2}: W is not <width>x<height> or -: ${cells.W}`);
    rows.set(file, { cells });
  }
  return { columns, rows };
}

const gateSet = (text) => new Set(text === '-' ? [] : text.split(','));
const area = (text) => text.split('x').reduce((product, side) => product * Number(side), 1);

/** The flags of one sheet, in judgement order; a missing column is never judged. */
function flags(base, head) {
  const worse = [];
  const both = (column) => column in base && column in head;
  if (both('bends') && Number(head.bends) > Number(base.bends)) worse.push('bends');
  if (both('removed') && Number(head.removed) > Number(base.removed)) worse.push('removed');
  if (both('gates') && [...gateSet(head.gates)].some((id) => !gateSet(base.gates).has(id))) worse.push('gates');
  if (both('X') && Number(head.X) > Number(base.X)) worse.push('crossings');
  if (both('W') && head.W !== '-' && base.W !== '-' && area(head.W) > area(base.W)) worse.push('canvas');
  if (both('labelBorder') && Number(head.labelBorder) > Number(base.labelBorder)) worse.push('labelBorder');
  if (both('track') && Number(head.track) > Number(base.track)) worse.push('track');
  return worse;
}

function compare(base, head) {
  const files = [...new Set([...base.rows.keys(), ...head.rows.keys()])].sort();
  const columns = PRINT_ORDER.filter((column) => base.columns.includes(column) && head.columns.includes(column));
  const lines = []; // [file, column, base, head, flag]
  const counts = Object.fromEntries(['error', ...JUDGED].map((flag) => [flag, 0]));
  let changed = 0;
  let geometry = 0;
  for (const file of files) {
    const b = base.rows.get(file);
    const h = head.rows.get(file);
    let sheetFlags = [];
    let cells = [];
    if (b === undefined) cells.push(['(sheet)', '-', 'only in head']);
    else if (h === undefined) cells.push(['(sheet)', 'only in base', '-']);
    else if (b.error !== undefined || h.error !== undefined) {
      if (b.error === h.error) continue;
      cells.push(['(sheet)', b.error ?? 'ok', h.error ?? 'ok']);
      if (h.error !== undefined && b.error === undefined) sheetFlags = ['error'];
    } else {
      cells = columns.filter((column) => b.cells[column] !== h.cells[column]).map((column) => [column, b.cells[column], h.cells[column]]);
      if (cells.length === 0) continue;
      sheetFlags = flags(b.cells, h.cells);
    }
    changed++;
    if (cells.some(([column]) => column === 'hash')) geometry++;
    for (const flag of sheetFlags) counts[flag]++;
    for (const [column, left, right] of cells) {
      const flag = column === 'bends' ? 'bends' : column === 'removed' ? 'removed' : column === 'gates' ? 'gates' : column === 'X' ? 'crossings' : column === 'W' ? 'canvas' : column === 'labelBorder' ? 'labelBorder' : column === 'track' ? 'track' : column === '(sheet)' ? 'error' : undefined;
      lines.push([file, column, left, right, flag !== undefined && sheetFlags.includes(flag) ? 'WORSE' : '']);
    }
  }
  return { lines, changed, counts, total: files.length, geometry };
}

function format({ lines, changed, counts, total, geometry }) {
  if (changed === 0) return `no change: ${total} sheets\n${geometry} sheets with a geometry change (hash)\n`;
  const table = [['file', 'column', 'base', 'head', ''], ...lines];
  const widths = [0, 1, 2, 3].map((position) => Math.max(...table.map((row) => row[position].length)));
  const out = table.map((row) => row.map((cell, position) => (position < 4 ? cell.padEnd(widths[position]) : cell)).join('  ').trimEnd());
  const worse = ['error', ...JUDGED].filter((flag) => counts[flag] > 0).map((flag) => `${flag} ${counts[flag]}`).join(', ');
  out.push('', `${changed} of ${total} sheets changed; worse: ${worse || 'none'}`);
  out.push(`${geometry} sheets with a geometry change (hash)`);
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const [basePath, headPath, ...rest] = argv;
  if (basePath === undefined || headPath === undefined || rest.length > 0) throw new ParseError('usage: npm run gate:compare -- <base.tsv> <head.tsv>');
  const base = parseTsv(basePath), head = parseTsv(headPath);
  // Without `Xf`, `X` counts the faint crossings too: a pair that mixes the two meanings would judge a fan's own crossings (ticket 40).
  for (const [path, file] of [[basePath, base], [headPath, head]]) {
    if (!file.columns.includes('Xf')) throw new ParseError(`${path}: no Xf column; X there counts faint crossings too, so it cannot be compared (measure it again)`);
  }
  process.stdout.write(format(compare(base, head)));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ParseError)) throw error;
  process.stderr.write(`gate:compare: ${error.message}\n`);
  process.exitCode = 2;
}
