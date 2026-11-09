/**
 * What `npm run r3` and the tests share: the same sheet with one block of its input in the reverse
 * order, and the first place where two layouts differ (CODING_STANDARDS.md, R3).
 */
import { isMap, isSeq, parseDocument } from 'yaml';

/** Leading spaces of a line. */
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');

/**
 * The YAML with the entries of the top-level block `key:` (`links` or `nodes`) in the reverse order.
 * A block (`links:` alone on its line, or with a comment) is reversed in the text: an entry is a line at the
 * block's own indent with the deeper lines under it, so a record that spans lines moves whole. Comment lines
 * before the first entry stay in place; later ones go with the entry above them. A flow block
 * (`links: [[a, b], [b, c]]`) is reversed through the YAML document and written again.
 * Throws when the block is absent, holds fewer than two entries, or cannot be reversed
 * (an anchor in the block would stand after its alias): a reversal that changes nothing, or breaks
 * the sheet, would let a test pass or fail without testing.
 */
export function reversed(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`) && /^\s*(#.*)?$/.test(line.slice(key.length + 1)));
  const inline = start < 0 && lines.some((line) => line.startsWith(`${key}:`));
  if (start < 0 && !inline) throw new Error(`reversed: no top-level \`${key}:\` block`);
  const text = inline ? reversedFlow(yaml, key) : reversedBlock(lines, start, key);
  // The result must parse when the input does: an alias that now comes before its anchor is a named skip, not a layout error.
  if (readable(yaml) && !readable(text)) {
    throw new Error(`reversed: reversing \`${key}:\` puts an alias before its anchor (an anchor inside the block)`);
  }
  return text;
}

/** True when the YAML parses and every alias finds its anchor (the library reports an alias before its anchor only when it reads the values). */
function readable(yaml) {
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return false;
  try {
    document.toJS();
    return true;
  } catch {
    return false;
  }
}

/** The text path of `reversed`: `lines[start]` is the `key:` line of a block. */
function reversedBlock(lines, start, key) {
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

/** The document path of `reversed`: the key's value is on the `key:` line (a flow list or map); the document is written again. */
function reversedFlow(yaml, key) {
  const document = parseDocument(yaml);
  if (document.errors.length > 0) throw new Error(`reversed: the sheet does not parse: ${document.errors[0].message}`);
  const node = document.get(key, true);
  if (!isSeq(node) && !isMap(node)) throw new Error(`reversed: \`${key}:\` is not a list or a map`);
  if (node.items.length < 2) throw new Error(`reversed: \`${key}:\` has fewer than two entries; reversing it changes nothing`);
  node.items.reverse();
  try {
    return document.toString();
  } catch (error) {
    // The library cannot write an alias that stands before its anchor.
    throw new Error(`reversed: reversing \`${key}:\` puts an alias before its anchor (an anchor inside the block): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
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

/**
 * The group member order the `nodes` reversal changes by construction: a group lists its members, and keeps its row order and the
 * record of the row-order decision, in the order the nodes are declared, and that order is meaningful (R3).
 */
export const MEMBER_ORDER = /^\$\.groups\.[^.:[]+\.(nodes|rowOrder|rowOrderDecision)(\[|:|\.|$)/;

/** The first difference of `differences(a, b)` whose description does not match `allowed`, or `undefined` when there is none. */
export function firstDifference(a, b, allowed) {
  for (const found of differences(a, b)) if (allowed === undefined || !allowed.test(found)) return found;
  return undefined;
}

/**
 * The R3 lines of one sheet: `{ lines: [[kind, text]], bad }`. `read()` gives the sheet text and `lay(text)` the comparable layout;
 * `describe(error)` words a failure. An unreadable sheet or a failed first layout is one `written` line, so the run goes on to the next sheet.
 * A reversal that cannot be made is `SKIP <reason>`; `bad` counts the reversals that differ and the failures.
 */
export async function checkSheet({ read, lay, describe }) {
  const lines = [];
  let bad = 0;
  let source;
  let written;
  try {
    source = read();
    written = await lay(source);
  } catch (error) {
    return { lines: [['written', describe(error)]], bad: 1 };
  }
  for (const key of ['links', 'nodes']) {
    let text;
    try {
      text = reversed(source, key);
    } catch (error) {
      lines.push([key, `SKIP ${error instanceof Error ? error.message : String(error)}`]);
      continue;
    }
    try {
      const reordered = await lay(text);
      // Reversed nodes list the members of a group in the reverse order, which R3 allows: look past it for a real difference.
      const found = firstDifference(written, reordered, key === 'nodes' ? MEMBER_ORDER : undefined);
      if (found !== undefined) bad++;
      lines.push([key, found ?? (firstDifference(written, reordered) === undefined ? 'SAME' : 'SAME (group member order only)')]);
    } catch (error) {
      bad++;
      lines.push([key, describe(error)]);
    }
  }
  return { lines, bad };
}
