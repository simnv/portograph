/**
 * The sweep gate: every sheet under `test/fixtures/sweep/` laid out, one line per sheet with the
 * links stage 8 removed, and the count `N removed of M` on standard output.
 *
 * Usage: npm run sweep -- <out.txt> [--only name,name]      (builds dist/ first; see docs/gates.md)
 *
 * Line format: `<name>\tremoved=<link ids, comma-separated, or ->`; a sheet that fails to lay out
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
  process.stdout.write(`${removed} removed of ${files.length}${errors > 0 ? ` (${errors} errors)` : ''}\n`);
}

withGateLock(() => main(process.argv.slice(2))).then(
  () => { process.exitCode = 0; },
  (error) => {
    process.stderr.write(`sweep: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
