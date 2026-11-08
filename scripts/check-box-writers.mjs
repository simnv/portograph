/**
 * Lint step (DR-11, audit T-25): every `moveGroup` call site in `src/` stands in the box writer table `src/layout/box-writers.ts`. A call is
 * keyed by its file and its top-level function; the number of calls of each key equals the number of its table entries. A new box writer
 * states its guard, its proof or its withdrawal path in the table first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { BOX_WRITERS } = await import(join(root, 'src', 'layout', 'box-writers.ts'));
const walk = (dir) => readdirSync(dir).sort().flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []; });
const sites = new Map();
for (const file of walk(join(root, 'src'))) {
  let fn = '(top level)';
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const head = /^(?:export )?(?:async )?function\*? ?(\w+)/.exec(line) ?? /^(?:export )?const (\w+)\s*(?::[^=]*)?=/.exec(line);
    if (head) fn = head[1];
    const calls = line.match(/\bmoveGroup\(/g)?.length ?? 0;
    if (calls === 0 || /function moveGroup\(/.test(line)) return;
    const key = `${relative(root, file)} ${fn}`, site = sites.get(key) ?? { count: 0, lines: [] };
    site.count += calls; site.lines.push(index + 1); sites.set(key, site);
  });
}
const table = new Map();
for (const writer of BOX_WRITERS) { const key = `${writer.file} ${writer.fn}`; table.set(key, (table.get(key) ?? 0) + 1); }
const bad = [];
for (const [key, site] of sites) if (table.get(key) !== site.count) bad.push(`${key}: ${site.count} moveGroup call(s) at line(s) ${site.lines.join(', ')}, ${table.get(key) ?? 0} table entr(ies)`);
for (const [key, count] of table) if (!sites.has(key)) bad.push(`${key}: ${count} table entr(ies), no moveGroup call`);
if (bad.length > 0) {
  process.stderr.write(`Box writers out of the table src/layout/box-writers.ts (state each guard there):\n${bad.join('\n')}\n`);
  process.exit(1);
}
