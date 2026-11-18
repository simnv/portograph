/**
 * What `gate:branch` reads from `gate:compare` output (scripts/gate-compare.mjs): the rows it fails on and the sheets it checks for R3; and the
 * sweep rows it fails on (`newRemovals`).
 */
import { unlistedFallback } from './gate-lib.mjs';

/** The WORSE and NEW-FAIL rows of gate:compare output, as `{ flag, file, column, base, head }`. */
export function worseRows(text) {
  return text.split('\n').filter((line) => /\s(WORSE|NEW-FAIL)$/.test(line)).map((line) => {
    const [, flag] = /\s(WORSE|NEW-FAIL)$/.exec(line);
    const [file, column, base, head] = line.replace(/\s+(WORSE|NEW-FAIL)$/, '').split(/\s{2,}/);
    return { flag, file, column, base, head };
  });
}

/** The sheets of gate:compare output to check for R3: those whose hash changed and those only the head has, sorted. */
export function changedSheets(text) {
  const rows = text.split('\n').map((line) => line.trimEnd().split(/\s{2,}/));
  const hashed = rows.filter(([, column]) => column === 'hash').map(([file]) => file);
  const added = rows.filter(([, column, base, head]) => column === '(sheet)' && base === '-' && head === 'only in head').map(([file]) => file);
  return [...new Set([...hashed, ...added])].filter((file) => file.endsWith('.yaml')).sort();
}

/**
 * Links a sweep file removes that the base sweep did not, as `name:id`; a new ERROR or TIMEOUT counts as one, and so does a head row that falls
 * back to the option-off run of `layout.moveBeforeGrow` on an unlisted sheet (`name:fallback=<code>`, `unlistedFallback`, dense-16x9 ticket 56).
 */
export function newRemovals(baseText, headText) {
  const parse = (text) => new Map(text.split('\n').filter(Boolean).map((line) => {
    const [name, rest = ''] = line.split('\t');
    return [name, rest];
  }));
  const fallbacks = new Map(headText.split('\n').filter(Boolean).map((line) => {
    const [name, , extra = ''] = line.split('\t');
    return [name, extra.startsWith('fallback=') ? extra.slice(9) : undefined];
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
    if (unlistedFallback(name, fallbacks.get(name))) found.push(`${name}:fallback=${fallbacks.get(name)}`);
  }
  return found;
}
