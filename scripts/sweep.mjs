/**
 * The sweep gate: every sheet under `test/fixtures/sweep/` laid out, one line per sheet with the
 * links stage 8 removed, and the count `N removed of M` on standard output.
 *
 * Usage: npm run sweep -- <out.txt> [--only name,name]      (builds dist/ first; see docs/gates.md)
 *
 * Line format: `<name>\tremoved=<link ids, comma-separated, or ->`, then `\tfallback=<refusal code>` when the sheet fell back to the
 * option-off run of `layout.moveBeforeGrow` (dense-16x9 ticket 56; the count is on standard output), or `\tchoice=off` when the growth choice
 * kept the option-off run (ticket 60: no fallback, and no gate reads it); a sheet that fails to lay out
 * gets `<name>\tERROR <message>`. The removed ids are the model's `removedLinks`, the list the
 * score counts (`counters.removedLinks`).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { ROOT, elapsed, failure, openPipeline, sheets, withGateLock } from './gate-lib.mjs';

const USAGE = 'npm run sweep -- <out.txt> [--only name,name]';

function parseArguments(argv) {
  let out;
  let only;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--only') {
      only = argv[++index]?.split(',').filter(Boolean);
      if (only === undefined || only.length === 0) throw new Error(`usage: ${USAGE}`);
    } else if (argument.startsWith('-') || out !== undefined) throw new Error(`usage: ${USAGE}`);
    else out = argument;
  }
  if (out === undefined) throw new Error(`usage: ${USAGE}`);
  return { out, only };
}

async function main(argv) {
  const { out, only } = parseArguments(argv);
  const files = sheets(join(ROOT, 'test', 'fixtures', 'sweep')).filter((file) => only === undefined || only.includes(basename(file, '.yaml')));
  if (files.length === 0) throw new Error('no sweep sheet selected');
  const start = performance.now();
  const pipeline = await openPipeline();
  writeFileSync(out, '');
  let removed = 0;
  let errors = 0;
  let fallbacks = 0;
  let choices = 0;
  try {
    for (const [index, file] of files.entries()) {
      const name = basename(file, '.yaml');
      process.stderr.write(`sweep: ${index + 1}/${files.length} ${name}\n`);
      let line;
      try {
        const model = await pipeline.layout(pipeline.api.parse(readFileSync(join(ROOT, file), 'utf8')));
        const ids = model.removedLinks ?? [];
        if (ids.length > 0) removed++;
        line = `${name}\tremoved=${ids.join(',') || '-'}`;
        if (model.moveBeforeGrowRun?.failure !== undefined) { fallbacks++; line += `\tfallback=${model.moveBeforeGrowRun.failure.code}`; }
        else if (model.moveBeforeGrowRun?.choice !== undefined) { choices++; line += '\tchoice=off'; }
      } catch (error) {
        errors++;
        line = `${name}\t${failure(error)}`;
      }
      appendFileSync(out, `${line}\n`);
    }
  } finally {
    pipeline.close();
  }
  process.stderr.write(`sweep: ${files.length} sheets in ${elapsed(start)} -> ${out}\n`);
  process.stdout.write(`${removed} removed of ${files.length}${errors > 0 ? ` (${errors} errors)` : ''}${fallbacks > 0 ? `, ${fallbacks} fell back to the option-off run` : ''}${choices > 0 ? `, ${choices} kept it by the growth choice` : ''}\n`);
}

withGateLock(() => main(process.argv.slice(2))).then(
  () => { process.exitCode = 0; },
  (error) => {
    process.stderr.write(`sweep: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
