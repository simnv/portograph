/**
 * The selection of `gate:pairs` (retro 2026-11, ticket 04): the sheets of two corpus TSVs that are most worse and most better, ranked by the
 * judgement of `gate:compare` (`worseFlags`), and the caption of each pair. No layout here: `gate-pairs.mjs` renders what this selects.
 */
import { area, gateSet, readCorpusTsv, worseFlags } from './gate-lib.mjs';

/** The judged columns in judgement order, as `worseFlags` names them, with the cell each reads. */
const JUDGED = [['bends', 'bends'], ['removed', 'removed'], ['gates', 'gates'], ['crossings', 'X'], ['canvas', 'W'], ['labelBorder', 'labelBorder'], ['track', 'track'], ['fallback', 'fallback']];

/**
 * How much worse `to` is than `from` in one judged column: a count difference, the number of new gate ids, or the relative growth of the
 * canvas area. 0 when a file has no such cell, as `worseFlags` judges a missing column by nothing.
 */
function step(column, from, to) {
  if (!(column in from) || !(column in to)) return 0;
  if (column === 'gates') { const had = gateSet(from.gates); return [...gateSet(to.gates)].filter(id => !had.has(id)).length; }
  if (column === 'W') return from.W === '-' || to.W === '-' ? 0 : area(to.W) / area(from.W) - 1;
  return Number(to[column] ?? 0) - Number(from[column] ?? 0);
}

/** The rank key of a pair that went from `from` to `to`: whether it broke, then the step of each judged column, in judgement order. */
const keyOf = (broke, from, to) => [broke ? 1 : 0, ...JUDGED.map(([, column]) => (broke ? 0 : step(column, from, to)))];

/** Larger key first (lexicographic), then the file name, so the order never depends on the order of the rows (R3). */
function byKey(a, b) {
  for (let index = 0; index < a.key.length; index++) if (a.key[index] !== b.key[index]) return b.key[index] - a.key[index];
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/**
 * The worse and the better sheets of two read TSVs (`readCorpusTsv`), each ranked, and the sheets left out with their reason. A sheet is
 * worse when `worseFlags` flags it, or when it lays out in the base and fails in the head; it is better when it is not worse and
 * `worseFlags` flags the base against the head, or when it fails in the base and lays out in the head. A sheet in one file only, or that
 * fails in both, is left out: it has no pair to show.
 */
export function rankPairs(base, head) {
  const worse = [], better = [], left = [];
  const files = [...new Set([...base.rows.keys(), ...head.rows.keys()])].sort();
  for (const file of files) {
    const b = base.rows.get(file), h = head.rows.get(file);
    if (b === undefined || h === undefined) { left.push({ file, reason: b === undefined ? 'only in head' : 'only in base' }); continue; }
    if (b.error !== undefined && h.error !== undefined) { if (b.error !== h.error) left.push({ file, reason: 'fails in both' }); continue; }
    if (h.error !== undefined) { worse.push({ file, flags: ['error'], key: keyOf(true), base: b, head: h }); continue; }
    if (b.error !== undefined) { better.push({ file, flags: ['error'], key: keyOf(true), base: b, head: h }); continue; }
    const flags = worseFlags(b.cells, h.cells, file);
    if (flags.length > 0) { worse.push({ file, flags, key: keyOf(false, b.cells, h.cells), base: b, head: h }); continue; }
    const gains = worseFlags(h.cells, b.cells, file);
    if (gains.length > 0) better.push({ file, flags: gains, key: keyOf(false, h.cells, b.cells), base: b, head: h });
  }
  return { worse: worse.sort(byKey), better: better.sort(byKey), left };
}

/** The top `top` worse and the top `top` better pairs of two corpus TSV files, with the counts of each list. */
export function selectPairs(basePath, headPath, top) {
  const ranked = rankPairs(readCorpusTsv(basePath), readCorpusTsv(headPath));
  return { worse: ranked.worse.slice(0, top), better: ranked.better.slice(0, top), counts: { worse: ranked.worse.length, better: ranked.better.length }, left: ranked.left };
}

/** The caption of a pair: the judged cells from base to head (bends, crossings, canvas, gates, and removed when it changed). */
export function caption(pair) {
  if (pair.base.error !== undefined || pair.head.error !== undefined) return `base ${pair.base.error ?? 'lays out'}; head ${pair.head.error ?? 'lays out'}`;
  const b = pair.base.cells, h = pair.head.cells;
  const parts = [`bends ${b.bends} to ${h.bends}`, `crossings ${b.X} to ${h.X}`, `canvas ${b.W} to ${h.W}`, `gates ${b.gates} to ${h.gates}`];
  if (b.removed !== h.removed) parts.push(`removed ${b.removed} to ${h.removed}`);
  return parts.join(', ');
}

/** The base name of the files of a sheet in the output: its path without `.yaml`, each `/` as `--` (`goldens/synthetic/a.yaml` gives `goldens--synthetic--a`). */
export function pictureName(file) {
  return file.replace(/\.ya?ml$/, '').replaceAll('/', '--');
}
