/**
 * What `gate:branch` reads from `gate:compare` output (scripts/gate-compare.mjs): the rows it fails on and the sheets it checks for R3.
 */

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
