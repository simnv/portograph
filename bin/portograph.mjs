#!/usr/bin/env node
// Executable shim. It carries the .mjs extension because the package is
// "type": "module" and Node refuses to load an extensionless entry point in that
// context (ERR_UNKNOWN_FILE_EXTENSION).
import { main } from './cli.mjs';

// A reader that closes early (`portograph layout x.yaml | head`) is not a failure of the tool.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    // main() returns 2 for every input error it recognises, so anything that escapes it is the
    // tool failing, not the document: a missing build, an unwritable path, an internal bug.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  },
);
