/**
 * What `npm run r3` and the tests share: the same sheet with one block of its input in the reverse
 * order, and the first place where two layouts differ (CODING_STANDARDS.md, R3).
 */

/** Leading spaces of a line. */
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');

/**
 * The YAML with the entries of the top-level block `key:` (`links` or `nodes`) in the reverse order.
 * An entry is a line at the block's own indent with the deeper lines under it, so a record that spans
 * lines moves whole. Comment lines before the first entry stay in place; later ones go with the entry
 * above them. Throws when the block is absent, is not a block, or holds fewer than two entries:
 * a reversal that changes nothing would let a test pass without testing.
 */
export function reversed(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start < 0) throw new Error(`reversed: no top-level \`${key}:\` block`);
  // The block ends at the first line that is not blank, not indented, not a comment and not a `- ` item at column 0.
  let end = start + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > 0 || isComment(lines[end]) || /^-(\s|$)/.test(lines[end]))) end++;
  while (end > start + 1 && (isBlank(lines[end - 1]) || (isComment(lines[end - 1]) && indentOf(lines[end - 1]) === 0))) end--;
  const body = lines.slice(start + 1, end);
  const entryLine = (line) => !isBlank(line) && !isComment(line);
  const first = body.findIndex(entryLine);
  if (first < 0) throw new Error(`reversed: \`${key}:\` has no entry`);
  const base = indentOf(body[first]);
  const entries = [];
  for (const line of body.slice(first)) {
    if (entryLine(line) && indentOf(line) === base) entries.push([line]);
    else entries.at(-1).push(line);
  }
  if (entries.length < 2) throw new Error(`reversed: \`${key}:\` has fewer than two entries; reversing it changes nothing`);
  return [...lines.slice(0, start + 1), ...body.slice(0, first), ...entries.reverse().flat(), ...lines.slice(end)].join('\n');
}

/**
 * The layout JSON for the R3 comparison: the serialised model without `runtime` (timings) and without
 * `document`, which echoes the input and so differs by construction when the input is reordered.
 */
export function comparable(api, model) {
  const { runtime, document, ...rest } = JSON.parse(api.serializeLayoutModel(model));
  void runtime;
  void document;
  return rest;
}

const shown = (value) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** Two numbers are the same when they differ by float noise only: the sums of a reordered input add in another order. */
const sameNumber = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** The fields that name an element of a list; a list in which one of them is unique is a set. */
const IDENTITY = ['id', 'node'];

/** The elements of a list by identity: the first field of IDENTITY that every element has as a string and no two share; else `undefined` (the list is ordered). */
function byIdentity(list) {
  for (const field of IDENTITY) {
    if (!list.every((item) => typeof item === 'object' && item !== null && typeof item[field] === 'string')) continue;
    const map = new Map(list.map((item) => [`${field} ${item[field]}`, item]));
    if (map.size === list.length) return map;
  }
  return undefined;
}

/**
 * Every difference between two JSON values, in document order, as `{ path, left, right }` with a
 * description of the first one at hand: `$.nodes.c1.bounds.x: 10 != 12`. Keys of `a` come first, then
 * keys only `b` has. Numbers within 1e-6 are the same. A list of objects that all have a unique `id`
 * or `node` (labels, links, the frozen topology) is a set: it is compared by that name, since the
 * order of such a list follows the input order by construction.
 */
export function* differences(a, b, path = '$') {
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && sameNumber(a, b)) return;
  const object = (value) => typeof value === 'object' && value !== null;
  if (!object(a) || !object(b) || Array.isArray(a) !== Array.isArray(b)) {
    yield `${path}: ${shown(a)} != ${shown(b)}`;
    return;
  }
  if (Array.isArray(a)) {
    const left = byIdentity(a), right = byIdentity(b);
    if (left !== undefined && right !== undefined) {
      for (const [id, item] of left) {
        if (right.has(id)) yield* differences(item, right.get(id), `${path}[${id}]`);
        else yield `${path}[${id}]: present != absent`;
      }
      for (const id of right.keys()) if (!left.has(id)) yield `${path}[${id}]: absent != present`;
      return;
    }
    for (let index = 0; index < Math.min(a.length, b.length); index++) yield* differences(a[index], b[index], `${path}[${index}]`);
    if (a.length !== b.length) yield `${path}: length ${a.length} != ${b.length}`;
    return;
  }
  for (const key of [...Object.keys(a), ...Object.keys(b).filter((name) => !(name in a))]) {
    if (!(key in a) || !(key in b)) yield `${path}.${key}: ${key in a ? 'present' : 'absent'} != ${key in b ? 'present' : 'absent'}`;
    else yield* differences(a[key], b[key], `${path}.${key}`);
  }
}

/** The first difference of `differences(a, b)`, or `undefined` when the two are the same. */
export function firstDifference(a, b) {
  for (const found of differences(a, b)) return found;
  return undefined;
}
