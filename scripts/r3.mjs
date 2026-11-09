/**
 * The R3 check (CODING_STANDARDS.md): is the layout independent of the order of the input?
 *
 * Usage: npm run r3 -- <sheet.yaml>...      (builds dist/ first; see docs/agents/gates.md)
 *
 * Each sheet is laid out as written, with its `links` in the reverse order and with its `nodes` in the
 * reverse order, the way `portograph render` lays out (the built library; `corpus` does the same). For
 * each reversal one line is printed: `<sheet>\t<links|nodes>\tSAME`, or the first differing JSON path of
 * the layout without `runtime` and without `document` (the echoed input), with the two values.
 * The `nodes` reversal lists the members of a group in the reverse order; R3 allows that, so the path
 * skips `groups.*.nodes`, `groups.*.rowOrder` and `groups.*.rowOrderDecision`, and `SAME (group member order only)` says that was all.
 * A sheet that cannot be read or laid out prints `ERROR`; a block that cannot be reversed
 * (fewer than two entries, or an anchor inside it) prints `SKIP <reason>`.
 *
 * Exit code: 0 when every reversal is SAME (or SKIP), 1 when one differs or fails, 2 for a usage error.
 * A difference is a lead. On `links` it is a defect: the parser lists the links in one canonical order, and `link-<n>` is the
 * place of a link in it (ticket DR-04). On `nodes` it may be a change of the author's input order; a refusal is a defect (decision review D-Q1).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { elapsed, failure, openPipeline, withGateLock } from './gate-lib.mjs';
import { checkSheet, comparable } from './r3-lib.mjs';

async function main(sheets) {
  if (sheets.length === 0 || sheets.some((sheet) => sheet.startsWith('-'))) throw new Error('usage: npm run r3 -- <sheet.yaml>...');
  const start = performance.now();
  const pipeline = await openPipeline();
  let bad = 0;
  const say = (sheet, kind, text) => process.stdout.write(`${sheet}\t${kind}\t${text}\n`);
  try {
    for (const [index, sheet] of sheets.entries()) {
      process.stderr.write(`r3: ${index + 1}/${sheets.length} ${sheet}\n`);
      const lay = async (text) => comparable(pipeline.api, await pipeline.layout(pipeline.api.parse(text)));
      const checked = await checkSheet({ read: () => readFileSync(resolve(sheet), 'utf8'), lay, describe: failure });
      bad += checked.bad;
      for (const [kind, text] of checked.lines) say(sheet, kind, text);
    }
  } finally {
    pipeline.close();
  }
  process.stderr.write(`r3: ${sheets.length} sheets in ${elapsed(start)}\n`);
  return bad === 0 ? 0 : 1;
}

withGateLock(() => main(process.argv.slice(2))).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`r3: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
