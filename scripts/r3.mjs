/**
 * The R3 check (CODING_STANDARDS.md): is the layout independent of the order of the input?
 *
 * Usage: npm run r3 -- <sheet.yaml>...      (builds dist/ first; see docs/agents/gates.md)
 *
 * Each sheet is laid out as written, with its `links` in the reverse order and with its `nodes` in the
 * reverse order, the way `portograph render` lays out (the built library; `corpus` does the same). For
 * each reversal one line is printed: `<sheet>\t<links|nodes>\tSAME`, or the first differing JSON path of
 * the layout without `runtime` and without `document` (the echoed input), with the two values.
 * A sheet that cannot be laid out, or a block with fewer than two entries, prints `ERROR` or `SKIP`.
 *
 * Exit code: 0 when every reversal is SAME or SKIP, 1 when one differs or fails, 2 for a usage error.
 * A difference is a lead, not always a defect: node order can be meaningful (the row order of a group,
 * R3), and a link without an `id` takes `link-<index>`, so its id follows the order. Give links ids.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { elapsed, failure, openPipeline, withGateLock } from './gate-lib.mjs';
import { comparable, firstDifference, reversed } from './r3-lib.mjs';

async function main(sheets) {
  if (sheets.length === 0 || sheets.some((sheet) => sheet.startsWith('-'))) throw new Error('usage: npm run r3 -- <sheet.yaml>...');
  const start = performance.now();
  const pipeline = await openPipeline();
  let bad = 0;
  const say = (sheet, kind, text) => process.stdout.write(`${sheet}\t${kind}\t${text}\n`);
  try {
    for (const [index, sheet] of sheets.entries()) {
      process.stderr.write(`r3: ${index + 1}/${sheets.length} ${sheet}\n`);
      const source = readFileSync(resolve(sheet), 'utf8');
      const lay = async (text) => comparable(pipeline.api, await pipeline.layout(pipeline.api.parse(text)));
      let written;
      try {
        written = await lay(source);
      } catch (error) {
        bad++;
        say(sheet, 'written', failure(error));
        continue;
      }
      for (const key of ['links', 'nodes']) {
        let text;
        try {
          text = reversed(source, key);
        } catch (error) {
          say(sheet, key, `SKIP ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        try {
          const found = firstDifference(written, await lay(text));
          if (found !== undefined) bad++;
          say(sheet, key, found ?? 'SAME');
        } catch (error) {
          bad++;
          say(sheet, key, failure(error));
        }
      }
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
